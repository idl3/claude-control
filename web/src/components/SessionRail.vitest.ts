import { describe, it, expect, vi, afterEach } from 'vitest';
import { claudeWorking, remoteRowLabel } from './SessionRail';
import type { Session } from '../lib/types';

/**
 * Mirrors the claudeState expression in PaneRow so the state-priority logic
 * can be unit-tested without rendering the full component tree.
 *
 * Priority (highest → lowest): ask > cloning > working > sleeping
 */
function computeClaudeState(
  s: Session,
  workingOverrideId?: string | null,
  hasRunningSubagents?: boolean,
): 'ask' | 'cloning' | 'working' | 'sleeping' {
  return s.pending
    ? 'ask'
    : hasRunningSubagents
      ? 'cloning'
      : claudeWorking(s) || s.id === workingOverrideId
        ? 'working'
        : 'sleeping';
}

function makeSession(partial: Partial<Session>): Session {
  return { id: 'test-session', ...partial };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('claudeWorking', () => {
  it('returns true when thinking is true', () => {
    const s = makeSession({ thinking: true });
    expect(claudeWorking(s)).toBe(true);
  });

  it('returns true when lastActivityMs is within 15 seconds', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const s = makeSession({ lastActivityMs: now - 5_000 });
    expect(claudeWorking(s)).toBe(true);
  });

  it('returns false when lastActivityMs is older than 15 seconds', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const s = makeSession({ lastActivityMs: now - 16_000 });
    expect(claudeWorking(s)).toBe(false);
  });

  it('returns false when both thinking is false/absent and lastActivityMs is absent', () => {
    const s = makeSession({});
    expect(claudeWorking(s)).toBe(false);
  });

  it('returns false when thinking is false and lastActivityMs is undefined', () => {
    const s = makeSession({ thinking: false, lastActivityMs: undefined });
    expect(claudeWorking(s)).toBe(false);
  });

  it('ignores a string lastActivity value (does not use it for recency)', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    // lastActivity is an ISO string (what the server actually used to send);
    // the fix uses lastActivityMs instead — a string should not make it work.
    const s = makeSession({
      thinking: false,
      // Cast via unknown to simulate the old server contract (string where number expected)
      lastActivity: new Date(now - 1_000).toISOString() as unknown as number,
      lastActivityMs: undefined,
    });
    expect(claudeWorking(s)).toBe(false);
  });

  it('returns true from thinking even when lastActivityMs is stale', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const s = makeSession({ thinking: true, lastActivityMs: now - 60_000 });
    expect(claudeWorking(s)).toBe(true);
  });

  it('returns true exactly at the 15s boundary (inclusive)', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    // Exactly 14_999 ms ago — still within window
    const s = makeSession({ lastActivityMs: now - 14_999 });
    expect(claudeWorking(s)).toBe(true);
  });

  it('returns false just past the 15s boundary', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const s = makeSession({ lastActivityMs: now - 15_001 });
    expect(claudeWorking(s)).toBe(false);
  });
});

describe('computeClaudeState — workingOverrideId', () => {
  it('shows working for the selected session when override matches, even though claudeWorking is false', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    // Session is stale (> 15s ago) — claudeWorking returns false
    const s = makeSession({ id: 'sess-a', lastActivityMs: Date.now() - 60_000 });
    expect(claudeWorking(s)).toBe(false);
    // But the override says this session is working (App just sent a message)
    expect(computeClaudeState(s, 'sess-a')).toBe('working');
  });

  it('does NOT show working for a non-matching session when override is set for a different id', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const s = makeSession({ id: 'sess-b', lastActivityMs: Date.now() - 60_000 });
    expect(claudeWorking(s)).toBe(false);
    expect(computeClaudeState(s, 'sess-a')).toBe('sleeping');
  });

  it('shows working for matching session even when override is the only signal (no thinking, stale activity)', () => {
    const s = makeSession({ id: 'sess-c', thinking: false, lastActivityMs: undefined });
    expect(computeClaudeState(s, 'sess-c')).toBe('working');
  });

  it('pending takes priority over workingOverrideId', () => {
    const s = makeSession({ id: 'sess-d', pending: true });
    expect(computeClaudeState(s, 'sess-d')).toBe('ask');
  });

  it('works without override (null) — sleeping session stays sleeping', () => {
    const s = makeSession({ id: 'sess-e', thinking: false, lastActivityMs: undefined });
    expect(computeClaudeState(s, null)).toBe('sleeping');
  });

  it('works without override (undefined) — sleeping session stays sleeping', () => {
    const s = makeSession({ id: 'sess-f', thinking: false, lastActivityMs: undefined });
    expect(computeClaudeState(s)).toBe('sleeping');
  });
});

describe('computeClaudeState — cloning state (running sub-agents)', () => {
  it('shows cloning when hasRunningSubagents is true and session is otherwise sleeping', () => {
    const s = makeSession({ id: 'sess-g', thinking: false, lastActivityMs: undefined });
    expect(computeClaudeState(s, null, true)).toBe('cloning');
  });

  it('shows cloning when hasRunningSubagents is true even while claudeWorking is true', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const s = makeSession({ id: 'sess-h', lastActivityMs: now - 1_000 });
    expect(claudeWorking(s)).toBe(true);
    // cloning takes priority over working
    expect(computeClaudeState(s, null, true)).toBe('cloning');
  });

  it('ask takes priority over cloning (pending question is highest)', () => {
    const s = makeSession({ id: 'sess-i', pending: true });
    expect(computeClaudeState(s, null, true)).toBe('ask');
  });

  it('falls back to working when hasRunningSubagents is false and workingOverrideId matches', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const s = makeSession({ id: 'sess-j', lastActivityMs: Date.now() - 60_000 });
    expect(computeClaudeState(s, 'sess-j', false)).toBe('working');
  });

  it('shows sleeping when hasRunningSubagents is false and no other working signal', () => {
    const s = makeSession({ id: 'sess-k', thinking: false, lastActivityMs: undefined });
    expect(computeClaudeState(s, null, false)).toBe('sleeping');
  });

  it('shows cloning when hasRunningSubagents is true and workingOverrideId matches — cloning wins', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const s = makeSession({ id: 'sess-l', lastActivityMs: Date.now() - 60_000 });
    expect(computeClaudeState(s, 'sess-l', true)).toBe('cloning');
  });
});

describe('remoteRowLabel — rail label never shows the raw olam:org:uuid id', () => {
  it('prefers title when present', () => {
    const s = { id: 'olam:atlas:55717fae-...', title: 'Fix login bug', summary: 'ignored' };
    expect(remoteRowLabel(s)).toBe('Fix login bug');
  });

  it('falls back to summary when title is absent', () => {
    const s = { id: 'olam:atlas:55717fae-...', title: undefined, summary: 'Investigate flaky test' };
    expect(remoteRowLabel(s)).toBe('Investigate flaky test');
  });

  it('falls back to the prettified id (org · short8) when both title and summary are absent', () => {
    const s = { id: 'olam:atlas:55717fae-1234-5678-9abc-def012345678', title: undefined, summary: undefined };
    expect(remoteRowLabel(s)).toBe('atlas · 55717fae');
  });

  it('falls back to the prettified id when title is an empty string (falsy)', () => {
    const s = { id: 'olam:grain:00000000-1111-2222-3333-444444444444', title: '', summary: undefined };
    expect(remoteRowLabel(s)).toBe('grain · 00000000');
  });

  it('never returns the raw 36-char olam:org:uuid id verbatim', () => {
    const rawId = 'olam:atlas:55717fae-1234-5678-9abc-def012345678';
    const s = { id: rawId, title: undefined, summary: undefined };
    expect(remoteRowLabel(s)).not.toBe(rawId);
  });
});
