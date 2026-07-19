// @vitest-environment jsdom
/**
 * WorkflowCard render tests (B4). Covers the load-bearing invariants:
 *  - the completed specimen shape (1 phase × 6 done agents) renders header +
 *    progress + one row per agent;
 *  - state is encoded by dot SHAPE (glyph) + text label, never hue alone (H3);
 *  - phase grouping is a labeled common-region per phase; the active phase auto-
 *    expands, completed ones collapse (D4);
 *  - model-authored previews render as ESCAPED text — no HTML injection (T2/#303);
 *  - the per-row memo key is exactly (agentId, state, lastToolName, tokens) +
 *    callback identity (P3);
 *  - "open full transcript" invokes the wired callback with (agentId, label).
 *
 * `.vitest.ts` (no JSX) → components are constructed with createElement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, within } from '@testing-library/react';
import { createElement as h } from 'react';
import type { Workflow, WorkflowAgent, WorkflowPhase } from '../lib/types';
import {
  WorkflowCard,
  agentRowPropsEqual,
  fmtTokens,
  fmtDuration,
  _agentRowRenderCountForTest,
} from './WorkflowCard';

afterEach(cleanup);

// --- fixtures --------------------------------------------------------------

function mkAgent(over: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return {
    index: 1,
    label: 'coherence',
    agentId: 'a1',
    agentType: 'plan-coherence-reviewer',
    model: 'claude-haiku-4-5',
    state: 'done',
    startedAt: 1000,
    queuedAt: 900,
    durationMs: 240000,
    tokens: 82000,
    toolCalls: 10,
    lastToolName: null,
    promptPreview: null,
    resultPreview: 'looks coherent',
    ...over,
  };
}

function mkPhase(over: Partial<WorkflowPhase> = {}): WorkflowPhase {
  return { index: 1, title: 'Review', detail: 'six reviewers in parallel', agents: [], ...over };
}

function mkWorkflow(over: Partial<Workflow> = {}): Workflow {
  return {
    runId: 'wf_dc36fa0e-3c0',
    workflowName: 'claudex-plan-review-fanout',
    summary: 'Pass-2 parallel reviewer fan-out',
    status: 'completed',
    agentCount: 6,
    startTime: 1000,
    durationMs: 480000,
    totalTokens: 431000,
    totalToolCalls: 42,
    done: 6,
    total: 6,
    active: false,
    phases: [],
    ...over,
  };
}

/** The completed specimen: 1 phase × 6 done agents. */
function specimen(): Workflow {
  const agents = Array.from({ length: 6 }, (_, i) =>
    mkAgent({ agentId: `a${i}`, label: `reviewer-${i}`, tokens: 60000 + i * 1000 }),
  );
  return mkWorkflow({ phases: [mkPhase({ agents })] });
}

/** Render + auto-expand: a finished card mounts as the D1 one-line resting
 *  state; tests asserting on the full card click through it first. */
function renderCard(wf: Workflow, onOpenAgentTranscript?: (agentId: string, label: string) => void) {
  const utils = render(h(WorkflowCard, { workflow: wf, onOpenAgentTranscript }));
  const collapsed = utils.container.querySelector('.wf-card--collapsed');
  if (collapsed) fireEvent.click(collapsed);
  return utils;
}

// --- tests -----------------------------------------------------------------

describe('WorkflowCard — specimen', () => {
  it('renders header (name/status/progress) + one row per agent (1 phase × 6 done)', () => {
    const { container } = renderCard(specimen());
    expect(container.querySelector('.wf-card')).toBeTruthy();
    expect(container.querySelector('.wf-name')?.textContent).toBe('claudex-plan-review-fanout');
    const chip = container.querySelector('.wf-status-chip');
    expect(chip?.getAttribute('data-status')).toBe('completed');
    expect(chip?.textContent).toContain('completed');
    expect(container.querySelector('.wf-progress')?.textContent).toBe('6/6');
    // 6 agent rows, all done.
    const rows = container.querySelectorAll('.wf-agent');
    expect(rows.length).toBe(6);
    rows.forEach((r) => expect(r.getAttribute('data-state')).toBe('done'));
    // aggregate meta carries the token total (431k).
    expect(container.querySelector('.wf-aggregate')?.textContent).toContain('431k');
  });

  it('single-phase card de-emphasizes the phase chrome (solo) and shows rows without a toggle', () => {
    const { container } = renderCard(specimen());
    const phase = container.querySelector('.wf-phase');
    expect(phase?.getAttribute('data-solo')).toBe('true');
    // solo phase head is not a button (no collapse control).
    expect(container.querySelector('.wf-phase-head--solo')).toBeTruthy();
    expect(container.querySelector('button.wf-phase-head')).toBeNull();
    // rows are visible without any interaction.
    expect(container.querySelectorAll('.wf-agent-list .wf-agent').length).toBe(6);
  });
});

describe('WorkflowCard — state encoding (H3: shape + text, not hue)', () => {
  it('each state renders a distinct glyph AND a text label', () => {
    const wf = mkWorkflow({
      status: 'running',
      active: true,
      done: 1,
      total: 4,
      phases: [
        mkPhase({
          agents: [
            mkAgent({ agentId: 'q', label: 'queued-one', state: 'queued', resultPreview: null }),
            mkAgent({ agentId: 'r', label: 'running-one', state: 'running', lastToolName: 'Grep', resultPreview: null }),
            mkAgent({ agentId: 'd', label: 'done-one', state: 'done' }),
            // 'error' is design-complete though the producer doesn't emit it yet.
            mkAgent({ agentId: 'e', label: 'error-one', state: 'error' as WorkflowAgent['state'] }),
          ],
        }),
      ],
    });
    const { container } = renderCard(wf);
    const byState = (s: string) => container.querySelector(`.wf-agent[data-state="${s}"]`)!;
    expect(within(byState('queued') as HTMLElement).getByText('○')).toBeTruthy();
    expect(within(byState('queued') as HTMLElement).getByText('queued')).toBeTruthy();
    expect(within(byState('running') as HTMLElement).getByText('◐')).toBeTruthy();
    expect(within(byState('running') as HTMLElement).getByText('running')).toBeTruthy();
    expect(within(byState('done') as HTMLElement).getByText('●')).toBeTruthy();
    expect(within(byState('done') as HTMLElement).getByText('done')).toBeTruthy();
    expect(within(byState('error') as HTMLElement).getByText('✕')).toBeTruthy();
    expect(within(byState('error') as HTMLElement).getByText('error')).toBeTruthy();
  });

  it('running rows show the live lastToolName caption; queued rows are non-expandable', () => {
    const wf = mkWorkflow({
      status: 'running',
      active: true,
      phases: [
        mkPhase({
          agents: [
            mkAgent({ agentId: 'r', state: 'running', lastToolName: 'StructuredOutput' }),
            mkAgent({ agentId: 'q', state: 'queued' }),
          ],
        }),
      ],
    });
    const { container } = renderCard(wf);
    expect(container.querySelector('.wf-agent-live')?.textContent).toContain('StructuredOutput');
    const queuedBtn = container.querySelector('.wf-agent[data-state="queued"] .wf-agent-row') as HTMLButtonElement;
    expect(queuedBtn.disabled).toBe(true);
  });
});

describe('WorkflowCard — phase grouping (Gestalt common-region, D4 auto-expand)', () => {
  it('multi-phase renders a header per phase; the running phase auto-expands, completed collapses', () => {
    const wf = mkWorkflow({
      status: 'running',
      active: true,
      done: 2,
      total: 4,
      phases: [
        mkPhase({ index: 1, title: 'Plan', agents: [mkAgent({ agentId: 'p1', state: 'done' }), mkAgent({ agentId: 'p2', state: 'done' })] }),
        mkPhase({ index: 2, title: 'Build', agents: [mkAgent({ agentId: 'b1', state: 'running', resultPreview: null }), mkAgent({ agentId: 'b2', state: 'queued', resultPreview: null })] }),
      ],
    });
    const { container } = renderCard(wf);
    const heads = container.querySelectorAll('button.wf-phase-head');
    expect(heads.length).toBe(2); // multi-phase → collapsible headers (not solo)
    const phases = container.querySelectorAll('.wf-phase');
    // Plan (completed) collapsed → no rows; Build (running) auto-expanded → rows.
    expect(phases[0].querySelectorAll('.wf-agent').length).toBe(0);
    expect(phases[1].querySelectorAll('.wf-agent').length).toBe(2);
    // toggling the collapsed phase reveals its rows.
    fireEvent.click(heads[0]);
    expect(phases[0].querySelectorAll('.wf-agent').length).toBe(2);
  });
});

describe('WorkflowCard — previews (T2: escaped, never HTML)', () => {
  it('renders a malicious resultPreview as inert text, injecting no elements', () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>hello & <b>world</b>';
    const wf = mkWorkflow({ phases: [mkPhase({ agents: [mkAgent({ agentId: 'x', state: 'done', resultPreview: evil })] })] });
    const { container } = renderCard(wf);
    fireEvent.click(container.querySelector('.wf-agent-row') as HTMLElement);
    const preview = container.querySelector('.wf-agent-preview')!;
    // The raw string is present verbatim as text …
    expect(preview.textContent).toBe(evil);
    // … and NO real elements were parsed out of it.
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.querySelector('b')).toBeNull();
  });
});

describe('WorkflowCard — memo key (P3)', () => {
  const base = mkAgent({ agentId: 'a1', state: 'running', lastToolName: 'Grep', tokens: 100 });
  const noop = () => {};

  it('equal (skip re-render) when the four keyed fields + callback are unchanged', () => {
    expect(
      agentRowPropsEqual(
        { agent: { ...base, durationMs: 1 }, onOpenTranscript: noop },
        { agent: { ...base, durationMs: 999999 }, onOpenTranscript: noop }, // duration alone → still equal
      ),
    ).toBe(true);
  });

  it('NOT equal (re-render) when any keyed field changes', () => {
    const p = { agent: base, onOpenTranscript: noop };
    expect(agentRowPropsEqual(p, { agent: { ...base, state: 'done' }, onOpenTranscript: noop })).toBe(false);
    expect(agentRowPropsEqual(p, { agent: { ...base, tokens: 200 }, onOpenTranscript: noop })).toBe(false);
    expect(agentRowPropsEqual(p, { agent: { ...base, lastToolName: 'Read' }, onOpenTranscript: noop })).toBe(false);
    expect(agentRowPropsEqual(p, { agent: { ...base, agentId: 'a2' }, onOpenTranscript: noop })).toBe(false);
    expect(agentRowPropsEqual(p, { agent: base, onOpenTranscript: () => {} })).toBe(false);
  });
});

describe('WorkflowCard — Agent View wiring (B3)', () => {
  it('"open full transcript" fires the callback with (agentId, label)', () => {
    const spy = vi.fn();
    const wf = mkWorkflow({ phases: [mkPhase({ agents: [mkAgent({ agentId: 'a7', label: 'feasibility', state: 'done' })] })] });
    const { container } = renderCard(wf, spy);
    fireEvent.click(container.querySelector('.wf-agent-row') as HTMLElement); // expand
    fireEvent.click(container.querySelector('.wf-open-transcript') as HTMLElement);
    expect(spy).toHaveBeenCalledWith('a7', 'feasibility');
  });

  it('no transcript affordance when no callback is provided (read-only card)', () => {
    const wf = mkWorkflow({ phases: [mkPhase({ agents: [mkAgent({ agentId: 'a7', state: 'done' })] })] });
    const { container } = renderCard(wf);
    fireEvent.click(container.querySelector('.wf-agent-row') as HTMLElement);
    expect(container.querySelector('.wf-open-transcript')).toBeNull();
  });
});

describe('WorkflowCard — formatters', () => {
  it('fmtTokens', () => {
    expect(fmtTokens(940)).toBe('940');
    expect(fmtTokens(82000)).toBe('82k');
    expect(fmtTokens(431000)).toBe('431k');
    expect(fmtTokens(1_200_000)).toBe('1.2M');
    expect(fmtTokens(null)).toBeNull();
  });
  it('fmtDuration', () => {
    expect(fmtDuration(53000)).toBe('53s');
    expect(fmtDuration(480000)).toBe('8m');
    expect(fmtDuration(3_840_000)).toBe('1h 4m');
    expect(fmtDuration(null)).toBeNull();
  });
});

describe('WorkflowCard — Phase D perf hardening', () => {
  function largeWorkflow(status = 'completed', active = false): Workflow {
    const agents = (n: number, phase: string, state: WorkflowAgent['state'] = 'done') =>
      Array.from({ length: n }, (_, i) =>
        mkAgent({ agentId: `${phase}-${i}`, label: `${phase}:${i}`, state }),
      );
    return mkWorkflow({
      status,
      active,
      agentCount: 40,
      done: 40,
      total: 40,
      phases: [
        mkPhase({ index: 1, title: 'Implement', agents: agents(24, 'impl') }),
        mkPhase({ index: 2, title: 'Verify', agents: agents(12, 'verify') }),
        mkPhase({ index: 3, title: 'Wrap', agents: agents(4, 'wrap') }),
      ],
    });
  }

  it('a finished card rests as a one-line summary; tap expands; ▾ re-collapses (D1)', () => {
    const { container } = render(h(WorkflowCard, { workflow: specimen() }));
    const collapsed = container.querySelector('.wf-card--collapsed');
    expect(collapsed).toBeTruthy();
    expect(container.querySelectorAll('.wf-agent').length).toBe(0);
    expect(collapsed?.textContent).toContain('claudex-plan-review-fanout');
    expect(collapsed?.textContent).toContain('6/6');
    fireEvent.click(collapsed as HTMLElement);
    expect(container.querySelector('.wf-card--collapsed')).toBeNull();
    expect(container.querySelectorAll('.wf-agent').length).toBe(6);
    fireEvent.click(container.querySelector('.wf-collapse-btn') as HTMLElement);
    expect(container.querySelector('.wf-card--collapsed')).toBeTruthy();
  });

  it('a running card mounts expanded (no collapse control while live)', () => {
    const wf = mkWorkflow({
      status: 'running',
      active: true,
      phases: [mkPhase({ agents: [mkAgent({ agentId: 'r', state: 'running' })] })],
    });
    const { container } = render(h(WorkflowCard, { workflow: wf }));
    expect(container.querySelector('.wf-card--collapsed')).toBeNull();
    expect(container.querySelector('.wf-collapse-btn')).toBeNull();
  });

  it('DOM at rest is O(phases): expanding the 40-agent card mounts phase heads, zero rows', () => {
    const { container } = renderCard(largeWorkflow());
    // All three phases are completed -> collapsed by default (D4): no rows.
    expect(container.querySelectorAll('.wf-phase').length).toBe(3);
    expect(container.querySelectorAll('.wf-agent').length).toBe(0);
  });

  it('expanding a 24-agent phase mounts only the 20-row window + "show 4 more" (D1)', () => {
    const { container } = renderCard(largeWorkflow());
    const implHead = container.querySelectorAll('button.wf-phase-head')[0] as HTMLElement;
    fireEvent.click(implHead);
    expect(container.querySelectorAll('.wf-agent').length).toBe(20);
    const more = container.querySelector('.wf-show-more');
    expect(more?.textContent).toContain('show 4 more');
    fireEvent.click(more as HTMLElement);
    expect(container.querySelectorAll('.wf-agent').length).toBe(24);
    expect(container.querySelector('.wf-show-more')).toBeNull();
  });

  it("one agent's tick re-renders exactly one row (D2 render probe)", () => {
    const wf = mkWorkflow({
      status: 'running',
      active: true,
      phases: [
        mkPhase({
          agents: [
            mkAgent({ agentId: 'a', label: 'row-a', state: 'running', lastToolName: 'Bash', resultPreview: null }),
            mkAgent({ agentId: 'b', label: 'row-b', state: 'running', lastToolName: 'Read', resultPreview: null }),
            mkAgent({ agentId: 'c', label: 'row-c', state: 'done' }),
          ],
        }),
      ],
    });
    const { rerender } = render(h(WorkflowCard, { workflow: wf }));
    const before = _agentRowRenderCountForTest();
    // A fresh run object (as each poll produces) where ONLY agent b advanced.
    const next: Workflow = JSON.parse(JSON.stringify(wf));
    next.phases[0].agents = next.phases[0].agents.map((a) =>
      a.agentId === 'b' ? { ...a, lastToolName: 'Edit', tokens: (a.tokens ?? 0) + 500 } : { ...a },
    );
    rerender(h(WorkflowCard, { workflow: next }));
    expect(_agentRowRenderCountForTest() - before).toBe(1);
  });
});
