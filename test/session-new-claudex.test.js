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

import { readCloudBearer, preflightClaudexModel } from '../lib/cloud-bearer.js';
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
