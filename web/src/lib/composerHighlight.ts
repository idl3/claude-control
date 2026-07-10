// Live reserved-token highlighting for the composer's mirror overlay
// (Composer.tsx "Inline pill overlay"). Reuses the transcript's ultrathink
// detector (lib/reservedTokens.ts splitUltrathink) so the composer shows
// similar feedback while typing that the sent message will render with.
//
// `/goal` detection is intentionally NOT shared with the transcript here:
// reservedTokens.parseGoalInvocation only recognizes `/goal` as the true
// prefix of a whole message (the transcript's SkillInvocation convention).
// The composer overlay wants `/goal` highlighted wherever it appears while
// typing, so splitGoalTokens below is a composer-only sibling detector with
// the same word-boundary rules, not a replacement for parseGoalInvocation.
//
// Segments concatenate back to the original `value` exactly (whitespace and
// newlines included) — the overlay renders each segment in order, so a
// caller can trust position/length without re-deriving offsets.

import { splitUltrathink } from './reservedTokens';

export type ComposerHighlightSegment =
  | { kind: 'text'; text: string }
  | { kind: 'goal'; text: string }
  | { kind: 'ultrathink'; text: string };

/** Matches a `/goal` token anywhere in the text, preceded by the start of
 * the string or whitespace (captured in group 1 so callers can keep the
 * prefix character as plain text) and not followed by an identifier
 * character. The trailing char class mirrors reservedTokens.GOAL_RE's
 * negative lookahead exactly — keep them in sync — so `/goalx`, `/goal-plan`,
 * and `/goal:foo` are rejected the same way in both places. Unlike GOAL_RE,
 * there's no `^` anchor on the whole pattern: the `(^|\s)` prefix lets the
 * token match starting anywhere, not just at the true start of the string,
 * and `foo/goal` (no whitespace/start before the slash) correctly fails to
 * match either alternative. */
const GOAL_TOKEN_RE = /(^|\s)\/goal(?![A-Za-z0-9:_-])/g;

export interface GoalSegment {
  text: string;
  /** True for a segment that is exactly one `/goal` token match (excluding
   * any preceding whitespace, which stays in its own non-goal segment). */
  goal: boolean;
}

/**
 * Split `text` into segments, flagging every `/goal` token that appears
 * anywhere in the string — composer-only counterpart to splitUltrathink's
 * anywhere-in-text, word-boundary matching. Segments concatenate back to
 * `text` exactly.
 */
export function splitGoalTokens(text: string): GoalSegment[] {
  GOAL_TOKEN_RE.lastIndex = 0;
  if (!GOAL_TOKEN_RE.test(text)) return [{ text, goal: false }];
  GOAL_TOKEN_RE.lastIndex = 0;

  const segments: GoalSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = GOAL_TOKEN_RE.exec(text)) !== null) {
    const tokenStart = m.index + m[1].length;
    if (tokenStart > last) segments.push({ text: text.slice(last, tokenStart), goal: false });
    segments.push({ text: '/goal', goal: true });
    last = tokenStart + '/goal'.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), goal: false });
  return segments;
}

/**
 * Split composer text into segments for the live overlay: every `/goal`
 * token (see splitGoalTokens above — anywhere in the text, word-boundary
 * matched) becomes a 'goal' segment; every whole-word "ultrathink" match in
 * the remaining text becomes an 'ultrathink' segment. Everything else is a
 * 'text' segment.
 */
export function composerHighlightSegments(value: string): ComposerHighlightSegment[] {
  const segments: ComposerHighlightSegment[] = [];
  for (const goalSeg of splitGoalTokens(value)) {
    if (goalSeg.goal) {
      segments.push({ kind: 'goal', text: goalSeg.text });
      continue;
    }
    for (const seg of splitUltrathink(goalSeg.text)) {
      if (!seg.text) continue;
      segments.push({ kind: seg.ultrathink ? 'ultrathink' : 'text', text: seg.text });
    }
  }
  return segments;
}
