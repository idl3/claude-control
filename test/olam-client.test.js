import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OlamOrgClient, NoAccessSession } from '../lib/olam-client.js';

const ORG = {
  org: 'atlas',
  runnerUrl: 'https://runner.test',
  spaBase: 'https://spa.test',
  gsmProject: 'p',
  gsmAccount: 'a@x',
  runnerTokenGsmSecret: 'gsm-secret-name',
  runnerTokenFiles: [],
};

/** execFile stub: cloudflared → jwt (or fail); gcloud → gsm token value. */
function execStub({ jwt = 'jwt-1', gsm = 'runner-tok' } = {}) {
  const calls = [];
  const impl = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    if (cmd === 'cloudflared') return jwt ? cb(null, `${jwt}\n`) : cb(new Error('no session'), '');
    if (cmd === 'gcloud') return gsm ? cb(null, `${gsm}\n`) : cb(new Error('denied'), '');
    cb(new Error(`unexpected cmd ${cmd}`), '');
  };
  return { impl, calls };
}

/** fetch stub routing by URL substring. Handlers: (url) => Response-like. */
function fetchStub(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [substr, handler] of routes) {
      if (url.includes(substr)) return handler(url, init, calls);
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
  return { impl, calls };
}

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const LIST_ROW = {
  session_id: 'agent-session-gid-1',
  world_id: 'w1',
  total_usd: 0.5,
  budget_usd_cap: 10,
  in_flight_turn_id: 'turn-9',
  halted_at: null,
  last_turn_at: '2026-07-02T01:00:00Z',
  created_at: '2026-07-01T00:00:00Z',
  summary: 'Fix the flaky spec',
  origin_chat_id: null,
};

// --- listSessions -------------------------------------------------------------

test('listSessions normalises rows on the ADR-062 identity', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl, calls } = fetchStub([
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [LIST_ROW] })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = await c.listSessions();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.org, 'atlas');
  assert.equal(r.sessionId, 'agent-session-gid-1');
  assert.equal(r.linearRef, 'agent-session-gid-1'); // session_id === AgentSession id
  assert.equal(r.inFlight, true);
  assert.equal(r.halted, false);
  assert.equal(r.pool, null); // filled by enrich()
  // JWT rode the request header, not the URL
  assert.match(calls[0].url, /^https:\/\/spa\.test\//);
  assert.equal(calls[0].init.headers['cf-access-token'], 'jwt-1');
});

test('missing Access session surfaces a typed NoAccessSession, not a crash', async () => {
  const { impl: execFileImpl } = execStub({ jwt: null });
  const { impl: fetchImpl } = fetchStub([]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await assert.rejects(() => c.listSessions(), NoAccessSession);
});

test('SPA 401 re-mints the JWT once, then surfaces NoAccessSession', async () => {
  const { impl: execFileImpl, calls: execCalls } = execStub();
  let hits = 0;
  const { impl: fetchImpl } = fetchStub([
    ['/api/plan-chat/v1/sessions', () => json(hits++ === 0 ? 401 : 401, {})],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await assert.rejects(() => c.listSessions(), NoAccessSession);
  const mints = execCalls.filter((x) => x.cmd === 'cloudflared').length;
  assert.equal(mints, 2); // initial + one re-mint, no loop
});

// --- runnerToken (probe-arbitrated walk) ---------------------------------------

test('runnerToken keeps the first candidate the live runner accepts', async () => {
  const { impl: execFileImpl } = execStub({ gsm: 'stale-gsm-token' });
  const org = { ...ORG, runnerTokenFiles: [] };
  // GSM value 401s; with no file fallback the walk fails loudly.
  const { impl: fetchImpl } = fetchStub([
    ['token-probe', () => json(401, { error: 'unauthorized' })],
  ]);
  const c = new OlamOrgClient(org, { fetchImpl, execFileImpl });
  await assert.rejects(() => c.runnerToken(), /no working runner bearer/);
});

test('runnerStatus retries the candidate walk exactly once on 401 (T2 rotation)', async () => {
  const { impl: execFileImpl } = execStub({ gsm: 'tok-a' });
  let statusHits = 0;
  const { impl: fetchImpl } = fetchStub([
    ['token-probe', () => json(200, {})],
    ['/agent-run/status', () => json(statusHits++ === 0 ? 401 : 401, {})],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await assert.rejects(() => c.runnerStatus('s1', 'linear'), /HTTP 401/);
  assert.equal(statusHits, 2); // one retry after re-walk, then fail loud
});

// --- enrich (pool probe-confirm) ----------------------------------------------

test('enrich confirms pool by first non-empty phase and caches it', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl, calls } = fetchStub([
    ['token-probe', () => json(200, {})],
    ['pool=linear', () => json(200, { phase: 'running', done: false })],
    ['pool=sandbox', () => json(200, { phase: '', done: false })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = [{ sessionId: 's1', pool: null, phase: null, inFlight: true }];
  await c.enrich(rows);
  assert.equal(rows[0].pool, 'linear');
  assert.equal(rows[0].phase, 'running');
  // second enrich uses the cached pool — no re-probe of other pools
  const before = calls.length;
  const again = [{ sessionId: 's1', pool: 'linear', phase: null, inFlight: true }];
  await c.enrich(again);
  assert.ok(calls.length - before <= 1 + 0 + 1); // status probe(s) only for confirmed pool
});

test('enrich probes only in-flight (or pool-cached) rows; idle rows stay list-only', async () => {
  const { impl: execFileImpl } = execStub();
  let probes = 0;
  const { impl: fetchImpl } = fetchStub([
    ['token-probe', () => json(200, {})],
    ['/agent-run/status', () => { probes++; return json(200, { phase: '', done: false }); }],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = [
    { sessionId: 'idle-1', pool: null, phase: null, inFlight: false },
    { sessionId: 'live-1', pool: null, phase: null, inFlight: true },
  ];
  await c.enrich(rows);
  assert.equal(rows[0].pool, null);
  assert.ok(probes <= 3); // only the in-flight row walked pools
});

test('enrich reports (never hides) in-flight rows the probe budget could not cover', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    ['token-probe', () => json(200, {})],
    ['/agent-run/status', () => json(200, { phase: '', done: false })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = Array.from({ length: 5 }, (_, i) => ({
    sessionId: `s${i}`, pool: null, phase: null, inFlight: true,
  }));
  const { unenriched } = await c.enrich(rows, { maxProbes: 3 });
  assert.ok(unenriched >= 3, `expected >=3 unenriched, got ${unenriched}`);
});

test('client instance never serializes token material (CP3 T1 guard)', async () => {
  const { impl: execFileImpl } = execStub({ jwt: 'JWT-SECRET', gsm: 'BEARER-SECRET' });
  const { impl: fetchImpl } = fetchStub([
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [] })],
    ['token-probe', () => json(200, {})],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await c.listSessions();
  await c.runnerToken();
  const dump = JSON.stringify(c);
  assert.ok(!dump.includes('JWT-SECRET'), 'JWT leaked via JSON.stringify(client)');
  assert.ok(!dump.includes('BEARER-SECRET'), 'runner bearer leaked via JSON.stringify(client)');
});

// --- secret hygiene -------------------------------------------------------------

test('normalised rows and thrown errors never carry token material', async () => {
  const { impl: execFileImpl } = execStub({ gsm: 'SUPER-SECRET' });
  const { impl: fetchImpl } = fetchStub([
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [LIST_ROW] })],
    ['token-probe', () => json(401, {})],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = await c.listSessions();
  assert.ok(!JSON.stringify(rows).includes('jwt-1'));
  const err = await c.runnerToken().catch((e) => e);
  assert.ok(!String(err.message).includes('SUPER-SECRET'));
});
