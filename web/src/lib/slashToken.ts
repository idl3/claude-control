/**
 * Caret-aware slash-command token detection.
 *
 * Given composer text and the current caret position, finds the slash-command
 * token immediately before the caret — i.e. a run of `[A-Za-z0-9:_-]` that is
 * preceded by `/` AND that `/` is either at the start of the string or
 * immediately preceded by whitespace. This lets autocomplete fire mid-text
 * (after a space) but NOT on path-like strings (e.g. `src/foo`).
 *
 * Returns `{ query, start, end }` where:
 *   - `query`  — the characters after the `/` (may be empty string right after `/`)
 *   - `start`  — index of the `/` in `text`
 *   - `end`    — index equal to `caret` (exclusive end of the token)
 *
 * Returns `null` when the caret is not inside / following a slash-command token.
 */
export interface SlashToken {
  /** Characters after the `/`, up to the caret. */
  query: string;
  /** Index of the `/` in the original string. */
  start: number;
  /** Exclusive end — equals `caret`. */
  end: number;
}

export function slashTokenAt(text: string, caret: number): SlashToken | null {
  if (caret < 1) return null; // need at least one char before caret

  // Walk back from caret through [A-Za-z0-9:_-] to find the name portion.
  let i = caret - 1;
  while (i >= 0 && /[A-Za-z0-9:_-]/.test(text[i])) {
    i -= 1;
  }

  // `i` is now pointing at the char BEFORE the name portion (or -1).
  // The next char must be `/`.
  const slashIdx = i;
  if (slashIdx < 0 || text[slashIdx] !== '/') return null;

  // The `/` must be at start-of-string or preceded by whitespace.
  if (slashIdx > 0 && !/\s/.test(text[slashIdx - 1])) return null;

  return {
    query: text.slice(slashIdx + 1, caret),
    start: slashIdx,
    end: caret,
  };
}
