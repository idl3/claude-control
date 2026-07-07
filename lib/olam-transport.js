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
 *   steer      — running session; POST cloud-dispatch (soft/hard), OR — when
 *                shouldSteerDoor(session, liveness) is true (Phase B, B3) —
 *                the steer door (POST /api/session-steer) instead. See
 *                dispatchLiveSteer.
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
 *
 * Phase B (B3) steer-door routing: within the 'steer' mode, a SECOND
 * decision picks the transport — shouldSteerDoor(session, liveness) is true
 * only for an execute-shaped session with liveness.state === 'live' (a
 * strictly stronger claim than isExecuteShaped alone; see shouldSteerDoor).
 * Plan/chat sessions never satisfy it (they never read 'live'), so their
 * sends stay byte-identical to the pre-Phase-B cloud-dispatch path.
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
  // alongside the numeric-status entries above. `dormant` is only reached via
  // preSendGate's own unit tests now — server.js's WS 'reply' handler (Phase
  // C, task C5) intercepts a dormant gate.mode BEFORE using gate.error and
  // routes to dispatchResume instead, so a live send never actually surfaces
  // this string.
  dormant: 'session dormant — send Resume & send to reconstitute it',
  unknown: 'session liveness unknown — steering disabled until state is confirmed',
  // Phase B (cloud-session-chat B3) — steer-door (POST /api/session-steer)
  // fallback strings. B1's contract has 409 (conflicting steer already
  // queued) and 422 (refused, e.g. no live container) carry a dynamic
  // `reason`/`error` field in the response body; dispatchLiveSteer's
  // steerDoorPost prefers that verbatim and only falls back to these when
  // the body has no parseable reason. Non-numeric keys (like dormant/unknown
  // above) so the numeric-status exhaustive test below skips them — 404/429/
  // 402/502 are door-agnostic infra failures and reuse the entries above.
  steerConflict: 'a steer is already queued for this session — wait for it to claim',
  steerInvalid: 'steer refused — the session is not live-steerable right now',
  // Phase C (cloud-session-chat C5) — /api/cloud-resume failure classes.
  // Keyed by the response body's `error` field (a fixed enum, not free text —
  // see resumeErrorFromBody), so these are looked up the same way as
  // dormant/unknown above. 409 covers four sub-classes distinguished by
  // `error`; 422 covers one. `pr_fix_in_flight` additionally carries a
  // `prUrl` the operator needs to click — resumeErrorFromBody appends it.
  pr_fix_in_flight: 'a fix run is updating this PR; open it',
  resume_in_flight: 'a turn is already running',
  execute_in_flight: 'a turn is already running',
  session_live: 'session is live — steer instead',
  no_execute_state: 'this session has no resumable state',
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
 * The B3 routing predicate (cloud-session-chat Phase B): an execute-shaped
 * session routes through the steer door (POST /api/session-steer) instead
 * of cloud-dispatch only when liveness is confirmed `'live'`. `'live'` is a
 * strictly stronger claim than isExecuteShaped's positive-evidence set
 * (dormant/containerSessionId/pool) — plan-DO's probeLiveness only ever
 * returns it for a session with a MAPPED container whose phase is non-empty
 * and `disposed !== true` (packages/plan-agent-do/src/plan-agent.ts). Plan/
 * chat sessions carry no mapping at all, so they can only ever read
 * `'unknown'` — never `'live'` — which keeps this predicate false for them
 * by construction and their sends byte-identical to today's cloud-dispatch
 * path (Phase B B3 acceptance).
 *
 * Single source of truth for the routing decision: server.js's WS 'reply'
 * handler (via dispatchLiveSteer) and the client mirror
 * (web/src/lib/olamMode.ts) must both call this, never re-derive it.
 *
 * @param {Parameters<typeof isExecuteShaped>[0]} session
 * @param {Parameters<typeof isExecuteShaped>[1]} liveness
 * @returns {boolean}
 */
export function shouldSteerDoor(session, liveness) {
  return isExecuteShaped(session, liveness) && liveness?.state === 'live';
}

/**
 * Decide the composer mode for a remote session row. `liveness` is optional
 * (server-authoritative, on-demand only — see lib/olam-liveness.js) and only
 * ever demotes an execute-shaped session (isExecuteShaped) that is otherwise
 * headed for 'steer'; read-only and approve both outrank it.
 *
 * `liveness.state` may also be `'n/a'` — the server's honest default for a
 * check that was never actually attempted/applicable (CP3 audit Finding 2;
 * distinct from `'unknown'`, which means a check was attempted and its
 * result couldn't be determined). `'n/a'` is treated identically to no
 * liveness at all: it never demotes the composer.
 *
 * @param {{ inFlight?: boolean, halted?: boolean, planStatus?: string|null, readOnly?: boolean, pool?: string|null }} session
 * @param {{ state: 'live'|'dormant'|'unknown'|'n/a', phase?: string, done?: boolean, containerSessionId?: string }|null} [liveness]
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
 * Extract a dynamic `reason`/`error` string from a steer-door JSON body, if
 * present (B1's 409/422 contract: "pass through with reason"). Never throws
 * — a malformed/reason-less body degrades to `null` so the caller falls back
 * to DISPATCH_ERRORS.steerConflict/steerInvalid.
 *
 * @param {{ json: () => Promise<any> }} res
 * @returns {Promise<string|null>}
 */
async function steerDoorReason(res) {
  try {
    const data = await res.json();
    const reason = data?.reason ?? data?.error;
    return typeof reason === 'string' && reason ? reason : null;
  } catch {
    return null;
  }
}

/**
 * POST the B1 steer door: `{session_id, instruction, mode}` →
 * `/api/session-steer`. Never throws — the same typed-result contract as
 * dispatchSteer. 409 (conflicting steer already queued) and 422 (refused —
 * e.g. no live container) prefer the response body's `reason`/`error` field
 * verbatim; every other failure class (404 not-owner, 429/402/502 infra,
 * network throw) falls back to the shared DISPATCH_ERRORS map exactly like
 * dispatchSteer.
 *
 * @param {import('./olam-client.js').OlamOrgClient} client
 * @param {{ sessionId: string, draft: string, mode?: 'soft'|'hard' }} args
 * @returns {Promise<{ ok: true, status: number } | { ok: false, status: number|null, error: string }>}
 */
async function steerDoorPost(client, { sessionId, draft, mode = 'soft' }) {
  const body = { session_id: sessionId, instruction: draft, mode };
  let res;
  try {
    res = await client.apiPost('/api/session-steer', body);
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message ?? err) };
  }
  if (res.ok) return { ok: true, status: res.status };
  if (res.status === 409 || res.status === 422) {
    const reason = await steerDoorReason(res);
    const fallback = res.status === 409 ? DISPATCH_ERRORS.steerConflict : DISPATCH_ERRORS.steerInvalid;
    return { ok: false, status: res.status, error: reason ?? fallback };
  }
  const known = DISPATCH_ERRORS[res.status];
  let detail = known;
  if (!known) {
    const text = await res.text().catch(() => '');
    detail = `steer failed HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
  }
  return { ok: false, status: res.status, error: detail };
}

/**
 * Route a remote-session send to the correct transport (Phase B, task B3):
 * the steer door when shouldSteerDoor(session, liveness) is true, else the
 * existing cloud-dispatch mirror (dispatchSteer) — byte-identical to today
 * for plan/chat sessions. Never throws; resolves to the same
 * {ok,status,error}-shaped result as dispatchSteer plus a `door` field so
 * the caller (server.js) can ack back which transport actually carried the
 * send.
 *
 * @param {import('./olam-client.js').OlamOrgClient} client
 * @param {{ worldId?: string, sessionId: string, pool?: string|null }} session
 * @param {{ state?: string, containerSessionId?: string|null }|null|undefined} liveness
 * @param {string} draft
 * @param {'soft'|'hard'} [mode]
 * @returns {Promise<{ ok: true, status: number, door: 'steer-live'|'dispatch' } | { ok: false, status: number|null, error: string, door: 'steer-live'|'dispatch' }>}
 */
export async function dispatchLiveSteer(client, session, liveness, draft, mode = 'soft') {
  if (shouldSteerDoor(session, liveness)) {
    const result = await steerDoorPost(client, { sessionId: session?.sessionId, draft, mode });
    return { ...result, door: 'steer-live' };
  }
  const result = await dispatchSteer(client, {
    worldId: session?.worldId,
    sessionId: session?.sessionId,
    draft,
    mode,
  });
  return { ...result, door: 'dispatch' };
}

/**
 * Classify a /api/cloud-resume failure body against the resume-specific
 * DISPATCH_ERRORS keys (409's four sub-classes + 422's one). Never throws —
 * a malformed/unrecognised body degrades to `null` so the caller falls back
 * to the generic numeric-status branch. Unlike steerDoorReason (which passes
 * a free-text `reason` through verbatim), the resume contract's `error`
 * field is a fixed enum, so this is a keyed DISPATCH_ERRORS lookup instead.
 * `pr_fix_in_flight` additionally carries the PR URL the operator needs to
 * actually click — appended to the message and returned as its own `prUrl`
 * field so the UI can render a real link (a toast alone can't).
 *
 * @param {{ json: () => Promise<any> }} res
 * @returns {Promise<{ error: string, prUrl?: string }|null>}
 */
async function resumeErrorFromBody(res) {
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const key = data?.error;
  if (typeof key !== 'string' || !DISPATCH_ERRORS[key]) return null;
  if (key === 'pr_fix_in_flight' && typeof data?.prUrl === 'string' && data.prUrl) {
    return { error: `${DISPATCH_ERRORS[key]}: ${data.prUrl}`, prUrl: data.prUrl };
  }
  return { error: DISPATCH_ERRORS[key] };
}

/**
 * Resume a dormant remote session and deliver the operator's message in ONE
 * call (Phase C, task C5). Mirrors the SPA's /api/cloud-resume contract:
 * `{session_id, message}` — identity is server-derived by the SPA, so no
 * actorSub rides here. The plan-DO reconstitutes the session and renders
 * `message` as the "## Current request" half of the resumed run (D14: the
 * steer door — POST /api/session-steer — is NEVER also called for a resume;
 * that would double-deliver the message). The reply streams back over the
 * SAME chunks-shape subscription the transcript already renders (Phase B) —
 * no separate response plumbing needed once this resolves ok:true. Never
 * throws — the same typed-result contract as dispatchSteer.
 *
 * @param {import('./olam-client.js').OlamOrgClient} client
 * @param {{ sessionId: string }} session
 * @param {string} draft
 * @returns {Promise<
 *   { ok: true, status: number, resumed: true, worldId: string|null, containerSessionId: string|null } |
 *   { ok: false, status: number|null, error: string, prUrl?: string }
 * >}
 */
export async function dispatchResume(client, session, draft) {
  const body = { session_id: session?.sessionId, message: draft };
  let res;
  try {
    res = await client.apiPost('/api/cloud-resume', body);
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message ?? err) };
  }
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    return {
      ok: true,
      status: res.status,
      resumed: true,
      worldId: data?.worldId ?? null,
      containerSessionId: data?.containerSessionId ?? null,
    };
  }
  const classed = await resumeErrorFromBody(res);
  if (classed) {
    return { ok: false, status: res.status, error: classed.error, ...(classed.prUrl ? { prUrl: classed.prUrl } : {}) };
  }
  const known = DISPATCH_ERRORS[res.status];
  let detail = known;
  if (!known) {
    const text = await res.text().catch(() => '');
    detail = `resume failed HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
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
