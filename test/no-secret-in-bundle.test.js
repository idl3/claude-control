import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T1 guard (design doc): zero org-secret machinery in client artifacts.
 *
 * Two layers:
 *  1. Bundle grep — the built web bundle must not pull in the server-side
 *     olam modules (they are the only place org bearers/GSM live). Skips with
 *     a note when web/dist is absent (run `npm run build:web` first).
 *  2. WS-frame fixture — the remote Session rows the server broadcasts carry
 *     an allow-listed key set only; no token-shaped fields can ride the frame.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'web', 'dist');

// Markers that only exist server-side; any of them in the bundle means an
// olam server module (or its secret plumbing) leaked into the client build.
const FORBIDDEN = [
  'runnerTokenGsmSecret',
  'sandbox-runner-token',
  'secrets versions access', // gcloud invocation
  'assertAuthWithRemoteOrgs',
  'readSecretCandidate',
];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('built web bundle contains no olam secret machinery', (t) => {
  if (!fs.existsSync(dist)) {
    t.skip('web/dist absent — run `npm run build:web` first (CI runs the full chain)');
    return;
  }
  const offenders = [];
  for (const file of walk(dist)) {
    if (!/\.(js|css|html|map)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const marker of FORBIDDEN) {
      if (text.includes(marker)) offenders.push(`${path.relative(root, file)}: ${marker}`);
    }
  }
  assert.deepEqual(offenders, [], `secret machinery leaked into client bundle:\n${offenders.join('\n')}`);
});

// --- WS-frame fixture -----------------------------------------------------------

// Exactly the keys RemoteSessionSource puts on a broadcast row. Anything new
// must be added HERE deliberately — this is the review gate for frame growth.
const ALLOWED_REMOTE_KEYS = new Set([
  'id', 'kind', 'transport', 'pending', 'stale', 'orgHealth',
  'org', 'sessionId', 'worldId', 'summary', 'lastActivity',
  'inFlight', 'halted', 'linearRef', 'linearIssueId', 'planStatus', 'title', 'pool', 'phase',
  'ownerEmail', 'readOnly',
  // lib/olam-prs.js normalizePrs() output + count (item #2 — PR badge/link).
  'prs', 'prCount',
  // lib/olam-archive.js deriveArchived() — reads canonical Gateway-written
  // status only (no gh/subprocess); see that module's header comment.
  'archived',
]);

test('remote WS rows carry only the allow-listed keys (no token-shaped fields)', async () => {
  const { RemoteSessionSource } = await import('../lib/olam-sessions.js');
  const pushed = [];
  const registry = { setRemoteSessions: (rows) => pushed.push(...rows) };
  const src = new RemoteSessionSource(
    { orgs: [{ org: 'atlas', runnerUrl: 'https://r.test', spaBase: 'https://s.test', brainUrl: null }] },
    registry,
    {
      clientFactory: () => ({
        listSessions: async () => ({
          rows: [{
            org: 'atlas', sessionId: 's1', worldId: 'w1', summary: 'x',
            lastActivity: null, inFlight: false, halted: false,
            linearRef: 's1', pool: null, phase: null,
          }],
          nextCursor: null,
        }),
        enrich: async (rows) => rows,
      }),
      probeFactory: () => ({ probe: async () => ({ status: 'green', reason: null }), state: {} }),
    },
  );
  await src.tick();
  assert.equal(pushed.length, 1);
  const frame = JSON.parse(JSON.stringify(pushed[0])); // what ws would serialize
  for (const key of Object.keys(frame)) {
    assert.ok(ALLOWED_REMOTE_KEYS.has(key), `unexpected key on remote WS row: ${key}`);
  }
  const flat = JSON.stringify(frame).toLowerCase();
  for (const needle of ['bearer', 'authorization', 'jwt', 'gsm']) {
    assert.ok(!flat.includes(needle), `token-shaped content on remote WS row: ${needle}`);
  }
});
