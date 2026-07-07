import { Fragment, useMemo } from 'react';
import { splitUltrathink } from '../lib/reservedTokens';

/**
 * `/goal` reserved-token pill — MessageParts.tsx renders this in place of the
 * raw token text when a user message invokes /goal (lib/reservedTokens.ts
 * parseGoalInvocation). Metallic silver-blue, animated via the same
 * shimmer-sweep keyframe as the "Working…" indicator (styles.css), so it
 * reads as part of the same "in-flight" animation family while staying
 * visually distinct from ordinary .skill-chip pills.
 */
export function GoalPill({ token }: { token: string }) {
  return (
    <span className="goal-pill" role="text" aria-label={`${token} command`}>
      {token}
    </span>
  );
}

/**
 * react-markdown `mark` component override (MarkdownText.tsx): every `<mark>`
 * produced by remarkUltrathink wraps one exact "ultrathink" match. `node` is
 * react-markdown's AST node — strip it so it isn't spread onto the DOM node.
 */
export function UltrathinkText({
  node: _node,
  ...props
}: { node?: unknown } & React.HTMLAttributes<HTMLElement>) {
  return <mark className="ultrathink-text" {...props} />;
}

/**
 * Plain-text renderer for the `/goal` invocation's argument tail. The tail
 * can't be routed through MarkdownTextPrimitive (it always reads the full
 * text part from message-part context, not an arbitrary prop string — see
 * lib/reservedTokens.ts module doc), so it renders as plain text with the
 * same ultrathink highlighting MarkdownText gives markdown-rendered text.
 */
export function TextWithUltrathink({ text }: { text: string }) {
  const segments = useMemo(() => splitUltrathink(text), [text]);
  return (
    <span className="goal-invocation-args">
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {seg.ultrathink ? <mark className="ultrathink-text">{seg.text}</mark> : seg.text}
        </Fragment>
      ))}
    </span>
  );
}
