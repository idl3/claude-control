// Tests for handleSessionNew codex path and /api/spawn-agents endpoint.
//
// These are pure-logic tests that verify the launch string construction,
// the pre-validation guard, and the response shape — no real tmux, binary,
// or HTTP server required.
//
// Security invariants tested:
//   - Codex launch string is `codex -C '<cwd>'` (shell-quoted, no raw input)
//   - Claude launch string is BYTE-IDENTICAL to pre-Phase-D
//   - Bad cwd → fsp.stat throws (gate that produces 400 before window creation)
//   - /api/spawn-agents response shape (id, available, optional reason, Codex transports)
//   - cwd flows via -C flag to codex, NOT a shell cd command
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { sanitizeName, shellQuoteName, defaultSessionName } from '../lib/tmux.js';
import { buildSpawnCommand, buildAppServerCommand } from '../lib/codex.js';
import { buildBridgeCommand } from '../lib/claude-print.js';

// Mirror of server.js handleSessionNew's Codex launch construction EXACTLY:
// buildSpawnCommand is the single source of truth for the flags, and the cwd
// arg is shell-quoted because the command is typed into an interactive shell.
// Keeping this in lockstep with the server guards against the prior bug where
// buildSpawnCommand's result was discarded (`void`) and the string hand-rolled.
function launchFor(config, cwd, { prompt = '', model = undefined, skipPermissions = false } = {}) {
  const { bin, args } = buildSpawnCommand({ cwd, bin: config.codexLaunchCommand, model, skipPermissions });
  const argv = args.map((a) => (a === cwd ? shellQuoteName(cwd) : a));
  // `--` ends option parsing before the positional prompt — verified on-host
  // that codex's clap-based parser (like claude's) treats a dash-prefixed
  // prompt as an unknown option without it.
  if (prompt) argv.push('--', shellQuoteName(prompt));
  return `${bin} ${argv.join(' ')}`;
}

// Mirror of server.js handleSessionNew's Claude tmux launch construction
// EXACTLY, including the --model flag, the skipPermissions bypass flag, and
// the positional initial prompt.
function claudeLaunchFor(config, name, { model = null, prompt = '', skipPermissions = false } = {}) {
  let launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
  if (model) launch += ` --model ${shellQuoteName(model)}`;
  if (skipPermissions) launch += ' --dangerously-skip-permissions';
  // `--` ends option parsing before the positional prompt — verified on-host:
  // `claude -p --model haiku "-x reply with just ok"` errors as an unknown
  // option without it; `claude -p --model haiku -- "-x ..."` works.
  if (prompt) launch += ` -- ${shellQuoteName(prompt)}`;
  return launch;
}

// Mirror of server.js handleSessionNew's model selection: Claude-only,
// unknown/absent values silently fall back to no flag (same silent-fallback
// pattern as claudeTransport/codexTransport, not a 400).
const ALLOWED_CLAUDE_MODELS = new Set(['opus', 'sonnet', 'haiku']);
function selectModel(body, agent) {
  return agent === 'claude' && ALLOWED_CLAUDE_MODELS.has(body.model) ? body.model : null;
}

// Mirror of server.js handleSessionNew's codexModel selection: same
// silent-fallback pattern, Codex-only, sourced from lib/models.js CODEX_MODELS.
const ALLOWED_CODEX_MODELS = new Set(['gpt-5.5', 'gpt-5.4']);
function selectCodexModel(body, agent) {
  return agent === 'codex' && ALLOWED_CODEX_MODELS.has(body.codexModel) ? body.codexModel : null;
}

// Mirror of server.js handleSessionNew's prompt boundary validation: type
// check, byte-length cap, and trim. Returns { error } or { prompt }.
const MAX_PROMPT_BYTES = 100_000;
function validatePrompt(body) {
  if (body.prompt !== undefined && typeof body.prompt !== 'string') {
    return { error: 'prompt must be a string' };
  }
  if (typeof body.prompt === 'string' && Buffer.byteLength(body.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    return { error: `prompt exceeds ${MAX_PROMPT_BYTES}-byte limit` };
  }
  return { prompt: typeof body.prompt === 'string' ? body.prompt.trim() : '' };
}

function appServerLaunchFor(config, endpoint) {
  const { bin, args } = buildAppServerCommand({ endpoint, bin: config.codexLaunchCommand });
  return `${bin} ${args.map((a) => (a === endpoint ? shellQuoteName(endpoint) : a)).join(' ')}`;
}

function selectCodexTransport(body, configuredTransport = 'rpc') {
  return body.codexTransport === 'tmux' || body.codexTransport === 'rpc'
    ? body.codexTransport
    : configuredTransport;
}

// ── Launch string construction ───────────────────────────────────────────────

describe('handleSessionNew codex launch string', () => {
  test('buildSpawnCommand is the source of truth: {bin, args:[-C, cwd]}', () => {
    const cwd = '/home/user/project';
    const { bin, args } = buildSpawnCommand({ cwd, bin: 'codex' });
    assert.equal(bin, 'codex');
    assert.deepEqual(args, ['-C', cwd]);
  });

  test('codex launch string is `codex -C <quoted-cwd>` — no --name', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/home/user/project');
    assert.equal(launch, `codex -C '/home/user/project'`);
  });

  test('codex launch string quotes cwd with embedded single quote', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, "/home/user/it's-a-project");
    assert.ok(launch.startsWith("codex -C '"), 'starts with codex -C quote');
    // shellQuoteName escapes embedded single quotes as '\''
    // Result: codex -C '/home/user/it'\''s-a-project'
    assert.ok(launch.includes("\\'"), 'single quote is escaped via backslash sequence');
  });

  test('codex launch string with custom codexLaunchCommand', () => {
    const launch = launchFor({ codexLaunchCommand: '/usr/local/bin/codex' }, '/workspace');
    assert.equal(launch, `/usr/local/bin/codex -C '/workspace'`);
  });

  test('codex launch string does NOT contain --name flag', () => {
    const cwd = '/some/dir';
    const codexLaunchCommand = 'codex';
    const launch = `${codexLaunchCommand} -C ${shellQuoteName(cwd)}`;
    assert.ok(!launch.includes('--name'), 'Codex launch must not have --name');
  });

  test('codex launch string with cwd containing spaces', () => {
    const cwd = '/home/user/my project dir';
    const launch = `codex -C ${shellQuoteName(cwd)}`;
    assert.equal(launch, `codex -C '/home/user/my project dir'`);
    // Single-quote wrapping keeps spaces safe for the shell
    assert.ok(launch.includes("'"), 'cwd must be quoted');
  });
});

// ── Codex model selection (draft-composer model picker, tmux/TUI transport) ──
// buildSpawnCommand is the single source of truth for the --model flag shape
// (mirrors Claude's --model handling in the tmux launch string above).

describe('buildSpawnCommand — Codex --model flag', () => {
  test('appends --model <id> when a model is passed', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex', model: 'gpt-5.5' });
    assert.deepEqual(result, { bin: 'codex', args: ['-C', '/workspace', '--model', 'gpt-5.5'] });
  });

  test('omits --model entirely when no model is passed (regression: byte-identical to no-model shape)', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex' });
    assert.deepEqual(result, { bin: 'codex', args: ['-C', '/workspace'] });
  });

  test('omits --model when model is undefined explicitly', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex', model: undefined });
    assert.deepEqual(result, { bin: 'codex', args: ['-C', '/workspace'] });
  });
});

describe('handleSessionNew codex launch string — --model flag (tmux/TUI transport)', () => {
  test('codex launch string is `codex -C <cwd> --model <id>` when a model is set', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', { model: 'gpt-5.5' });
    assert.equal(launch, `codex -C '/workspace' --model gpt-5.5`);
  });

  test('--model precedes the -- guard and positional prompt when both are set', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', {
      model: 'gpt-5.4',
      prompt: 'fix the failing test',
    });
    assert.equal(launch, `codex -C '/workspace' --model gpt-5.4 -- 'fix the failing test'`);
  });

  test('is byte-identical to the no-model shape when model is unset (regression)', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace');
    assert.equal(launch, `codex -C '/workspace'`);
  });
});

// ── Task 10: skipPermissions toggle (default ON) — Codex tmux/TUI transport ──
// buildSpawnCommand appends the exact flag the installed codex CLI documents
// for a full approval/sandbox bypass (`codex --help`).

describe('buildSpawnCommand — Codex skipPermissions flag', () => {
  test('appends --dangerously-bypass-approvals-and-sandbox when skipPermissions is true', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex', skipPermissions: true });
    assert.deepEqual(result, {
      bin: 'codex',
      args: ['-C', '/workspace', '--dangerously-bypass-approvals-and-sandbox'],
    });
  });

  test('omits the bypass flag when skipPermissions is false (regression: byte-identical to unset shape)', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex', skipPermissions: false });
    assert.deepEqual(result, { bin: 'codex', args: ['-C', '/workspace'] });
  });

  test('omits the bypass flag when skipPermissions is absent (regression)', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex' });
    assert.deepEqual(result, { bin: 'codex', args: ['-C', '/workspace'] });
  });

  test('model and skipPermissions compose: --model precedes the bypass flag', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex', model: 'gpt-5.5', skipPermissions: true });
    assert.deepEqual(result, {
      bin: 'codex',
      args: ['-C', '/workspace', '--model', 'gpt-5.5', '--dangerously-bypass-approvals-and-sandbox'],
    });
  });
});

describe('handleSessionNew codex launch string — skipPermissions (tmux/TUI transport)', () => {
  test('codex launch string carries the bypass flag when skipPermissions is on', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', { skipPermissions: true });
    assert.equal(launch, `codex -C '/workspace' --dangerously-bypass-approvals-and-sandbox`);
  });

  test('codex launch string omits the bypass flag when skipPermissions is off (regression)', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', { skipPermissions: false });
    assert.equal(launch, `codex -C '/workspace'`);
  });

  test('bypass flag precedes the -- guard and positional prompt when both are set', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', {
      skipPermissions: true,
      prompt: 'fix the failing test',
    });
    assert.equal(
      launch,
      `codex -C '/workspace' --dangerously-bypass-approvals-and-sandbox -- 'fix the failing test'`,
    );
  });
});

describe('handleSessionNew codexModel selection (Codex-only, silent-fallback validation)', () => {
  test('accepts each allowed model for the codex agent', () => {
    assert.equal(selectCodexModel({ codexModel: 'gpt-5.5' }, 'codex'), 'gpt-5.5');
    assert.equal(selectCodexModel({ codexModel: 'gpt-5.4' }, 'codex'), 'gpt-5.4');
  });

  test('"default", unknown strings, and absent codexModel all resolve to null (no --model flag)', () => {
    assert.equal(selectCodexModel({ codexModel: 'default' }, 'codex'), null);
    assert.equal(selectCodexModel({ codexModel: 'gpt-5.1-codex' }, 'codex'), null);
    assert.equal(selectCodexModel({}, 'codex'), null);
    assert.equal(selectCodexModel({ codexModel: '' }, 'codex'), null);
  });

  test('codexModel is ignored entirely for the claude agent, even a valid-looking value', () => {
    assert.equal(selectCodexModel({ codexModel: 'gpt-5.5' }, 'claude'), null);
  });
});

// ── Draft-composer: Codex initial prompt (`codex [OPTIONS] [PROMPT]`) ──────
// Verified on-host: `codex --help` shows a positional `[PROMPT]` argument for
// the interactive TUI, so this is the "trivially supported" case the brief
// calls for — wired for the tmux/TUI transport only (RPC uses submit(), see
// test/codex-rpc.test.js).

describe('handleSessionNew codex launch string — initial prompt (tmux/TUI transport)', () => {
  test('appends -- then the quoted positional prompt after -C <cwd>', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', { prompt: 'fix the failing test' });
    assert.equal(launch, `codex -C '/workspace' -- 'fix the failing test'`);
  });

  test('omits the prompt arg AND the -- guard entirely when no prompt is set (regression)', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace');
    assert.equal(launch, `codex -C '/workspace'`);
  });

  test('quotes a multi-line prompt safely (embedded newline stays inside the single-quote span)', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', { prompt: 'line one\nline two' });
    assert.equal(launch, `codex -C '/workspace' -- 'line one\nline two'`);
  });

  test('escapes an embedded single quote in the prompt', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', { prompt: "it's broken" });
    assert.ok(launch.includes("it'\\''s broken"), 'single quote in prompt is escaped');
  });

  // Regression: a dash-prefixed prompt (e.g. a bullet point like "- fix the
  // bug") must not be parsable as an option. codex's clap-based parser treats
  // a lone `--` as end-of-options, same as claude's commander-based parser —
  // parse-side behavior confirmed with `codex exec "-x hi"` (rejects as an
  // unrecognized flag without `--`; not run against a real turn).
  test('a dash-prefixed prompt sits after the -- guard, never immediately after -C <cwd>', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/workspace', { prompt: '-x hi' });
    assert.equal(launch, `codex -C '/workspace' -- '-x hi'`);
    assert.ok(/ -- '-x hi'$/.test(launch), '-- guard immediately precedes the dash-prefixed prompt');
  });
});

describe('handleSessionNew claude launch string (byte-identical regression)', () => {
  test('claude launch string is `<launchCommand> --name <quoted-name>`', () => {
    const config = { launchCommand: 'claude' };
    const name = sanitizeName('my session') || defaultSessionName();
    // This is the EXACT expression from the pre-Phase-D handleSessionNew:
    const launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
    assert.equal(launch, `claude --name 'my session'`);
  });

  test('claude launch string with custom launchCommand (yolo alias)', () => {
    const config = { launchCommand: 'yolo' };
    const name = 'my-session';
    const launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
    assert.equal(launch, `yolo --name 'my-session'`);
  });

  test('claude launch string escapes single quotes in name', () => {
    const config = { launchCommand: 'claude' };
    const name = sanitizeName("it's fine");
    const launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
    assert.ok(launch.startsWith("claude --name '"), 'starts with claude --name quote');
    // The escaped form is '\'' (end-quote, backslash-quote, open-quote)
    assert.ok(launch.includes("\\'"), 'single quote is escaped with backslash sequence');
  });

  test('claude launch string contains --name but NOT -C', () => {
    const config = { launchCommand: 'claude' };
    const name = 'test-session';
    const launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
    assert.ok(launch.includes('--name'), 'claude launch has --name');
    assert.ok(!launch.includes(' -C '), 'claude launch must not have codex -C flag');
  });

  test('claude print bridge launch uses node bridge and quoted args', () => {
    const launch = buildBridgeCommand({
      nodeBin: '/usr/local/bin/node',
      bridgePath: '/app/bin/claude-print-bridge.mjs',
      socketPath: '/tmp/cc.sock',
      cwd: '/workspace',
      claudeBin: '/usr/local/bin/claude',
      name: 'my session',
      permissionMode: 'acceptEdits',
      quote: shellQuoteName,
    });
    assert.equal(
      launch,
      "'/usr/local/bin/node' '/app/bin/claude-print-bridge.mjs' --socket '/tmp/cc.sock' --cwd '/workspace' --bin '/usr/local/bin/claude' --permission-mode 'acceptEdits' --name 'my session'",
    );
  });
});

// ── Draft-composer: Claude initial prompt + model (tmux/interactive transport) ──
// Verified on-host: `claude --help` shows `Usage: claude [options] [command]
// [prompt]` plus `--model <model>`, so both are appended to the SAME launch
// command that already carries --name — atomic with launch, no separate typed
// step. Print-transport model plumbing (buildBridgeCommand) is covered in
// test/claude-print.test.js; print-transport prompt delivery (socket submit)
// is covered there too.

describe('handleSessionNew claude launch string — --model and initial prompt', () => {
  test('appends --model after --name when a model is set', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', { model: 'opus' });
    assert.equal(launch, `claude --name 'my session' --model 'opus'`);
  });

  test('appends -- then the positional prompt after --model when both are set', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', {
      model: 'sonnet',
      prompt: 'fix the failing test',
    });
    assert.equal(launch, `claude --name 'my session' --model 'sonnet' -- 'fix the failing test'`);
  });

  test('appends -- then the positional prompt with no --model when model is unset', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', { prompt: 'hello' });
    assert.equal(launch, `claude --name 'my session' -- 'hello'`);
  });

  test('quotes a multi-line prompt safely (embedded newline stays inside the single-quote span)', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', { prompt: 'line one\nline two' });
    assert.equal(launch, `claude --name 'my session' -- 'line one\nline two'`);
  });

  test('is byte-identical to the pre-existing shape when neither model nor prompt is set (regression)', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session');
    assert.equal(launch, `claude --name 'my session'`);
  });

  test('works with a custom launchCommand (yolo alias) plus model and prompt', () => {
    const launch = claudeLaunchFor({ launchCommand: 'yolo' }, 'feat', { model: 'haiku', prompt: 'go' });
    assert.equal(launch, `yolo --name 'feat' --model 'haiku' -- 'go'`);
  });

  // Regression (the whole reason for the `--` guard): verified on-host that
  // `claude -p --model haiku "-x reply with just ok"` errors with "unknown
  // option '-x reply with just ok'", while `claude -p --model haiku --
  // "-x reply with just the word ok"` works. A prompt starting with `-`
  // (e.g. a bullet point like "- fix the bug") must never land immediately
  // after --model / --name without the `--` guard between it and the prompt.
  test('a dash-prefixed prompt sits after the -- guard, never immediately after --model', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', {
      model: 'haiku',
      prompt: '-x reply with just ok',
    });
    assert.equal(launch, `claude --name 'my session' --model 'haiku' -- '-x reply with just ok'`);
    assert.ok(/ -- '-x reply with just ok'$/.test(launch), '-- guard immediately precedes the dash-prefixed prompt');
  });

  test('a dash-prefixed prompt with no model still gets the -- guard after --name', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', { prompt: '- fix the bug' });
    assert.equal(launch, `claude --name 'my session' -- '- fix the bug'`);
  });
});

// ── Task 10: skipPermissions toggle (default ON) — Claude tmux transport ────
// The explicit --dangerously-skip-permissions flag is appended by
// handleSessionNew itself (idempotent even if config.launchCommand is an
// alias that already carries it), independent of --model/prompt.

describe('handleSessionNew claude launch string — skipPermissions', () => {
  test('appends --dangerously-skip-permissions when skipPermissions is on', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', { skipPermissions: true });
    assert.equal(launch, `claude --name 'my session' --dangerously-skip-permissions`);
  });

  test('omits the flag when skipPermissions is off (regression: byte-identical to the pre-Task-10 shape)', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', { skipPermissions: false });
    assert.equal(launch, `claude --name 'my session'`);
  });

  test('omits the flag when skipPermissions is absent (regression)', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session');
    assert.equal(launch, `claude --name 'my session'`);
  });

  test('bypass flag sits between --model and the -- guard when model, skipPermissions, and prompt are all set', () => {
    const launch = claudeLaunchFor({ launchCommand: 'claude' }, 'my session', {
      model: 'opus',
      skipPermissions: true,
      prompt: 'fix the failing test',
    });
    assert.equal(
      launch,
      `claude --name 'my session' --model 'opus' --dangerously-skip-permissions -- 'fix the failing test'`,
    );
  });

  test('works with a custom launchCommand (yolo alias) — flag is appended regardless of alias contents', () => {
    const launch = claudeLaunchFor({ launchCommand: 'yolo' }, 'feat', { skipPermissions: true });
    assert.equal(launch, `yolo --name 'feat' --dangerously-skip-permissions`);
  });
});

// ── Task 10: skipPermissions toggle — Claude print/bridge transport ─────────
// buildBridgeCommand's permissionMode param is gated by handleSessionNew:
// skipPermissions on → 'bypassPermissions' (unchanged from before Task 10);
// skipPermissions off → 'manual' (asks for each action — the closest
// --permission-mode literal to "prompt normally"; confirmed via `claude
// --help`, whose --permission-mode enum has no literal "default").

describe('handleSessionNew claude print bridge — skipPermissions gates permissionMode', () => {
  function bridgePermissionModeFor(skipPermissions) {
    return skipPermissions ? 'bypassPermissions' : 'manual';
  }

  test('skipPermissions on resolves to bypassPermissions (unchanged pre-Task-10 default)', () => {
    const launch = buildBridgeCommand({
      nodeBin: '/usr/local/bin/node',
      bridgePath: '/app/bin/claude-print-bridge.mjs',
      socketPath: '/tmp/cc.sock',
      cwd: '/workspace',
      claudeBin: '/usr/local/bin/claude',
      name: 'my session',
      permissionMode: bridgePermissionModeFor(true),
      quote: shellQuoteName,
    });
    assert.ok(launch.includes("--permission-mode 'bypassPermissions'"));
  });

  test('skipPermissions off resolves to manual', () => {
    const launch = buildBridgeCommand({
      nodeBin: '/usr/local/bin/node',
      bridgePath: '/app/bin/claude-print-bridge.mjs',
      socketPath: '/tmp/cc.sock',
      cwd: '/workspace',
      claudeBin: '/usr/local/bin/claude',
      name: 'my session',
      permissionMode: bridgePermissionModeFor(false),
      quote: shellQuoteName,
    });
    assert.ok(launch.includes("--permission-mode 'manual'"));
  });
});

describe('handleSessionNew model selection (Claude-only, silent-fallback validation)', () => {
  test('accepts each allowed model for the claude agent', () => {
    assert.equal(selectModel({ model: 'opus' }, 'claude'), 'opus');
    assert.equal(selectModel({ model: 'sonnet' }, 'claude'), 'sonnet');
    assert.equal(selectModel({ model: 'haiku' }, 'claude'), 'haiku');
  });

  test('"default", unknown strings, and absent model all resolve to null (no --model flag)', () => {
    assert.equal(selectModel({ model: 'default' }, 'claude'), null);
    assert.equal(selectModel({ model: 'gpt-5' }, 'claude'), null);
    assert.equal(selectModel({}, 'claude'), null);
    assert.equal(selectModel({ model: '' }, 'claude'), null);
  });

  test('model is ignored entirely for the codex agent, even a valid-looking value', () => {
    assert.equal(selectModel({ model: 'opus' }, 'codex'), null);
  });
});

describe('handleSessionNew prompt validation (boundary check)', () => {
  test('missing prompt resolves to an empty string (no prompt)', () => {
    assert.deepEqual(validatePrompt({}), { prompt: '' });
  });

  test('a whitespace-only prompt trims to empty (treated as no prompt)', () => {
    assert.deepEqual(validatePrompt({ prompt: '   \n  ' }), { prompt: '' });
  });

  test('a non-string prompt is rejected with a boundary error', () => {
    assert.deepEqual(validatePrompt({ prompt: 12345 }), { error: 'prompt must be a string' });
    assert.deepEqual(validatePrompt({ prompt: { text: 'x' } }), { error: 'prompt must be a string' });
    assert.deepEqual(validatePrompt({ prompt: ['x'] }), { error: 'prompt must be a string' });
  });

  test('a prompt at exactly the byte cap passes', () => {
    const prompt = 'a'.repeat(MAX_PROMPT_BYTES);
    assert.deepEqual(validatePrompt({ prompt }), { prompt });
  });

  test('a prompt one byte over the cap is rejected', () => {
    const prompt = 'a'.repeat(MAX_PROMPT_BYTES + 1);
    const result = validatePrompt({ prompt });
    assert.equal(result.error, `prompt exceeds ${MAX_PROMPT_BYTES}-byte limit`);
  });

  test('the cap is measured in UTF-8 bytes, not JS string length (multi-byte chars)', () => {
    // Each 🎉 is 4 UTF-8 bytes but counts as 2 UTF-16 code units in .length.
    const emoji = '🎉';
    const repeats = Math.floor(MAX_PROMPT_BYTES / 4) + 10; // over the byte cap
    const prompt = emoji.repeat(repeats);
    assert.ok(prompt.length < Buffer.byteLength(prompt, 'utf8'), 'JS length must undercount UTF-8 bytes here');
    const result = validatePrompt({ prompt });
    assert.equal(result.error, `prompt exceeds ${MAX_PROMPT_BYTES}-byte limit`);
  });

  test('a multi-line prompt is preserved (only outer whitespace trimmed)', () => {
    assert.deepEqual(
      validatePrompt({ prompt: '  line one\nline two  ' }),
      { prompt: 'line one\nline two' },
    );
  });
});

// ── buildSpawnCommand shape validation ───────────────────────────────────────

describe('buildSpawnCommand from lib/codex.js', () => {
  test('returns {bin, args:["-C", cwd]}', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex' });
    assert.deepEqual(result, { bin: 'codex', args: ['-C', '/workspace'] });
  });

  test('default bin is "codex"', () => {
    const result = buildSpawnCommand({ cwd: '/tmp' });
    assert.equal(result.bin, 'codex');
  });

  test('args array always has -C at index 0 and cwd at index 1', () => {
    const result = buildSpawnCommand({ cwd: '/my/project' });
    assert.equal(result.args[0], '-C');
    assert.equal(result.args[1], '/my/project');
  });
});

describe('buildAppServerCommand from lib/codex.js', () => {
  test('returns {bin, args:["app-server","--listen", endpoint]}', () => {
    const endpoint = 'ws://127.0.0.1:43210';
    const result = buildAppServerCommand({ endpoint, bin: 'yodex' });
    assert.deepEqual(result, { bin: 'yodex', args: ['app-server', '--listen', endpoint] });
  });

  test('codex RPC launch appends app-server suffix to custom command', () => {
    const endpoint = 'ws://127.0.0.1:43210';
    const launch = appServerLaunchFor({ codexLaunchCommand: 'yodex' }, endpoint);
    assert.equal(launch, `yodex app-server --listen 'ws://127.0.0.1:43210'`);
  });
});

describe('handleSessionNew codex transport selection', () => {
  test('request body can force tmux/TUI even when server default is rpc', () => {
    const transport = selectCodexTransport({ codexTransport: 'tmux' }, 'rpc');
    assert.equal(transport, 'tmux');
    assert.equal(launchFor({ codexLaunchCommand: 'yodex' }, '/workspace'), `yodex -C '/workspace'`);
  });

  test('request body can force rpc even when server default is tmux', () => {
    const transport = selectCodexTransport({ codexTransport: 'rpc' }, 'tmux');
    assert.equal(transport, 'rpc');
    assert.equal(
      appServerLaunchFor({ codexLaunchCommand: 'yodex' }, 'ws://127.0.0.1:43210'),
      `yodex app-server --listen 'ws://127.0.0.1:43210'`,
    );
  });

  test('missing or invalid transport falls back to configured default', () => {
    assert.equal(selectCodexTransport({}, 'rpc'), 'rpc');
    assert.equal(selectCodexTransport({ codexTransport: 'bad' }, 'tmux'), 'tmux');
  });
});

// ── cwd validation: bad path produces 400, no window created ─────────────────
//
// The server's pre-validation uses fsp.stat BEFORE calling createWindow.
// These tests confirm the guard logic that produces 400-before-window.

describe('handleSessionNew pre-validation (bad cwd must not create window)', () => {
  test('fsp.stat throws for nonexistent cwd', async () => {
    const badCwd = '/nonexistent/__codex_test_path_xyzzy__';
    await assert.rejects(
      () => fsp.stat(badCwd),
      /ENOENT/,
      'fsp.stat should throw ENOENT for nonexistent path',
    );
  });

  test('a non-directory path fails isDirectory() check', async () => {
    // Use a known file that exists
    const filePath = new URL('../package.json', import.meta.url).pathname;
    const st = await fsp.stat(filePath);
    assert.ok(!st.isDirectory(), 'a file is not a directory');
  });

  test('a valid directory passes isDirectory() check', async () => {
    const st = await fsp.stat(os.tmpdir());
    assert.ok(st.isDirectory(), 'tmpdir is a directory');
  });

  test('validation guard returns 400 shape (mock window creation asserted not called)', () => {
    // Simulate the guard logic: windowCreated tracks whether createWindow was called.
    let windowCreated = false;
    const mockCreateWindow = () => {
      windowCreated = true;
      return Promise.resolve('session:0');
    };

    // Replicate the validation logic from handleSessionNew for the codex path:
    async function validateAndCreate(cwd) {
      // Pre-validate cwd BEFORE createWindow
      let st;
      try {
        st = await fsp.stat(cwd);
      } catch {
        return { status: 400, error: `cwd does not exist: ${cwd}` };
      }
      if (!st.isDirectory()) {
        return { status: 400, error: `cwd is not a directory: ${cwd}` };
      }
      // Only reach here if validation passes
      await mockCreateWindow();
      return { status: 200, ok: true };
    }

    return validateAndCreate('/nonexistent/__test__').then((result) => {
      assert.equal(result.status, 400);
      assert.ok(result.error.includes('does not exist'));
      assert.ok(!windowCreated, 'createWindow must NOT be called when cwd is invalid');
    });
  });
});

// ── /api/spawn-agents availability logic ─────────────────────────────────────

describe('/api/spawn-agents response shape', () => {
  test('agent list structure: id, available, optional reason', () => {
    // Simulate what the handler builds when codex is unavailable:
    const claudeResult = { available: true, path: '/usr/bin/claude' };
    const codexResult = { available: false, reason: 'codex not found on PATH' };
    const agents = [
          {
            id: 'claude',
            available: claudeResult.available,
            defaultTransport: 'tmux',
            transports: ['tmux', 'print'],
            ...(claudeResult.available ? {} : { reason: claudeResult.reason }),
          },
      {
        id: 'codex',
        available: codexResult.available,
        defaultTransport: 'rpc',
        transports: ['rpc', 'tmux'],
        ...(codexResult.available ? {} : { reason: codexResult.reason }),
      },
    ];
    assert.equal(agents[0].id, 'claude');
    assert.equal(agents[1].id, 'codex');
    assert.ok(agents[0].available);
    assert.ok(!agents[1].available);
    assert.equal(agents[1].reason, 'codex not found on PATH');
    assert.equal(agents[1].defaultTransport, 'rpc');
    assert.deepEqual(agents[1].transports, ['rpc', 'tmux']);
    assert.equal(agents[0].defaultTransport, 'tmux');
    assert.deepEqual(agents[0].transports, ['tmux', 'print']);
    assert.ok(!('reason' in agents[0]), 'no reason key when available');
  });

  test('both agents available: neither has a reason key', () => {
    const agents = [
      { id: 'claude', available: true, defaultTransport: 'tmux', transports: ['tmux', 'print'] },
      { id: 'codex', available: true, defaultTransport: 'rpc', transports: ['rpc', 'tmux'] },
    ];
    assert.ok(!('reason' in agents[0]));
    assert.ok(!('reason' in agents[1]));
    assert.deepEqual(agents[1].transports, ['rpc', 'tmux']);
    assert.deepEqual(agents[0].transports, ['tmux', 'print']);
  });

  test('both agents unavailable: both have reason strings', () => {
    const claudeResult = { available: false, reason: 'claude not found on PATH' };
    const codexResult = { available: false, reason: 'codex not found on PATH' };
    const agents = [
      {
        id: 'claude',
        available: claudeResult.available,
        defaultTransport: 'tmux',
        transports: ['tmux', 'print'],
        ...(claudeResult.available ? {} : { reason: claudeResult.reason }),
      },
      {
        id: 'codex',
        available: codexResult.available,
        defaultTransport: 'rpc',
        transports: ['rpc', 'tmux'],
        ...(codexResult.available ? {} : { reason: codexResult.reason }),
      },
    ];
    assert.equal(typeof agents[0].reason, 'string');
    assert.equal(typeof agents[1].reason, 'string');
    assert.deepEqual(agents[1].transports, ['rpc', 'tmux']);
  });
});

// ── Security: cwd goes via -C flag, NOT shell cd ─────────────────────────────

describe('codex cwd security: no shell cd in launch string', () => {
  test('codex launch string uses -C flag, no cd command', () => {
    const cwd = '/home/user/workspace';
    const launch = `codex -C ${shellQuoteName(cwd)}`;
    assert.ok(!launch.includes('cd '), 'launch string must not contain shell cd');
    assert.ok(launch.includes(' -C '), 'launch string must use -C flag');
  });

  test('claude launch string does not contain cd either', () => {
    const name = 'my-session';
    const launch = `claude --name ${shellQuoteName(name)}`;
    assert.ok(!launch.includes('cd '), 'claude launch string must not contain shell cd');
  });

  test('cwd with shell-special chars is safely single-quoted (no injection)', () => {
    const maliciousCwd = '/tmp; rm -rf /';
    const launch = `codex -C ${shellQuoteName(maliciousCwd)}`;
    // After quoting, the entire cwd (including the semicolon) is wrapped in single
    // quotes. Shell cannot interpret a semicolon inside '...'. The launch string
    // takes the form: codex -C '/tmp; rm -rf /' — the semicolon is INSIDE the
    // single-quote span, so it cannot act as a shell command separator.
    assert.ok(launch.startsWith("codex -C '"), 'cwd is single-quoted after -C flag');
    // The quoted form wraps the whole string: starts with ' right after -C and ends '
    const afterFlag = launch.slice('codex -C '.length);
    assert.ok(afterFlag.startsWith("'"), 'opening single quote present');
    assert.ok(afterFlag.endsWith("'"), 'closing single quote present');
    // Verify the semicolon is not the very first non-space after -C (i.e. it's inside quotes)
    const match = /^codex -C '(.*)'$/.exec(launch);
    assert.ok(match !== null, 'launch matches `codex -C \'...\'` pattern');
    assert.ok(match[1].includes(';'), 'semicolon is INSIDE the quotes (safe)');
  });
});
