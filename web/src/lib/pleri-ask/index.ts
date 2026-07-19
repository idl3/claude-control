/**
 * pleri.ask — framework-agnostic core lib (DSL types + parse/serialize + wire
 * framing). Pure: no DOM, no harness deps. Imported verbatim by claude-control
 * (vitest) and, later, the Olam SPA; the 3-transport round-trip gate imports it
 * from `node --test` via type-stripping.
 *
 * Encoding (design CP0, "Hybrid"): the ASK is short-keyed enum objects
 * (readable, forward-compatible; prose dominates its bytes); the ANSWER is
 * positional + type-discriminated (tiny — the hot round-trip path).
 *
 * Enum-coded fields are typed `number` (not a closed union) ON PURPOSE: a code
 * minted by a newer schema version must parse without throwing (H3). Authors
 * construct with the const tables in `./schema` (e.g. `k: QuestionKind.multi`).
 */

// Explicit `.ts` extension: the web tsconfig sets `allowImportingTsExtensions`
// + bundler resolution (vite/vitest/tsc all accept it), and it lets Node's
// native type-stripping resolve this re-export when the 3-transport gate
// (test/pleri-ask-roundtrip.test.js) imports this lib from `node --test`.
export * from './schema.ts';

// ── Wire types ────────────────────────────────────────────────────────────

/** Preview payload (`p`). Fields used depend on `pt` — see schema.PreviewType. */
export interface Preview {
  /** preview-type code (schema.PreviewType); unknown codes tolerated. */
  pt: number;
  /** source text: markdown (pt 0) / code (pt 1) / diagram source (pt 3). */
  s?: string;
  /** code language (pt 1) or diagram engine e.g. "mermaid" (pt 3). */
  g?: string;
  /** wireframe node tree (pt 2). */
  w?: WireNode[];
  [extra: string]: unknown;
}

/** Wireframe node attrs (`a`) — all optional, omitted when default. */
export interface WireAttrs {
  /** text / label. */
  x?: string;
  /** variant code (schema.WireframeVariant). */
  v?: number;
  /** grow (0/1). */
  g?: 0 | 1;
  /** width hint. */
  w?: number;
  [extra: string]: unknown;
}

/** Wireframe node: `[element, attrs?, children?]` (schema.WireframeElement). */
export type WireNode = [number, WireAttrs?, WireNode[]?];

/** A selectable option (`o[]`). */
export interface AskOption {
  /** label. */
  l: string;
  /** description. */
  d?: string;
  /** flag code (schema.OptionFlag); unknown codes tolerated. */
  f?: number;
  /** preview. */
  p?: Preview;
  [extra: string]: unknown;
}

/** A single question in a set (`q[]`). */
export interface AskQuestion {
  /** header chip. */
  h?: string;
  /** prompt. */
  t: string;
  /** kind code (schema.QuestionKind); unknown codes tolerated. */
  k: number;
  /** recommended option index. */
  r?: number;
  /** allow free-text / "Other" on a select (1 = yes). */
  ft?: number;
  /** options (omit for free-text, k = QuestionKind.freeText). */
  o?: AskOption[];
  [extra: string]: unknown;
}

/** Optional ask meta (`m`) — omit when empty. */
export interface AskMeta {
  /** time-to-live seconds. */
  ttl?: number;
  [extra: string]: unknown;
}

/** The question envelope (the ASK). */
export interface AskEnvelope {
  /** schema version. */
  v: number;
  /** question-set correlation id (agent-generated, session-unique). */
  qid: string;
  /** optional meta. */
  m?: AskMeta;
  /** questions — a multi-question set is native (an array). */
  q: AskQuestion[];
  [extra: string]: unknown;
}

/**
 * A per-question answer slot, positional (SAME order as `q[]`), type-discriminated:
 * - `number`   → single-select index, OR confirm 0/1
 * - `number[]` → multi-select indices
 * - `string`   → free-text (k = freeText) OR "Other" on a select (ft = 1)
 */
export type AnswerSlot = number | number[] | string;

/** The answer envelope (the ANSWER). */
export interface AnswerEnvelope {
  /** schema version. */
  v: number;
  /** the ask's `qid`. */
  qid: string;
  /** one slot per question, in `q[]` order. */
  a: AnswerSlot[];
  /** the user cancelled/dismissed the whole set. */
  x?: 0 | 1;
  [extra: string]: unknown;
}

// ── Wire framing tags (the content-block envelope grammar) ──────────────────

export const ASK_TAG = 'pleri:ask';
export const ANSWER_TAG = 'pleri:answer';

// ── Serialize ───────────────────────────────────────────────────────────────

/** Serialize an ask to compact single-line JSON (codes + values only). */
export function serializeAsk(ask: AskEnvelope): string {
  return JSON.stringify(ask);
}

/**
 * Serialize an answer to compact single-line JSON.
 *
 * HARD INVARIANT (OQ17): the output is a SINGLE physical line — zero raw `\n`
 * or `\r`. `JSON.stringify` already escapes newlines inside free-text values to
 * the two-char `\\n` sequence, so this holds by construction; the guard makes
 * the invariant fail-loud rather than silently ship a multi-line answer down an
 * unprotected transport (e.g. tmux's `-l` fallback).
 */
export function serializeAnswer(answer: AnswerEnvelope): string {
  const line = JSON.stringify(answer);
  if (line.includes('\n') || line.includes('\r')) {
    throw new Error('pleri-ask: serializeAnswer produced a multi-line answer (single-line invariant violated)');
  }
  return line;
}

// ── Parse (lenient; forward-compatible; NEVER throws) ─────────────────────────

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function coerce(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

/**
 * Parse an ask from a JSON string or an already-parsed object.
 *
 * Returns `null` on an unparseable / structurally-invalid envelope (missing
 * `v`/`qid`/`q`) — the caller degrades (re-ask). Otherwise returns the envelope
 * with unknown enum codes and extra keys PRESERVED verbatim (H3: never drop the
 * set on `k:99`, never strip a key a newer consumer might use). Never throws.
 */
export function parseAsk(input: unknown): AskEnvelope | null {
  const obj = coerce(input);
  if (!isObj(obj)) return null;
  if (typeof obj.v !== 'number') return null;
  if (typeof obj.qid !== 'string') return null;
  if (!Array.isArray(obj.q)) return null;
  return obj as unknown as AskEnvelope;
}

/**
 * Parse an answer from a JSON string or an already-parsed object. Same lenient
 * contract as {@link parseAsk}: validates the `v`/`qid`/`a` skeleton, preserves
 * slot types and extra keys, returns `null` on invalid input, never throws.
 */
export function parseAnswer(input: unknown): AnswerEnvelope | null {
  const obj = coerce(input);
  if (!isObj(obj)) return null;
  if (typeof obj.v !== 'number') return null;
  if (typeof obj.qid !== 'string') return null;
  if (!Array.isArray(obj.a)) return null;
  return obj as unknown as AnswerEnvelope;
}

// ── Wire framing (wrap/extract) ───────────────────────────────────────────────
//
// This is the pure wire framing — NOT the strict structural provenance rule
// (sole top-level content of a finalized message, not in a code fence, not
// nested), which is Phase C. `extractBlock` is a lenient first-match extractor
// for the round-trip gate and for callers that have already established
// provenance.

/** Wrap an ask in its content-block envelope. */
export function serializeAskBlock(ask: AskEnvelope): string {
  return `<${ASK_TAG}>${serializeAsk(ask)}</${ASK_TAG}>`;
}

/**
 * Wrap an answer in its content-block envelope. Inherits the single-line
 * invariant from {@link serializeAnswer}; the tags add no newlines, so the whole
 * block is a single physical line safe for every transport.
 */
export function serializeAnswerBlock(answer: AnswerEnvelope): string {
  const block = `<${ANSWER_TAG}>${serializeAnswer(answer)}</${ANSWER_TAG}>`;
  if (block.includes('\n') || block.includes('\r')) {
    throw new Error('pleri-ask: answer block must be single-line');
  }
  return block;
}

/**
 * Guard for the answer send path (wired in Phase C). Throws if a block is not a
 * single physical line.
 *
 * The proven tmux transport bracket-pastes safely, but its `-l` literal fallback
 * (lib/tmux.js) forwards raw bytes with no bracketed-paste protection — an
 * embedded newline would submit the reply early / split it. {@link serializeAnswer}
 * escapes newlines so this never triggers for a well-formed answer; this guard
 * makes a malformed or forged multi-line block fail loud instead of being sent
 * raw. Returns the block unchanged when it is safe (chainable at the send site).
 */
export function assertSingleLineAnswerBlock(block: string): string {
  if (block.includes('\n') || block.includes('\r')) {
    throw new Error('pleri-ask: refusing to send a multi-line answer block down an unprotected transport');
  }
  return block;
}

/** Extract the inner JSON text of the first `<tag>…</tag>` block, or `null`. */
export function extractBlock(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = text.indexOf(open);
  if (i < 0) return null;
  const j = text.indexOf(close, i + open.length);
  if (j < 0) return null;
  return text.slice(i + open.length, j);
}

/** Extract + parse an ask content-block from surrounding text. */
export function parseAskBlock(text: string): AskEnvelope | null {
  const inner = extractBlock(text, ASK_TAG);
  return inner == null ? null : parseAsk(inner);
}

/** Extract + parse an answer content-block from surrounding text. */
export function parseAnswerBlock(text: string): AnswerEnvelope | null {
  const inner = extractBlock(text, ANSWER_TAG);
  return inner == null ? null : parseAnswer(inner);
}

// ── Correlation ───────────────────────────────────────────────────────────────

/** True when an answer resolves to a given ask by `qid` (H4). */
export function correlate(ask: { qid?: unknown }, answer: { qid?: unknown }): boolean {
  return typeof ask?.qid === 'string' && ask.qid === answer?.qid;
}
