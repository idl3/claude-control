// Pure logic for the spawn-picker feature (P3). No React, no DOM.
// The React component (SpawnPicker.tsx) is a thin shell over these functions.

import type { SpawnClientMessage } from './types';

export type { SpawnClientMessage };

export interface AgentInfo {
  id: 'claude' | 'codex';
  available: boolean;
  reason?: string;
}

export interface TmuxSessionInfo {
  name: string;
  cwd?: string;
}

export type SpawnMode = 'new-window' | 'new-session';

export interface SpawnFormState {
  agentType: 'claude' | 'codex';
  mode: SpawnMode;
  /** For mode==='new-window': the existing tmux session name to open a window in. */
  session: string;
  /** For mode==='new-session': the new tmux session name to create. */
  name: string;
  cwd: string;
}

// Session names may only contain alphanumerics, hyphens, and underscores.
// Dots and colons are not valid (tmux interprets them specially).
const SESSION_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Build the WS ClientMessage from form state.
 * Returns null when the form is not in a submittable state so the component can
 * disable the submit button. Pure — no side-effects.
 */
export function buildSpawnMessage(state: SpawnFormState): SpawnClientMessage | null {
  const { agentType, mode, session, name, cwd } = state;

  // agentType guard
  if (agentType !== 'claude' && agentType !== 'codex') return null;

  // cwd must be non-empty after trim
  if (!cwd.trim()) return null;

  if (mode === 'new-window') {
    if (!session.trim()) return null;
    return {
      type: 'spawn',
      agentType,
      target: { mode: 'new-window', session: session.trim() },
      cwd: cwd.trim(),
    };
  }

  // mode === 'new-session'
  const trimmedName = name.trim();
  if (!trimmedName) return null;
  if (!SESSION_NAME_RE.test(trimmedName)) return null;

  return {
    type: 'spawn',
    agentType,
    target: { mode: 'new-session' },
    cwd: cwd.trim(),
    name: trimmedName,
  };
}

/**
 * Advisory client-side validation. Returns a map of field → error string for
 * inline display. Empty map = no errors. The server is authoritative; these
 * checks are UX-only.
 */
export function validateSpawnForm(
  state: SpawnFormState,
): Partial<Record<keyof SpawnFormState, string>> {
  const errors: Partial<Record<keyof SpawnFormState, string>> = {};

  if (state.cwd && !state.cwd.trim().startsWith('/')) {
    errors.cwd = 'Working directory should be an absolute path (start with /)';
  }

  if (state.mode === 'new-session' && state.name) {
    if (!SESSION_NAME_RE.test(state.name.trim())) {
      errors.name =
        'Session name may only contain letters, digits, hyphens, and underscores';
    }
  }

  return errors;
}

/**
 * Given the /api/agents response, return the reason string if the agent should
 * be shown as disabled, or null if it's selectable.
 */
export function agentDisabledReason(
  agents: AgentInfo[],
  id: 'claude' | 'codex',
): string | null {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return `${id} is not available on this server`;
  if (!agent.available) return agent.reason ?? `${id} is not available`;
  return null;
}
