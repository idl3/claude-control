import type { SubAgent } from '../lib/types';
import { latestAgentSummary } from '../lib/agentSummary';

interface SubAgentStripProps {
  subagents: SubAgent[];
  /** Called when the user clicks a pill — set the inline agent view. */
  onOpenAgent: (agentId: string) => void;
  /** The agentId currently shown inline (marks that pill as active). */
  viewingAgentId?: string | null;
}

/**
 * Horizontal wrapping row of PILLS — one per running sub-agent, directly
 * above the composer. Each pill shows the agent name + animated dot. The
 * activity caption for the active/focused agent is shown below the row.
 * Clicking a pill sets the inline inline agent transcript view.
 */
export function SubAgentStrip({ subagents, onOpenAgent, viewingAgentId }: SubAgentStripProps) {
  const running = subagents.filter((a) => a.status === 'running');
  if (running.length === 0) return null;

  const focused = viewingAgentId
    ? running.find((a) => a.agentId === viewingAgentId) ?? null
    : null;
  const captionAgent = focused ?? running[0];
  const caption = latestAgentSummary(captionAgent);

  return (
    <div
      className="subagent-strip"
      role="list"
      aria-label={`${running.length} sub-agent${running.length === 1 ? '' : 's'} running`}
    >
      <div className="subagent-pills">
        {running.map((a) => (
          <button
            type="button"
            role="listitem"
            className="subagent-pill"
            key={a.agentId}
            data-active={a.agentId === viewingAgentId ? 'true' : undefined}
            onClick={() => onOpenAgent(a.agentId)}
            title={`View ${a.agentType || 'sub-agent'}'s transcript`}
          >
            <span className="sa-dot" data-status="running" aria-hidden="true" />
            <span className="subagent-pill-name">{a.agentType || 'sub-agent'}</span>
          </button>
        ))}
      </div>
      {caption ? (
        <p className="subagent-strip-caption" aria-live="polite">
          {caption}
        </p>
      ) : null}
    </div>
  );
}
