// Minimal client mirror of lib/protocol/pty.js's PTY control-frame shapes.
// Server-side zod (lib/protocol/pty.js) is the validation source of truth.
export type PtyClientMessage =
  | { type: 'attach'; sessionId: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'close'; sessionId: string };
export type PtyServerMessage =
  | { type: 'error'; code: 'dead-target' | 'unauthorized'; message: string }
  | { type: 'attached'; sessionId: string };
