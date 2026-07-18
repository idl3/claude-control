/**
 * lib/protocol/index.js — the versioned wire protocol every head + backend
 * speaks. Plain JS + JSDoc + zod — this repo has no build step for its
 * server-side code and runs source directly under Node >=20 (package.json
 * engines). The web app may consume these same schemas and derive its TS
 * types with `z.infer`.
 *
 * Two schema families today: PTY control frames (lib/protocol/pty.js) and
 * session-list entries (lib/protocol/session.js).
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
