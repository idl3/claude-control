// Pure logic for the SPA's client-accumulated "scrolled tail" of a remote
// (olam) org's session list. The 10s server poller keeps owning the live
// page-1 HEAD (pushed over WS into cockpit.sessions); this module owns
// pages 2..N per org, driven by the rail's IntersectionObserver sentinel.
// See useClaudeControl.ts's olamPaging state + loadMoreOlam for the wiring.
import type { Session } from './types';

/** Concatenate primary + (secondary rows whose id isn't already in primary).
 *  Primary wins on duplicate id; order preserved. Used for head∪tail and for
 *  appending a fetched page onto the existing tail. */
export function mergeById(primary: Session[], secondary: Session[]): Session[] {
  if (secondary.length === 0) return primary;
  const seen = new Set(primary.map((s) => s.id));
  const extra = secondary.filter((s) => !seen.has(s.id));
  return extra.length === 0 ? primary : [...primary, ...extra];
}

export interface OrgPaging {
  tail: Session[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
}

export const EMPTY_PAGING: OrgPaging = { tail: [], cursor: null, hasMore: false, loading: false };

/** Seed/refresh an org's paging from the live head's orgHealth. Only refreshes
 *  cursor/hasMore while the tail is still empty & idle (i.e. the client cursor
 *  hasn't advanced past the head yet). Once the tail is non-empty, the client
 *  cursor is authoritative and orgHealth must NOT clobber it. `capped` (legacy,
 *  no fetchable cursor) counts toward hasMore only for the tab badge — it never
 *  yields a cursor, so load-more can't fire (loads 50 and stops). */
export function seedFromHead(
  cur: OrgPaging | undefined,
  head: { hasMore?: boolean; nextCursor?: string | null; capped?: boolean },
): OrgPaging {
  const headCursor = head.nextCursor ?? null;
  const headHasMore = !!head.hasMore || !!head.capped;
  if (!cur) return { tail: [], cursor: headCursor, hasMore: headHasMore, loading: false };
  if (cur.tail.length === 0 && !cur.loading) return { ...cur, cursor: headCursor, hasMore: headHasMore };
  return cur;
}

/** Can we fetch another page right now? Needs a real cursor + more + not already loading. */
export function canLoadMore(cur: OrgPaging | undefined): boolean {
  return !!cur && cur.hasMore && cur.cursor != null && !cur.loading;
}

/** Apply a fetched page onto the tail. Dedups; advances cursor; stops at null. */
export function applyPage(
  cur: OrgPaging,
  page: { sessions: Session[]; nextCursor: string | null },
): OrgPaging {
  return {
    tail: mergeById(cur.tail, page.sessions),
    cursor: page.nextCursor,
    hasMore: page.nextCursor != null,
    loading: false,
  };
}
