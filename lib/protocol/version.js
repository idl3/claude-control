/**
 * lib/protocol/version.js — the wire-protocol version.
 *
 * Bump PROTOCOL_VERSION whenever ANY exported schema's structural shape
 * changes: a field is added/removed/renamed, a field's type changes, a
 * field's optionality changes, or a union/enum gains or loses a member.
 *
 * test/protocol-fingerprint.test.js is the enforcement mechanism: it
 * recomputes a structural fingerprint of every exported schema and fails if
 * the fingerprint moved without this constant also moving. That failure is
 * the whole point — a missed version bump must fail CI loudly, not silently
 * ship wire drift to a head/backend pair that assumed an older shape.
 *
 * This closes a dangling reference: lib/protocol/pty.js's `resize` doc
 * comment already pointed at "version.js" for the compat-discipline this
 * file defines — that reference predated this file existing on main.
 *
 * After bumping this, regenerate the committed snapshot:
 *   node scripts/gen-protocol-fingerprint.mjs
 */
export const PROTOCOL_VERSION = 2;
