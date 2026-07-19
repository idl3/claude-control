/**
 * Adapter: native Claude Code `AskUserQuestion` tool_use input shape → the
 * pleri-ask DSL, for RENDER normalization (the shared renderer renders native
 * asks through the same DSL used for pleri-ask asks). Pure — no DOM/harness
 * imports; builds new objects, never mutates the input.
 *
 * The `NativeAskInput`/`NativeQuestion`/`NativeOption` interfaces below mirror
 * `Pending`/`PendingQuestion`/`PendingOption` (web/src/lib/types.ts:207-225) but
 * are declared locally — this lib must stay framework-agnostic and types.ts is
 * web-coupled, so it is intentionally not imported here.
 */

import { QuestionKind } from './schema.ts';
import type { AskEnvelope, AskQuestion, AskOption } from './index.ts';
import { ASK_VERSION } from './index.ts';

/** A selectable option on a native question. */
export interface NativeOption {
  label: string;
  description?: string;
  /**
   * Multi-line ASCII preview — a cockpit UI extension, not part of the native
   * `AskUserQuestion` tool_use input. Intentionally dropped by this adapter;
   * preview typing/mapping is Phase B/G scope.
   */
  preview?: string;
}

/** One native `AskUserQuestion` question. */
export interface NativeQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: NativeOption[];
}

/** The native `AskUserQuestion` tool_use input (one or more questions). */
export interface NativeAskInput {
  toolUseId: string;
  ts?: number;
  questions: NativeQuestion[];
}

/**
 * Case-insensitive trailing `(Recommended)` marker on an option label.
 *
 * ADAPTER-INTRODUCED CONVENTION: the native `AskUserQuestion` tool has no
 * `recommended` field in this repo. When an option's label ends with this
 * marker (optionally preceded by whitespace), the adapter treats that option
 * as recommended — sets `AskQuestion.r` to its index and strips the marker
 * (and the whitespace before it) from the emitted label. If more than one
 * option in a question carries the marker, only the FIRST one wins.
 */
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;

/** Strip a trailing `(Recommended)` marker (case-insensitive) from a label, if present. */
function stripRecommended(label: string): { label: string; isRecommended: boolean } {
  if (RECOMMENDED_SUFFIX.test(label)) {
    return { label: label.replace(RECOMMENDED_SUFFIX, ''), isRecommended: true };
  }
  return { label, isRecommended: false };
}

/** Adapt one native question to a DSL `AskQuestion`. */
function adaptQuestion(question: NativeQuestion): AskQuestion {
  const hasOptions = Array.isArray(question.options) && question.options.length > 0;

  if (!hasOptions) {
    // Free-text: `k` = freeText, `o` omitted entirely, no `ft`/synthetic rows.
    return {
      t: question.question,
      k: QuestionKind.freeText,
      ...(question.header !== undefined ? { h: question.header } : {}),
    };
  }

  let recommendedIndex: number | undefined;
  const options: AskOption[] = question.options.map((opt, i) => {
    const { label, isRecommended } = stripRecommended(opt.label);
    if (isRecommended && recommendedIndex === undefined) recommendedIndex = i;
    // `opt.preview` is a cockpit ASCII-preview extension, not native tool_use
    // input — intentionally dropped here (preview typing is Phase B/G scope).
    return {
      l: label,
      ...(opt.description !== undefined ? { d: opt.description } : {}),
    };
  });

  return {
    t: question.question,
    k: question.multiSelect === true ? QuestionKind.multi : QuestionKind.single,
    ...(question.header !== undefined ? { h: question.header } : {}),
    o: options,
    ...(recommendedIndex !== undefined ? { r: recommendedIndex } : {}),
  };
}

/**
 * Adapt a native `AskUserQuestion` tool_use input to a pleri-ask `AskEnvelope`
 * for render normalization. `qid` reuses `toolUseId` verbatim as a render-only
 * correlation id. Pure: builds new objects, never mutates `native`.
 */
export function adaptNativeAsk(native: NativeAskInput): AskEnvelope {
  return {
    v: ASK_VERSION,
    qid: native.toolUseId,
    q: native.questions.map(adaptQuestion),
  };
}
