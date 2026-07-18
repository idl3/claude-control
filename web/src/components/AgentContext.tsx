import { createContext, useContext } from 'react';

/**
 * The kind of the currently selected session: 'claude', 'claudex', 'codex', or
 * 'terminal'. Provided in App.tsx around the Thread so deep components (e.g.
 * MessageParts) can render the correct per-agent icon without prop-drilling.
 * Defaults to 'claude' so any uncontexted render stays safe. Consumers only
 * ever branch on `=== 'codex'` (with everything else rendering the Claude
 * icon), so 'claudex' — the claude binary pointed at the olam auth-worker —
 * already renders correctly with no dedicated branch.
 */
export const AgentKindContext = createContext<'claude' | 'claudex' | 'codex' | 'terminal'>('claude');

export function useAgentKind(): 'claude' | 'claudex' | 'codex' | 'terminal' {
  return useContext(AgentKindContext);
}
