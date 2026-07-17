/**
 * lib/protocol/pty.js — control-frame schemas for the binary PTY bridge.
 *
 * The PTY bridge is a WebSocket that carries two kinds of payload:
 *   - binary frames: a 1-byte channel header + length prefix, opaque PTY
 *     bytes. Framing is handled at the transport layer — NOT schema'd here,
 *     the payload itself is arbitrary terminal output/input.
 *   - JSON control frames: attach/resize/close (client -> server) and
 *     error/attached (server -> client). These ARE schema'd, below, as a
 *     discriminated union on `type` (mirrors ClientMessage/ServerMessage in
 *     web/src/lib/types.ts).
 *
 * `resize` intentionally carries no `sessionId` — it (like `close`) applies
 * to the PTY this connection is already bound to via a prior `attach`. Only
 * `attach` and `close` name a `sessionId` explicitly, matching the Phase A
 * decision record for this schema (do not add one to `resize` without a
 * PROTOCOL_VERSION bump — see version.js).
 */
import { z } from 'zod';

/** Client -> server: bind this connection to a PTY-backed session. */
export const PtyAttachSchema = z.object({
  type: z.literal('attach'),
  sessionId: z.string(),
});

/** Client -> server: resize the PTY already attached on this connection. */
export const PtyResizeSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** Client -> server: detach/terminate the PTY bridge on this connection. */
export const PtyCloseSchema = z.object({
  type: z.literal('close'),
  sessionId: z.string(),
});

/**
 * Server -> client: the requested operation failed. `code` is a closed enum
 * for Phase A (only the two cases the PTY bridge can currently raise);
 * widening it to cover more failure modes is itself a shape change and must
 * bump PROTOCOL_VERSION.
 */
export const PtyErrorCodeSchema = z.enum(['dead-target', 'unauthorized']);

export const PtyErrorSchema = z.object({
  type: z.literal('error'),
  code: PtyErrorCodeSchema,
  message: z.string(),
});

/** Server -> client: attach succeeded; binary PTY frames follow. */
export const PtyAttachedSchema = z.object({
  type: z.literal('attached'),
  sessionId: z.string(),
});

/** Client -> server control-frame union. */
export const PtyClientMessageSchema = z.discriminatedUnion('type', [
  PtyAttachSchema,
  PtyResizeSchema,
  PtyCloseSchema,
]);

/** Server -> client control-frame union. */
export const PtyServerMessageSchema = z.discriminatedUnion('type', [
  PtyErrorSchema,
  PtyAttachedSchema,
]);

/** Full control-frame union (either direction) — convenient for logging/tests. */
export const PtyMessageSchema = z.discriminatedUnion('type', [
  PtyAttachSchema,
  PtyResizeSchema,
  PtyCloseSchema,
  PtyErrorSchema,
  PtyAttachedSchema,
]);

/** @typedef {import('zod').z.infer<typeof PtyAttachSchema>} PtyAttach */
/** @typedef {import('zod').z.infer<typeof PtyResizeSchema>} PtyResize */
/** @typedef {import('zod').z.infer<typeof PtyCloseSchema>} PtyClose */
/** @typedef {import('zod').z.infer<typeof PtyErrorSchema>} PtyError */
/** @typedef {import('zod').z.infer<typeof PtyAttachedSchema>} PtyAttached */
/** @typedef {import('zod').z.infer<typeof PtyClientMessageSchema>} PtyClientMessage */
/** @typedef {import('zod').z.infer<typeof PtyServerMessageSchema>} PtyServerMessage */
