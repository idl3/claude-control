import { describe, it, expect, vi, afterEach } from 'vitest';
import { claudeWorking } from './SessionRail';
import type { Session } from '../lib/types';

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
