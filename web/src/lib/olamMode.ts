import type { Session } from './types';

/**
 * Client mirror of lib/olam-transport.js composerMode — decides how the
 * composer behaves for a remote (olam) session. Kept in lockstep with the
 * server helper (the server is authoritative; this drives the UI affordance).
 */
export type RemoteComposerMode = 'steer' | 'approve' | 'read-only';

export function remoteComposerMode(session: Session | null | undefined): RemoteComposerMode {
  if (!session || session.kind !== 'remote') return 'steer';
  if ((session as { readOnly?: boolean }).readOnly) return 'read-only';
  const ps = (session.planStatus ?? '').toLowerCase();
  if (ps === 'planned' || ps === 'awaiting_approval' || ps === 'awaiting-approval') return 'approve';
  return 'steer';
}
