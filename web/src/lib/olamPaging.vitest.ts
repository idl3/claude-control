import { describe, it, expect } from 'vitest';
import { mergeById, seedFromHead, canLoadMore, applyPage, EMPTY_PAGING, type OrgPaging } from './olamPaging';
import type { Session } from './types';

function session(id: string, partial: Partial<Session> = {}): Session {
  return { id, kind: 'remote', org: 'atlas', ...partial } as Session;
}

describe('mergeById', () => {
  it('returns primary unchanged when secondary is empty', () => {
    const primary = [session('a'), session('b')];
    expect(mergeById(primary, [])).toBe(primary);
  });

  it('appends secondary rows whose id is not already in primary, preserving order', () => {
    const primary = [session('a'), session('b')];
    const secondary = [session('c'), session('d')];
    expect(mergeById(primary, secondary).map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('primary wins on a duplicate id — the secondary copy is dropped, not appended', () => {
    const primary = [session('a', { archived: true })];
    const secondary = [session('a', { archived: false }), session('b')];
    const merged = mergeById(primary, secondary);
    expect(merged.map((s) => s.id)).toEqual(['a', 'b']);
    expect(merged[0].archived).toBe(true);
  });

  it('returns primary by reference (no new array) when secondary contributes nothing new', () => {
    const primary = [session('a')];
    const secondary = [session('a')];
    expect(mergeById(primary, secondary)).toBe(primary);
  });
});

describe('seedFromHead', () => {
  it('creates a fresh idle OrgPaging from the head when no prior state exists', () => {
    const paging = seedFromHead(undefined, { hasMore: true, nextCursor: 'c1' });
    expect(paging).toEqual({ tail: [], cursor: 'c1', hasMore: true, loading: false });
  });

  it('defaults nextCursor to null and hasMore to false when the head omits both (back-compat, un-migrated org)', () => {
    const paging = seedFromHead(undefined, {});
    expect(paging).toEqual({ tail: [], cursor: null, hasMore: false, loading: false });
  });

  it('folds legacy `capped` into hasMore for the badge, but never yields a fetchable cursor', () => {
    const paging = seedFromHead(undefined, { capped: true });
    expect(paging.hasMore).toBe(true);
    expect(paging.cursor).toBeNull();
    expect(canLoadMore(paging)).toBe(false);
  });

  it('refreshes cursor/hasMore from a new head while the tail is still empty and idle', () => {
    const cur: OrgPaging = { tail: [], cursor: 'stale', hasMore: true, loading: false };
    const next = seedFromHead(cur, { hasMore: true, nextCursor: 'fresh' });
    expect(next.cursor).toBe('fresh');
  });

  it('does NOT clobber the client cursor once the tail has advanced past the head', () => {
    const cur: OrgPaging = { tail: [session('a')], cursor: 'client-owned', hasMore: true, loading: false };
    const next = seedFromHead(cur, { hasMore: true, nextCursor: 'head-thinks-this' });
    expect(next).toBe(cur);
    expect(next.cursor).toBe('client-owned');
  });

  it('does NOT clobber state while a fetch is in flight, even with an empty tail', () => {
    const cur: OrgPaging = { tail: [], cursor: 'in-flight-cursor', hasMore: true, loading: true };
    const next = seedFromHead(cur, { hasMore: true, nextCursor: 'head-cursor' });
    expect(next).toBe(cur);
  });
});

describe('canLoadMore', () => {
  it('is false for undefined paging state (org not seeded yet)', () => {
    expect(canLoadMore(undefined)).toBe(false);
  });

  it('is false when hasMore is false', () => {
    expect(canLoadMore({ tail: [], cursor: 'c1', hasMore: false, loading: false })).toBe(false);
  });

  it('is false when cursor is null, even if hasMore is true (legacy capped case)', () => {
    expect(canLoadMore({ tail: [], cursor: null, hasMore: true, loading: false })).toBe(false);
  });

  it('is false while a fetch is already in flight (loading:true)', () => {
    expect(canLoadMore({ tail: [], cursor: 'c1', hasMore: true, loading: true })).toBe(false);
  });

  it('is true with a real cursor, hasMore, and not loading', () => {
    expect(canLoadMore({ tail: [], cursor: 'c1', hasMore: true, loading: false })).toBe(true);
  });

  it('EMPTY_PAGING can never load more', () => {
    expect(canLoadMore(EMPTY_PAGING)).toBe(false);
  });
});

describe('applyPage', () => {
  it('appends the fetched page onto the tail and advances the cursor', () => {
    const cur: OrgPaging = { tail: [session('a')], cursor: 'c1', hasMore: true, loading: true };
    const next = applyPage(cur, { sessions: [session('b'), session('c')], nextCursor: 'c2' });
    expect(next).toEqual({ tail: [session('a'), session('b'), session('c')], cursor: 'c2', hasMore: true, loading: false });
  });

  it('dedups a page that re-returns a row already in the tail', () => {
    const cur: OrgPaging = { tail: [session('a')], cursor: 'c1', hasMore: true, loading: true };
    const next = applyPage(cur, { sessions: [session('a'), session('b')], nextCursor: 'c2' });
    expect(next.tail.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('sets hasMore:false and clears loading when the page terminates with nextCursor:null', () => {
    const cur: OrgPaging = { tail: [session('a')], cursor: 'c1', hasMore: true, loading: true };
    const next = applyPage(cur, { sessions: [session('b')], nextCursor: null });
    expect(next.hasMore).toBe(false);
    expect(next.cursor).toBeNull();
    expect(next.loading).toBe(false);
  });

  // Regression: the sentinel must fire exactly once per page and stop dead
  // at the terminal page — no repeat fetches once nextCursor goes null.
  it('fires once per page and stops at nextCursor:null — a 2-page-then-done sequence', () => {
    let paging: OrgPaging = seedFromHead(undefined, { hasMore: true, nextCursor: 'p1' });
    expect(canLoadMore(paging)).toBe(true);

    // Page 1 fetched.
    paging = applyPage({ ...paging, loading: true }, { sessions: [session('a'), session('b')], nextCursor: 'p2' });
    expect(paging.tail.map((s) => s.id)).toEqual(['a', 'b']);
    expect(canLoadMore(paging)).toBe(true);

    // Page 2 fetched — terminal.
    paging = applyPage({ ...paging, loading: true }, { sessions: [session('c')], nextCursor: null });
    expect(paging.tail.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(paging.hasMore).toBe(false);
    expect(canLoadMore(paging)).toBe(false);
  });
});
