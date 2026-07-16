/**
 * lib/protocol/index.js — the versioned wire protocol every head + backend
 * speaks. Plain JS + JSDoc + zod (NOT TypeScript — this repo has no build
 * step and runs source directly under Node >=20; see CONTRACT.md /
 * package.json). The web app consumes these same schemas via the `@protocol`
 * vite alias (web/vite.config.ts) and derives its TS types with `z.infer`.
 *
 * Phase A: two schema families (PTY control frames, session-list entries).
 * The full surface lands in Phase C.
 *
 * See version.js for PROTOCOL_VERSION + the compat-discipline contract, and
 * fingerprint.js for how shape drift is detected.
 */
export { PROTOCOL_VERSION } from './version.js';

export {
  PtyAttachSchema,
  PtyResizeSchema,
  PtyCloseSchema,
  PtyErrorCodeSchema,
  PtyErrorSchema,
  PtyAttachedSchema,
  PtyClientMessageSchema,
  PtyServerMessageSchema,
  PtyMessageSchema,
} from './pty.js';

export {
  SessionKindSchema,
  SessionTransportSchema,
  SessionEntrySchema,
  SessionListSchema,
} from './session.js';

export { describeModule, fingerprintModule } from './fingerprint.js';
