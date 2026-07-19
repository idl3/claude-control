// Minimal client mirror of lib/protocol/pty.js's PTY control-frame shapes.
// Server-side zod (lib/protocol/pty.js) is the validation source of truth.
export type PtyClientMessage =
  | { type: 'attach'; sessionId: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close'; sessionId: string };
export type PtyServerMessage =
  | { type: 'error'; code: 'dead-target' | 'unauthorized'; message: string }
  | { type: 'attached'; sessionId: string }
  // agent-kind sessions only — see lib/protocol/pty.js's PtyPaneSizeSchema doc
  // comment for why the client needs the real tmux pane's geometry at all.
  | { type: 'pane-size'; paneCols: number; paneRows: number };
