// Reserved-token detection for transcript USER messages.
//
// `/goal` is a specially highlighted slash invocation — rendered as a pulsing
// silver-blue pill (components/ReservedTokens.tsx GoalPill) instead of plain
// text, distinct from ordinary /skill chips (SkillInvocation.tsx).
// `ultrathink` (case-insensitive, whole word) renders as animated rainbow
// gradient text (components/ReservedTokens.tsx) anywhere it appears in a
// user message. Both are wired in from MessageParts.tsx / MarkdownText.tsx,
// gated on the message's role — assistant/system text is never scanned.

/** Matches `/goal` at the very start of the (left-trimmed) message, the same
 * whole-message-prefix convention SkillInvocation.isSkillInvocation uses.
 * The negative lookahead rejects longer command names sharing the prefix
 * (`/goalx`, `/goal-plan`) using slashToken's valid slash-name char class. */
const GOAL_RE = /^\/goal(?![A-Za-z0-9:_-])/;

export interface GoalInvocation {
  /** The literal token as typed, e.g. "/goal" (case preserved). */
  token: string;
  /** Everything after the token, unmodified (leading space/newline kept). */
  rest: string;
}

/** Detect a `/goal` invocation. Returns null for non-invocations and for
 * longer command names sharing the `/goal` prefix. */
export function parseGoalInvocation(text: string): GoalInvocation | null {
  const trimmed = text.trimStart();
  const match = GOAL_RE.exec(trimmed);
  if (!match) return null;
  return { token: match[0], rest: trimmed.slice(match[0].length) };
}

const ULTRATHINK_RE = /\bultrathink\b/gi;

export interface TextSegment {
  text: string;
  /** True for a segment that is exactly one "ultrathink" match. */
  ultrathink: boolean;
}

/** Split `text` into segments, flagging exact "ultrathink" word matches
 * (case-insensitive, word-boundary — rejects "ultrathinking" and
 * "megaultrathink") for highlighted rendering. Casing and surrounding
 * whitespace are preserved verbatim; segments concatenate back to `text`. */
export function splitUltrathink(text: string): TextSegment[] {
  ULTRATHINK_RE.lastIndex = 0;
  if (!ULTRATHINK_RE.test(text)) return [{ text, ultrathink: false }];
  ULTRATHINK_RE.lastIndex = 0;

  const segments: TextSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = ULTRATHINK_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), ultrathink: false });
    segments.push({ text: m[0], ultrathink: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), ultrathink: false });
  return segments;
}

// Minimal mdast shape — enough to walk and rewrite without pulling in
// @types/mdast (matches lib/embeds.ts's MdNode).
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string };
  [key: string]: unknown;
}

/** Recursively replace `text` nodes containing "ultrathink" with a run of
 * text nodes, the matched word carrying `data.hName: 'mark'` so
 * mdast-util-to-hast emits a real `<mark>` element around it (upgrading a
 * registered leaf handler rather than inventing a custom node type — see
 * mdast-util-to-hast's applyData). MarkdownText maps `mark` to
 * UltrathinkText (components/ReservedTokens.tsx). */
function walk(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      ULTRATHINK_RE.lastIndex = 0;
      if (ULTRATHINK_RE.test(child.value)) {
        for (const seg of splitUltrathink(child.value)) {
          if (!seg.text) continue;
          next.push(
            seg.ultrathink
              ? { type: 'text', value: seg.text, data: { hName: 'mark' } }
              : { type: 'text', value: seg.text },
          );
        }
        continue;
      }
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

/** remark plugin — add to MarkdownText's remarkPlugins for user-role text
 * only (assistant/system text never renders the ultrathink highlight). */
export function remarkUltrathink() {
  return (tree: MdNode) => walk(tree);
}
