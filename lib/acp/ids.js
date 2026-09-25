/**
 * ACP session identity. Must never look like a tmux pane target
 * (`sess:0.1`) so sessionById / capture / send-keys cannot treat these
 * as panes. See lib/tmux.js isValidTarget.
 */
import { randomUUID } from 'node:crypto';

const KIND_RE = /^[a-z][a-z0-9-]*$/;
const ACP_ID_RE = /^acp:[a-z][a-z0-9-]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} kind  harness id (`grok` | `codex` | …)
 * @param {string} [uuid]
 * @returns {string} `acp:<kind>:<uuid>`
 */
export function makeAcpId(kind, uuid = randomUUID()) {
  const k = String(kind || '').trim().toLowerCase();
  if (!KIND_RE.test(k)) throw new Error(`invalid acp kind: ${kind}`);
  const id = String(uuid || '').trim() || randomUUID();
  return `acp:${k}:${id}`;
}

/** @param {unknown} id */
export function isAcpId(id) {
  return typeof id === 'string' && ACP_ID_RE.test(id);
}
