import { createContext, useContext } from 'react';

/**
 * The kind of the currently selected session: 'claude', 'codex', or 'terminal'.
 * Provided in App.tsx around the Thread so deep components (e.g. MessageParts)
 * can render the correct per-agent icon without prop-drilling.
 * Defaults to 'claude' so any uncontexted render stays safe.
 */
export const AgentKindContext = createContext<'claude' | 'codex' | 'terminal'>('claude');

export function useAgentKind(): 'claude' | 'codex' | 'terminal' {
  return useContext(AgentKindContext);
}
