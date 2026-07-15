import { useEffect, useState } from 'react';
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
 * Horizontal wrapping row of PILLS — one per sub-agent in the current active
 * batch, directly above the composer. Each pill shows the agent name + a
 * status dot (`data-status="running" | "done"`, mirrored onto the pill
 * itself so CSS can style the whole pill per state — see `.subagent-pill`
 * rules in styles.css).
 *
 * `cockpit.subagents` accumulates every sub-agent dispatched all session
 * long (it's a map keyed by agentId, entries are never deleted — see
 * useCockpit.ts), so this can't just render "everything with status ===
 * 'done'" or the strip would resurrect agents from turns long past. Instead
 * a pill stays visible from the moment its agent starts running through the
 * moment the WHOLE current batch finishes: a sibling that finishes early
 * turns green and waits (steady, no pulse) next to any siblings still
 * running, then the entire row clears together the instant the last one in
 * the batch goes 'done' — that's "awaiting parent to respond/clear".
 */
export function SubAgentStrip({ subagents, onOpenAgent, viewingAgentId }: SubAgentStripProps) {
  // agentIds that are part of the currently-visible batch (added the moment
  // they're seen running; the whole set is dropped once none of them are
  // running any more, so a future batch starts from empty rather than
  // dragging along long-done agents from earlier in the session).
  const [batchIds, setBatchIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setBatchIds((prev) => {
      const runningIds = subagents.filter((a) => a.status === 'running').map((a) => a.agentId);
      if (runningIds.length === 0) {
        return prev.size === 0 ? prev : new Set();
      }
      let changed = false;
      const next = new Set(prev);
      for (const id of runningIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [subagents]);

  // Running agents are always shown immediately (no need to wait for the
  // effect above to register them); done agents show only while still part
  // of the tracked batch.
  const visible = subagents.filter((a) => a.status === 'running' || batchIds.has(a.agentId));
  const runningCount = visible.filter((a) => a.status === 'running').length;
  if (runningCount === 0) return null;

  const focused = viewingAgentId
    ? visible.find((a) => a.agentId === viewingAgentId) ?? null
    : null;
  const captionAgent = focused ?? visible.find((a) => a.status === 'running') ?? visible[0];
  const caption = latestAgentSummary(captionAgent);
  const doneCount = visible.length - runningCount;

  return (
    <div
      className="subagent-strip"
      role="list"
      aria-label={
        doneCount > 0
          ? `${runningCount} sub-agent${runningCount === 1 ? '' : 's'} running, ${doneCount} done`
          : `${runningCount} sub-agent${runningCount === 1 ? '' : 's'} running`
      }
    >
      <div className="subagent-pills">
        {visible.map((a) => (
          <button
            type="button"
            role="listitem"
            className="subagent-pill"
            key={a.agentId}
            data-status={a.status}
            data-active={a.agentId === viewingAgentId ? 'true' : undefined}
            onClick={() => onOpenAgent(a.agentId)}
            title={`View ${a.agentType || 'sub-agent'}'s transcript`}
          >
            <span className="sa-dot" data-status={a.status} aria-hidden="true" />
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
