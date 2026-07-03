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
 *   dormant    — (Phase A) an execute-shaped session whose container has been
 *                disposed; steering is refused honestly instead of 404ing.
 *   unknown    — (Phase A) liveness couldn't be determined (probe failure /
 *                unreachable plan-DO) for an execute-shaped session; refused
 *                the same way as dormant — a real reason beats a bare 404.
 *
 * Mode precedence: read-only > approve > dormant/unknown > steer.
 */

/** Dispatch failure classes surfaced verbatim in the thread (never swallowed). */
export const DISPATCH_ERRORS = {
  429: 'rate limit reached — dispatch cap hit; retry shortly',
  402: 'budget exhausted — clear the session cap to continue',
  502: 'model cost unknown — dispatch refused (unpriced model)',
  409: 'a turn is already in flight — wait for it to finish',
  404: 'session not found or not steerable as this operator',
  // Phase A (cloud-session-chat) — not HTTP statuses; keyed by composerMode's
  // 'dormant'/'unknown' so preSendGate can look failures up by mode name
  // alongside the numeric-status entries above.
  dormant: 'session dormant — resume support lands in Phase C',
  unknown: 'session liveness unknown — steering disabled until state is confirmed',
};

/**
 * Conservative execute/chat discriminator (Phase A). Session rows carry no
 * explicit execute-vs-chat flag today (they all come from the SAME
 * `/api/plan-chat/v1/sessions?type=chat&scope=all` listing surface — A5
 * confirmed zero legacy execute-lineage rows there as of 2026-07-03), and the
 * plan-DO's liveness read returns `unknown` both for (a) a session that
 * genuinely dispatched an execute run whose mapping predates A1, AND (b) a
 * pure plan-chat session that never executed at all. Those two cases are
 * indistinguishable from `state: 'unknown'` alone, so a bare `unknown` with no
 * other signal must NOT demote a normal chat session's composer.
 *
 * A session counts as "execute-shaped" — i.e. liveness is even allowed to
 * touch its composer mode — only with POSITIVE evidence a real execute
 * container ran for it:
 *   1. liveness itself reports `dormant` — A2 can only derive `dormant` from
 *      an EXISTING plan-DO dispatch mapping (v1:last_dispatch); no mapping,
 *      no `dormant`. This is unambiguous proof on its own.
 *   2. liveness carries a `containerSessionId` — the same mapping, surfaced
 *      directly (A2's contract: only present when a mapping exists).
 *   3. the row's `pool` is set — olam-client.js's enrich() only ever fills
 *      `pool` after a runner `/agent-run/status` probe SUCCEEDS with a phase
 *      or done=true; a pure plan-DO chat turn never touches the runner, so
 *      `pool` stays null for it.
 * Anything else falls through to `false` — "if in doubt, stay steer" (Phase B
 * adds the real upstream execute/chat discriminator; this is the interim,
 * deliberately conservative stand-in).
 *
 * @param {{ pool?: string|null }} session
 * @param {{ state?: string, containerSessionId?: string|null }|null|undefined} liveness
 * @returns {boolean}
 */
export function isExecuteShaped(session, liveness) {
  if (liveness?.state === 'dormant') return true;
  if (liveness?.containerSessionId) return true;
  if (session?.pool) return true;
  return false;
}

/**
 * Decide the composer mode for a remote session row. `liveness` is optional
 * (server-authoritative, on-demand only — see lib/olam-liveness.js) and only
 * ever demotes an execute-shaped session (isExecuteShaped) that is otherwise
 * headed for 'steer'; read-only and approve both outrank it.
 *
 * @param {{ inFlight?: boolean, halted?: boolean, planStatus?: string|null, readOnly?: boolean, pool?: string|null }} session
 * @param {{ state: 'live'|'dormant'|'unknown', phase?: string, done?: boolean, containerSessionId?: string }|null} [liveness]
 * @returns {'steer'|'approve'|'read-only'|'dormant'|'unknown'}
 */
export function composerMode(session, liveness) {
  if (session?.readOnly) return 'read-only';
  // A Linear session that has a plan but hasn't been approved yet: the first
  // reply is the approve. plan_status of 'planned'/'awaiting_approval' marks it.
  const ps = (session?.planStatus ?? '').toLowerCase();
  if (ps === 'planned' || ps === 'awaiting_approval' || ps === 'awaiting-approval') {
    return 'approve';
  }
  if (
    liveness &&
    (liveness.state === 'dormant' || liveness.state === 'unknown') &&
    isExecuteShaped(session, liveness)
  ) {
    return liveness.state;
  }
  return 'steer';
}

/**
 * Pre-send gate for a remote session (Phase A): resolves the composer mode
 * with liveness folded in and turns a locked-out mode into an ack-shaped
 * refusal, so server.js's WS 'reply' handler stays a thin dispatcher — this
 * is the one place "should this send even be attempted" is decided, and it's
 * unit-testable without booting the HTTP/WS stack.
 *
 * @param {Parameters<typeof composerMode>[0]} session
 * @param {Parameters<typeof composerMode>[1]} [liveness]
 * @returns {{ ok: true, mode: 'steer'|'approve' } | { ok: false, mode: 'read-only'|'dormant'|'unknown', error: string }}
 */
export function preSendGate(session, liveness) {
  const mode = composerMode(session, liveness);
  if (mode === 'read-only') {
    return { ok: false, mode, error: 'This session is read-only — steering is disabled.' };
  }
  if (mode === 'dormant' || mode === 'unknown') {
    return { ok: false, mode, error: DISPATCH_ERRORS[mode] };
  }
  return { ok: true, mode };
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
