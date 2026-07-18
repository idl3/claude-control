import { memo, useCallback, useMemo, useState } from 'react';
import type { Workflow, WorkflowPhase, WorkflowAgent } from '../lib/types';

// ---------------------------------------------------------------------------
// Formatting — pure, total. All model-authored strings render as React text
// nodes (auto-escaped); NO dangerouslySetInnerHTML anywhere in this file (T2 /
// #303 lesson). These only format numbers/durations, never HTML.
// ---------------------------------------------------------------------------

/** 431000 → "431k", 1_200_000 → "1.2M", 940 → "940". null/NaN → null. */
export function fmtTokens(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Milliseconds → "8m", "53s", "1h 4m", "0s". null → null. */
export function fmtDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ---------------------------------------------------------------------------
// State model — encoded by BOTH shape (glyph) and text label, never hue alone
// (design H3: greyscale/colorblind-safe). The producer currently emits only
// queued|running|done; 'error' is design-complete for a future producer that
// marks a failed agent, and is exercised by the render tests.
// ---------------------------------------------------------------------------

type DotState = 'queued' | 'running' | 'done' | 'error';

const DOT_GLYPH: Record<DotState, string> = {
  queued: '○',
  running: '◐',
  done: '●',
  error: '✕',
};
const DOT_LABEL: Record<DotState, string> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  error: 'error',
};

function agentDotState(agent: WorkflowAgent): DotState {
  const s = agent.state as string;
  if (s === 'running' || s === 'done' || s === 'error' || s === 'queued') return s;
  return 'queued';
}

/** Run status → the header chip's three visual buckets. `active` (status ===
 *  'running', server-computed) is authoritative for the running bucket; a
 *  parseable-but-unknown status falls back to running (never falsely "done"). */
type ChipStatus = 'running' | 'completed' | 'failed';
function chipStatus(wf: Workflow): ChipStatus {
  if (wf.active) return 'running';
  const s = (wf.status || '').toLowerCase();
  if (s === 'failed' || s === 'errored' || s === 'error') return 'failed';
  if (s === 'completed' || s === 'complete' || s === 'done' || s === 'finished') return 'completed';
  return 'running';
}
const CHIP_TEXT: Record<ChipStatus, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
};

/** Phase "activity" for auto-expand (D4) + phase-head status: running if any
 *  agent is running, else errored if any errored, else done if all done. */
function phaseActivity(phase: WorkflowPhase): DotState {
  const agents = phase.agents;
  if (agents.some((a) => a.state === 'running')) return 'running';
  if (agents.some((a) => (a.state as string) === 'error')) return 'error';
  if (agents.length > 0 && agents.every((a) => a.state === 'done')) return 'done';
  return 'queued';
}

function phaseDone(phase: WorkflowPhase): number {
  return phase.agents.filter((a) => a.state === 'done').length;
}

// ---------------------------------------------------------------------------
// Agent row — memoized so one agent's tick (a new run object each poll)
// re-renders ONLY the rows whose (agentId, state, lastToolName, tokens) changed
// (P3). Row expansion is LOCAL state, so toggling one row never touches others.
// ---------------------------------------------------------------------------

interface AgentRowProps {
  agent: WorkflowAgent;
  /** Bound in B2/B3 to open the agent's full transcript overlay; absent → no
   *  "open transcript" affordance (the card renders standalone in tests). */
  onOpenTranscript?: (agentId: string, label: string) => void;
}

function AgentRowImpl({ agent, onOpenTranscript }: AgentRowProps) {
  const state = agentDotState(agent);
  const [expanded, setExpanded] = useState(false);

  const label = agent.label || agent.agentType || 'agent';
  const tokens = fmtTokens(agent.tokens);
  const duration = fmtDuration(agent.durationMs);
  // Queued agents are inert until they start (design: non-expandable until started).
  const expandable = state !== 'queued';

  const canOpen = !!onOpenTranscript && !!agent.agentId;
  const openTranscript = () => {
    if (agent.agentId && onOpenTranscript) onOpenTranscript(agent.agentId, label);
  };

  return (
    <li className="wf-agent" data-state={state}>
      <button
        type="button"
        className="wf-agent-row"
        data-state={state}
        aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
      >
        <span className="wf-dot" data-state={state} aria-hidden="true">
          {DOT_GLYPH[state]}
        </span>
        <span className="wf-vis-hidden">{DOT_LABEL[state]}</span>
        <span className="wf-agent-label">{label}</span>
        {agent.agentType && agent.label ? (
          <span className="wf-agent-type">{agent.agentType}</span>
        ) : null}
        {agent.model ? <span className="meta-model wf-agent-model">{agent.model}</span> : null}
        {/* Running rows show the live tool name; finished rows show cost/time. */}
        {state === 'running' ? (
          <span className="wf-agent-live" key={agent.lastToolName ?? ''}>
            {agent.lastToolName ? agent.lastToolName : 'working…'}
          </span>
        ) : (
          <span className="wf-agent-meta">
            {tokens ? <span className="wf-agent-tok">{tokens}</span> : null}
            {duration ? <span className="wf-agent-dur">{duration}</span> : null}
          </span>
        )}
      </button>

      {expandable && expanded ? (
        <div className="wf-agent-detail">
          {/* provenance/cost row */}
          <div className="wf-agent-provenance">
            {agent.model ? <span className="meta-model">{agent.model}</span> : null}
            {tokens ? <span>{tokens} tok</span> : null}
            {agent.toolCalls != null ? <span>{agent.toolCalls} calls</span> : null}
            {duration ? <span>{duration}</span> : null}
          </div>
          {/* resultPreview (done) or promptPreview/live (running) — escaped text */}
          {agent.resultPreview ? (
            <p className="wf-agent-preview">{agent.resultPreview}</p>
          ) : agent.promptPreview ? (
            <p className="wf-agent-preview wf-agent-preview--prompt">{agent.promptPreview}</p>
          ) : (
            <p className="wf-agent-preview wf-agent-preview--empty">no result yet…</p>
          )}
          {canOpen ? (
            <button type="button" className="wf-open-transcript" onClick={openTranscript}>
              Open full transcript <span aria-hidden="true">↗</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Re-render only when a memo-key field changes (P3). Duration ticks alone are
 *  intentionally NOT a trigger — the spec keys on these four. onOpenTranscript
 *  is stable (useCallback keyed on the stable runId). */
export const AgentRow = memo(AgentRowImpl, (prev, next) => {
  const a = prev.agent;
  const b = next.agent;
  return (
    a.agentId === b.agentId &&
    a.state === b.state &&
    a.lastToolName === b.lastToolName &&
    a.tokens === b.tokens &&
    prev.onOpenTranscript === next.onOpenTranscript
  );
});

// ---------------------------------------------------------------------------
// Phase group — Gestalt common-region (labeled inset). Collapse-by-default;
// the single active phase auto-expands (D4), completed ones stay collapsed.
// The single-phase common case (specimen) de-emphasizes the phase chrome.
// ---------------------------------------------------------------------------

interface PhaseGroupProps {
  phase: WorkflowPhase;
  phaseKey: string;
  solo: boolean;
  open: boolean;
  onToggle: (key: string) => void;
  onOpenTranscript?: (agentId: string, label: string) => void;
}

function PhaseGroup({ phase, phaseKey, solo, open, onToggle, onOpenTranscript }: PhaseGroupProps) {
  const activity = phaseActivity(phase);
  const done = phaseDone(phase);
  const total = phase.agents.length;
  const title = phase.title || 'Phase';

  // Solo phase: no collapse chrome, always show rows (card reads "name → agents").
  const showRows = solo || open;

  const rows =
    total === 0 ? (
      <li className="wf-phase-empty">queued — no agents yet</li>
    ) : (
      phase.agents.map((agent, i) => (
        <AgentRow
          key={agent.agentId ?? `${phaseKey}:${i}`}
          agent={agent}
          onOpenTranscript={onOpenTranscript}
        />
      ))
    );

  return (
    <section className="wf-phase" data-activity={activity} data-solo={solo ? 'true' : undefined}>
      {solo ? (
        <div className="wf-phase-head wf-phase-head--solo">
          <span className="wf-phase-title">{title}</span>
          {phase.detail ? <span className="wf-phase-detail">{phase.detail}</span> : null}
          <span className="wf-phase-count">
            {done}/{total}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="wf-phase-head"
          aria-expanded={open}
          onClick={() => onToggle(phaseKey)}
        >
          <span className="wf-phase-caret" data-open={open ? 'true' : 'false'} aria-hidden="true">
            ▸
          </span>
          <span className="wf-dot wf-phase-dot" data-state={activity} aria-hidden="true">
            {DOT_GLYPH[activity]}
          </span>
          <span className="wf-phase-title">{title}</span>
          {phase.detail ? <span className="wf-phase-detail">{phase.detail}</span> : null}
          <span className="wf-phase-count">
            {done}/{total}
          </span>
        </button>
      )}
      {showRows ? <ul className="wf-agent-list">{rows}</ul> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Workflow Card — the inline, canonical, LIVE surface. Header (F1 status/
// progress · F2 name/summary · F4 aggregate meta) + phase-grouped agent rows.
// ---------------------------------------------------------------------------

export interface WorkflowCardProps {
  workflow: Workflow;
  /** Opens one agent's full transcript overlay (wired in B3 via WorkflowContext).
   *  Absent → the card renders read-only with no transcript affordance. */
  onOpenAgentTranscript?: (agentId: string, label: string) => void;
}

export function WorkflowCard({ workflow, onOpenAgentTranscript }: WorkflowCardProps) {
  const status = chipStatus(workflow);
  const phases = workflow.phases ?? [];
  const solo = phases.length === 1;

  // Stable phase keys (index, else title, else position) for expansion state
  // and React keys. Pipelined/multi-run runs keep first-appearance order.
  const phaseKeys = useMemo(
    () => phases.map((p, i) => (p.index != null ? `i:${p.index}` : p.title ? `t:${p.title}` : `p:${i}`)),
    [phases],
  );

  // Auto-expand the single active phase (D4); completed/queued stay collapsed.
  const activeKey = useMemo(() => {
    for (let i = 0; i < phases.length; i++) {
      if (phaseActivity(phases[i]) === 'running') return phaseKeys[i];
    }
    return null;
  }, [phases, phaseKeys]);

  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const togglePhase = useCallback((key: string) => {
    setOverrides((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }, []);
  const isOpen = (key: string) =>
    key in overrides ? overrides[key] : key === activeKey;

  // Stable per-card callback (runId never changes for a mounted card) so the
  // AgentRow memo is not defeated by a fresh function identity each render.
  const openTranscript = useCallback(
    (agentId: string, label: string) => onOpenAgentTranscript?.(agentId, label),
    [onOpenAgentTranscript],
  );
  const hasOpen = !!onOpenAgentTranscript;

  const name = workflow.workflowName || 'Workflow';
  const tokens = fmtTokens(workflow.totalTokens);
  const elapsed = fmtDuration(workflow.durationMs);
  const agentCount = workflow.agentCount || workflow.total;

  return (
    <section className="wf-card" data-status={status} aria-label={`Workflow ${name}, ${CHIP_TEXT[status]}`}>
      <header className="wf-header">
        <div className="wf-header-main">
          <span className="wf-glyph" aria-hidden="true">
            ⚙
          </span>
          <span className="wf-name">{name}</span>
          <span className="wf-status-chip" data-status={status}>
            <span className="wf-status-dot" aria-hidden="true" />
            {CHIP_TEXT[status]}
          </span>
          <span className="wf-progress">
            {workflow.done}/{workflow.total}
          </span>
        </div>
        {workflow.summary ? <p className="wf-summary">{workflow.summary}</p> : null}
        <div className="wf-aggregate">
          <span>{agentCount} agents</span>
          {tokens ? <span>{tokens}</span> : null}
          {elapsed ? <span>{elapsed}</span> : null}
        </div>
      </header>

      <div className="wf-phases">
        {phases.length === 0 ? (
          <div className="wf-phase-empty wf-phases-empty">no phases yet…</div>
        ) : (
          phases.map((phase, i) => (
            <PhaseGroup
              key={phaseKeys[i]}
              phase={phase}
              phaseKey={phaseKeys[i]}
              solo={solo}
              open={isOpen(phaseKeys[i])}
              onToggle={togglePhase}
              onOpenTranscript={hasOpen ? openTranscript : undefined}
            />
          ))
        )}
      </div>
    </section>
  );
}
