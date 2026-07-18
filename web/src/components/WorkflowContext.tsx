import { createContext, useContext } from 'react';
import type { Workflow } from '../lib/types';

/**
 * Live workflow slice for the selected session, provided in App.tsx around the
 * Thread so a deep `Workflow` tool-block part (MessageParts) can bind to the
 * POLLED, live-updating run — not the frozen tool_result — without prop-drilling
 * through assistant-ui's Parts. Mirrors AgentKindContext's plumbing.
 *
 * The map is keyed by `runId` (the key the tool_result carries — see
 * MessageParts' extractWorkflowRunId). `openAgent` opens one agent's full
 * transcript overlay (wired in B3); undefined until then, in which case the card
 * renders read-only.
 */
export interface WorkflowContextValue {
  byRunId: Map<string, Workflow>;
  openAgent?: (runId: string, agentId: string, label: string) => void;
}

const EMPTY: WorkflowContextValue = { byRunId: new Map() };

export const WorkflowContext = createContext<WorkflowContextValue>(EMPTY);

export function useWorkflows(): WorkflowContextValue {
  return useContext(WorkflowContext);
}
