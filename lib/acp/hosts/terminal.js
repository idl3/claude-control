/**
 * ACP terminal/* host. Spawns with an args array — never a shell string.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_LIMIT = 256 * 1024;

function rpcError(code, message) {
  const err = new Error(message);
  err.rpc = { code, message };
  return err;
}

function envArrayToObject(envArray) {
  if (!Array.isArray(envArray)) return null;
  const out = {};
  for (const e of envArray) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.name === 'string') out[e.name] = String(e.value ?? '');
  }
  return out;
}

/**
 * @param {{ getCwd: () => string }} opts
 */
export function createTerminalHost({ getCwd }) {
  const terminals = new Map();

  function append(t, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    t.buffer = Buffer.concat([t.buffer, buf]);
    if (t.buffer.length > t.limit) {
      t.buffer = t.buffer.subarray(t.buffer.length - t.limit);
      t.truncated = true;
    }
  }

  function killTerm(t, signal = 'SIGKILL') {
    if (!t?.proc || t.exited) return;
    try { t.proc.kill(signal); } catch { /* ignore */ }
  }

  function getOrThrow(id) {
    const t = id ? terminals.get(id) : undefined;
    if (!t) throw rpcError(-32004, `unknown terminalId: ${id}`);
    return t;
  }

  return {
    async create(params) {
      const command = params?.command;
      if (typeof command !== 'string' || !command.length) {
        throw rpcError(-32602, 'terminal/create: command required');
      }
      const cwd = params?.cwd || getCwd() || process.cwd();
      const limit = typeof params?.outputByteLimit === 'number' ? params.outputByteLimit : DEFAULT_LIMIT;
      const envObj = envArrayToObject(params?.env);
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(envObj || {}),
      };

      let cmd;
      let args;
      if (Array.isArray(params?.args) && params.args.length) {
        cmd = command;
        args = params.args.map((a) => String(a));
      } else {
        cmd = '/bin/bash';
        args = ['-lc', command];
      }

      const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const terminalId = `term-${randomUUID()}`;
      const t = {
        id: terminalId,
        proc,
        buffer: Buffer.alloc(0),
        truncated: false,
        limit,
        exited: false,
        exitStatus: null,
        waiters: [],
        command,
        cwd,
      };
      terminals.set(terminalId, t);
      proc.stdout?.on('data', (d) => append(t, d));
      proc.stderr?.on('data', (d) => append(t, d));
      proc.on('error', (err) => append(t, `\n[terminal-host] spawn error: ${err.message}\n`));
      proc.on('exit', (code, signal) => {
        t.exited = true;
        t.exitStatus = { exitCode: code, signal };
        for (const w of t.waiters.splice(0)) w({ exitStatus: t.exitStatus });
      });
      return { terminalId };
    },

    async output(params) {
      const t = getOrThrow(params?.terminalId);
      return {
        output: t.buffer.toString('utf8'),
        truncated: t.truncated,
        exitStatus: t.exitStatus,
      };
    },

    async waitForExit(params) {
      const t = getOrThrow(params?.terminalId);
      if (t.exited) return { exitStatus: t.exitStatus };
      return new Promise((resolve) => t.waiters.push(resolve));
    },

    async kill(params) {
      killTerm(getOrThrow(params?.terminalId));
      return {};
    },

    async release(params) {
      const t = params?.terminalId ? terminals.get(params.terminalId) : undefined;
      if (t) {
        killTerm(t);
        terminals.delete(t.id);
      }
      return {};
    },

    shutdownAll() {
      for (const t of terminals.values()) killTerm(t);
      terminals.clear();
    },
  };
}
