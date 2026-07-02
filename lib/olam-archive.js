/**
 * lib/olam-archive.js — archive-lifecycle derivation for remote (olam) rows.
 *
 * The Pleri Gateway ingests GitHub + Linear webhooks and writes canonical
 * status (PR merged/closed, Linear issue closed/cancelled, agent-session
 * archived) onto the Neon session row — surfaced through the SPA's
 * `/api/plan-chat/v1/sessions` response cockpit already reads
 * (lib/olam-client.js listSessions()). This module is a PURE reader of that
 * canonical status: no subprocess, no GitHub/Linear API calls, no polling.
 *
 * The exact vocabulary the Gateway writes is still being confirmed live
 * (see the one-time key-log in olam-client.js), so this checks a
 * deliberately generous set of terminal-status fields/values and is meant to
 * be extended once the real field names are confirmed.
 */

/** Case-insensitive terminal-status values across any of the status-ish fields. */
export const ARCHIVED_STATUSES = [
  'completed',
  'closed',
  'archived',
  'merged',
  'cancelled',
  'canceled',
  'done',
];

/** Status-bearing fields checked against ARCHIVED_STATUSES (first match wins). */
const STATUS_FIELDS = ['planStatus', 'status', 'state', 'linearState', 'linearStatus', 'prState'];

/** Boolean/timestamp fields whose mere truthiness marks a row archived. */
const TRUTHY_FIELDS = ['closed', 'cancelled', 'canceled', 'archived', 'merged', 'closedAt', 'cancelledAt', 'archivedAt', 'mergedAt'];

/**
 * True when `value` is a non-empty terminal status string (case-insensitive
 * membership in ARCHIVED_STATUSES).
 */
function isTerminalStatus(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return ARCHIVED_STATUSES.includes(value.toLowerCase());
}

/**
 * Derive the `archived` boolean for a normalised remote-session row. Pure
 * function of the row's own fields — no I/O. Returns false for any
 * unrecognised/absent status (fail open: an unrecognised status keeps the
 * session in the active list rather than silently hiding it).
 *
 * @param {object} session normalised row (lib/olam-client.js listSessions() shape,
 *   optionally enriched with `phase`/`prMerged` by enrich())
 * @returns {boolean}
 */
export function deriveArchived(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.halted === true) return true;
  if (session.phase === 'done') return true;
  if (session.prMerged === true) return true;
  for (const field of STATUS_FIELDS) {
    if (isTerminalStatus(session[field])) return true;
  }
  for (const field of TRUTHY_FIELDS) {
    if (session[field]) return true;
  }
  return false;
}
