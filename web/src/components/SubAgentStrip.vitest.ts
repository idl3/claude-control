// @vitest-environment jsdom
/**
 * SubAgentStrip status-pill wiring + batch-visibility regression tests.
 *
 * `cockpit.subagents` (App.tsx / useCockpit.ts) accumulates every sub-agent
 * dispatched all session long — entries are never deleted, only their
 * `status` flips 'running' -> 'done'. Naively rendering "everything with
 * status !== undefined" would resurrect long-finished agents from earlier
 * turns the instant a brand-new one starts running. SubAgentStrip instead
 * tracks a "current batch" of agentIds (added the moment they're seen
 * running, dropped together once none of them are running any more), so:
 *   - a pill mirrors `data-status="running" | "done"` from the sub-agent
 *   - a sibling that finishes early stays visible (green, steady) next to
 *     any siblings still running, instead of vanishing mid-batch
 *   - the whole strip unmounts together once the batch fully clears
 *   - an unrelated agent finished in a PRIOR batch never reappears
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import type { SubAgent } from '../lib/types';
import { SubAgentStrip } from './SubAgentStrip';

afterEach(cleanup);

function makeAgent(agentId: string, status: 'running' | 'done', agentType = 'coder'): SubAgent {
  return {
    agentId,
    toolUseId: null,
    agentType,
    description: null,
    status,
    messages: [],
  };
}

describe('SubAgentStrip', () => {
  it('renders nothing when no agent is running', () => {
    const { container } = render(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'done')],
        onOpenAgent: () => {},
      }),
    );
    expect(container.querySelector('.subagent-strip')).toBeNull();
  });

  it('wires data-status="running" onto a running pill', () => {
    const { container } = render(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'running')],
        onOpenAgent: () => {},
      }),
    );
    const pill = container.querySelector<HTMLElement>('.subagent-pill');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute('data-status')).toBe('running');
  });

  it('keeps a finished sibling visible (data-status="done") while another agent in the same batch is still running', () => {
    const { container, rerender } = render(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'running', 'coder'), makeAgent('a2', 'running', 'reviewer')],
        onOpenAgent: () => {},
      }),
    );
    expect(container.querySelectorAll('.subagent-pill')).toHaveLength(2);

    // a1 finishes; a2 is still running.
    rerender(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'done', 'coder'), makeAgent('a2', 'running', 'reviewer')],
        onOpenAgent: () => {},
      }),
    );

    const pills = container.querySelectorAll<HTMLElement>('.subagent-pill');
    expect(pills).toHaveLength(2);
    const a1Pill = [...pills].find((p) => p.textContent?.includes('coder'));
    expect(a1Pill?.getAttribute('data-status')).toBe('done');
  });

  it('clears the whole strip once every agent in the batch is done', () => {
    const { container, rerender } = render(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'running')],
        onOpenAgent: () => {},
      }),
    );
    expect(container.querySelector('.subagent-strip')).not.toBeNull();

    rerender(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'done')],
        onOpenAgent: () => {},
      }),
    );
    expect(container.querySelector('.subagent-strip')).toBeNull();
  });

  it('does not resurrect an agent finished in a prior batch when a new, unrelated agent starts running', () => {
    const { container, rerender } = render(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('old', 'running')],
        onOpenAgent: () => {},
      }),
    );

    // Prior batch fully completes — strip clears.
    rerender(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('old', 'done')],
        onOpenAgent: () => {},
      }),
    );
    expect(container.querySelector('.subagent-strip')).toBeNull();

    // A new, unrelated agent starts running; `subagents` (accumulated by
    // useCockpit) still carries the old, long-done entry alongside it.
    rerender(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('old', 'done'), makeAgent('new', 'running')],
        onOpenAgent: () => {},
      }),
    );

    const pills = container.querySelectorAll<HTMLElement>('.subagent-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0].getAttribute('data-status')).toBe('running');
  });
});
