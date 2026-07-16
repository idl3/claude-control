// web/src/lib/protocol.ts — the web app's single import point for the
// shared wire-protocol schemas.
//
// lib/protocol/ (repo root) is plain JS + JSDoc + zod — NOT TypeScript (the
// root has no build step and runs source directly under Node >=20; see
// CONTRACT.md). It is resolved here via the `@protocol` vite alias
// (vite.config.ts `resolve.alias`) and `tsconfig.json`'s matching `paths`
// entry. Derive TS types with `z.infer` instead of hand-duplicating shapes —
// see the SessionEntry/PtyClientMessage/PtyServerMessage types below.
export {
  PROTOCOL_VERSION,
  PtyAttachSchema,
  PtyResizeSchema,
  PtyCloseSchema,
  PtyErrorCodeSchema,
  PtyErrorSchema,
  PtyAttachedSchema,
  PtyClientMessageSchema,
  PtyServerMessageSchema,
  PtyMessageSchema,
  SessionKindSchema,
  SessionTransportSchema,
  SessionEntrySchema,
  SessionListSchema,
} from '@protocol';

import type { z } from 'zod';
import {
  PtyClientMessageSchema,
  PtyServerMessageSchema,
  SessionEntrySchema,
  SessionListSchema,
} from '@protocol';

export type PtyClientMessage = z.infer<typeof PtyClientMessageSchema>;
export type PtyServerMessage = z.infer<typeof PtyServerMessageSchema>;
export type SessionEntry = z.infer<typeof SessionEntrySchema>;
export type SessionList = z.infer<typeof SessionListSchema>;
