import { useEffect, useState } from 'react';
import type { SubAgent } from '../lib/types';
import { latestAgentSummary, recentAgentSummaries } from '../lib/agentSummary';

interface SubAgentStripProps {
  subagents: SubAgent[];
  /** Called when the user clicks a pill — set the inline agent view. */
  onOpenAgent: (agentId: string) => void;
  /** The agentId currently shown inline (marks that pill as active). */
  viewingAgentId?: string | null;
  /** True while the parent turn is still active — a finished sub-agent stays
   *  visible (green, awaiting the parent to read/clear) until the whole turn
   *  ends. */
  working?: boolean;
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
 * useClaudeControl.ts), so this can't just render "everything with status ===
 * 'done'" or the strip would resurrect agents from turns long past. Instead
 * a pill stays visible from the moment its agent starts running through the
 * moment the WHOLE current batch finishes: a sibling that finishes early
 * turns green and waits (steady, no pulse) next to any siblings still
 * running, then the entire row clears together the instant the last one in
 * the batch goes 'done' — that's "awaiting parent to respond/clear".
 */
export function SubAgentStrip({ subagents, onOpenAgent, viewingAgentId, working }: SubAgentStripProps) {
  // agentIds that are part of the currently-visible batch (added the moment
  // they're seen running; the whole set is dropped once none of them are
  // running any more, so a future batch starts from empty rather than
  // dragging along long-done agents from earlier in the session).
  const [batchIds, setBatchIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setBatchIds((prev) => {
      const runningIds = subagents.filter((a) => a.status === 'running').map((a) => a.agentId);
      // Clear the batch only when the parent has finished the turn (not working)
      // AND nothing is running — i.e. it has consumed all sub-agent results.
      // While `working`, finished agents linger (green) beside any still running.
      if (runningIds.length === 0 && !working) {
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
  }, [subagents, working]);

  // Running agents are always shown immediately (no need to wait for the
  // effect above to register them); done agents show only while still part
  // of the tracked batch.
  const visible = subagents.filter((a) => a.status === 'running' || batchIds.has(a.agentId));
  const runningCount = visible.filter((a) => a.status === 'running').length;
  const doneCount = visible.length - runningCount;
  if (visible.length === 0) return null;

  const focused = viewingAgentId
    ? visible.find((a) => a.agentId === viewingAgentId) ?? null
    : null;
  const captionAgent = focused ?? visible.find((a) => a.status === 'running') ?? visible[0];
  const caption = latestAgentSummary(captionAgent);
  // Last (up to) 5 distinct activity lines for the captionAgent, oldest
  // first / most recent last — pulled straight from the agent's own
  // transcript (agentSummary.ts) rather than a component-local rolling
  // buffer, so switching the focused agent or losing/regaining a batch
  // never leaves the quick-view panel showing a stale/foreign agent's
  // history. Feeds the hover-expand quick view below.
  const recentLines = recentAgentSummaries(captionAgent, 5);

  const ariaLabel =
    runningCount > 0 && doneCount > 0
      ? `${runningCount} sub-agent${runningCount === 1 ? '' : 's'} running, ${doneCount} done`
      : runningCount > 0
        ? `${runningCount} sub-agent${runningCount === 1 ? '' : 's'} running`
        : `${doneCount} done`;

  return (
    <div className="subagent-strip" role="list" aria-label={ariaLabel}>
      {(() => {
        const nested = visible.flatMap((a) => a.nested ?? []);
        if (nested.length === 0) return null;
        return (
          <div className="subagent-pills subagent-pills-nested" role="list" aria-label="Nested sub-agents">
            {nested.map((n) => (
              <span
                role="listitem"
                className="subagent-pill subagent-pill-nested"
                key={n.agentId}
                data-status="running"
                title={`${n.agentType || 'sub-agent'} (nested)`}
              >
                <span className="sa-dot" data-status="running" aria-hidden="true" />
                <span className="subagent-pill-name">{n.agentType || 'sub-agent'}</span>
              </span>
            ))}
          </div>
        );
      })()}
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
        // Hover/focus wrapper: resting state shows only the single truncated
        // `.subagent-strip-caption` line; `.subagent-quickview-panel` sits
        // absolutely positioned on top of it (bottom-anchored, grows upward —
        // same overhang idea as the pill row above) and is revealed by pure
        // CSS on `:hover`/`:focus-within` (styles.css), so it never pushes
        // the composer down. tabIndex makes it keyboard-reachable too.
        <div className="subagent-strip-caption-wrap" tabIndex={0}>
          <p className="subagent-strip-caption" aria-live="polite">
            {/* Keyed on the text itself: each change remounts this span, so
                the CSS `subagent-caption-in` keyframe (styles.css) plays a
                fresh slide-up + fade every time the activity line changes —
                a smooth, compositor-only replacement for the old SlotText
                char-roll, which read as too busy/distracting here. */}
            <span key={caption} className="subagent-progress-text">
              {caption}
            </span>
          </p>
          {recentLines.length > 1 ? (
            <div
              className="subagent-quickview-panel"
              role="group"
              aria-label="Recent activity"
            >
              {recentLines.map((line, i) => (
                <p
                  key={i}
                  className="subagent-quickview-line"
                  data-latest={i === recentLines.length - 1 ? 'true' : undefined}
                >
                  {line}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
