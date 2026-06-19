/**
 * Pure, testable helper for in-transcript search matching.
 *
 * Kept framework-free so vitest can run it in a plain Node environment without
 * any DOM or React dependencies.
 */

export interface MatchSpan {
  /** Inclusive start index in the source string. */
  start: number;
  /** Exclusive end index in the source string. */
  end: number;
}

/**
 * Find all non-overlapping occurrences of `query` in `text` (case-insensitive).
 *
 * Returns an empty array when `query` is empty or whitespace-only (no-op
 * semantics for the UI — no highlights, count 0).
 */
export function findMatches(text: string, query: string): MatchSpan[] {
  const q = query.trim();
  if (!q) return [];

  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const spans: MatchSpan[] = [];
  let pos = 0;

  while (pos <= lower.length - lowerQ.length) {
    const idx = lower.indexOf(lowerQ, pos);
    if (idx === -1) break;
    spans.push({ start: idx, end: idx + lowerQ.length });
    pos = idx + lowerQ.length; // non-overlapping: advance past the match
  }

  return spans;
}
