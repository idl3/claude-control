/**
 * lib/olam-transport.js — the `'olam'` transport: steering a remote olam
 * session from cockpit (Phase C).
 *
 * A cockpit reply on a remote session mirrors what the plan-chat SPA composer
 * does in cloud mode (docs/olam-contract.md):
 *
 *   POST <spa>/api/cloud-dispatch
 *     { world_id, session_id, messages:[{role:'user', content:<draft>}],
 *       executor:'do'|'sandbox', goal_mode:false }
 *
 * The plan-DO resumes the session and streams the agent's reply back as chunks
 * — which Phase B's ShapeSubscriber already renders into the transcript. So a
 * steer needs no separate "response" plumbing: send → the reply appears in the
 * stream. Auth is the two-layer SPA recipe, owned by OlamOrgClient.apiPost.
 *
 * Composer modes (chosen by session state, see composerMode):
 *   steer      — running session; POST cloud-dispatch (soft/hard).
 *   approve    — Linear session awaiting first reply; the operator's reply IS
 *                the approve. Routed via cloud-dispatch too (the plan-DO's
 *                first-reply latch treats it as the approve), OR surfaced as a
 *                Linear deep-link when no dispatch identity is available.
 *   read-only  — shared (#ro) / unauthed session; no steer path — refuse.
 */

/** Dispatch failure classes surfaced verbatim in the thread (never swallowed). */
export const DISPATCH_ERRORS = {
  429: 'rate limit reached — dispatch cap hit; retry shortly',
  402: 'budget exhausted — clear the session cap to continue',
  502: 'model cost unknown — dispatch refused (unpriced model)',
  409: 'a turn is already in flight — wait for it to finish',
  404: 'session not found or not steerable as this operator',
};

/**
 * Decide the composer mode for a remote session row.
 * @param {{ inFlight?: boolean, halted?: boolean, planStatus?: string|null, readOnly?: boolean }} session
 * @returns {'steer'|'approve'|'read-only'}
 */
export function composerMode(session) {
  if (session?.readOnly) return 'read-only';
  // A Linear session that has a plan but hasn't been approved yet: the first
  // reply is the approve. plan_status of 'planned'/'awaiting_approval' marks it.
  const ps = (session?.planStatus ?? '').toLowerCase();
  if (ps === 'planned' || ps === 'awaiting_approval' || ps === 'awaiting-approval') {
    return 'approve';
  }
  return 'steer';
}

/**
 * Steer a remote session by mirroring the SPA cloud-dispatch. Resolves to a
 * result the caller acks to the client; NEVER throws for an HTTP failure —
 * the failure class is returned so the thread can surface it verbatim.
 *
 * @param {import('./olam-client.js').OlamOrgClient} client
 * @param {{ worldId: string, sessionId: string, draft: string, mode?: 'soft'|'hard', executor?: 'do'|'sandbox' }} args
 * @returns {Promise<{ ok: true, status: number } | { ok: false, status: number|null, error: string }>}
 */
export async function dispatchSteer(client, { worldId, sessionId, draft, mode = 'soft', executor = 'do' }) {
  const body = {
    world_id: worldId,
    session_id: sessionId,
    messages: [{ role: 'user', content: draft }],
    executor,
    goal_mode: false,
    // `mode` rides for dispatch-type sessions (soft steer vs hard replace); the
    // broker ignores it for the 'do' path, so it's a no-op there — safe to send.
    steer_mode: mode,
  };
  let res;
  try {
    res = await client.apiPost('/api/cloud-dispatch', body);
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message ?? err) };
  }
  if (res.ok) return { ok: true, status: res.status };
  const known = DISPATCH_ERRORS[res.status];
  let detail = known;
  if (!known) {
    const text = await res.text().catch(() => '');
    detail = `dispatch failed HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
  }
  return { ok: false, status: res.status, error: detail };
}

/**
 * Single source of truth for which transport a reply routes to. server.js's
 * reply handler uses this to decide the 'olam' branch; the local branches
 * (claude-print / codex-rpc / tmux) keep their existing inline logic, which
 * this classifier mirrors so the four-way routing is testable in one place.
 *
 * @param {{ kind?: string, transport?: string }} session
 * @returns {'olam'|'claude-print'|'codex-rpc'|'tmux'}
 */
export function replyTransport(session) {
  if (session?.kind === 'remote') return 'olam';
  if (session?.kind === 'claude' && session?.transport === 'print') return 'claude-print';
  if (session?.kind === 'codex' && session?.transport === 'rpc') return 'codex-rpc';
  return 'tmux';
}
