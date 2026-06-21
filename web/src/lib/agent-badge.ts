// Pure logic for deriving the agent-type badge shown in the session rail.
// Extracted so it can be unit-tested independently of the React component.

export type AgentKind = 'claude' | 'codex';

export interface AgentBadgeInfo {
  label: string;
  kind: AgentKind;
}

/**
 * Returns badge label + kind for a given agentType, or null when the agent
 * type is unknown / undefined (legacy sessions with no agentType set).
 */
export function agentBadge(
  agentType: AgentKind | undefined,
): AgentBadgeInfo | null {
  if (agentType === 'claude') return { label: 'CLA', kind: 'claude' };
  if (agentType === 'codex') return { label: 'CDX', kind: 'codex' };
  return null;
}

/**
 * Converts per-question Set<string> selections to the string[][] payload shape
 * that the server's `answer` message expects.
 *
 * selectionsToPayload([new Set(['Yes, proceed'])]) => [['Yes, proceed']]
 */
export function selectionsToPayload(selections: Set<string>[]): string[][] {
  return selections.map((s) => [...s]);
}
