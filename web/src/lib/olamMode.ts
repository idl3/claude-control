import type { Session } from './types';

/**
 * Client mirror of lib/olam-transport.js composerMode — decides how the
 * composer behaves for a remote (olam) session. Kept in lockstep with the
 * server helper (the server is authoritative; this drives the UI affordance).
 *
 *   steer      — running session; POST cloud-dispatch (soft/hard), OR — when
 *                shouldSteerDoor(session, liveness) is true (Phase B, B3) —
 *                the steer door (POST /api/session-steer) instead. The
 *                server (dispatchLiveSteer) is authoritative for the actual
 *                routing; shouldSteerDoor here drives UI affordances only
 *                (hard-steer toggle gating, next-turn-boundary composer copy).
 *   approve    — Linear session awaiting first reply; the operator's reply IS
 *                the approve.
 *   read-only  — shared (#ro) / unauthed session; no steer path — refuse.
 *   dormant    — (Phase A) an execute-shaped session whose container has been
 *                disposed; steering is refused honestly instead of 404ing.
 *   unknown    — (Phase A) liveness couldn't be determined for an
 *                execute-shaped session; refused the same way as dormant.
 *
 * Mode precedence: read-only > approve > dormant/unknown > steer.
 */
export type RemoteComposerMode = 'steer' | 'approve' | 'read-only' | 'dormant' | 'unknown';

/** Server-authoritative liveness read (GET /api/olam/liveness). Optional —
 * held as on-demand component state, NEVER folded onto the polled Session.
 *
 * `'n/a'` (CP3 audit Finding 2) is the server's honest default for a check
 * that was never actually attempted/applicable — distinct from `'unknown'`,
 * which means a check WAS attempted and its result couldn't be determined.
 * `remoteComposerMode`/`isExecuteShaped` treat `'n/a'` identically to no
 * liveness at all: it never demotes the composer. */
export interface SessionLiveness {
  state: 'live' | 'dormant' | 'unknown' | 'n/a';
  phase?: string;
  done?: boolean;
  containerSessionId?: string;
}

/**
 * Conservative execute/chat discriminator — mirrors lib/olam-transport.js's
 * isExecuteShaped. Session rows carry no explicit execute-vs-chat flag today,
 * so liveness is only allowed to touch the composer mode with POSITIVE
 * evidence a real execute container ran for this session: `dormant` liveness,
 * a `containerSessionId`, or a confirmed `pool` on the row. Anything else
 * falls through to `false` — "if in doubt, stay steer".
 */
export function isExecuteShaped(session: Session | null | undefined, liveness?: SessionLiveness | null): boolean {
  if (liveness?.state === 'dormant') return true;
  if (liveness?.containerSessionId) return true;
  if ((session as { pool?: string | null } | null | undefined)?.pool) return true;
  return false;
}

/**
 * The B3 routing predicate (cloud-session-chat Phase B) — mirrors
 * lib/olam-transport.js's shouldSteerDoor exactly. An execute-shaped session
 * routes composer sends through the steer door (POST /api/session-steer)
 * instead of cloud-dispatch only when liveness is confirmed 'live'. The
 * server (dispatchLiveSteer) makes the actual routing decision; this drives
 * the hard-steer toggle's gating and the "next turn boundary" composer copy.
 */
export function shouldSteerDoor(session: Session | null | undefined, liveness?: SessionLiveness | null): boolean {
  return isExecuteShaped(session, liveness) && liveness?.state === 'live';
}

export function remoteComposerMode(
  session: Session | null | undefined,
  liveness?: SessionLiveness | null,
): RemoteComposerMode {
  if (!session || session.kind !== 'remote') return 'steer';
  if ((session as { readOnly?: boolean }).readOnly) return 'read-only';
  const ps = (session.planStatus ?? '').toLowerCase();
  if (ps === 'planned' || ps === 'awaiting_approval' || ps === 'awaiting-approval') return 'approve';
  if (liveness && (liveness.state === 'dormant' || liveness.state === 'unknown') && isExecuteShaped(session, liveness)) {
    return liveness.state;
  }
  return 'steer';
}

/** Refusal copy for a send attempted while locked out — mirrors server's DISPATCH_ERRORS. */
export const REMOTE_REFUSAL_MESSAGES: Record<'dormant' | 'unknown', string> = {
  dormant: 'session dormant — resume support lands in Phase C',
  unknown: 'session liveness unknown — steering disabled until state is confirmed',
};

/** Exhaustive mode → pill label. Switch (not a ternary/default-else) so a
 * new RemoteComposerMode value fails TS compilation instead of silently
 * rendering the wrong pill. */
export function remoteModeLabel(mode: RemoteComposerMode): string {
  switch (mode) {
    case 'steer': return '⇄ steer';
    case 'approve': return '✓ approve';
    case 'read-only': return '👁 read-only';
    case 'dormant': return '⏸ dormant';
    case 'unknown': return '? unknown';
    default: {
      const _exhaustive: never = mode;
      return `⚠ ${String(_exhaustive)}`;
    }
  }
}

/** Exhaustive mode → pill title/tooltip. */
export function remoteModeTitle(mode: RemoteComposerMode): string {
  switch (mode) {
    case 'steer': return 'Reply steers the running session';
    case 'approve': return 'Reply approves the plan and starts the run';
    case 'read-only': return 'Shared session — steering is disabled';
    case 'dormant': return REMOTE_REFUSAL_MESSAGES.dormant;
    case 'unknown': return REMOTE_REFUSAL_MESSAGES.unknown;
    default: {
      const _exhaustive: never = mode;
      return `Unrecognised composer mode: ${String(_exhaustive)}`;
    }
  }
}
