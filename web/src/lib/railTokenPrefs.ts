// Session-rail meta-slot token order — which of model/effort/ctx/usage rotate
// through each pane row's right-hand meta slot, and in what order. Device-
// local only (no server counterpart), same try/catch-and-default idiom as
// lib/cosmosPrefs.ts. All array logic here is pure so it's unit-testable
// without DOM layout (see railTokenPrefs.vitest.ts) — the DnD component
// (components/RailTokenConfig.tsx) is a thin pointer-event shell around these
// functions and never mutates an array itself.

/** The four dimensions a pane row's meta slot can rotate through. Order here
 *  is arbitrary (it's just the source of truth for "known tokens" + the
 *  pool's default display order) — the operator-chosen rail order lives in
 *  `RailToken[]` arrays, not this constant. */
export const RAIL_TOKENS = ['model', 'effort', 'ctx', 'usage'] as const;
export type RailToken = (typeof RAIL_TOKENS)[number];

const STORAGE_KEY = 'cc:rail-tokens';

/** Current (pre-configurator) behavior: every token, in the order
 *  paneMetaFields has always built them in. */
export const DEFAULT_RAIL_TOKENS: RailToken[] = ['model', 'effort', 'ctx', 'usage'];

function isRailToken(v: unknown): v is RailToken {
  return typeof v === 'string' && (RAIL_TOKENS as readonly string[]).includes(v);
}

/** Validate + dedupe a parsed JSON value into a `RailToken[]`; non-array
 *  input, unknown tokens, and duplicate tokens are dropped silently (first
 *  occurrence wins). Returns null (not []) when nothing valid survives, so
 *  callers can tell "corrupt/empty" apart from "a legitimately empty bar"
 *  and fall back to the default instead of rendering a blank rail. */
function sanitize(parsed: unknown): RailToken[] | null {
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<RailToken>();
  const out: RailToken[] = [];
  for (const v of parsed) {
    if (isRailToken(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.length > 0 ? out : null;
}

/** Load the operator's rail-token order, falling back to
 *  `DEFAULT_RAIL_TOKENS` on absent/corrupt storage or a value with no valid
 *  tokens left after sanitization. */
export function loadRailTokens(): RailToken[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RAIL_TOKENS;
    return sanitize(JSON.parse(raw)) ?? DEFAULT_RAIL_TOKENS;
  } catch {
    return DEFAULT_RAIL_TOKENS;
  }
}

export function saveRailTokens(tokens: RailToken[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    /* localStorage unavailable/full — the choice just doesn't survive reload */
  }
}

/** Tokens NOT currently on the bar — the configurator's "pool" pile, in
 *  `RAIL_TOKENS` order. */
export function poolTokens(bar: RailToken[]): RailToken[] {
  return RAIL_TOKENS.filter((t) => !bar.includes(t));
}

/** Immutable insert-or-move: places `token` at `index` in `bar`. Drops any
 *  existing occurrence of `token` first, so this is also the "move within
 *  the bar" op — callers computing `index` from rendered pill midpoints
 *  should exclude the dragged pill itself from that measurement so the
 *  index already lines up with the post-removal array (see
 *  RailTokenConfig.tsx's insertion-index calculation). `index` is clamped
 *  to the valid range. */
export function insertToken(bar: RailToken[], token: RailToken, index: number): RailToken[] {
  const without = bar.filter((t) => t !== token);
  const at = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, at), token, ...without.slice(at)];
}

/** Immutable remove. No-op (returns an equal-valued new array) if `token`
 *  isn't present. */
export function removeToken(bar: RailToken[], token: RailToken): RailToken[] {
  return bar.filter((t) => t !== token);
}

/** Immutable move — alias of `insertToken`: moving an existing bar token is
 *  the same operation as inserting one from the pool (drop, then reinsert
 *  at the target index). Kept as a separate export so call sites read as
 *  intent ("moveToken" at a drop-on-bar-while-already-on-bar site) even
 *  though the implementation is shared. */
export function moveToken(bar: RailToken[], token: RailToken, index: number): RailToken[] {
  return insertToken(bar, token, index);
}

/** Order `fields` (anything keyed by `.key`) to match `tokens`' order,
 *  dropping any field whose key isn't present in `tokens`. Shared by
 *  SessionRail's `paneMetaFields` (real per-row data, gated by what that
 *  session actually reports) and RailTokenConfig's live preview (fabricated
 *  dummy data) — both filter+reorder the same way, just over different
 *  input arrays. */
export function orderMetaFields<T extends { key: string }>(fields: T[], tokens: RailToken[]): T[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: T[] = [];
  for (const t of tokens) {
    const f = byKey.get(t);
    if (f) out.push(f);
  }
  return out;
}
