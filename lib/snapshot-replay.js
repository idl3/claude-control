// lib/snapshot-replay.js — replay the last-known TUI-scrape prompt + picker
// state into a subscription snapshot.
//
// The tmux-scrape prompt (a Claude/Codex pane picker — AskUserQuestion,
// permission, trust, plan, custom menu) is broadcast EDGE-TRIGGERED by the
// prompt poller: only when it changes (server.js `if (json !== sub._lastPrompt)`).
// So a client that (re)subscribes WHILE a picker is already open — a page
// reload, a session switch, or a late join — would otherwise never receive it:
// there has been no change since the first broadcast, and the snapshot only
// replayed the codex-RPC prompt, never the scrape prompt. That is why an open
// question showed once and then vanished on reload, and why a session opened
// after the question appeared showed nothing.
//
// Replaying the cached `_lastPrompt` / `_lastPickerOpen` into the snapshot makes
// the open question (and the picker-open guard state) appear immediately on
// every (re)subscribe.

/**
 * Build the prompt/picker frames to replay on a subscription snapshot.
 *
 * @param {{_lastPrompt?: string|null, _lastPickerOpen?: boolean}} sub  subscription
 * @param {string} id  session id
 * @returns {Array<object>} frames to `send` (possibly empty)
 */
export function buildSnapshotPromptFrames(sub, id) {
  const frames = [];
  if (!sub) return frames;

  if (sub._lastPrompt) {
    let prompt = null;
    try {
      prompt = JSON.parse(sub._lastPrompt);
    } catch {
      prompt = null; // corrupt cache — skip the prompt frame rather than throw
    }
    if (prompt) frames.push({ type: 'prompt', id, prompt });
  }

  // Replay picker-open so the composer send-guard / awareness is correct
  // immediately, without waiting for the next poll cycle.
  if (sub._lastPickerOpen) {
    frames.push({ type: 'picker', id, open: true });
  }

  return frames;
}
