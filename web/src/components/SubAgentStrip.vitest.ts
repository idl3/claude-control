// @vitest-environment jsdom
/**
 * SubAgentStrip status-pill wiring + batch-visibility regression tests.
 *
 * `cockpit.subagents` (App.tsx / useClaudeControl.ts) accumulates every sub-agent
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
import type { NestedSubAgent, SubAgent } from '../lib/types';
import { SubAgentStrip } from './SubAgentStrip';

afterEach(cleanup);

function makeAgent(
  agentId: string,
  status: 'running' | 'done',
  agentType = 'coder',
  nested?: NestedSubAgent[],
): SubAgent {
  return {
    agentId,
    toolUseId: null,
    agentType,
    description: null,
    status,
    messages: [],
    ...(nested ? { nested } : {}),
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
    // useClaudeControl) still carries the old, long-done entry alongside it.
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

  // ── SYNC / persist: `working` keeps a finished agent visible until the
  // parent turn itself ends, not just until nothing is running. ──────────
  it('keeps a finished agent visible while working=true, then clears once working=false and nothing is running', () => {
    const { container, rerender } = render(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'running')],
        onOpenAgent: () => {},
        working: true,
      }),
    );
    expect(container.querySelector('.subagent-strip')).not.toBeNull();

    // a1 finishes, but the parent turn (`working`) is still active.
    rerender(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'done')],
        onOpenAgent: () => {},
        working: true,
      }),
    );
    const pill = container.querySelector<HTMLElement>('.subagent-pill');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute('data-status')).toBe('done');
    expect(pill!.querySelector('.sa-dot')?.getAttribute('data-status')).toBe('done');
    expect(container.querySelector('.subagent-strip')).not.toBeNull();

    // The parent turn ends and nothing is running — now it clears.
    rerender(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'done')],
        onOpenAgent: () => {},
        working: false,
      }),
    );
    expect(container.querySelector('.subagent-strip')).toBeNull();
  });

  it('existing (no `working` prop) callers keep clearing the instant nothing is running', () => {
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

  // ── NESTED: a nested-agent row renders above the parent row. ───────────
  it('renders a nested-agent row that precedes the parent .subagent-pills row in DOM order', () => {
    const { container } = render(
      createElement(SubAgentStrip, {
        subagents: [
          makeAgent('a1', 'running', 'coder', [{ agentId: 'c1', agentType: 'reviewer', model: null }]),
        ],
        onOpenAgent: () => {},
      }),
    );

    const strip = container.querySelector('.subagent-strip');
    expect(strip).not.toBeNull();

    const nestedRow = strip!.querySelector('.subagent-pills-nested');
    expect(nestedRow).not.toBeNull();
    expect(nestedRow!.querySelector('.subagent-pill-nested')?.textContent).toContain('reviewer');

    const pillsRows = strip!.querySelectorAll(':scope > .subagent-pills');
    expect(pillsRows).toHaveLength(2);
    expect(pillsRows[0]).toBe(nestedRow);
    expect(pillsRows[0].classList.contains('subagent-pills-nested')).toBe(true);
    expect(pillsRows[1].classList.contains('subagent-pills-nested')).toBe(false);
  });

  it('does not render a nested row when no visible agent has nested children', () => {
    const { container } = render(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'running')],
        onOpenAgent: () => {},
      }),
    );
    expect(container.querySelector('.subagent-pills-nested')).toBeNull();
  });

  // ── CAPTION: plain-text feed-style animate-in (no SlotText char-roll). ──
  it('renders the caption as plain text, keyed so a changed line remounts the inner span (plays the CSS slide-up-fade enter)', () => {
    const running = (text: string): SubAgent => ({
      agentId: 'a1',
      toolUseId: null,
      agentType: 'coder',
      description: null,
      status: 'running',
      messages: [{ uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text }] }],
    });

    const { container, rerender } = render(
      createElement(SubAgentStrip, {
        subagents: [running('Inspecting redis-helm chart')],
        onOpenAgent: () => {},
      }),
    );

    const caption = container.querySelector('.subagent-strip-caption');
    expect(caption).not.toBeNull();
    const span = caption!.querySelector<HTMLElement>('.subagent-progress-text');
    expect(span).not.toBeNull();
    // Plain text content — no per-character .char-slot/.char-face markup and
    // no slot-text library class.
    expect(span!.classList.contains('slot-text')).toBe(false);
    expect(span!.querySelectorAll('.char-slot').length).toBe(0);
    expect(span!.textContent).toBe('Inspecting redis-helm chart');

    // Updating the activity text swaps in a DIFFERENT span instance (keyed on
    // the text) so the CSS enter-animation (subagent-caption-in, styles.css)
    // plays fresh on every change — the opposite contract of the old
    // persistent-SlotText-node approach.
    rerender(
      createElement(SubAgentStrip, {
        subagents: [running('Reviewing values.yaml diff')],
        onOpenAgent: () => {},
      }),
    );
    const spanAfter = container.querySelector<HTMLElement>('.subagent-progress-text');
    expect(spanAfter).not.toBe(span);
    expect(spanAfter!.textContent).toBe('Reviewing values.yaml diff');
  });

  // ── QUICK VIEW: hover-expand panel showing the last (up to) 5 distinct
  // activity lines, most recent last. ─────────────────────────────────────
  it('renders a quick-view panel with the last 5 distinct lines (deduped, most recent last) when more than one line exists', () => {
    const agentWithHistory = (): SubAgent => ({
      agentId: 'a1',
      toolUseId: null,
      agentType: 'coder',
      description: null,
      status: 'running',
      messages: [
        { uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text: 'Reading config.yaml' }] },
        { uuid: '2', role: 'assistant', blocks: [{ kind: 'text', text: 'Reading config.yaml' }] }, // consecutive dup, collapses
        { uuid: '3', role: 'assistant', blocks: [{ kind: 'text', text: 'Editing helm chart' }] },
        { uuid: '4', role: 'assistant', blocks: [{ kind: 'text', text: 'Running tests' }] },
        { uuid: '5', role: 'assistant', blocks: [{ kind: 'text', text: 'Tests passed' }] },
      ],
    });

    const { container } = render(
      createElement(SubAgentStrip, {
        subagents: [agentWithHistory()],
        onOpenAgent: () => {},
      }),
    );

    const wrap = container.querySelector('.subagent-strip-caption-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap!.getAttribute('tabindex')).toBe('0');

    const panel = container.querySelector('.subagent-quickview-panel');
    expect(panel).not.toBeNull();
    const lines = [...panel!.querySelectorAll('.subagent-quickview-line')].map((el) => el.textContent);
    expect(lines).toEqual([
      'Reading config.yaml',
      'Editing helm chart',
      'Running tests',
      'Tests passed',
    ]);
    // Most recent line is flagged for the "slightly less dim than older
    // lines" styling (styles.css `[data-latest='true']`).
    const lastLine = panel!.querySelector('.subagent-quickview-line[data-latest="true"]');
    expect(lastLine?.textContent).toBe('Tests passed');
  });

  it('does not render a quick-view panel when there is only a single activity line', () => {
    const { container } = render(
      createElement(SubAgentStrip, {
        subagents: [
          {
            agentId: 'a1',
            toolUseId: null,
            agentType: 'coder',
            description: null,
            status: 'running',
            messages: [{ uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text: 'only line' }] }],
          },
        ],
        onOpenAgent: () => {},
      }),
    );
    expect(container.querySelector('.subagent-quickview-panel')).toBeNull();
  });

  // ── DONE-DOT: the testable contract for the done pill's dot. ────────────
  it('carries data-status="done" on both the pill and its .sa-dot when finished', () => {
    const { container, rerender } = render(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'running', 'coder'), makeAgent('a2', 'running', 'reviewer')],
        onOpenAgent: () => {},
      }),
    );

    rerender(
      createElement(SubAgentStrip, {
        subagents: [makeAgent('a1', 'done', 'coder'), makeAgent('a2', 'running', 'reviewer')],
        onOpenAgent: () => {},
      }),
    );

    const pills = container.querySelectorAll<HTMLElement>('.subagent-pill');
    const donePill = [...pills].find((p) => p.textContent?.includes('coder'));
    expect(donePill?.getAttribute('data-status')).toBe('done');
    expect(donePill?.querySelector('.sa-dot')?.getAttribute('data-status')).toBe('done');
  });
});
