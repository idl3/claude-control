import { createContext, useContext } from 'react';

/**
 * The kind of the currently selected session: 'claude', 'claudex', 'claudemi',
 * 'codex', 'codewhale', or 'terminal'. Provided in App.tsx around the Thread so deep
 * components (e.g. MessageParts) can render the correct per-agent icon
 * without prop-drilling. Defaults to 'claude' so any uncontexted render stays
 * safe. Icon consumers distinguish Codex and CodeWhale; Claudex/Claudemi use
 * the Claude mark because they are the Claude binary pointed at an alternate
 * auth worker.
 */
export type AgentKind = 'claude' | 'claudex' | 'claudemi' | 'codex' | 'codewhale' | 'terminal';

export const AgentKindContext = createContext<AgentKind>('claude');

export function useAgentKind(): AgentKind {
  return useContext(AgentKindContext);
}
