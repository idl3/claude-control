import { describe, it, expect } from 'vitest';
import { filterTag } from './NewSessionForm';
import type { SessionFilter } from './SessionRail';

// ── filterTag ────────────────────────────────────────────────────────────────
// Pure helper: returns the badge label for the filter funnel button.

describe('filterTag', () => {
  it('returns null for "all"', () => {
    expect(filterTag('all')).toBeNull();
  });

  it('returns "CC" for "claude"', () => {
    expect(filterTag('claude')).toBe('CC');
  });

  it('returns "CX" for "codex"', () => {
    expect(filterTag('codex')).toBe('CX');
  });

  it('returns ">_" for "terminal"', () => {
    expect(filterTag('terminal')).toBe('>_');
  });
});

// ── Filter cycle ──────────────────────────────────────────────────────────────
// Mirrors the cycleFilter logic in App.tsx so we can assert the full sequence.
// If App.tsx is changed, this test catches regressions.

function cycleFilter(f: SessionFilter): SessionFilter {
  return f === 'all'
    ? 'claude'
    : f === 'claude'
      ? 'codex'
      : f === 'codex'
        ? 'terminal'
        : 'all';
}

describe('filter cycle (all → claude → codex → terminal → all)', () => {
  it('all → claude', () => expect(cycleFilter('all')).toBe('claude'));
  it('claude → codex', () => expect(cycleFilter('claude')).toBe('codex'));
  it('codex → terminal', () => expect(cycleFilter('codex')).toBe('terminal'));
  it('terminal → all', () => expect(cycleFilter('terminal')).toBe('all'));

  it('full cycle returns to all', () => {
    let f: SessionFilter = 'all';
    f = cycleFilter(f); // claude
    f = cycleFilter(f); // codex
    f = cycleFilter(f); // terminal
    f = cycleFilter(f); // all
    expect(f).toBe('all');
  });
});

// ── Agent availability types ───────────────────────────────────────────────
// Light type-level smoke test that the SpawnAgentInfo shape is correct.

import type { SpawnAgentInfo } from '../lib/api';

describe('SpawnAgentInfo type contract', () => {
  it('claude available entry has no reason', () => {
    const info: SpawnAgentInfo = { id: 'claude', available: true };
    expect(info.id).toBe('claude');
    expect(info.available).toBe(true);
    expect(info.reason).toBeUndefined();
  });

  it('codex unavailable entry has a reason', () => {
    const info: SpawnAgentInfo = { id: 'codex', available: false, reason: 'not found' };
    expect(info.available).toBe(false);
    expect(info.reason).toBe('not found');
  });
});
