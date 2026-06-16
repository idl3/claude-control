import { describe, it, expect } from 'vitest';
import { mergeMessages, MAX_RETAINED_MESSAGES } from './messages';
import type { Msg } from './types';

const m = (uuid: string, role: Msg['role'] = 'user'): Msg => ({
  uuid,
  role,
  blocks: [{ kind: 'text', text: uuid }],
});

describe('mergeMessages', () => {
  it('returns the snapshot when there is no existing history', () => {
    expect(mergeMessages(undefined, [m('a'), m('b')]).map((x) => x.uuid)).toEqual(['a', 'b']);
    expect(mergeMessages([], [m('a')]).map((x) => x.uuid)).toEqual(['a']);
  });

  it('keeps existing history and appends only unseen snapshot messages', () => {
    // Client accumulated [a,b,c]; server trimmed its buffer to [c,d,e] and
    // re-snapshots on reconnect. We must NOT lose a/b, and must gain d/e.
    const existing = [m('a'), m('b'), m('c')];
    const snapshot = [m('c'), m('d'), m('e')];
    expect(mergeMessages(existing, snapshot).map((x) => x.uuid)).toEqual([
      'a', 'b', 'c', 'd', 'e',
    ]);
  });

  it('is a no-op when the snapshot is fully contained in history', () => {
    const existing = [m('a'), m('b'), m('c')];
    const snapshot = [m('b'), m('c')];
    const out = mergeMessages(existing, snapshot);
    expect(out).toBe(existing); // same ref → no needless re-render
  });

  it('does not duplicate a user message across repeated trimmed snapshots', () => {
    let acc = mergeMessages(undefined, [m('a'), m('u-msg'), m('b')]);
    // reconnect 1: trimmed window re-snapshots the same tail
    acc = mergeMessages(acc, [m('u-msg'), m('b')]);
    // reconnect 2: same again
    acc = mergeMessages(acc, [m('u-msg'), m('b')]);
    expect(acc.filter((x) => x.uuid === 'u-msg')).toHaveLength(1);
    expect(acc.map((x) => x.uuid)).toEqual(['a', 'u-msg', 'b']);
  });

  it('caps retained history to the memory bound, keeping the newest', () => {
    const existing = Array.from({ length: MAX_RETAINED_MESSAGES }, (_, i) => m(`old-${i}`));
    const out = mergeMessages(existing, [m('new')]);
    expect(out).toHaveLength(MAX_RETAINED_MESSAGES);
    expect(out[out.length - 1].uuid).toBe('new');
    expect(out[0].uuid).toBe('old-1'); // 'old-0' evicted
  });
});
