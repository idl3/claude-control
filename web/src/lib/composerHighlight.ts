// Live reserved-token highlighting for the composer's mirror overlay
// (Composer.tsx "Inline pill overlay"). Reuses the same detectors the
// transcript uses for /goal + ultrathink (lib/reservedTokens.ts) so the
// composer shows the identical feedback while typing that the sent message
// will render with.
//
// Segments concatenate back to the original `value` exactly (whitespace and
// newlines included) — the overlay renders each segment in order, so a
// caller can trust position/length without re-deriving offsets.

import { parseGoalInvocation, splitUltrathink } from './reservedTokens';

export type ComposerHighlightSegment =
  | { kind: 'text'; text: string }
  | { kind: 'goal'; text: string }
  | { kind: 'ultrathink'; text: string };

/**
 * Split composer text into segments for the live overlay: a leading `/goal`
 * token (only recognized at the true start of the message, same convention
 * as the transcript) becomes one 'goal' segment; every whole-word
 * "ultrathink" match in the remaining text becomes an 'ultrathink' segment.
 * Everything else is a 'text' segment.
 */
export function composerHighlightSegments(value: string): ComposerHighlightSegment[] {
  const goal = parseGoalInvocation(value);
  if (!goal) {
    return splitUltrathink(value)
      .filter((seg) => seg.text.length > 0)
      .map((seg) => ({ kind: seg.ultrathink ? 'ultrathink' : 'text', text: seg.text }) as const);
  }

  // parseGoalInvocation matches against text.trimStart() — recover the
  // stripped leading whitespace so segments still concatenate back to the
  // original `value`.
  const leading = value.slice(0, value.length - value.trimStart().length);
  const segments: ComposerHighlightSegment[] = [];
  if (leading) segments.push({ kind: 'text', text: leading });
  segments.push({ kind: 'goal', text: goal.token });
  for (const seg of splitUltrathink(goal.rest)) {
    if (!seg.text) continue;
    segments.push({ kind: seg.ultrathink ? 'ultrathink' : 'text', text: seg.text });
  }
  return segments;
}
