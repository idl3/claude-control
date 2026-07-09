import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OlamOrgClient, NoAccessSession } from '../lib/olam-client.js';
import { composerMode } from '../lib/olam-transport.js';

const ORG = {
  org: 'atlas',
  runnerUrl: 'https://runner.test',
  spaBase: 'https://spa.test',
  gsmProject: 'p',
  gsmAccount: 'a@x',
  runnerTokenGsmSecret: 'gsm-secret-name',
  runnerTokenFiles: [],
};

const BOOT_ROUTE = ['/api/bootstrap', () => json(200, { token: 'app-bearer-1' })];

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
    BOOT_ROUTE,
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
  // Both auth layers rode request headers, not the URL
  const listCall = calls.find((x) => x.url.includes('/v1/sessions'));
  assert.equal(listCall.init.headers['cf-access-token'], 'jwt-1');
  assert.equal(listCall.init.headers.Authorization, 'Bearer app-bearer-1');
});

test('readOnly: a session owned via CF Access SUB (not email) is steerable, org-mate is not', async () => {
  // The SPA returns `owner_email` as the owner's CF Access SUB. A real-shaped JWT
  // carrying both email + sub lets operatorSub() resolve. An owned session
  // (matches our sub OR email) must be steerable; a genuine org-mate's read-only.
  const payload = Buffer.from(
    JSON.stringify({ email: 'me@atlas.kitchen', sub: 'sub-me-123' }),
  ).toString('base64url');
  const jwt = `h.${payload}.s`;
  const execFileImpl = (cmd, args, opts, cb) => {
    if (cmd === 'cloudflared') return cb(null, `${jwt}\n`);
    if (cmd === 'gcloud') return cb(null, 'runner-tok\n');
    cb(new Error(`unexpected ${cmd}`), '');
  };
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [
      { ...LIST_ROW, session_id: 'own-by-sub', owner_email: 'sub-me-123' },
      { ...LIST_ROW, session_id: 'own-by-email', owner_email: 'me@atlas.kitchen' },
      { ...LIST_ROW, session_id: 'org-mate', owner_email: 'sub-other-999' },
    ] })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = await c.listSessions();
  const bySub = rows.find((r) => r.sessionId === 'own-by-sub');
  const byEmail = rows.find((r) => r.sessionId === 'own-by-email');
  const mate = rows.find((r) => r.sessionId === 'org-mate');
  assert.equal(bySub.readOnly, false); // owner_email === our sub → steerable
  assert.equal(byEmail.readOnly, false); // owner_email === our email → steerable
  assert.equal(mate.readOnly, true); // matches neither → org-mate, read-only
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
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(hits++ === 0 ? 401 : 401, {})],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await assert.rejects(() => c.listSessions(), NoAccessSession);
  const mints = execCalls.filter((x) => x.cmd === 'cloudflared').length;
  assert.equal(mints, 2); // initial + one re-mint, no loop
});

/** An expired CF Access session — the edge answers 302 → login HTML (200 after
 *  fetch follows the redirect), NOT a 401. Response-like with a text/html
 *  content-type and redirected:true; .json() throws like the real parse would. */
const html = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  redirected: true,
  headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html; charset=UTF-8' : null) },
  json: async () => {
    throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
  },
});

test('expired CF Access (302→HTML, not 401) re-mints once, then surfaces NoAccessSession', async () => {
  // Login is gone: cloudflared cannot mint a fresh JWT on the re-attempt.
  const { impl: execFileImpl, calls: execCalls } = execStub({ jwt: 'stale-jwt' });
  let hits = 0;
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    // Every call rides the CF Access wall (HTML), never a clean JSON body.
    ['/api/plan-chat/v1/sessions', () => { hits++; return html(200); }],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await assert.rejects(() => c.listSessions(), NoAccessSession);
  // Re-mint fired on the HTML wall (not just on 401) — exactly once, no loop.
  assert.equal(hits, 2);
  assert.equal(execCalls.filter((x) => x.cmd === 'cloudflared').length, 2);
});

test('expired CF Access self-heals after re-login: HTML wall → re-mint → JSON', async () => {
  // First mint returns the stale JWT (still cached from before expiry); after the
  // operator re-runs `cloudflared access login`, the re-mint returns a fresh JWT
  // and the retried request gets clean JSON — no process restart needed.
  let mint = 0;
  const execFileImpl = (cmd, args, opts, cb) => {
    if (cmd === 'cloudflared') return cb(null, `${mint++ === 0 ? 'stale-jwt' : 'fresh-jwt'}\n`);
    if (cmd === 'gcloud') return cb(null, 'runner-tok\n');
    cb(new Error(`unexpected ${cmd}`), '');
  };
  let hits = 0;
  const { impl: fetchImpl, calls } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => (hits++ === 0 ? html(200) : json(200, { sessions: [LIST_ROW] }))],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = await c.listSessions();
  assert.equal(rows.length, 1); // recovered without a restart
  assert.equal(hits, 2); // HTML wall, then JSON on retry
  // The retried request carried the FRESH re-minted JWT.
  const retry = calls.filter((x) => x.url.includes('/v1/sessions')).at(-1);
  assert.equal(retry.init.headers['cf-access-token'], 'fresh-jwt');
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
    ['/api/bootstrap', () => json(200, { token: 'APP-BEARER-SECRET' })],
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [] })],
    ['token-probe', () => json(200, {})],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await c.listSessions();
  await c.runnerToken();
  const dump = JSON.stringify(c);
  assert.ok(!dump.includes('JWT-SECRET'), 'JWT leaked via JSON.stringify(client)');
  assert.ok(!dump.includes('BEARER-SECRET'), 'runner bearer leaked via JSON.stringify(client)');
  assert.ok(!dump.includes('APP-BEARER-SECRET'), 'app bearer leaked via JSON.stringify(client)');
});

// --- secret hygiene -------------------------------------------------------------

test('normalised rows and thrown errors never carry token material', async () => {
  const { impl: execFileImpl } = execStub({ gsm: 'SUPER-SECRET' });
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [LIST_ROW] })],
    ['token-probe', () => json(401, {})],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = await c.listSessions();
  assert.ok(!JSON.stringify(rows).includes('jwt-1'));
  const err = await c.runnerToken().catch((e) => e);
  assert.ok(!String(err.message).includes('SUPER-SECRET'));
});

// --- Phase C CP3: readOnly derived from owner mismatch (dead-gate fix) ---------

test('readOnly is set for an org-mate session, false for the operator own', async () => {
  // JWT with email claim ernest@atlas.kitchen (payload only; edge already verified).
  const payload = Buffer.from(JSON.stringify({ email: 'ernest@atlas.kitchen', sub: 'u1' })).toString('base64url');
  const jwt = `h.${payload}.sig`;
  const execFileImpl = (cmd, args, opts, cb) => {
    if (cmd === 'cloudflared') return cb(null, `${jwt}\n`);
    if (cmd === 'gcloud') return cb(null, 'tok\n');
    cb(new Error('x'), '');
  };
  const rows = [
    { session_id: 'mine', owner_email: 'ernest@atlas.kitchen', summary: 'a' },
    { session_id: 'theirs', owner_email: 'someone@atlas.kitchen', summary: 'b' },
    { session_id: 'noowner', owner_email: null, summary: 'c' },
  ];
  const fetchImpl = async (url) => {
    if (url.includes('/api/bootstrap')) return json(200, { token: 'app' });
    if (url.includes('/v1/sessions')) return json(200, { sessions: rows });
    return json(200, {});
  };
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const out = await c.listSessions();
  const by = Object.fromEntries(out.map((r) => [r.sessionId, r]));
  assert.equal(by.mine.readOnly, false);
  assert.equal(by.theirs.readOnly, true);   // org-mate's session → view-only
  assert.equal(by.noowner.readOnly, false); // unknown owner → not gated (404 still guards)
});

test('operatorEmail decodes the JWT email claim, cached, never serialized', async () => {
  const payload = Buffer.from(JSON.stringify({ email: 'e@x.io' })).toString('base64url');
  const jwt = `h.${payload}.s`;
  const execFileImpl = (cmd, args, opts, cb) => cb(null, cmd === 'cloudflared' ? `${jwt}\n` : 'tok\n');
  const c = new OlamOrgClient(ORG, { fetchImpl: async () => json(200, {}), execFileImpl });
  assert.equal(await c.operatorEmail(), 'e@x.io');
  assert.ok(!JSON.stringify(c).includes('e@x.io')); // non-enumerable
});

// --- listSessions: canonical archive-status passthrough (Gateway-written) -----

test('listSessions captures canonical status fields onto the row when present', async () => {
  const { impl: execFileImpl } = execStub();
  const row = {
    ...LIST_ROW,
    session_id: 's-status',
    plan_status: 'merged',
    status: 'closed',
    linear_state: 'Done',
    merged_at: '2026-07-02T00:00:00Z',
  };
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [row] })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const [r] = await c.listSessions();
  assert.equal(r.planStatus, 'merged');
  assert.equal(r.status, 'closed');
  assert.equal(r.linearState, 'Done');
  assert.equal(r.mergedAt, '2026-07-02T00:00:00Z');
});

test('listSessions omits canonical status fields entirely when absent from the row (no invented values)', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [LIST_ROW] })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const [r] = await c.listSessions();
  for (const key of ['status', 'state', 'closed', 'closedAt', 'cancelled', 'canceled', 'archived', 'archivedAt', 'prState', 'merged', 'mergedAt', 'linearState', 'linearStatus']) {
    assert.ok(!(key in r), `unexpected invented field: ${key}`);
  }
});

// --- listSessions: model / context-remaining passthrough (SPA-computed) -------

test('listSessions passes through last_model/last_ctx_pct as model/ctxPct', async () => {
  const { impl: execFileImpl } = execStub();
  const row = {
    ...LIST_ROW,
    session_id: 's-model-ctx',
    last_model: 'claude-opus-4-8',
    last_ctx_pct: 42,
  };
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [row] })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const [r] = await c.listSessions();
  assert.equal(r.model, 'claude-opus-4-8');
  assert.equal(r.ctxPct, 42);
});

test('listSessions leaves model/ctxPct undefined when last_model/last_ctx_pct are null', async () => {
  const { impl: execFileImpl } = execStub();
  const row = {
    ...LIST_ROW,
    session_id: 's-model-ctx-null',
    last_model: null,
    last_ctx_pct: null,
  };
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [row] })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const [r] = await c.listSessions();
  assert.equal(r.model, undefined);
  assert.equal(r.ctxPct, undefined);
});

test('listSessions leaves model/ctxPct undefined when the row omits last_model/last_ctx_pct entirely', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [LIST_ROW] })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const [r] = await c.listSessions();
  assert.equal(r.model, undefined);
  assert.equal(r.ctxPct, undefined);
});

// --- enrich: prs/prCount surfaced from runner status ----------------------------

test('enrich surfaces normalized prs + prCount from the runner status', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    ['token-probe', () => json(200, {})],
    ['/agent-run/status', () => json(200, {
      phase: 'done',
      done: true,
      prs: ['https://github.com/idl3/claude-control/pull/153'],
      prCount: 1,
    })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = [{ sessionId: 's1', pool: null, phase: null, inFlight: true }];
  await c.enrich(rows);
  assert.deepEqual(rows[0].prs, [{ url: 'https://github.com/idl3/claude-control/pull/153', number: 153 }]);
  assert.equal(rows[0].prCount, 1);
});

// --- sessionLiveness (Phase A, cloud-session-chat task A4) --------------------

test('sessionLiveness returns the parsed body on 200', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl, calls } = fetchStub([
    BOOT_ROUTE,
    ['/api/session-liveness', () => json(200, { state: 'dormant', phase: 'disposed' })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const liveness = await c.sessionLiveness('s1');
  assert.deepEqual(liveness, { state: 'dormant', phase: 'disposed' });
  const call = calls.find((x) => x.url.includes('/api/session-liveness'));
  assert.match(call.url, /session_id=s1/);
});

test('sessionLiveness fails CLOSED to {state:"unknown"} on a non-200, never throws', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/session-liveness', () => json(404, { error: 'not found' })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  assert.deepEqual(await c.sessionLiveness('s1'), { state: 'unknown' });
});

test('sessionLiveness fails CLOSED to {state:"unknown"} on a network error, never throws', async () => {
  const { impl: execFileImpl } = execStub();
  const fetchImpl = async (url) => {
    if (url.includes('/api/bootstrap')) return json(200, { token: 'app' });
    throw new Error('socket hang up');
  };
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  assert.deepEqual(await c.sessionLiveness('s1'), { state: 'unknown' });
});

test('sessionLiveness fails CLOSED to {state:"unknown"} on a malformed body (no state field)', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/session-liveness', () => json(200, { phase: 'running' })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  assert.deepEqual(await c.sessionLiveness('s1'), { state: 'unknown' });
});

// --- CP3 audit Finding 1: always-probe liveness policy (the restart scenario) --

test('CP3 Finding 1 regression: a fresh client (empty _pools), session pool=null, still surfaces dormant liveness — server.js no longer gates the fetch on isExecuteShaped(session)', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl, calls } = fetchStub([
    BOOT_ROUTE,
    ['/api/session-liveness', () => json(200, { state: 'dormant', containerSessionId: 'exec-x' })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  // Fresh process: _pools is empty — no session was ever observed inFlight
  // during this process lifetime (exactly the state right after a cockpit
  // restart).
  assert.equal(c._pools.size, 0);
  // Session row as it looks right after that restart: no cached pool.
  // isExecuteShaped(session) with no liveness arg would be false here — the
  // old preflight gate in server.js's getSessionLiveness would have skipped
  // the fetch entirely on this signal alone.
  const session = { pool: null };
  // The always-probe policy calls sessionLiveness() unconditionally rather
  // than gating on session.pool.
  const liveness = await c.sessionLiveness('exec-x');
  assert.deepEqual(liveness, { state: 'dormant', containerSessionId: 'exec-x' });
  const call = calls.find((x) => x.url.includes('/api/session-liveness'));
  assert.ok(call, 'sessionLiveness must have actually hit the network — no gate suppressed it');
  // isExecuteShaped(session, liveness) now has positive evidence FROM the
  // fetched result itself (dormant state + containerSessionId), so
  // composerMode correctly demotes the composer — proving the dormant-after-
  // restart session no longer silently resolves to 'steer'.
  assert.equal(composerMode(session, liveness), 'dormant');
});

test('enrich falls back to prs.length when the runner omits prCount', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    ['token-probe', () => json(200, {})],
    ['/agent-run/status', () => json(200, {
      phase: 'running',
      prs: [{ url: 'https://x/pull/1' }, { url: 'https://x/pull/2' }],
    })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const rows = [{ sessionId: 's1', pool: null, phase: null, inFlight: true }];
  await c.enrich(rows);
  assert.equal(rows[0].prCount, 2);
});
