import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  echoMatches,
  hasDeliveredEcho,
  msgHasImage,
  msgText,
  parsePendingKey,
  PENDING_SENDS_LS_KEY,
  removePendingSend,
  toMs,
} from './pendingSend';
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

  it('returns "" for an image-only message (no text block at all)', () => {
    const m: Msg = { uuid: 'u1', role: 'user', blocks: [{ kind: 'image' }] };
    expect(msgText(m)).toBe('');
  });
});

// ── msgHasImage ──────────────────────────────────────────────────────────────

describe('msgHasImage', () => {
  it('is true when the message contains an image block', () => {
    const m: Msg = { uuid: 'u1', role: 'user', blocks: [{ kind: 'image' }] };
    expect(msgHasImage(m)).toBe(true);
  });

  it('is true when an image block accompanies typed text', () => {
    const m: Msg = {
      uuid: 'u1',
      role: 'user',
      blocks: [{ kind: 'text', text: 'check this out' }, { kind: 'image' }],
    };
    expect(msgHasImage(m)).toBe(true);
  });

  it('is false for a text-only message', () => {
    const m: Msg = { uuid: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'hi' }] };
    expect(msgHasImage(m)).toBe(false);
  });

  it('is false for a message with no blocks', () => {
    expect(msgHasImage({ uuid: 'u1', role: 'user', blocks: [] })).toBe(false);
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

  // ── image-only reconciliation (the "stuck Queued forever" bug) ────────────
  // An image-only send (no typed text) never gets a text block in the real
  // transcript record — Claude Code strips the path token and represents the
  // attachment as its own content block — so the echo's normalized text is
  // always ''. Reconciling that case requires the 4th `echoHasAttachment` arg.

  it('reconciles an image-only send via the attachment fallback (empty echo text + image block + attachments>0)', () => {
    const imageOnly = { text: '/tmp/uploads/screenshot.png', label: '📎 1 attachment(s)', at: 10_000, attachments: 1 };
    expect(echoMatches(imageOnly, '', 10_100, true)).toBe(true);
  });

  it('still honors the clock-skew cutoff for the attachment fallback', () => {
    const imageOnly = { text: '/tmp/uploads/screenshot.png', label: '📎 1 attachment(s)', at: 10_000, attachments: 1 };
    expect(echoMatches(imageOnly, '', 10_000 - 6_000, true)).toBe(false);
  });

  it('does NOT reconcile via the attachment fallback when the echo has no image (empty text, no attachment)', () => {
    const imageOnly = { text: '/tmp/uploads/screenshot.png', label: '📎 1 attachment(s)', at: 10_000, attachments: 1 };
    // echoHasAttachment omitted (defaults to false) — an unrelated empty-text
    // echo (if one could even occur) must not falsely resolve an image send.
    expect(echoMatches(imageOnly, '', 10_100)).toBe(false);
  });

  it('does NOT reconcile a plain text-only entry (attachments 0/undefined) via an unrelated image echo', () => {
    // Guards against a stray image landing in an unrelated turn falsely
    // resolving a plain-text queued bubble that has no attachments of its own.
    expect(echoMatches(entry, '', 10_100, true)).toBe(false);
  });

  it('plain text-only reconciliation is unaffected by the new 4th arg (still matches on text as before)', () => {
    expect(echoMatches(entry, 'hello world', 10_100, false)).toBe(true);
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

  // Regression: an image-only Retry (no typed text) must promote instead of
  // re-sending once its image-only transcript echo lands — this is the same
  // "Queued forever" bug, exercised through the Retry decision surface.
  it('resolves (true) for an image-only send against an image-only transcript echo', () => {
    const imageOnly = { text: '/tmp/uploads/screenshot.png', label: '📎 1 attachment(s)', at: 50_000, attachments: 1 };
    const msgs: Msg[] = [{ uuid: 'm1', role: 'user', blocks: [{ kind: 'image' }], ts: 50_100 }];
    expect(hasDeliveredEcho(imageOnly, msgs)).toBe(true);
  });

  it('does not resolve an image-only send with no attachments-bearing echo in the transcript', () => {
    const imageOnly = { text: '/tmp/uploads/screenshot.png', label: '📎 1 attachment(s)', at: 50_000, attachments: 1 };
    const msgs: Msg[] = [{ uuid: 'm1', role: 'user', blocks: [{ kind: 'text', text: 'unrelated' }], ts: 50_100 }];
    expect(hasDeliveredEcho(imageOnly, msgs)).toBe(false);
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

// ── removePendingSend (force-remove a stuck queued/failed bubble) ────────────
// Backs both the existing "Discard" action on a FAILED bubble and the new
// dismiss (×) control on a still-queued/sent bubble whose transcript echo will
// never arrive (see App.tsx's onDiscard / the Messages.tsx dismiss button).
// Node's own experimental global `localStorage` implements neither getItem
// nor setItem (see ArtifactPanel.vitest.ts's D4 note) — stub a minimal real
// Storage in-memory so the persistence half of removePendingSend is actually
// exercised, not silently swallowed by its own try/catch.
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

describe('removePendingSend', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new FakeLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const pending = [
    { key: 1, label: 'first' },
    { key: 2, label: 'stuck one' },
    { key: 3, label: 'third' },
  ];

  it('drops exactly the matching entry, leaving the rest (and their order) untouched', () => {
    const out = removePendingSend(pending, 2);
    expect(out).toEqual([
      { key: 1, label: 'first' },
      { key: 3, label: 'third' },
    ]);
  });

  it('persists the pruned array to localStorage under PENDING_SENDS_LS_KEY', () => {
    const out = removePendingSend(pending, 2);
    const persisted = JSON.parse(localStorage.getItem(PENDING_SENDS_LS_KEY) ?? 'null');
    expect(persisted).toEqual(out);
  });

  it('is a no-op (and does not touch localStorage) when the key is not present', () => {
    const out = removePendingSend(pending, 999);
    expect(out).toEqual(pending);
    expect(localStorage.getItem(PENDING_SENDS_LS_KEY)).toBeNull();
  });

  it('does not mutate the input array', () => {
    const copy = pending.map((e) => ({ ...e }));
    removePendingSend(pending, 1);
    expect(pending).toEqual(copy);
  });

  it('survives a localStorage write failure (quota / private mode) without throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(() => removePendingSend(pending, 2)).not.toThrow();
    expect(removePendingSend(pending, 2)).toEqual([
      { key: 1, label: 'first' },
      { key: 3, label: 'third' },
    ]);
  });
});
