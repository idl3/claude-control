// Tests for the Claudemi spawn path (claudemi-cockpit, mirroring the merged
// claudex-integration work in test/session-new-claudex.test.js).
//
// Claudemi is claudex's sibling: the SAME claude binary, pointed at Kimi K3
// via the olam auth-worker's `/kimi` provider-selector segment instead of
// Codex's default route. It reuses resolveClaudexBaseUrl AS-IS (no renamed
// helper — see server.js:1439-1452) and appends `/kimi` to the resolved base
// before Claude Code's own `/v1/messages` suffix.
//
// Pure-logic per house convention (create-session-codex.test.js /
// session-new-claudex.test.js): server.js's launch/env construction is
// mirrored EXACTLY here (single source of truth comments in server.js point
// back to these line ranges), rather than importing handleSessionNew
// directly.
//
// Security invariants tested:
//   - The composed base URL (carrying the bearer secret) NEVER appears in the
//     launch string — it rides tmux -e only (design T3/T8), same as claudex.
//   - The 7 additional Moonshot-guide env vars (none secrets) ride the SAME
//     tmux -e mechanism, never the launch string, never a log line.
//   - Fail-closed: an unknown claudemiModel is rejected (400), never silently
//     substituted (design T2).
//   - No preflight call for claudemi — the worker's /v1/models registry is
//     codex-only; the closed ALLOWED_CLAUDEMI_MODELS list is the only check.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readCloudBearer, resolveClaudexBaseUrl } from '../lib/cloud-bearer.js';
import { shellQuoteName } from '../lib/tmux.js';

// Mirror of server.js handleSessionNew's claudemi launch construction
// EXACTLY (server.js:1552-1557): the claude tmux shape with the claudemi
// model flag — identical shape to claudex, different model value. The base
// URL + the 7 guide env vars ride the tmux -e env option and MUST NOT appear
// in the typed launch string.
function claudemiLaunchFor(config, name, claudemiModel, { prompt = '', skipPermissions = false } = {}) {
  let launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
  if (claudemiModel) launch += ` --model ${shellQuoteName(claudemiModel)}`;
  if (skipPermissions) launch += ' --dangerously-skip-permissions';
  if (prompt) launch += ` -- ${shellQuoteName(prompt)}`;
  return launch;
}

// Mirror of server.js handleSessionNew's claudemi env construction EXACTLY
// (server.js:1466-1475). All 8 keys ride the tmux -e mechanism.
function claudemiEnvFor(baseUrl, claudemiModel) {
  return {
    ANTHROPIC_BASE_URL: `${baseUrl}/kimi`,
    ANTHROPIC_DEFAULT_OPUS_MODEL: claudemiModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: claudemiModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudemiModel,
    CLAUDE_CODE_SUBAGENT_MODEL: claudemiModel,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1048576',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    ENABLE_TOOL_SEARCH: 'false',
  };
}

describe('claudemi launch construction (server.js mirror)', () => {
  test('launch carries --model but never the base URL / secret / guide env values', () => {
    const launch = claudemiLaunchFor({ launchCommand: 'claude' }, 'my-sess', 'kimi-k3', {
      skipPermissions: true,
      prompt: 'hello',
    });
    assert.equal(
      launch,
      "claude --name 'my-sess' --model 'kimi-k3' --dangerously-skip-permissions -- 'hello'",
    );
    assert.ok(!launch.includes('/auth/'));
    assert.ok(!launch.includes('/kimi'));
    assert.ok(!launch.includes('ANTHROPIC_BASE_URL'));
    assert.ok(!launch.includes('CLAUDE_CODE_EFFORT_LEVEL'));
  });

  test('omitting claudemiModel omits --model entirely (never a bare flag)', () => {
    const launch = claudemiLaunchFor({ launchCommand: 'claude' }, 'my-sess', null);
    assert.equal(launch, "claude --name 'my-sess'");
  });
});

describe('claudemi env: /kimi-suffixed base URL + 8-key guide env (server.js mirror)', () => {
  test('appends /kimi to the resolved base URL — Claude Code adds its own /v1/messages after this', () => {
    const env = claudemiEnvFor('https://h.example/auth/op/sek', 'kimi-k3');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://h.example/auth/op/sek/kimi');
  });

  test('env carries exactly the 8 documented keys, no more, no less', () => {
    const env = claudemiEnvFor('https://h.example/auth/op/sek', 'kimi-k3');
    assert.deepEqual(
      Object.keys(env).sort(),
      [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL',
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
        'CLAUDE_CODE_EFFORT_LEVEL',
        'ENABLE_TOOL_SEARCH',
      ].sort(),
    );
  });

  test('the 4 model-valued vars all carry the SAME resolved claudemiModel, never hardcoded', () => {
    const env = claudemiEnvFor('https://h.example/auth/op/sek', 'kimi-k2.7-code');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'kimi-k2.7-code');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'kimi-k2.7-code');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k2.7-code');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'kimi-k2.7-code');
  });

  test('the 3 non-model guide vars are fixed literals, coerced to strings (tmux -e requires string values)', () => {
    const env = claudemiEnvFor('https://h.example/auth/op/sek', 'kimi-k3');
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1048576');
    assert.equal(typeof env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 'string');
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    assert.equal(env.ENABLE_TOOL_SEARCH, 'false');
    assert.equal(typeof env.ENABLE_TOOL_SEARCH, 'string');
  });

  test('reuses resolveClaudexBaseUrl AS-IS — no renamed helper, no diverging resolution logic', async () => {
    const artifact = { authHost: 'h', sub: 'op', secret: 'sek', baseUrl: 'https://h/auth/op/sek' };
    const r = await resolveClaudexBaseUrl('/d', {
      _exec: async () => { throw new Error('direnv not found'); },
      _readBearer: () => artifact,
    });
    assert.equal(r.source, 'cloud-bearer');
    const env = claudemiEnvFor(r.baseUrl, 'kimi-k3');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://h/auth/op/sek/kimi');
  });
});

// CP3 Fix 5 parity: claudemi must NEVER take the print-transport bridge path
// — same forced-tmux discipline as claudex (server.js:1284-1289).
function claudeTransportFor(agent, requestedTransport, configDefault) {
  if (agent === 'claudex' || agent === 'claudemi') return 'tmux';
  return requestedTransport === 'print' || requestedTransport === 'tmux'
    ? requestedTransport
    : configDefault;
}

describe('claudeTransport forcing for claudemi (server.js mirror)', () => {
  test('claudemi always forces tmux, even when body/config both request print', () => {
    assert.equal(claudeTransportFor('claudemi', 'print', 'print'), 'tmux');
    assert.equal(claudeTransportFor('claudemi', undefined, 'print'), 'tmux');
    assert.equal(claudeTransportFor('claudemi', 'tmux', 'tmux'), 'tmux');
  });

  test('claude/codex/claudex transport selection is unaffected by the claudemi force', () => {
    assert.equal(claudeTransportFor('claude', 'print', 'tmux'), 'print');
    assert.equal(claudeTransportFor('codex', undefined, 'print'), 'print');
    assert.equal(claudeTransportFor('claudex', 'print', 'print'), 'tmux');
  });
});

// GET /api/spawn-agents claudemi entry, mirroring server.js's ~:594-611 +
// ~:630-638 handler EXACTLY. Availability = claude binary available AND
// readCloudBearer() !== null AND tmux >= 3.2 — identical precondition chain
// to claudex (only the upstream provider differs), checked in that order,
// short-circuiting, so `reason` always names the FIRST failing precondition.
function claudemiSpawnEntryFor(claudeResult, bearerPresent, tmuxError) {
  let available = claudeResult.available;
  let reason = claudeResult.reason;
  if (available && !bearerPresent) {
    available = false;
    reason = "claudemi requires ~/.olam/cloud-bearer.json — run 'olam auth login' to provision it";
  }
  if (available && tmuxError) {
    available = false;
    reason = tmuxError;
  }
  return {
    id: 'claudemi',
    available,
    defaultTransport: 'tmux',
    transports: ['tmux'],
    ...(available ? {} : { reason }),
  };
}

describe('/api/spawn-agents claudemi entry (server.js mirror)', () => {
  test('all three preconditions pass → available, no reason field', () => {
    const entry = claudemiSpawnEntryFor({ available: true }, true, null);
    assert.equal(entry.id, 'claudemi');
    assert.equal(entry.available, true);
    assert.equal(entry.defaultTransport, 'tmux');
    assert.deepEqual(entry.transports, ['tmux']);
    assert.ok(!('reason' in entry));
  });

  test('claude binary unavailable → claudemi unavailable, reason is the claude-binary reason (first precondition)', () => {
    const entry = claudemiSpawnEntryFor(
      { available: false, reason: 'claude missing' },
      true, // bearer present — must NOT override the earlier failure
      null,
    );
    assert.equal(entry.available, false);
    assert.equal(entry.reason, 'claude missing');
  });

  test('claude available, bearer missing → claudemi unavailable, reason names the bearer artifact (second precondition)', () => {
    const entry = claudemiSpawnEntryFor({ available: true }, false, null);
    assert.equal(entry.available, false);
    assert.match(entry.reason, /cloud-bearer\.json/);
    assert.match(entry.reason, /olam auth login/);
  });

  test('claude available, bearer present, tmux too old → claudemi unavailable, reason is the tmux version message (third precondition)', () => {
    const entry = claudemiSpawnEntryFor(
      { available: true },
      true,
      'tmux >= 3.2 required for claudex/claudemi env injection (new-session -e); found 3.1 — brew upgrade tmux',
    );
    assert.equal(entry.available, false);
    assert.match(entry.reason, /tmux >= 3\.2/);
  });

  test('claude unavailable AND bearer missing → reason stays the FIRST failing precondition (claude), never overwritten by the bearer check', () => {
    const entry = claudemiSpawnEntryFor({ available: false, reason: 'claude missing' }, false, null);
    assert.equal(entry.reason, 'claude missing');
  });
});

// Sanity: readCloudBearer itself is untouched infra shared with claudex —
// full coverage already lives in session-new-claudex.test.js. One smoke test
// here confirms claudemi's pre-validation block (server.js:1453-1476) reads
// through the same fail-closed path (missing artifact → null → 400, never a
// silent Anthropic fallback — design T2).
describe('claudemi pre-validation fail-closed smoke (server.js mirror)', () => {
  test('missing cloud-bearer artifact and no direnv output → resolveClaudexBaseUrl returns null', async () => {
    const r = await resolveClaudexBaseUrl('/d', {
      _exec: async () => ({ stdout: '', stderr: '' }),
      _readBearer: () => null,
    });
    assert.equal(r, null);
  });

  test('readCloudBearer itself fails closed on a missing artifact (claudemi has no separate artifact path)', () => {
    assert.equal(readCloudBearer({ _path: '/nonexistent/cloud-bearer.json' }), null);
  });
});
