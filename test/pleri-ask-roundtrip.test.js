/**
 * A3 — the 3-transport answer round-trip GATE (blocks Phase B).
 *
 * The load-bearing seam of the whole ask-protocol plan (OQ11/OQ14): the answer
 * channel reuses claude-control's EXISTING send path, which is not one transport
 * but three — chosen in server.js's `reply` op by session kind/transport:
 *   1. tmux    `sendText`         (default; bracketed-paste + `-l` fallback)
 *   2. print   `claudePrint.submit` (raw newline-delimited JSON socket)
 *   3. codex   `codexRpc.submit`    (JSON-RPC `turn/start` over a WebSocket)
 *
 * This gate proves a single-line `<pleri:answer>…</pleri:answer>` block sent via
 * EACH transport arrives BYTE-EXACT as the agent's next input and re-parses to
 * the same envelope, correlated by qid. It exercises the REAL transport code;
 * only the peer (the agent) is faked — which is exactly what we cannot run in a
 * unit gate. If any transport could not carry the block, that is a Halt for the
 * plan (the seam is where the fragility would just move).
 *
 * It also proves the unprotected tmux `-l` fallback is safe: a well-formed answer
 * is always single-line (serializeAnswer escapes newlines), and a forged
 * multi-line block is REJECTED by `assertSingleLineAnswerBlock` (the guard the
 * Phase-C send path calls before handing text to any transport).
 *
 * Runs under `node --test` via native TS type-stripping importing the pure lib.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { sendText } from '../lib/tmux.js';
import { ClaudePrintManager } from '../lib/claude-print.js';
import { CodexRpcManager, CodexRpcClient } from '../lib/codex-rpc.js';
import {
  serializeAnswerBlock,
  serializeAnswer,
  parseAnswerBlock,
  assertSingleLineAnswerBlock,
  correlate,
  ANSWER_TAG,
} from '../web/src/lib/pleri-ask/index.ts';

const TARGET = 's:1.0';

// A multi-question answer whose free-text slot carries characters that stress
// escaping across every transport (JSON, socket line-framing, tmux argv, WS
// JSON-RPC): quotes, angle brackets, backslash, ampersand, tab, and — the
// decisive one — an embedded newline that MUST survive as escaped data on a
// single physical line.
const ASK = {
  v: 1,
  qid: 'x9f2',
  q: [
    { h: 'Auth', t: 'Which auth method?', k: 0, o: [{ l: 'OAuth' }, { l: 'API key' }, { l: 'mTLS' }] },
    { h: 'Scope', t: 'Scopes?', k: 1, o: [{ l: 'read' }, { l: 'write' }, { l: 'admin' }] },
    { t: 'Anything else?', k: 2 },
  ],
};
const ANSWER = {
  v: 1,
  qid: 'x9f2',
  a: [0, [0, 2], 'needs "quotes", <brackets>, back\\slash & tab\there & a\nnewline'],
};

/** Assert the string the agent RECEIVES equals what we sent, and re-parses. */
function assertRoundTrip(arrived, sent) {
  assert.equal(arrived, sent, 'byte-exact: arrived input must equal the sent block');
  const parsed = parseAnswerBlock(arrived);
  assert.deepEqual(parsed, ANSWER, 'envelope round-trips (qid + every slot type)');
  assert.ok(correlate(ASK, parsed), 'answer correlates to the ask by qid');
}

test('gate precondition: the answer block is a single physical line', () => {
  const block = serializeAnswerBlock(ANSWER);
  assert.ok(!block.includes('\n') && !block.includes('\r'), 'no raw newline/CR');
  assert.ok(block.startsWith(`<${ANSWER_TAG}>`) && block.endsWith(`</${ANSWER_TAG}>`));
});

test('transport 1a — tmux sendText carries the block byte-exact (bracketed-paste path)', async () => {
  const block = assertSingleLineAnswerBlock(serializeAnswerBlock(ANSWER));
  const calls = [];
  const fakeRun = async (args) => {
    calls.push(args);
    // capture-pane must NOT contain "Pasting" so the settle-poll exits at once.
    if (args[0] === 'capture-pane') return { stdout: 'idle pane — no paste indicator', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  await sendText(TARGET, block, { _run: fakeRun, _delay: async () => {} });

  const setBuffer = calls.find((a) => a[0] === 'set-buffer');
  assert.ok(setBuffer, 'used the bracketed-paste buffer path (the proven chat transport)');
  // `set-buffer -b <buf> -- <text>` — the staged text is the final argv element,
  // pasted verbatim (bracketed) into the pane, so it is what the agent receives.
  assertRoundTrip(setBuffer[setBuffer.length - 1], block);
  assert.ok(calls.some((a) => a[0] === 'paste-buffer'), 'bracket-pasted the buffer');
  assert.ok(!calls.some((a) => a.includes('-l')), 'happy path never touched the -l fallback');
});

test('transport 1b — tmux `-l` literal fallback still carries a single-line block byte-exact', async () => {
  const block = serializeAnswerBlock(ANSWER);
  const calls = [];
  const fakeRun = async (args) => {
    calls.push(args);
    if (args[0] === 'paste-buffer') throw new Error('buffer route unavailable'); // force the fallback
    if (args[0] === 'capture-pane') return { stdout: '', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  await sendText(TARGET, block, { _run: fakeRun, _delay: async () => {} });

  const literal = calls.find((a) => a[0] === 'send-keys' && a.includes('-l'));
  assert.ok(literal, 'fell back to the `-l` literal path');
  // `send-keys -t <tgt> -l -- <text>` — single argv, no newline splitting; safe
  // ONLY because the block is single-line (an embedded newline here would submit
  // early). That safety is what the guard below enforces at the send site.
  assertRoundTrip(literal[literal.length - 1], block);
});

test('safety — a multi-line answer is rejected/escaped, never sent raw via `-l`', () => {
  // Escape path: a free-text answer WITH real newlines serializes to ONE line;
  // the newline survives only as escaped JSON data and round-trips.
  const escaped = serializeAnswerBlock({ v: 1, qid: 'x9f2', a: ['a\nb\r\nc'] });
  assert.ok(!escaped.includes('\n') && !escaped.includes('\r'), 'newlines escaped, block stays single-line');
  assert.equal(parseAnswerBlock(escaped).a[0], 'a\nb\r\nc', 'escaped newline round-trips as data');

  // serializeAnswer itself can never emit a multi-line answer (fail-loud guard).
  // (JSON.stringify escapes; the guard documents + enforces the invariant.)
  const line = serializeAnswer({ v: 1, qid: 'x9f2', a: ['x\ny'] });
  assert.ok(!line.includes('\n'));

  // Reject path: a forged/hand-crafted multi-line block must THROW at the send
  // guard (the Phase-C send path calls this before any transport), so it can
  // never ride the unprotected `-l` fallback and inject a premature Enter.
  const forged = `<${ANSWER_TAG}>{"v":1,"qid":"x9f2",\n"a":[0]}</${ANSWER_TAG}>`;
  assert.throws(() => assertSingleLineAnswerBlock(forged), /multi-line/);
  assert.throws(() => assertSingleLineAnswerBlock(`<${ANSWER_TAG}>a\r\nb</${ANSWER_TAG}>`), /multi-line/);
});

test('transport 2 — claude-print submit carries the block byte-exact over the bridge socket', async (t) => {
  const block = serializeAnswerBlock(ANSWER);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleri-print-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const manager = new ClaudePrintManager({ socketDir: dir });
  const socketPath = manager.endpointFor(TARGET);
  const client = await manager.attach({ target: TARGET, socketPath, cwd: os.tmpdir() });
  t.after(() => client.close());

  const bridge = net.createConnection(socketPath);
  bridge.setEncoding('utf8');
  t.after(() => bridge.destroy());
  await new Promise((resolve, reject) => {
    bridge.once('connect', resolve);
    bridge.once('error', reject);
  });
  bridge.write(JSON.stringify({ type: 'ready' }) + '\n');
  await client.waitForBridge();

  const gotLine = new Promise((resolve) => {
    let buf = '';
    bridge.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i >= 0) resolve(buf.slice(0, i));
    });
  });

  manager.submit(TARGET, block); // mirrors server.js reply op (print branch)

  const framed = JSON.parse(await gotLine);
  assert.equal(framed.type, 'submit');
  // `framed.text` is what the agent's `-p` bridge hands to the model as input.
  assertRoundTrip(framed.text, block);
});

test('transport 3 — codex-rpc submit carries the block byte-exact in turn/start', async () => {
  const block = serializeAnswerBlock(ANSWER);
  const manager = new CodexRpcManager();
  const client = new CodexRpcClient({ target: TARGET, endpoint: 'ws://127.0.0.1:1', cwd: '/workspace' });
  client.threadId = 'thread-1'; // set by connect()/_openThread() in production
  client._closed = false;
  const sent = [];
  client.ws = { readyState: 1, send: (payload) => sent.push(payload) };
  manager.clients.set(TARGET, client);

  const pending = manager.submit(TARGET, block, { cwd: '/workspace' }); // server.js codex branch
  assert.equal(sent.length, 1, 'submit framed exactly one ws message');

  const frame = JSON.parse(sent[0]);
  assert.equal(frame.method, 'turn/start');
  // `params.input[0].text` is what the codex app-server delivers to the model.
  assertRoundTrip(frame.params.input[0].text, block);

  // Settle the in-flight JSON-RPC request so its promise + timeout timer clear
  // (no live app-server to answer it).
  const entry = client.pending?.get(frame.id);
  if (entry) {
    clearTimeout(entry.timer);
    entry.resolve({});
    client.pending.delete(frame.id);
  }
  await pending;
});
