#!/usr/bin/env node
// Bridge process for Claude print-mode sessions.
//
// This runs inside the tmux pane so the pane remains a real session pin. It owns
// `claude -p` subprocesses and streams their NDJSON events back to server.js over
// a local Unix socket. It never shells out with prompt text.

import net from 'node:net';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    out[key.slice(2)] = argv[i + 1] ?? '';
    i += 1;
  }
  return out;
}

function writeLine(socket, obj) {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(obj)}\n`);
}

function userInputEvent(text) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: String(text ?? '') }],
    },
    parent_tool_use_id: null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = parseArgs(process.argv.slice(2));
const socketPath = args.socket;
const cwd = args.cwd || process.cwd();
const claudeBin = args.bin || 'claude';
// In -p (print) mode permission prompts can never be answered, so any
// un-preapproved tool call auto-denies; bypassPermissions is the only mode
// that leaves the session usable. Overridable via --permission-mode.
const permissionMode = args['permission-mode'] || 'bypassPermissions';
const sessionName = args.name || '';
// Applied on every turn (not just the first) since print mode spawns a fresh
// `claude -p` child per turn — the model choice must survive across resumes.
const model = args.model || '';

if (!socketPath) {
  console.error('claude-print-bridge: --socket is required');
  process.exit(2);
}

let socket = null;
let buffer = '';
let connected = false;
let busy = false;
let sessionId = null;
let currentChild = null;
const queue = [];

console.log('Claude Print mode');
console.log(`cwd: ${cwd}`);
console.log('waiting for claude-control...');

function connect() {
  const next = net.createConnection(socketPath);
  next.setEncoding('utf8');
  next.on('connect', () => {
    socket = next;
    connected = true;
    buffer = '';
    console.log('connected to claude-control');
    writeLine(socket, { type: 'ready', pid: process.pid });
  });
  next.on('data', onData);
  next.on('error', () => {
    connected = false;
  });
  next.on('close', async () => {
    connected = false;
    socket = null;
    await sleep(1000);
    connect();
  });
}

function onData(chunk) {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'submit') {
      queue.push(String(msg.text ?? ''));
      drainQueue().catch((err) => writeLine(socket, { type: 'error', error: String(err?.message || err) }));
    } else if (msg.type === 'cancel') {
      if (currentChild && !currentChild.killed) {
        currentChild.kill('SIGINT');
        setTimeout(() => {
          if (currentChild && !currentChild.killed) currentChild.kill('SIGTERM');
        }, 1500).unref?.();
      }
    }
  }
}

async function drainQueue() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length > 0) {
      const text = queue.shift();
      if (!text.trim()) continue;
      await runClaudeTurn(text);
    }
  } finally {
    busy = false;
  }
}

async function runClaudeTurn(text) {
  writeLine(socket, { type: 'status', status: 'active' });
  console.log(`running claude -p stream-json turn${sessionId ? ` resume=${sessionId}` : ''}`);
  const streamResult = await runClaudeChild(text, true, { reportExitError: false });
  if (streamResult.code !== 0 && !streamResult.sawResponse) {
    writeLine(socket, {
      type: 'event',
      event: {
        type: 'stderr',
        text: 'stream-json input was rejected; falling back to argv prompt mode for this turn',
      },
    });
    console.log('stream-json input rejected; falling back to argv prompt mode');
    await runClaudeChild(text, false);
  } else if (streamResult.code !== 0) {
    writeLine(socket, { type: 'error', error: `claude exited ${streamResult.code}` });
  }
  writeLine(socket, { type: 'status', status: 'idle' });
}

function runClaudeChild(text, useStreamInput, { reportExitError = true } = {}) {
  return new Promise((resolve) => {
    const turnArgs = useStreamInput
      ? [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--replay-user-messages',
        '--permission-mode', permissionMode,
      ]
      : [
        '-p', text,
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', permissionMode,
      ];
    if (sessionId) {
      turnArgs.push('--resume', sessionId);
    } else if (sessionName) {
      turnArgs.push('--name', sessionName);
    }
    if (model) turnArgs.push('--model', model);

    const child = spawn(claudeBin, turnArgs, {
      cwd,
      stdio: [useStreamInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
      },
    });
    currentChild = child;

    let out = '';
    let err = '';
    let sawResponse = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      let idx;
      while ((idx = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, idx);
        out = out.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (typeof event.session_id === 'string') sessionId = event.session_id;
          if (event.type === 'assistant' || event.type === 'result') sawResponse = true;
          writeLine(socket, { type: 'event', event });
        } catch {
          writeLine(socket, { type: 'event', event: { type: 'stdout', text: line } });
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      err += chunk;
      const lines = err.split('\n');
      err = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) writeLine(socket, { type: 'event', event: { type: 'stderr', text: line } });
      }
    });

    if (useStreamInput) {
      child.stdin.write(`${JSON.stringify(userInputEvent(text))}\n`);
      child.stdin.end();
    }

    child.on('error', (error) => {
      writeLine(socket, { type: 'error', error: String(error?.message || error) });
    });

    child.on('close', (code) => {
      if (currentChild === child) currentChild = null;
      if (out.trim()) {
        try {
          const event = JSON.parse(out.trim());
          if (typeof event.session_id === 'string') sessionId = event.session_id;
          if (event.type === 'assistant' || event.type === 'result') sawResponse = true;
          writeLine(socket, { type: 'event', event });
        } catch {
          writeLine(socket, { type: 'event', event: { type: 'stdout', text: out.trim() } });
        }
      }
      if (err.trim()) {
        writeLine(socket, { type: 'event', event: { type: 'stderr', text: err.trim() } });
      }
      if (code !== 0 && reportExitError) {
        writeLine(socket, { type: 'error', error: `claude exited ${code}` });
      }
      resolve({ code, sawResponse });
    });
  });
}

connect();
