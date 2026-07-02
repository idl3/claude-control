import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OlamHealthProbe, classifyFailure } from '../lib/olam-health.js';
import { NoAccessSession } from '../lib/olam-client.js';

function clientStub({ runner = async () => ({}), list = async () => [] } = {}) {
  return {
    cfg: { spaBase: 'https://spa.test' },
    runnerStatus: runner,
    listSessions: list,
  };
}

const jsonRes = (status, body) => ({ ok: status < 300, status, json: async () => body });

// --- classification ------------------------------------------------------------

test('classifyFailure: 401/403 → auth red; NoAccessSession → login red; else transient amber', () => {
  assert.deepEqual(classifyFailure(new Error('[atlas] runner status HTTP 401 (x)')), { class: 'auth', status: 'red' });
  assert.deepEqual(classifyFailure(new Error('list HTTP 403')), { class: 'auth', status: 'red' });
  assert.equal(classifyFailure(new NoAccessSession('https://spa.test')).class, 'login');
  assert.deepEqual(classifyFailure(new Error('HTTP 502')), { class: 'transient', status: 'amber' });
  assert.deepEqual(classifyFailure(new Error('fetch failed')), { class: 'transient', status: 'amber' });
});

// --- probe outcomes -------------------------------------------------------------

test('all green when every surface answers', async () => {
  const p = new OlamHealthProbe(clientStub(), {
    brainUrl: 'https://brain.test',
    fetchImpl: async () => jsonRes(200, { install_present: true }),
  });
  const s = await p.probe();
  assert.equal(s.status, 'green');
  assert.equal(s.checks.brain.status, 'green');
});

test('auth failure → red with rotation-shaped reason', async () => {
  const p = new OlamHealthProbe(
    clientStub({ runner: async () => { throw new Error('HTTP 401'); } }),
    { brainUrl: null },
  );
  const s = await p.probe();
  assert.equal(s.status, 'red');
  assert.match(s.reason, /rotated/);
});

test('missing Access session → red with actionable login command', async () => {
  const p = new OlamHealthProbe(
    clientStub({ list: async () => { throw new NoAccessSession('https://spa.test'); } }),
  );
  const s = await p.probe();
  assert.equal(s.status, 'red');
  assert.match(s.reason, /cloudflared access login https:\/\/spa\.test/);
});

test('timeout/5xx → amber transient, not red', async () => {
  const p = new OlamHealthProbe(
    clientStub({ runner: async () => { throw new Error('HTTP 503'); } }),
  );
  const s = await p.probe();
  assert.equal(s.status, 'amber');
});

test('brain install_present:false → red "Linear app install missing"', async () => {
  const p = new OlamHealthProbe(clientStub(), {
    brainUrl: 'https://brain.test',
    fetchImpl: async () => jsonRes(200, { install_present: false }),
  });
  const s = await p.probe();
  assert.equal(s.status, 'red');
  assert.match(s.reason, /Linear app install missing/);
});

test('brainUrl absent → brain check skipped, org can still be green', async () => {
  const p = new OlamHealthProbe(clientStub());
  const s = await p.probe();
  assert.equal(s.status, 'green');
  assert.equal(s.checks.brain.status, 'skipped');
});

// --- 3-strikes halt --------------------------------------------------------------

test('3 auth strikes in 60s halt probing until reset()', async () => {
  let t = 0;
  const p = new OlamHealthProbe(
    clientStub({ runner: async () => { throw new Error('HTTP 401'); } }),
    { now: () => t },
  );
  await p.probe(); t += 1000;
  await p.probe(); t += 1000;
  await p.probe(); // 3rd strike inside 60s
  assert.equal(p.halted, true);
  const frozen = await p.probe();
  assert.equal(frozen.halted, true);
  assert.match(frozen.reason, /halted until manual retry/);
  p.reset();
  assert.equal(p.halted, false);
});

test('slow auth failures outside the 60s window do not halt', async () => {
  let t = 0;
  const p = new OlamHealthProbe(
    clientStub({ runner: async () => { throw new Error('HTTP 401'); } }),
    { now: () => t },
  );
  await p.probe(); t += 61_000;
  await p.probe(); t += 61_000;
  await p.probe();
  assert.equal(p.halted, false);
});
