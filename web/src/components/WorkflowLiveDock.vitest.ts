// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { createElement } from 'react';
import {
  WorkflowLiveDock,
  pickActiveRun,
  currentAgent,
  activePhaseTitle,
} from './WorkflowLiveDock';
import type { Workflow, WorkflowAgent, WorkflowPhase } from '../lib/types';

function agent(over: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return {
    index: 0,
    label: 'impl:a',
    agentId: 'a1',
    agentType: 'workflow',
    model: null,
    state: 'done',
    startedAt: 1000,
    queuedAt: null,
    durationMs: 2000,
    tokens: 1000,
    toolCalls: 3,
    lastToolName: null,
    promptPreview: null,
    resultPreview: null,
    ...over,
  };
}

function phase(agents: WorkflowAgent[], over: Partial<WorkflowPhase> = {}): WorkflowPhase {
  return { index: 0, title: 'Implement', detail: null, agents, ...over };
}

function run(over: Partial<Workflow> = {}): Workflow {
  return {
    runId: 'wf_test-1',
    workflowName: 'test-fanout',
    summary: 'a test fan-out',
    status: 'running',
    agentCount: 2,
    startTime: 100,
    durationMs: 60_000,
    totalTokens: 5000,
    totalToolCalls: 9,
    done: 1,
    total: 2,
    active: true,
    phases: [
      phase([
        agent({ label: 'impl:a', state: 'done' }),
        agent({ label: 'impl:b', agentId: 'b1', state: 'running', startedAt: 2000, lastToolName: 'Bash' }),
      ]),
    ],
    ...over,
  };
}

afterEach(cleanup);

describe('pickActiveRun', () => {
  it('returns null when nothing is running', () => {
    expect(pickActiveRun([run({ status: 'completed' })])).toBeNull();
    expect(pickActiveRun([])).toBeNull();
  });

  it('picks the most-recently-started running run', () => {
    const older = run({ runId: 'wf_old', startTime: 100 });
    const newer = run({ runId: 'wf_new', startTime: 200 });
    expect(pickActiveRun([older, newer, run({ runId: 'wf_done', status: 'completed', startTime: 999 })])?.runId).toBe(
      'wf_new',
    );
  });
});

describe('currentAgent / activePhaseTitle', () => {
  it('picks the most-recently-started running agent', () => {
    const w = run({
      phases: [
        phase([agent({ label: 'x', state: 'running', startedAt: 10 })]),
        phase([agent({ label: 'y', agentId: 'y1', state: 'running', startedAt: 50 })], { index: 1, title: 'Verify' }),
      ],
    });
    expect(currentAgent(w)?.label).toBe('y');
    expect(activePhaseTitle(w)).toBe('Implement');
  });

  it('falls back to the first not-fully-done phase, else the last', () => {
    const w = run({
      phases: [
        phase([agent({ state: 'done' })]),
        phase([agent({ state: 'queued' })], { index: 1, title: 'Verify' }),
      ],
    });
    expect(activePhaseTitle(w)).toBe('Verify');
    const allDone = run({ phases: [phase([agent()]), phase([agent()], { index: 1, title: 'Wrap' })] });
    expect(activePhaseTitle(allDone)).toBe('Wrap');
  });
});

describe('WorkflowLiveDock', () => {
  it('renders nothing when no run is active', () => {
    const { container } = render(
      createElement(WorkflowLiveDock, { workflows: [run({ status: 'completed' })], onOpenCard: vi.fn() }),
    );
    expect(container.querySelector('.wf-dock')).toBeNull();
  });

  it('shows phase + progress + current agent while running, and opens the card on tap', () => {
    const onOpenCard = vi.fn();
    render(createElement(WorkflowLiveDock, { workflows: [run()], onOpenCard }));
    const dock = screen.getByRole('button');
    expect(dock.getAttribute('data-state')).toBe('running');
    expect(dock.textContent).toContain('Implement 1/2');
    expect(dock.textContent).toContain('impl:b');
    expect(dock.textContent).toContain('Bash');
    dock.click();
    expect(onOpenCard).toHaveBeenCalledWith('wf_test-1');
  });

  it('shows a +N more affordance when several runs are live', () => {
    render(
      createElement(WorkflowLiveDock, {
        workflows: [run(), run({ runId: 'wf_test-2', startTime: 50 })],
        onOpenCard: vi.fn(),
      }),
    );
    expect(screen.getByText('+1 more')).toBeTruthy();
  });

  it('flashes done for a few seconds after the run completes, then dismisses', () => {
    vi.useFakeTimers();
    try {
      const live = run();
      const { rerender, container } = render(
        createElement(WorkflowLiveDock, { workflows: [live], onOpenCard: vi.fn() }),
      );
      expect(container.querySelector('.wf-dock')?.getAttribute('data-state')).toBe('running');

      const finished = run({ status: 'completed', done: 2, active: false });
      rerender(createElement(WorkflowLiveDock, { workflows: [finished], onOpenCard: vi.fn() }));
      const dock = container.querySelector('.wf-dock');
      expect(dock?.getAttribute('data-state')).toBe('done');
      expect(dock?.textContent).toContain('done');

      act(() => {
        vi.advanceTimersByTime(4500);
      });
      expect(container.querySelector('.wf-dock')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
