import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OlamOrgClient, LIST_SESSIONS_PAGE } from '../lib/olam-client.js';
import { RemoteSessionSource } from '../lib/olam-sessions.js';

const ORG = {
  org: 'atlas',
  runnerUrl: 'https://runner.test',
  spaBase: 'https://spa.test',
  gsmProject: 'p',
  gsmAccount: 'a@x',
  runnerTokenGsmSecret: 'gsm-secret-name',
  runnerTokenFiles: [],
};

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const BOOT_ROUTE = ['/api/bootstrap', () => json(200, { token: 'app-bearer-1' })];

/** execFile stub: cloudflared → jwt (or fail). No gcloud needed for these tests. */
function execStub({ jwt = 'jwt-1' } = {}) {
  const impl = (cmd, args, opts, cb) => {
    if (cmd === 'cloudflared') return jwt ? cb(null, `${jwt}\n`) : cb(new Error('no session'), '');
    cb(new Error(`unexpected cmd ${cmd}`), '');
  };
  return { impl };
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

const row = (id) => ({ session_id: id, world_id: null, summary: '' });

function fullPage(n) {
  return Array.from({ length: n }, (_, i) => row(`s${i}`));
}

// --- request shape ------------------------------------------------------------

test('listSessions() first call requests limit=50 and no cursor param', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl, calls } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [], nextCursor: null })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await c.listSessions();
  const listCall = calls.find((x) => x.url.includes('/v1/sessions'));
  const u = new URL(listCall.url);
  assert.equal(u.searchParams.get('limit'), String(LIST_SESSIONS_PAGE));
  assert.equal(u.searchParams.has('cursor'), false);
});

test('listSessions({ cursor }) requests that cursor and still limit=50', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl, calls } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: [], nextCursor: null })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  await c.listSessions({ cursor: 'c1' });
  const listCall = calls.find((x) => x.url.includes('/v1/sessions'));
  const u = new URL(listCall.url);
  assert.equal(u.searchParams.get('limit'), String(LIST_SESSIONS_PAGE));
  assert.equal(u.searchParams.get('cursor'), 'c1');
});

// --- response shape / capped fallback ------------------------------------------

test('migrated server: {sessions, nextCursor} with a real cursor never sets capped', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: fullPage(50), nextCursor: 'c2' })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const { rows, nextCursor } = await c.listSessions();
  assert.equal(rows.length, 50);
  assert.equal(nextCursor, 'c2');
  assert.equal(c.capped, false);
  assert.equal(c.nextCursor, 'c2');
});

test('old server: bare array of 50 rows (no nextCursor field) falls back to capped:true', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, fullPage(50))],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const { nextCursor } = await c.listSessions();
  assert.equal(nextCursor, null);
  assert.equal(c.capped, true);
});

test('old server: {sessions} short page (no nextCursor field) is not capped', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: fullPage(30) })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const { nextCursor } = await c.listSessions();
  assert.equal(nextCursor, null);
  assert.equal(c.capped, false);
});

test('migrated server: {sessions, nextCursor: null} means genuinely no more pages, not capped', async () => {
  const { impl: execFileImpl } = execStub();
  const { impl: fetchImpl } = fetchStub([
    BOOT_ROUTE,
    ['/api/plan-chat/v1/sessions', () => json(200, { sessions: fullPage(50), nextCursor: null })],
  ]);
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl });
  const { nextCursor } = await c.listSessions();
  assert.equal(nextCursor, null);
  assert.equal(c.capped, false);
});

// --- registry-level health()/loadMore() ----------------------------------------

test('RemoteSessionSource surfaces hasMore/nextCursor via health() and loadMore() pages forward', async () => {
  const registry = { setRemoteSessions: () => {} };
  let cursorSeen;
  const client = {
    async listSessions({ cursor } = {}) {
      cursorSeen = cursor;
      if (!cursor) {
        return { rows: [{ org: 'atlas', sessionId: 's1', summary: 'x', lastActivity: null, inFlight: false, halted: false, linearRef: 's1', pool: null, phase: null }], nextCursor: 'page2' };
      }
      return { rows: [{ org: 'atlas', sessionId: 's2', summary: 'y', lastActivity: null, inFlight: false, halted: false, linearRef: 's2', pool: null, phase: null }], nextCursor: null };
    },
    enrich: async (rows) => rows,
    cfg: { spaBase: 'https://s.test' },
  };
  const probe = { probe: async () => ({ status: 'green', reason: null }), state: { status: 'green', reason: null } };
  const src = new RemoteSessionSource(
    { orgs: [{ org: 'atlas', runnerUrl: 'https://r.test', spaBase: 'https://s.test', brainUrl: null }] },
    registry,
    { clientFactory: () => client, probeFactory: () => probe },
  );
  await src.tick();
  assert.equal(src.health().atlas.hasMore, true);
  assert.equal(src.health().atlas.nextCursor, 'page2');

  const { sessions, nextCursor } = await src.loadMore('atlas', 'page2');
  assert.equal(cursorSeen, 'page2');
  assert.equal(nextCursor, null);
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].id.startsWith('olam:atlas:'));
  assert.equal(sessions[0].kind, 'remote');

  await assert.rejects(() => src.loadMore('nope', 'x'), /unknown org nope/);
});
