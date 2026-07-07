import { describe, it, expect } from 'vitest';
import { echoMatches, hasDeliveredEcho, msgText, parsePendingKey, toMs } from './pendingSend';
import type { Msg } from './types';

// ── msgText ──────────────────────────────────────────────────────────────────

describe('msgText', () => {
  it('concatenates text blocks with a space', () => {
    const m: Msg = {
      uuid: 'u1',
      role: 'user',
      blocks: [
        { kind: 'text', text: 'hello' },
        { kind: 'text', text: 'world' },
      ],
    };
    expect(msgText(m)).toBe('hello world');
  });

  it('ignores non-text blocks', () => {
    const m: Msg = {
      uuid: 'u1',
      role: 'user',
      blocks: [
        { kind: 'text', text: 'do it' },
        { kind: 'tool_use', id: 'tu_1', name: 'Bash' },
      ],
    };
    expect(msgText(m)).toBe('do it');
  });

  it('returns "" for a message with no blocks', () => {
    expect(msgText({ uuid: 'u1', role: 'user', blocks: [] })).toBe('');
  });
});

// ── toMs ─────────────────────────────────────────────────────────────────────

describe('toMs', () => {
  it('passes a numeric ts through unchanged', () => {
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('parses an ISO string ts', () => {
    expect(toMs('2024-01-01T00:00:00.000Z')).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
  });

  it('falls back to 0 for missing/unparseable ts', () => {
    expect(toMs(undefined)).toBe(0);
    expect(toMs('not a date')).toBe(0);
  });
});

// ── echoMatches ──────────────────────────────────────────────────────────────

describe('echoMatches', () => {
  const entry = { text: 'hello world', label: 'hello world', at: 10_000 };

  it('matches identical normalized text landing after send time', () => {
    expect(echoMatches(entry, 'hello world', 10_100)).toBe(true);
  });

  it('matches through the clock-skew tolerance window (ts slightly before at)', () => {
    expect(echoMatches(entry, 'hello world', 10_000 - 4_000)).toBe(true);
  });

  it('rejects an echo that lands before the skew-tolerant cutoff (stale/older message)', () => {
    expect(echoMatches(entry, 'hello world', 10_000 - 6_000)).toBe(false);
  });

  it('rejects non-matching text', () => {
    expect(echoMatches(entry, 'goodbye world', 10_100)).toBe(false);
  });

  it('matches on the label when text and label diverge (e.g. attachment sends)', () => {
    const withPaths = { text: 'hello world /tmp/a.png', label: 'hello world', at: 10_000 };
    expect(echoMatches(withPaths, 'hello world', 10_100)).toBe(true);
  });

  it('matches via startsWith fallback for a truncated echo', () => {
    expect(echoMatches(entry, 'hello', 10_100)).toBe(true);
  });

  it('rejects an empty echo text', () => {
    expect(echoMatches(entry, '   ', 10_100)).toBe(false);
  });

  it('collapses whitespace before comparing', () => {
    expect(echoMatches(entry, '  hello   world  ', 10_100)).toBe(true);
  });
});

// ── hasDeliveredEcho / parsePendingKey (retry decision surface) ──────────────
// These two are what App.tsx's Retry handler actually calls: hasDeliveredEcho
// decides "promote" vs. "re-send", parsePendingKey recovers the PendingSend key
// from the optimistic bubble's message id dispatched by Messages.tsx.

describe('hasDeliveredEcho', () => {
  const entry = { text: 'fix the bug', label: 'fix the bug', at: 50_000 };

  it('resolves (true) when a matching user-transcript echo already exists', () => {
    const msgs: Msg[] = [
      { uuid: 'm1', role: 'assistant', blocks: [{ kind: 'text', text: 'fix the bug' }], ts: 50_100 },
      { uuid: 'm2', role: 'user', blocks: [{ kind: 'text', text: 'fix the bug' }], ts: 50_100 },
    ];
    expect(hasDeliveredEcho(entry, msgs)).toBe(true);
  });

  it('selects the retry (re-send) path when no echo exists in the transcript', () => {
    const msgs: Msg[] = [
      { uuid: 'm1', role: 'user', blocks: [{ kind: 'text', text: 'something unrelated' }], ts: 50_100 },
    ];
    expect(hasDeliveredEcho(entry, msgs)).toBe(false);
  });

  it('ignores a same-text echo from an assistant message (role must be user)', () => {
    const msgs: Msg[] = [
      { uuid: 'm1', role: 'assistant', blocks: [{ kind: 'text', text: 'fix the bug' }], ts: 50_100 },
    ];
    expect(hasDeliveredEcho(entry, msgs)).toBe(false);
  });

  it('ignores an identical OLDER message that predates the send (clock-skew cutoff)', () => {
    const msgs: Msg[] = [
      { uuid: 'm1', role: 'user', blocks: [{ kind: 'text', text: 'fix the bug' }], ts: 10_000 },
    ];
    expect(hasDeliveredEcho(entry, msgs)).toBe(false);
  });

  it('resolves true against an empty-string ts field (falls back to 0, still valid if entry.at is 0)', () => {
    const zeroAtEntry = { text: 'ping', label: 'ping', at: 0 };
    const msgs: Msg[] = [{ uuid: 'm1', role: 'user', blocks: [{ kind: 'text', text: 'ping' }] }];
    expect(hasDeliveredEcho(zeroAtEntry, msgs)).toBe(true);
  });
});

describe('parsePendingKey', () => {
  it('parses the numeric key out of a queued-<key> id', () => {
    expect(parsePendingKey('queued-42')).toBe(42);
  });

  it('parses key 0', () => {
    expect(parsePendingKey('queued-0')).toBe(0);
  });

  it('returns null for a non-optimistic message id', () => {
    expect(parsePendingKey('msg-abc123')).toBeNull();
  });

  it('returns null for a malformed queued id', () => {
    expect(parsePendingKey('queued-')).toBeNull();
    expect(parsePendingKey('queued-abc')).toBeNull();
    expect(parsePendingKey('optimistic-working')).toBeNull();
  });
});
