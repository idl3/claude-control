// @vitest-environment jsdom
/**
 * Session row streamline: one right-hand meta slot per local row, cycling
 * model -> context every 10s (single shared SessionRail-level interval —
 * see useMetaCyclePhase/paneMetaFields in SessionRail.tsx), swapping to the
 * tmux pane name while cmdHeld is true. Also verifies the standalone
 * per-window "N <pane-name>" sub-label (.session-window-head) is gone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import type { Session } from '../lib/types';
import { SessionRail } from './SessionRail';

// slot-text's real <SlotText> builds its roll via per-character DOM nodes
// (a hidden `.char-sizer` + a visible `.char-face` per glyph — see
// node_modules/slot-text/dist/slotText.js buildSlotText), so
// `element.textContent` on the real component doubles every character
// ("opus" -> "ooppuuss"). These tests assert WHICH field the shared cycle
// picked (model/ctx/usage/pane-name), not slot-text's own roll mechanics
// (that's slot-text's own test surface, not this repo's) — so swap in a
// plain-span stand-in that keeps `text`/`className` exactly as passed.
vi.mock('slot-text/react', () => ({
  SlotText: ({ text, className }: { text: string; className?: string }) =>
    createElement('span', { className }, text),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeSession(partial: Partial<Session>): Session {
  return {
    id: 'sess-1',
    sessionName: 'main',
    windowIndex: 0,
    paneIndex: 0,
    kind: 'claude',
    ...partial,
  };
}

function renderRail(sessions: Session[], cmdHeld = false) {
  return render(
    createElement(SessionRail, {
      sessions,
      selectedId: null,
      onSelect: () => {},
      filter: 'all',
      collapsed: new Set<string>(),
      onToggleCollapse: () => {},
      hotkeyById: new Map<string, string>(),
      cmdHeld,
    }),
  );
}

describe('SessionRail — right-hand meta slot cycle', () => {
  it('shows the model in the meta slot by default', () => {
    const { container } = renderRail([
      makeSession({ id: 's1', tmuxName: 'my-pane', model: 'opus', ctxPct: 42 }),
    ]);
    const slot = container.querySelector('.session-row-meta');
    expect(slot).not.toBeNull();
    expect(slot!.querySelector('.meta-model')?.textContent).toBe('opus');
    expect(slot!.querySelector('.meta-ctx')).toBeNull();
  });

  it('swaps to context after the shared 10s tick fires', () => {
    vi.useFakeTimers();
    const { container } = renderRail([
      makeSession({ id: 's1', tmuxName: 'my-pane', model: 'opus', ctxPct: 42 }),
    ]);
    expect(container.querySelector('.meta-model')?.textContent).toBe('opus');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    const slot = container.querySelector('.session-row-meta');
    expect(slot!.querySelector('.meta-ctx')?.textContent).toBe('ctx:42%');
    expect(slot!.querySelector('.meta-model')).toBeNull();
  });

  it('swaps back to model after a second 10s tick (alternation)', () => {
    vi.useFakeTimers();
    const { container } = renderRail([
      makeSession({ id: 's1', tmuxName: 'my-pane', model: 'opus', ctxPct: 42 }),
    ]);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(container.querySelector('.meta-model')?.textContent).toBe('opus');
  });

  it('uses ONE shared interval for every row — two rows flip in lockstep on the same tick', () => {
    vi.useFakeTimers();
    const { container } = renderRail([
      makeSession({ id: 's1', tmuxName: 'pane-a', model: 'opus', ctxPct: 10 }),
      makeSession({ id: 's2', tmuxName: 'pane-b', model: 'sonnet', ctxPct: 20 }),
    ]);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const slots = container.querySelectorAll('.session-row-meta');
    expect(slots).toHaveLength(2);
    // Both rows must have swapped to context together (same shared tick).
    expect(slots[0].querySelector('.meta-ctx')?.textContent).toBe('ctx:10%');
    expect(slots[1].querySelector('.meta-ctx')?.textContent).toBe('ctx:20%');
  });

  it('shows the tmux pane name in the meta slot while cmdHeld is true, overriding the cycle', () => {
    const { container } = renderRail(
      [makeSession({ id: 's1', tmuxName: 'my-pane', model: 'opus', ctxPct: 42 })],
      true,
    );
    const slot = container.querySelector('.session-row-meta');
    expect(slot!.querySelector('.session-row-meta-pane')?.textContent).toBe('my-pane');
    expect(slot!.querySelector('.meta-model')).toBeNull();
    expect(slot!.querySelector('.meta-ctx')).toBeNull();
  });

  it('falls back to the model/context cycle when cmdHeld is true but the row has no tmuxName', () => {
    const { container } = renderRail([makeSession({ id: 's1', tmuxName: undefined, model: 'opus' })], true);
    const slot = container.querySelector('.session-row-meta');
    expect(slot!.querySelector('.session-row-meta-pane')).toBeNull();
    expect(slot!.querySelector('.meta-model')?.textContent).toBe('opus');
  });

  it('does not render a meta slot when the row has no model, ctx, or tmuxName data', () => {
    const { container } = renderRail([makeSession({ id: 's1', tmuxName: undefined, model: undefined, ctxPct: undefined })]);
    expect(container.querySelector('.session-row-meta')).toBeNull();
  });

  it('renders no standalone per-window pane-name sub-label (.session-window-head is gone)', () => {
    const { container } = renderRail([
      makeSession({ id: 's1', tmuxName: 'my-pane', model: 'opus' }),
      makeSession({ id: 's2', tmuxName: 'other-pane', windowIndex: 1, model: 'sonnet' }),
    ]);
    expect(container.querySelector('.session-window-head')).toBeNull();
    expect(container.querySelector('.window-name')).toBeNull();
    expect(container.querySelector('.window-idx')).toBeNull();
  });
});
