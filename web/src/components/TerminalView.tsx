import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { parseAnsi, splitUrls, trimTrailingBlankLines } from '../lib/ansi';
import type { Mods } from '../lib/terminalKeys';

interface TerminalViewProps {
  /** Latest capture of the shell pane, or null before the first poll. */
  output: string | null;
  /** Poll the shell pane capture (server clamps lines 1..10000). */
  requestCapture: (lines?: number) => boolean;
  /** Drop the cached capture (on unmount / leaving terminal mode). */
  clearOutput: () => void;
  /** Send an allow-listed control key (Stop = C-c). */
  sendKey: (key: string) => boolean;
  /** Armed sticky modifiers (one-shot Ctrl/Opt), shown as pressed in the bar. */
  mods: Mods;
  /** Toggle a sticky modifier on/off. */
  onToggleMod: (m: keyof Mods) => void;
}

const LINES = 400;
const POLL_MS = 800; // snappier than LivePane — this is the active surface.

// On-screen key bar: keys a phone keyboard can't physically produce, mapped to
// tmux send-keys tokens (must stay within the backend SHELL_KEYS allow-list).
// Sticky Ctrl/Opt (handled separately) cover arbitrary Ctrl-/Opt-<letter>; this
// row keeps the high-frequency one-tap keys. label → tmux key; gap === separator.
type KeyBarItem = { label: string; key: string; title: string } | 'gap';
const KEY_BAR: KeyBarItem[] = [
  { label: '↑', key: 'Up', title: 'Up' },
  { label: '↓', key: 'Down', title: 'Down' },
  { label: '←', key: 'Left', title: 'Left' },
  { label: '→', key: 'Right', title: 'Right' },
  'gap',
  { label: 'Tab', key: 'Tab', title: 'Tab' },
  { label: 'Esc', key: 'Escape', title: 'Escape' },
  'gap',
  { label: '^C', key: 'C-c', title: 'Interrupt (Ctrl-C)' },
  { label: '^D', key: 'C-d', title: 'EOF (Ctrl-D)' },
  { label: '^R', key: 'C-r', title: 'Reverse search (Ctrl-R)' },
  { label: '^Z', key: 'C-z', title: 'Suspend (Ctrl-Z)' },
  { label: '^L', key: 'C-l', title: 'Clear (Ctrl-L)' },
  'gap',
  { label: 'Home', key: 'Home', title: 'Home' },
  { label: 'End', key: 'End', title: 'End' },
  { label: 'PgUp', key: 'PPage', title: 'Page Up' },
  { label: 'PgDn', key: 'NPage', title: 'Page Down' },
];

/**
 * Live view of the server's dedicated shell pane, shown while the composer is in
 * terminal (>_) mode. Mirrors LivePane: polls the `shell-capture` op and renders
 * the plain-text capture in a terminal-style <pre>, auto-scrolling when pinned.
 * Includes a Stop button (sends C-c) for interrupting a running command.
 */
export function TerminalView({
  output,
  requestCapture,
  clearOutput,
  sendKey,
  mods,
  onToggleMod,
}: TerminalViewProps) {
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
      {/* Tappable special-keys row — the only way to reach arrows / Esc / Ctrl-*
          from a phone. Scrolls horizontally; keeps textarea focus so the iOS
          keyboard stays up. ponytail: discrete buttons, no sticky modifier —
          add a sticky Ctrl/Opt toggle if Ctrl+<any letter> is ever needed. */}
      <div className="terminal-key-bar" role="toolbar" aria-label="Terminal keys">
        {/* Sticky one-shot modifiers: tap Ctrl, then a letter, for Ctrl-<letter>
            "in succession" — the soft keyboard can't chord. */}
        <button
          type="button"
          className="terminal-key terminal-key-mod"
          aria-pressed={mods.ctrl}
          data-on={mods.ctrl ? 'true' : undefined}
          title="Sticky Ctrl — applies to the next key"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleMod('ctrl')}
        >
          Ctrl
        </button>
        <button
          type="button"
          className="terminal-key terminal-key-mod"
          aria-pressed={mods.alt}
          data-on={mods.alt ? 'true' : undefined}
          title="Sticky Opt/Meta — applies to the next key"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleMod('alt')}
        >
          Opt
        </button>
        <span className="terminal-key-gap" aria-hidden="true" />
        {KEY_BAR.map((item, i) =>
          item === 'gap' ? (
            <span key={`gap-${i}`} className="terminal-key-gap" aria-hidden="true" />
          ) : (
            <button
              key={item.key}
              type="button"
              className="terminal-key"
              title={item.title}
              aria-label={item.title}
              // Keep focus in the textarea so the mobile keyboard doesn't dismiss.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sendKey(item.key)}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
