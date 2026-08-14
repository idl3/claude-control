import type { Session } from './types';

/**
 * Presentation compatibility seam. New producers state their treatment
 * explicitly; older servers fall back to the historical kind convention.
 */
export function isTerminalPresentation(session: Pick<Session, 'kind' | 'presentation'>): boolean {
  return session.presentation === 'terminal' || session.kind === 'terminal';
}

export function isThreadPresentation(session: Pick<Session, 'kind' | 'presentation'>): boolean {
  return !isTerminalPresentation(session);
}
