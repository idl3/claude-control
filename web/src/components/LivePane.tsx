import { useEffect, useLayoutEffect, useRef } from 'react';

interface LivePaneProps {
  /** Selected session id (== tmux target). Re-arms the poll when it changes. */
  sessionId: string;
  /** Latest capture text from the cockpit store, or null before the first poll. */
  capture: string | null;
  /** Request a fresh `capture` from the server (optionally with a line count). */
  requestCapture: (lines?: number) => boolean;
  /** Drop the cached capture text (called when switching away). */
  clearCapture: () => void;
}

// How many history lines to grab for the live view (the server clamps 1..10000).
// Larger than the AskModal peek so a full pending question + context is visible.
const LIVE_LINES = 200;
// Poll cadence — matches the registry-refresh feel without hammering capture-pane.
const POLL_MS = 2000;

/**
 * Live tmux-pane fallback for a SELECTED session with no matched transcript
 * (e.g. a brand-new session, or a git-worktree cwd whose transcript Claude
 * records under a different path). Without this the assistant-ui thread renders
 * an empty "no messages yet" even though the pane has live content (a pending
 * AskUserQuestion, etc.).
 *
 * Polls the existing `capture` WS op (~2s) and renders the plain text in a
 * terminal-style <pre>, auto-scrolling to the bottom as new content arrives.
 * The interval is cleared on unmount or when the session id changes.
 */
export function LivePane({
  sessionId,
  capture,
  requestCapture,
  clearCapture,
}: LivePaneProps) {
  const preRef = useRef<HTMLPreElement>(null);
  // Track whether the user has scrolled up; only auto-scroll when pinned to bottom.
  const pinnedRef = useRef(true);

  // Arm the poll: fire once immediately, then every POLL_MS. Re-arms whenever
  // the selected session changes; clears the cached capture on teardown so a
  // stale pane never flashes when switching sessions.
  useEffect(() => {
    requestCapture(LIVE_LINES);
    const t = setInterval(() => requestCapture(LIVE_LINES), POLL_MS);
    return () => {
      clearInterval(t);
      clearCapture();
    };
  }, [sessionId, requestCapture, clearCapture]);

  // Auto-scroll to the bottom after each capture update, but only if the user
  // was already pinned there (so manual scroll-up to read history sticks).
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [capture]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    // 24px slack so a near-bottom position still counts as pinned.
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="live-pane">
      <div className="live-pane-head">live pane (no transcript)</div>
      <pre className="live-pane-body" ref={preRef} onScroll={onScroll}>
        {capture ?? 'capturing live pane…'}
      </pre>
    </div>
  );
}
