import { describe, it, expect, vi, afterEach } from 'vitest';
import { claudeWorking } from './SessionRail';
import type { Session } from '../lib/types';

/**
 * Mirrors the claudeState expression in PaneRow so the override logic can be
 * unit-tested without rendering the full component tree.
 */
function computeClaudeState(
  s: Session,
  workingOverrideId?: string | null,
): 'ask' | 'working' | 'sleeping' {
  return s.pending
    ? 'ask'
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
