import type { SubAgent } from '../lib/types';
import { latestAgentSummary } from '../lib/agentSummary';

interface SubAgentStripProps {
  subagents: SubAgent[];
  /** Open the full sub-agent panel (clicking the strip). */
  onOpen: () => void;
}

/**
 * Compact "what are my sub-agents doing right now" strip, shown directly above
 * the composer. Renders ONLY while ≥1 sub-agent is running: each row is the
 * agent type + its latest work line. Clicking opens the full sub-agent panel.
 */
export function SubAgentStrip({ subagents, onOpen }: SubAgentStripProps) {
  const running = subagents.filter((a) => a.status === 'running');
  if (running.length === 0) return null;

  return (
    <button
      type="button"
      className="subagent-strip"
      onClick={onOpen}
      aria-label={`${running.length} sub-agent${running.length === 1 ? '' : 's'} running — open panel`}
      title="Open sub-agents"
    >
      <span className="subagent-strip-rows">
        {running.map((a) => {
          const summary = latestAgentSummary(a);
          return (
            <span className="subagent-strip-row" key={a.agentId}>
              <span className="sa-dot" data-status="running" aria-hidden="true" />
              <span className="subagent-strip-type">{a.agentType || 'sub-agent'}</span>
              {summary ? (
                <span className="subagent-strip-summary">{summary}</span>
              ) : (
                <span className="subagent-strip-summary subagent-strip-idle">working…</span>
              )}
            </span>
          );
        })}
      </span>
    </button>
  );
}
