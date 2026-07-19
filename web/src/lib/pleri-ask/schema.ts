/**
 * pleri.ask — out-of-band enum schema (keyed by wire version `v`).
 *
 * These tables are NOT on the wire. Both consumers (claude-control and the
 * Olam SPA) ship them and resolve codes → meaning at render/log time. The wire
 * payload carries only codes, ids, and values — never field-definition or type
 * metadata (design heuristic H1).
 *
 * FORWARD-COMPAT (design heuristic H3): an unknown code degrades gracefully.
 * The parsers keep unknown codes verbatim (never drop the set, never throw);
 * the label resolvers below fall back to a stable `name:code` string so a
 * renderer can show *something* for a code minted by a newer schema version.
 *
 * Pure module — no DOM, no harness deps. Authored as type-strip-safe TS
 * (const objects, not `enum`) so both vitest and `node --test` import it
 * verbatim.
 */

/** Current wire schema version. */
export const ASK_VERSION = 1 as const;

/** Question kind (`k`). */
export const QuestionKind = {
  single: 0,
  multi: 1,
  freeText: 2,
  confirm: 3,
} as const;

/** Option flag (`f`). */
export const OptionFlag = {
  plain: 0,
  danger: 1,
} as const;

/** Preview type (`pt`). */
export const PreviewType = {
  markdown: 0,
  code: 1,
  wireframe: 2,
  diagram: 3,
} as const;

/** Wireframe element (`we`). */
export const WireframeElement = {
  frame: 0,
  row: 1,
  col: 2,
  text: 3,
  button: 4,
  input: 5,
  badge: 6,
  divider: 7,
  spacer: 8,
  img: 9,
} as const;

/** Wireframe variant (`wv`). */
export const WireframeVariant = {
  default: 0,
  primary: 1,
  muted: 2,
  danger: 3,
} as const;

/**
 * Lifecycle status (`s`) — render-time only, NEVER on the ask wire.
 */
export const LifecycleStatus = {
  pending: 0,
  answered: 1,
  expired: 2,
  cancelled: 3,
  superseded: 4,
} as const;

// ── Label resolvers (render/log; graceful fallback on unknown codes) ──────────

const QUESTION_KIND_LABELS: Record<number, string> = {
  0: 'single-select',
  1: 'multi-select',
  2: 'free-text',
  3: 'confirm',
};
const OPTION_FLAG_LABELS: Record<number, string> = {
  0: 'plain',
  1: 'danger',
};
const PREVIEW_TYPE_LABELS: Record<number, string> = {
  0: 'markdown',
  1: 'code',
  2: 'wireframe',
  3: 'diagram',
};
const LIFECYCLE_STATUS_LABELS: Record<number, string> = {
  0: 'pending',
  1: 'answered',
  2: 'expired',
  3: 'cancelled',
  4: 'superseded',
};

/** Resolve a question-kind code → label; unknown codes fall back to `kind:<n>`. */
export function kindLabel(k: number): string {
  return QUESTION_KIND_LABELS[k] ?? `kind:${k}`;
}

/** Resolve an option-flag code → label; unknown codes fall back to `flag:<n>`. */
export function flagLabel(f: number): string {
  return OPTION_FLAG_LABELS[f] ?? `flag:${f}`;
}

/** Resolve a preview-type code → label; unknown codes fall back to `preview:<n>`. */
export function previewTypeLabel(pt: number): string {
  return PREVIEW_TYPE_LABELS[pt] ?? `preview:${pt}`;
}

/** Resolve a lifecycle-status code → label; unknown codes fall back to `status:<n>`. */
export function statusLabel(s: number): string {
  return LIFECYCLE_STATUS_LABELS[s] ?? `status:${s}`;
}
