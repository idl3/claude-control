// Request authentication for claude-control.
//
// Tokens NEVER ride the URL anymore (URLs leak via history/logs/referrer).
// Instead:
//   - HTTP/API requests carry the token in `Authorization: Bearer <token>`.
//   - WebSocket upgrades carry it as a `Sec-WebSocket-Protocol` value, because
//     browsers cannot set arbitrary headers on `new WebSocket(...)` but CAN
//     offer subprotocols.
//
// Tokenless mode (no token configured server-side) stays fully open: every
// check returns true and the client shows no login prompt.
//
// Every surface — including the embedded xterm.js terminal's `/pty` bridge —
// authenticates via one of the two mechanisms above. There is no URL-token
// exception.

import crypto from 'node:crypto';

/**
 * Constant-time token equality. Digests both sides with SHA-256 before calling
 * `crypto.timingSafeEqual` so the buffers are always the same length regardless
 * of the candidate string (timingSafeEqual throws on length mismatch).
 *
 * Returns `false` — never throws — for null/undefined/empty candidates, which
 * preserves the "open server when no token configured" contract used by every
 * call site (they gate on `!configToken` before calling this).
 *
 * @param {string|null|undefined} candidate
 * @param {string|null|undefined} expected
 * @returns {boolean}
 */
export function safeTokenEqual(candidate, expected) {
  if (!candidate) return false;
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
}

// A dedicated subprotocol label the client always offers alongside the token,
// so the server can select a non-secret protocol to echo back (some proxies /
// strict clients want a selection) without ever reflecting the raw token.
export const WS_PROTOCOL = 'claude-control';

/**
 * Extract the bearer token from an incoming HTTP request's Authorization
 * header. Scheme match is case-insensitive ("Bearer", "bearer", "BEARER").
 * Returns the token string, or null when absent/malformed.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function tokenFromRequest(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return null;
  const m = /^\s*Bearer\s+(.+)\s*$/i.exec(header);
  return m ? m[1].trim() : null;
}

/**
 * Authenticate an HTTP/API request against the configured token.
 *
 * Tokenless server → always authorized. Otherwise the request must present the
 * exact token via `Authorization: Bearer <token>`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string|null|undefined} configToken
 * @returns {boolean}
 */
export function checkToken(req, configToken) {
  if (!configToken) return true;
  return safeTokenEqual(tokenFromRequest(req), configToken);
}

/**
 * Parse the offered WebSocket subprotocols from a `Sec-WebSocket-Protocol`
 * header value (comma-separated, each entry trimmed). Returns [] when absent.
 *
 * @param {string|undefined} headerValue
 * @returns {string[]}
 */
export function parseWsProtocols(headerValue) {
  if (typeof headerValue !== 'string') return [];
  return headerValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Authenticate a WebSocket upgrade against the configured token. The client
 * offers the token as one of its subprotocols (alongside WS_PROTOCOL). Tokenless
 * server → always authorized.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string|null|undefined} configToken
 * @returns {boolean}
 */
export function checkWsToken(req, configToken) {
  if (!configToken) return true;
  const offered = parseWsProtocols(req?.headers?.['sec-websocket-protocol']);
  return offered.some((o) => safeTokenEqual(o, configToken));
}
