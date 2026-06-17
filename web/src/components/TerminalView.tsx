import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { parseAnsi, splitUrls, trimTrailingBlankLines } from '../lib/ansi';

interface TerminalViewProps {
  /** Latest capture of the shell pane, or null before the first poll. */
  output: string | null;
  /** Poll the shell pane capture (server clamps lines 1..10000). */
  requestCapture: (lines?: number) => boolean;
  /** Drop the cached capture (on unmount / leaving terminal mode). */
  clearOutput: () => void;
  /** Send an allow-listed control key (Stop = C-c). */
  sendKey: (key: string) => boolean;
}

const LINES = 400;
const POLL_MS = 800; // snappier than LivePane — this is the active surface.

/**
 * Live view of the server's dedicated shell pane, shown while the composer is in
 * terminal (>_) mode. Mirrors LivePane: polls the `shell-capture` op and renders
 * the plain-text capture in a terminal-style <pre>, auto-scrolling when pinned.
 * Includes a Stop button (sends C-c) for interrupting a running command.
 */
export function TerminalView({ output, requestCapture, clearOutput, sendKey }: TerminalViewProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    requestCapture(LINES);
    const t = setInterval(() => requestCapture(LINES), POLL_MS);
    return () => {
      clearInterval(t);
      clearOutput();
    };
  }, [requestCapture, clearOutput]);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // Parse ANSI colors → styled segments, and linkify URLs inside each segment.
  const rendered = useMemo(() => {
    if (output == null) return null;
    return parseAnsi(trimTrailingBlankLines(output)).map((seg, i) => {
      const style: React.CSSProperties = {
        color: seg.fg,
        background: seg.bg,
        fontWeight: seg.bold ? 700 : undefined,
        fontStyle: seg.italic ? 'italic' : undefined,
        textDecoration: seg.underline ? 'underline' : undefined,
        opacity: seg.dim ? 0.7 : undefined,
      };
      return (
        <span key={i} style={style}>
          {splitUrls(seg.text).map((p, j) =>
            p.href ? (
              <a key={j} href={p.href} target="_blank" rel="noopener noreferrer">
                {p.text}
              </a>
            ) : (
              p.text
            ),
          )}
        </span>
      );
    });
  }, [output]);

  return (
    <div className="terminal-view">
      <div className="terminal-view-head">
        <span className="terminal-view-title">terminal · cc-shell</span>
        <button
          type="button"
          className="terminal-view-btn"
          onClick={() => sendKey('C-c')}
          title="Interrupt (Ctrl-C)"
        >
          Stop
        </button>
      </div>
      <pre className="terminal-view-body" ref={preRef} onScroll={onScroll}>
        {rendered ?? 'starting shell…'}
      </pre>
    </div>
  );
}
