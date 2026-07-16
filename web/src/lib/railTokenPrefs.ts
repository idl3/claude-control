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

/** Default rotation interval for the rail's shared meta-slot cycle (see
 *  SessionRail's useMetaCyclePhase) — matches the pre-configurator hardcoded
 *  10s period. */
export const DEFAULT_RAIL_INTERVAL_MS = 10_000;
/** Floor for the operator-configured interval — guards against a pathological
 *  stored value (e.g. 0 or negative) driving setInterval into a tight loop. */
export const MIN_RAIL_INTERVAL_MS = 1_000;
/** Choices offered by the configurator's interval `<select>`. */
export const RAIL_INTERVAL_CHOICES_MS = [3_000, 5_000, 10_000, 15_000, 30_000] as const;

/** The operator's full rail-token configuration: which tokens rotate through
 *  each row's meta slot, in what order, and how often. */
export interface RailTokenPrefs {
  tokens: RailToken[];
  intervalMs: number;
}

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

/** Coerce a parsed `intervalMs` value to a finite number no smaller than
 *  `MIN_RAIL_INTERVAL_MS`, falling back to `DEFAULT_RAIL_INTERVAL_MS` for
 *  anything non-numeric/non-finite. */
function coerceInterval(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(MIN_RAIL_INTERVAL_MS, Math.round(v))
    : DEFAULT_RAIL_INTERVAL_MS;
}

/** Load the operator's rail-token prefs (order + rotation interval), falling
 *  back to defaults on absent/corrupt storage. Handles both the legacy
 *  storage shape (a bare `RailToken[]`, pre-interval-control) and the current
 *  `RailTokenPrefs` object shape under the same `STORAGE_KEY` — a legacy
 *  array always resolves to `DEFAULT_RAIL_INTERVAL_MS` since it predates the
 *  interval control entirely. */
export function loadRailTokens(): RailTokenPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tokens: DEFAULT_RAIL_TOKENS, intervalMs: DEFAULT_RAIL_INTERVAL_MS };
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy bare token-array shape.
      return { tokens: sanitize(parsed) ?? DEFAULT_RAIL_TOKENS, intervalMs: DEFAULT_RAIL_INTERVAL_MS };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { tokens?: unknown; intervalMs?: unknown };
      return {
        tokens: sanitize(obj.tokens) ?? DEFAULT_RAIL_TOKENS,
        intervalMs: coerceInterval(obj.intervalMs),
      };
    }
    return { tokens: DEFAULT_RAIL_TOKENS, intervalMs: DEFAULT_RAIL_INTERVAL_MS };
  } catch {
    return { tokens: DEFAULT_RAIL_TOKENS, intervalMs: DEFAULT_RAIL_INTERVAL_MS };
  }
}

export function saveRailTokens(prefs: RailTokenPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tokens: prefs.tokens, intervalMs: prefs.intervalMs }));
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
