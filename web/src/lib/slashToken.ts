/**
 * Caret-aware slash-command and @agent token detection.
 *
 * Given composer text and the current caret position, finds the trigger token
 * immediately before the caret — a run of `[A-Za-z0-9:_-]` preceded by `/` or
 * `@`, where the trigger char is either at the start of the string or immediately
 * preceded by whitespace. This fires autocomplete mid-text (after a space) but
 * NOT on path-like strings (`src/foo`) or email addresses (`foo@bar`).
 *
 * Returns `{ trigger, query, start, end }` where:
 *   - `trigger` — `'/'` or `'@'`
 *   - `query`   — the characters after the trigger (may be empty right after trigger)
 *   - `start`   — index of the trigger char in `text`
 *   - `end`     — index equal to `caret` (exclusive end of the token)
 *
 * Returns `null` when the caret is not inside / following a trigger token.
 */
export interface TriggerToken {
  /** The trigger character: '/' for skills, '@' for agents. */
  trigger: '/' | '@';
  /** Characters after the trigger, up to the caret. */
  query: string;
  /** Index of the trigger char in the original string. */
  start: number;
  /** Exclusive end — equals `caret`. */
  end: number;
}

/**
 * Legacy interface kept for callers that import SlashToken. Structurally
 * identical to TriggerToken (just without the `trigger` field) — existing
 * callers only use query/start/end.
 */
export interface SlashToken {
  /** Characters after the `/`, up to the caret. */
  query: string;
  /** Index of the `/` in the original string. */
  start: number;
  /** Exclusive end — equals `caret`. */
  end: number;
}

/**
 * Detect both `/skill` and `@agent` tokens at the caret.
 * The trigger char (`/` or `@`) must be at start-of-string or preceded by
 * whitespace — this prevents path strings and email addresses from triggering.
 */
export function triggerTokenAt(text: string, caret: number): TriggerToken | null {
  if (caret < 1) return null; // need at least one char before caret

  // Walk back from caret through [A-Za-z0-9:_-] to find the name portion.
  let i = caret - 1;
  while (i >= 0 && /[A-Za-z0-9:_-]/.test(text[i])) {
    i -= 1;
  }

  // `i` now points at the char BEFORE the name portion (or -1).
  // That char must be a trigger: `/` or `@`.
  const triggerIdx = i;
  if (triggerIdx < 0) return null;
  const triggerChar = text[triggerIdx];
  if (triggerChar !== '/' && triggerChar !== '@') return null;

  // The trigger must be at start-of-string or preceded by whitespace.
  if (triggerIdx > 0 && !/\s/.test(text[triggerIdx - 1])) return null;

  return {
    trigger: triggerChar as '/' | '@',
    query: text.slice(triggerIdx + 1, caret),
    start: triggerIdx,
    end: caret,
  };
}

/**
 * Caret-aware slash-command token detection (legacy wrapper over triggerTokenAt).
 * Filters to `/`-triggered tokens only. Behavior is identical to the original
 * implementation — all existing callers and tests are unaffected.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const token = triggerTokenAt(text, caret);
  if (!token || token.trigger !== '/') return null;
  return { query: token.query, start: token.start, end: token.end };
}
