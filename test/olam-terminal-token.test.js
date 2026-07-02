import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OlamOrgClient } from '../lib/olam-client.js';

const ORG = {
  org: 'atlas', runnerUrl: 'https://runner.test', spaBase: 'https://spa.test',
  gsmProject: 'p', gsmAccount: 'a@x', runnerTokenGsmSecret: 'g', runnerTokenFiles: [],
};
const exec = (cmd, args, opts, cb) => cb(null, cmd === 'cloudflared' ? 'jwt\n' : 'runner-tok\n');
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('terminalToken returns only browser-safe URLs (uiUrl/replayUiUrl), clamps TTL', async () => {
  let mintUrl = null;
  const fetchImpl = async (url, init) => {
    if (url.includes('/agent-run/status')) return json(200, {}); // token probe
    if (url.includes('/agent-run/terminal-token')) {
      mintUrl = url;
      assert.equal(init.method, 'POST');
      assert.match(init.headers.Authorization, /^Bearer /);
      return json(200, {
        sessionId: 's1', pool: 'linear', expiresAt: '2026-07-02T02:00:00Z',
        wsUrl: 'wss://runner/agent-run/terminal?token=SECRET',
        uiUrl: 'https://host/terminal?token=SECRET',
        replayUiUrl: 'https://host/replay?token=SECRET',
        uploadUrl: 'https://host/upload',
      });
    }
    return json(200, {});
  };
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl: exec });
  const out = await c.terminalToken('s1', 'linear', 99999); // over-max → clamp to 3600
  assert.deepEqual(Object.keys(out).sort(), ['expiresAt', 'replayUiUrl', 'uiUrl']);
  assert.equal(out.uiUrl, 'https://host/terminal?token=SECRET');
  assert.equal(out.replayUiUrl, 'https://host/replay?token=SECRET');
  assert.match(mintUrl, /ttl=3600/); // clamped
  // wsUrl/uploadUrl (non-browser) are NOT surfaced
  assert.equal('wsUrl' in out, false);
});

test('terminalToken re-walks the bearer once on 401 (rotation)', async () => {
  let mintCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/agent-run/status')) return json(200, {});
    if (url.includes('/agent-run/terminal-token')) {
      mintCalls += 1;
      return json(mintCalls === 1 ? 401 : 200, mintCalls === 1 ? {} : { uiUrl: 'u', replayUiUrl: 'r', expiresAt: null });
    }
    return json(200, {});
  };
  const c = new OlamOrgClient(ORG, { fetchImpl, execFileImpl: exec });
  const out = await c.terminalToken('s1', 'linear');
  assert.equal(out.uiUrl, 'u');
  assert.equal(mintCalls, 2);
});
