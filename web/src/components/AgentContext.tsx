import { createContext, useContext } from 'react';

/**
 * The kind of the currently selected session: 'claude', 'claudex', 'claudemi',
 * 'codex', or 'terminal'. Provided in App.tsx around the Thread so deep
 * components (e.g. MessageParts) can render the correct per-agent icon
 * without prop-drilling. Defaults to 'claude' so any uncontexted render stays
 * safe. Consumers only ever branch on `=== 'codex'` (with everything else
 * rendering the Claude icon), so 'claudex'/'claudemi' — the claude binary
 * pointed at the olam auth-worker (OpenAI or Kimi respectively) — already
 * render correctly with no dedicated branch.
 */
export const AgentKindContext = createContext<'claude' | 'claudex' | 'claudemi' | 'codex' | 'terminal'>('claude');

export function useAgentKind(): 'claude' | 'claudex' | 'claudemi' | 'codex' | 'terminal' {
  return useContext(AgentKindContext);
}
