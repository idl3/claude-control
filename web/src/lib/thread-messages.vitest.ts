import { describe, it, expect } from 'vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { buildThreadMessages, dedupeById, initialSendSeq } from './thread-messages';

const txt = (id: string, text: string): ThreadMessageLike =>
  ({ role: 'user', id, content: [{ type: 'text', text }] }) as ThreadMessageLike;

describe('thread-messages: duplicate queued-<key> id (localStorage rehydration race)', () => {
  it('REGRESSION: a rehydrated pending send and a fresh send that reuse a key must not both reach the runtime', () => {
    // Repro of the real crash: pendingSends rehydrates from localStorage carrying
    // key=1 (an un-reconciled send from a previous page load); sendSeq resets to 0
    // on remount so the next fresh send also mints key=1. Naively both become
    // `queued-1` → assistant-ui's MessageRepository throws on the duplicate id.
    const pending = [
      { key: 1, at: 1_000, label: 'rehydrated (old)', status: 'sent' },
      { key: 1, at: 2_000, label: 'fresh send (new)', status: 'queued' },
    ];

    // The OLD assembly pushed one bubble per pending with no dedupe → two dup ids:
    const naive = pending.map((e) => `queued-${e.key}`);
    expect(naive.filter((id) => id === 'queued-1')).toHaveLength(2); // the bug

    // The fixed assembler collapses them to ONE id-unique entry.
    const out = buildThreadMessages([], 0, pending, false);
    const ids = out.map((m) => String(m.id));
    expect(new Set(ids).size).toBe(ids.length); // all unique — no crash
    expect(ids.filter((id) => id === 'queued-1')).toHaveLength(1);
    // last-write-wins: the fresh send's content survives at the stable position.
    expect(JSON.stringify(out[0].content)).toContain('fresh send (new)');
  });

  it('keeps transcript + optimistic + working all id-unique in one snapshot', () => {
    const full = [txt('u-abc', 'hello'), txt('a-def', 'hi')];
    const out = buildThreadMessages(
      full,
      0,
      [{ key: 5, at: 1, label: 'q', status: 'queued' }],
      true,
    );
    const ids = out.map((m) => String(m.id));
    expect(ids).toEqual(['u-abc', 'a-def', 'queued-5', 'optimistic-working']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('dedupeById', () => {
  it('collapses a repeated id to one entry, last content wins, order preserved', () => {
    const out = dedupeById([txt('x', 'first'), txt('y', 'mid'), txt('x', 'second')]);
    expect(out.map((m) => String(m.id))).toEqual(['x', 'y']);
    expect(JSON.stringify(out[0].content)).toContain('second');
  });
  it('is a no-op when all ids are already unique', () => {
    expect(dedupeById([txt('a', '1'), txt('b', '2')])).toHaveLength(2);
  });
});

describe('initialSendSeq (root fix: no key reuse across reloads)', () => {
  it('seeds the counter past the largest rehydrated key so the next mint cannot collide', () => {
    expect(initialSendSeq([{ key: 3 }, { key: 1 }, { key: 7 }])).toBe(7); // next = ++7 = 8
  });
  it('is 0 for an empty (fresh) load', () => {
    expect(initialSendSeq([])).toBe(0);
  });
});
