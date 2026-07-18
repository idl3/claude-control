// Tests for the Claudex spawn path (claudex-integration Phase B, task B4).
//
// Pure-logic per house convention (create-session-codex.test.js): the real
// lib/cloud-bearer.js module is exercised directly with test seams; the
// server.js launch construction is mirrored EXACTLY (single source of truth
// comments in server.js point back here).
//
// Security invariants tested:
//   - The composed base URL (carrying the bearer secret) NEVER appears in the
//     launch string (it rides tmux -e only) — design T3.
//   - Preflight failure reasons never contain the secret.
//   - Fail-closed: missing artifact / unserved model / unreachable worker all
//     refuse the spawn (no silent Anthropic fallback) — design T2.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCloudBearer, preflightClaudexModel, resolveClaudexBaseUrl } from '../lib/cloud-bearer.js';
import { shellQuoteName } from '../lib/tmux.js';

function tmpBearerFile(contents) {
  const p = path.join(os.tmpdir(), `cc-bearer-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return p;
}

describe('readCloudBearer', () => {
  test('valid artifact → percent-encoded path-bearer base URL', () => {
    const p = tmpBearerFile({ authHost: 'auth-worker.example.co', sub: 'op+1', secret: 'se/kret=x' });
    const b = readCloudBearer({ _path: p });
    assert.ok(b);
    assert.equal(b.baseUrl, 'https://auth-worker.example.co/auth/op%2B1/se%2Fkret%3Dx');
  });

  test('authHost with scheme is preserved; trailing slash trimmed', () => {
    const p = tmpBearerFile({ authHost: 'http://localhost:9999/', sub: 's', secret: 'k' });
    assert.equal(readCloudBearer({ _path: p }).baseUrl, 'http://localhost:9999/auth/s/k');
  });

  test('missing file / bad JSON / missing or empty fields → null (fail closed)', () => {
    assert.equal(readCloudBearer({ _path: '/nonexistent/cloud-bearer.json' }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile('not json{') }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ sub: 's', secret: 'k' }) }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ authHost: 'h', sub: '', secret: 'k' }) }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile([1, 2]) }), null);
  });

  // CP3 Fix 6 (LOW): authHost hardening — reject whitespace/control chars.
  test('authHost containing whitespace or control chars → null (fail closed)', () => {
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ authHost: 'evil host', sub: 's', secret: 'k' }) }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ authHost: 'evil\thost', sub: 's', secret: 'k' }) }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ authHost: 'evil\nhost', sub: 's', secret: 'k' }) }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ authHost: 'evil\rhost', sub: 's', secret: 'k' }) }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ authHost: 'evil\x01host', sub: 's', secret: 'k' }) }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ authHost: 'evil\x7fhost', sub: 's', secret: 'k' }) }), null);
    assert.equal(readCloudBearer({ _path: tmpBearerFile({ authHost: 'trailing-space ', sub: 's', secret: 'k' }) }), null);
    // A normal hostname (with scheme + port) still passes.
    assert.ok(readCloudBearer({ _path: tmpBearerFile({ authHost: 'http://localhost:9999', sub: 's', secret: 'k' }) }));
  });
});

describe('resolveClaudexBaseUrl — direnv-first, artifact fallback', () => {
  const artifact = () => ({ authHost: 'h', sub: 's', secret: 'k', baseUrl: 'https://h/auth/s/k' });

  test('direnv-provided URL wins (per-org routing) and is shape-guarded', async () => {
    const r = await resolveClaudexBaseUrl('/some/org/dir', {
      _exec: async () => ({ stdout: 'https://auth-worker.pleri.com/auth/op/sek\n', stderr: '' }),
      _readBearer: artifact,
    });
    assert.deepEqual(r, { baseUrl: 'https://auth-worker.pleri.com/auth/op/sek', source: 'direnv' });
  });

  test('empty / malformed / whitespace direnv output falls through to the artifact', async () => {
    for (const stdout of ['', '   ', 'not-a-url', 'https://h /auth/x', 'ftp://nope']) {
      const r = await resolveClaudexBaseUrl('/d', {
        _exec: async () => ({ stdout, stderr: '' }),
        _readBearer: artifact,
      });
      assert.deepEqual(r, { baseUrl: 'https://h/auth/s/k', source: 'cloud-bearer' }, JSON.stringify(stdout));
    }
  });

  test('direnv exec failure (binary absent / cwd not allowed) falls through; both absent → null', async () => {
    const boom = async () => { throw new Error('direnv: command not found'); };
    const r = await resolveClaudexBaseUrl('/d', { _exec: boom, _readBearer: artifact });
    assert.equal(r.source, 'cloud-bearer');
    const none = await resolveClaudexBaseUrl('/d', { _exec: boom, _readBearer: () => null });
    assert.equal(none, null);
  });

  test('trailing slash trimmed on the direnv source', async () => {
    const r = await resolveClaudexBaseUrl('/d', {
      _exec: async () => ({ stdout: 'https://h/auth/a/b///', stderr: '' }),
      _readBearer: () => null,
    });
    assert.equal(r.baseUrl, 'https://h/auth/a/b');
  });
});

describe('preflightClaudexModel', () => {
  const BASE = 'https://h/auth/op/sekret42';
  const LISTING = { data: [{ id: 'gpt-5.6-sol', aliases: ['codex', 'gpt-5.6'] }] };
  const okFetch = async () => new Response(JSON.stringify(LISTING), { status: 200 });

  test('served id and served alias both pass', async () => {
    assert.equal((await preflightClaudexModel(BASE, 'gpt-5.6-sol', { _fetch: okFetch })).ok, true);
    assert.equal((await preflightClaudexModel(BASE, 'codex', { _fetch: okFetch })).ok, true);
  });

  test('unserved model → fail with served list; reason carries no secret', async () => {
    const r = await preflightClaudexModel(BASE, 'gpt-9-nope', { _fetch: okFetch });
    assert.equal(r.ok, false);
    assert.ok(r.served.includes('gpt-5.6-sol'));
    assert.ok(!r.reason.includes('sekret42'));
  });

  test('non-200 / non-JSON / network error → fail closed, secret never leaked', async () => {
    for (const f of [
      async () => new Response('nope', { status: 503 }),
      async () => new Response('not json{', { status: 200 }),
      async () => { throw new TypeError('fetch failed'); },
    ]) {
      const r = await preflightClaudexModel(BASE, 'gpt-5.6-sol', { _fetch: f });
      assert.equal(r.ok, false);
      assert.ok(!r.reason.includes('sekret42'), r.reason);
    }
  });
});

// Mirror of server.js handleSessionNew's claudex launch construction EXACTLY:
// the claude tmux shape with the claudex model flag; the base URL rides the
// tmux -e env option and MUST NOT appear in the typed launch string.
function claudexLaunchFor(config, name, claudexModel, { prompt = '', skipPermissions = false } = {}) {
  let launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
  if (claudexModel) launch += ` --model ${shellQuoteName(claudexModel)}`;
  if (skipPermissions) launch += ' --dangerously-skip-permissions';
  if (prompt) launch += ` -- ${shellQuoteName(prompt)}`;
  return launch;
}

describe('claudex launch construction (server.js mirror)', () => {
  test('launch carries --model but never the base URL / secret', () => {
    const launch = claudexLaunchFor({ launchCommand: 'claude' }, 'my-sess', 'gpt-5.6-sol', {
      skipPermissions: true,
      prompt: 'hello',
    });
    assert.equal(
      launch,
      "claude --name 'my-sess' --model 'gpt-5.6-sol' --dangerously-skip-permissions -- 'hello'",
    );
    assert.ok(!launch.includes('/auth/'));
    assert.ok(!launch.includes('ANTHROPIC_BASE_URL'));
  });

  test('claudex env is exactly { ANTHROPIC_BASE_URL: <baseUrl> } (server.js mirror)', () => {
    const p = tmpBearerFile({ authHost: 'h.example', sub: 'op', secret: 'sek' });
    const bearer = readCloudBearer({ _path: p });
    const claudexEnv = { ANTHROPIC_BASE_URL: bearer.baseUrl };
    assert.deepEqual(Object.keys(claudexEnv), ['ANTHROPIC_BASE_URL']);
    assert.equal(claudexEnv.ANTHROPIC_BASE_URL, 'https://h.example/auth/op/sek');
  });
});

// CP3 Fix 5 (HIGH): claudex must NEVER take the print-transport bridge path.
//
// Mirror of server.js handleSessionNew's claudeTransport computation
// (~:1218): with a host running CLAUDE_TRANSPORT=print (or a body override),
// `agent === 'claudex'` short-circuits to 'tmux' BEFORE the print/tmux
// branch selection — so the `else if (claudeTransport === 'print')` branch
// (which has no agent guard of its own) is structurally unreachable for
// claudex. Without this, claudex would lose its preflighted model (the
// print bridge only knows `model`, which is null for claudex) and mislabel
// the pane (@cc_agent hardcoded to 'claude' in that branch).
function claudeTransportFor(agent, requestedTransport, configDefault) {
  if (agent === 'claudex') return 'tmux';
  return requestedTransport === 'print' || requestedTransport === 'tmux'
    ? requestedTransport
    : configDefault;
}

describe('claudeTransport forcing for claudex (server.js mirror)', () => {
  test('claudex always forces tmux, even when body/config both request print', () => {
    assert.equal(claudeTransportFor('claudex', 'print', 'print'), 'tmux');
    assert.equal(claudeTransportFor('claudex', undefined, 'print'), 'tmux');
    assert.equal(claudeTransportFor('claudex', 'tmux', 'tmux'), 'tmux');
  });

  test('claude/codex transport selection is unaffected by the claudex force', () => {
    assert.equal(claudeTransportFor('claude', 'print', 'tmux'), 'print');
    assert.equal(claudeTransportFor('claude', undefined, 'print'), 'print');
    assert.equal(claudeTransportFor('claude', undefined, 'tmux'), 'tmux');
    assert.equal(claudeTransportFor('codex', undefined, 'print'), 'print');
  });
});

// CP3 Fix 2 (MEDIUM): GET /api/spawn-agents claudex entry, mirroring
// server.js's ~:573-627 handler EXACTLY. Availability = claude binary
// available AND readCloudBearer() !== null AND tmux >= 3.2 — checked in that
// order, short-circuiting, so `reason` always names the FIRST failing
// precondition (never a later-stage one masking an earlier real cause).
function claudexSpawnEntryFor(claudeResult, bearerPresent, tmuxError) {
  let available = claudeResult.available;
  let reason = claudeResult.reason;
  if (available && !bearerPresent) {
    available = false;
    reason = "claudex requires ~/.olam/cloud-bearer.json — run 'olam auth login' to provision it";
  }
  if (available && tmuxError) {
    available = false;
    reason = tmuxError;
  }
  return {
    id: 'claudex',
    available,
    defaultTransport: 'tmux',
    transports: ['tmux'],
    ...(available ? {} : { reason }),
  };
}

describe('/api/spawn-agents claudex entry (server.js mirror)', () => {
  test('all three preconditions pass → available, no reason field', () => {
    const entry = claudexSpawnEntryFor({ available: true }, true, null);
    assert.equal(entry.available, true);
    assert.equal(entry.defaultTransport, 'tmux');
    assert.deepEqual(entry.transports, ['tmux']);
    assert.ok(!('reason' in entry));
  });

  test('claude binary unavailable → claudex unavailable, reason is the claude-binary reason (first precondition)', () => {
    const entry = claudexSpawnEntryFor(
      { available: false, reason: 'claude missing' },
      true, // bearer present — must NOT override the earlier failure
      null,
    );
    assert.equal(entry.available, false);
    assert.equal(entry.reason, 'claude missing');
  });

  test('claude available, bearer missing → claudex unavailable, reason names the bearer artifact (second precondition)', () => {
    const entry = claudexSpawnEntryFor({ available: true }, false, null);
    assert.equal(entry.available, false);
    assert.match(entry.reason, /cloud-bearer\.json/);
    assert.match(entry.reason, /olam auth login/);
  });

  test('claude available, bearer present, tmux too old → claudex unavailable, reason is the tmux version message (third precondition)', () => {
    const entry = claudexSpawnEntryFor(
      { available: true },
      true,
      'tmux >= 3.2 required for claudex env injection (new-session -e); found 3.1 — brew upgrade tmux',
    );
    assert.equal(entry.available, false);
    assert.match(entry.reason, /tmux >= 3\.2/);
  });

  test('claude unavailable AND bearer missing → reason stays the FIRST failing precondition (claude), never overwritten by the bearer check', () => {
    const entry = claudexSpawnEntryFor({ available: false, reason: 'claude missing' }, false, null);
    assert.equal(entry.reason, 'claude missing');
  });
});
