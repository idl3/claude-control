import { useEffect, useRef, useState } from 'react';
import type { Workflow, WorkflowAgent } from '../lib/types';
import { fmtDuration } from './WorkflowCard';

/**
 * Live Dock (Phase C1) — a compact progress strip pinned above the composer
 * while a workflow is running, so live progress is reachable without scrolling
 * (design H1). Mounts in Thread.tsx beside SubAgentStrip, i.e. inside the SAME
 * above-composer surface, so it inherits the `body.kbd-up` / visualViewport
 * mobile-keyboard pinning shipped in #311 for free.
 *
 * State grammar mirrors the card: amber while running, green ✓ flash on
 * completion (~4s, then dismisses), red on failure — always dot-shape + text,
 * never hue alone (design H3). Tap → scroll to the inline WorkflowCard.
 */

/** The run the dock shows: the most-recently-started still-running run. */
export function pickActiveRun(workflows: readonly Workflow[]): Workflow | null {
  let best: Workflow | null = null;
  for (const w of workflows) {
    if (w.status !== 'running') continue;
    if (!best || (w.startTime ?? 0) > (best.startTime ?? 0)) best = w;
  }
  return best;
}

/** "What is it doing right now": the most-recently-started running agent. */
export function currentAgent(w: Workflow): WorkflowAgent | null {
  let best: WorkflowAgent | null = null;
  for (const phase of w.phases ?? []) {
    for (const a of phase.agents ?? []) {
      if (a.state !== 'running') continue;
      if (!best || (a.startedAt ?? 0) > (best.startedAt ?? 0)) best = a;
    }
  }
  return best;
}

/** The phase the header line names: the first phase with a running agent, else
 *  the first not-fully-done phase, else the last. */
export function activePhaseTitle(w: Workflow): string | null {
  const phases = w.phases ?? [];
  for (const p of phases) {
    if ((p.agents ?? []).some((a) => a.state === 'running')) return p.title;
  }
  for (const p of phases) {
    if ((p.agents ?? []).some((a) => a.state !== 'done')) return p.title;
  }
  return phases.length ? phases[phases.length - 1].title : null;
}

interface WorkflowLiveDockProps {
  /** The selected session's runs (cockpit.workflowsById slice). */
  workflows: readonly Workflow[];
  /** Scroll to / reveal the inline card for this run. */
  onOpenCard: (runId: string) => void;
}

const DONE_FLASH_MS = 4000;

export function WorkflowLiveDock({ workflows, onOpenCard }: WorkflowLiveDockProps) {
  const run = pickActiveRun(workflows);
  const runningCount = workflows.filter((w) => w.status === 'running').length;

  // Completion flash: when the run the dock was showing stops running, keep a
  // "✓ done · {dur}" (or red "failed") strip for a few seconds, then dismiss.
  const [flash, setFlash] = useState<Workflow | null>(null);
  const prevRunId = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRunId.current;
    prevRunId.current = run?.runId ?? null;
    if (prev && !run) {
      const finished = workflows.find((w) => w.runId === prev);
      if (finished) {
        setFlash(finished);
        const t = setTimeout(() => setFlash(null), DONE_FLASH_MS);
        return () => clearTimeout(t);
      }
    }
    if (run) setFlash(null);
  }, [run, workflows]);

  const shown = run ?? flash;
  if (!shown) return null;

  const failed = !run && shown.status !== 'completed' && shown.status !== 'running';
  const state = run ? 'running' : failed ? 'failed' : 'done';
  const pct = shown.total > 0 ? Math.round((shown.done / shown.total) * 100) : 0;
  const phase = activePhaseTitle(shown);
  const agent = run ? currentAgent(run) : null;
  const name = shown.workflowName || 'workflow';
  const dur = fmtDuration(shown.durationMs);

  const headline = run
    ? `${phase ?? name} ${shown.done}/${shown.total}`
    : failed
      ? `${name} failed · ${shown.done}/${shown.total}`
      : `${name} done${dur ? ` · ${dur}` : ''}`;

  return (
    <div className="wf-dock-wrap" aria-live="polite">
      <button
        type="button"
        className="wf-dock"
        data-state={state}
        onClick={() => onOpenCard(shown.runId)}
        title={`${name} — open the workflow card`}
        aria-label={`Workflow ${name}, ${state}, ${shown.done} of ${shown.total} agents. Open card.`}
      >
        <span className="wf-dock-glyph" aria-hidden="true">
          {run ? '⚙' : failed ? '✕' : '✓'}
        </span>
        <span className="wf-dock-main">
          <span className="wf-dock-head">
            <span className="wf-dock-phase">{headline}</span>
            {runningCount > 1 ? (
              <span className="wf-dock-more">+{runningCount - 1} more</span>
            ) : null}
          </span>
          <span className="wf-dock-bar" aria-hidden="true">
            <span className="wf-dock-fill" style={{ width: `${pct}%` }} />
          </span>
          {agent ? (
            <span className="wf-dock-agent">
              <span className="wf-dock-agent-label">{agent.label || agent.agentType || 'agent'}</span>
              {agent.lastToolName ? (
                <span className="wf-dock-agent-tool">{agent.lastToolName}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="wf-dock-chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </div>
  );
}
