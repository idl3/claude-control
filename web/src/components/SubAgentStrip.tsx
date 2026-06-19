import type { SubAgent } from '../lib/types';
import { latestAgentSummary } from '../lib/agentSummary';

interface SubAgentStripProps {
  subagents: SubAgent[];
  /** Open a SPECIFIC running agent's transcript (the panel focused on it). */
  onOpenAgent: (agentId: string) => void;
}

/**
 * Live "what are my sub-agents doing" strip, stacked directly above the composer.
 * Renders ONLY while ≥1 sub-agent is running: one tappable row per agent (type +
 * latest work line). Tapping a row opens THAT agent's transcript — so with 2-3
 * agents you can toggle between them and read each one's thread.
 */
export function SubAgentStrip({ subagents, onOpenAgent }: SubAgentStripProps) {
  const running = subagents.filter((a) => a.status === 'running');
  if (running.length === 0) return null;

  return (
    <div
      className="subagent-strip"
      role="list"
      aria-label={`${running.length} sub-agent${running.length === 1 ? '' : 's'} running`}
    >
      {running.map((a) => {
        const summary = latestAgentSummary(a);
        return (
          <button
            type="button"
            role="listitem"
            className="subagent-strip-row"
            key={a.agentId}
            onClick={() => onOpenAgent(a.agentId)}
            title={`Open ${a.agentType || 'sub-agent'}'s transcript`}
          >
            <span className="sa-dot" data-status="running" aria-hidden="true" />
            <span className="subagent-strip-head">
              <span className="subagent-strip-type">{a.agentType || 'sub-agent'}</span>
              {summary ? (
                <span className="subagent-strip-summary">{summary}</span>
              ) : (
                <span className="subagent-strip-summary subagent-strip-idle">working…</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
