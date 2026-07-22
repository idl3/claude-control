// @vitest-environment jsdom
//
// Rail drag-and-drop entry point for "move window to another session": a
// pane row is POINTER-dragged (not HTML5 DnD — the desktop shell's WKWebView
// breaks that; see useRowPointerDrag in SessionRail.tsx) onto a DIFFERENT
// tmux-session group's header, which fires onRequestMove(srcId,
// destSessionName) on release — it does NOT perform the move itself (App.tsx
// opens MoveWindowModal with that presetDest so the operator still
// confirms). Dropping onto the dragged pane's OWN group is a guarded no-op.
//
// The gesture under test: pointerdown records a candidate; mouse movement
// past the 6px threshold (or a 300ms touch hold) ARMS the drag — pointer
// capture, data-dragging on the row, a body-level ghost (lib/dragGhost.ts);
// document.elementFromPoint probes the hovered header via its
// data-session-name; pointerup over a header fires the move request. jsdom
// has no layout, so elementFromPoint is mocked per-test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { SessionRail } from './SessionRail';
import type { Session } from '../lib/types';

const realElementFromPoint = document.elementFromPoint;

beforeEach(() => {
  // jsdom either lacks elementFromPoint or answers from a zero-size layout —
  // each test that needs a drop target points this at the header explicitly.
  document.elementFromPoint = vi.fn(() => null);
});

afterEach(() => {
  cleanup();
  document.elementFromPoint = realElementFromPoint;
  vi.useRealTimers();
});

function makeSession(partial: Partial<Session>): Session {
  return { id: 'pane-1', sessionName: 'work', windowIndex: 0, kind: 'claude', ...partial };
}

function renderRail(overrides: Partial<Parameters<typeof SessionRail>[0]> = {}) {
  const onRequestMove = vi.fn();
  const onSelect = vi.fn();
  const sessions: Session[] = [
    makeSession({ id: 'pane-1', sessionName: 'work' }),
    makeSession({ id: 'pane-2', sessionName: 'scratch' }),
  ];
  render(
    createElement(SessionRail, {
      sessions,
      selectedId: null,
      onSelect,
      filter: 'all',
      collapsed: new Set<string>(),
      onToggleCollapse: () => {},
      hotkeyById: new Map<string, string>(),
      onRequestMove,
      ...overrides,
    }),
  );
  return { onRequestMove, onSelect, sessions };
}

/** The pointer ghost is a .session-item clone appended DIRECTLY to <body> —
 *  rendered rows all live inside testing-library's container div, so a
 *  body-child .session-item can only be the ghost. */
function bodyGhosts(): NodeListOf<Element> {
  return document.querySelectorAll('body > .session-item');
}

function groupHead(name: string): HTMLElement {
  return screen.getByText(name).closest('.session-group-head') as HTMLElement;
}

describe('SessionRail — pointer-event move-window drag-and-drop', () => {
  it('sub-threshold pointer movement stays a CLICK: no drag state, row still selects', () => {
    const { onSelect, onRequestMove } = renderRail();
    const row = screen.getByRole('option', { name: /pane-1/ });

    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 13, clientY: 12 }); // <6px — jitter, not a drag
    expect(row.getAttribute('data-dragging')).toBeNull();
    expect(bodyGhosts().length).toBe(0);
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 13, clientY: 12 });
    fireEvent.click(row); // the browser's synthesized click follows the up

    expect(onSelect).toHaveBeenCalledWith('pane-1');
    expect(onRequestMove).not.toHaveBeenCalled();
  });

  it('movement past the threshold arms the drag: data-dragging + a body-level ghost', () => {
    renderRail();
    const row = screen.getByRole('option', { name: /pane-1/ });

    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 30, clientY: 10 }); // 20px > 6px
    expect(row.getAttribute('data-dragging')).toBe('true');
    expect(bodyGhosts().length).toBe(1);

    // Release over nothing: state and ghost tear down, no move requested.
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 30, clientY: 10 });
    expect(row.getAttribute('data-dragging')).toBeNull();
    expect(bodyGhosts().length).toBe(0);
  });

  it('hovering a header rings it (data-drag-over); releasing over a DIFFERENT group fires onRequestMove and suppresses the trailing click', () => {
    const { onRequestMove, onSelect } = renderRail();
    const row = screen.getByRole('option', { name: /pane-1/ });
    const destHead = groupHead('scratch');
    expect(destHead.getAttribute('data-session-name')).toBe('scratch');

    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 80 });
    vi.mocked(document.elementFromPoint).mockReturnValue(destHead);
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 90 });
    expect(destHead.getAttribute('data-drag-over')).toBe('true');

    fireEvent.pointerUp(row, { pointerId: 1, clientX: 40, clientY: 90 });
    expect(onRequestMove).toHaveBeenCalledWith('pane-1', 'scratch');
    expect(destHead.getAttribute('data-drag-over')).toBeNull();

    // The pointerdown/up pair still synthesizes a click — it must NOT also
    // select the row the drag started on.
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("releasing over the dragged pane's OWN group header does NOT fire onRequestMove", () => {
    const { onRequestMove } = renderRail();
    const row = screen.getByRole('option', { name: /pane-1/ });
    const ownHead = groupHead('work');

    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    vi.mocked(document.elementFromPoint).mockReturnValue(ownHead);
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 40, clientY: 40 });

    expect(onRequestMove).not.toHaveBeenCalled();
    expect(bodyGhosts().length).toBe(0);
  });

  it('Escape cancels a live drag cleanly — no move on the subsequent release', () => {
    const { onRequestMove } = renderRail();
    const row = screen.getByRole('option', { name: /pane-1/ });
    const destHead = groupHead('scratch');

    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    vi.mocked(document.elementFromPoint).mockReturnValue(destHead);
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 90 });
    expect(row.getAttribute('data-dragging')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(row.getAttribute('data-dragging')).toBeNull();
    expect(destHead.getAttribute('data-drag-over')).toBeNull();
    expect(bodyGhosts().length).toBe(0);

    fireEvent.pointerUp(row, { pointerId: 1, clientX: 40, clientY: 90 });
    expect(onRequestMove).not.toHaveBeenCalled();
  });

  it('pointercancel tears the drag down without a move', () => {
    const { onRequestMove } = renderRail();
    const row = screen.getByRole('option', { name: /pane-1/ });

    fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 40, clientY: 40 });
    expect(row.getAttribute('data-dragging')).toBe('true');
    fireEvent.pointerCancel(row, { pointerId: 1 });

    expect(row.getAttribute('data-dragging')).toBeNull();
    expect(bodyGhosts().length).toBe(0);
    expect(onRequestMove).not.toHaveBeenCalled();
  });

  it('touch: a 300ms stationary hold arms the drag (no movement threshold)', () => {
    vi.useFakeTimers();
    renderRail();
    const row = screen.getByRole('option', { name: /pane-1/ });

    fireEvent.pointerDown(row, {
      pointerId: 1,
      button: 0,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    });
    expect(row.getAttribute('data-dragging')).toBeNull(); // hold not elapsed yet
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(row.getAttribute('data-dragging')).toBe('true');
    expect(bodyGhosts().length).toBe(1);

    fireEvent.pointerUp(row, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(bodyGhosts().length).toBe(0);
  });

  it('touch: movement before the hold elapses means SCROLL — arming cancels', () => {
    vi.useFakeTimers();
    const { onRequestMove } = renderRail();
    const row = screen.getByRole('option', { name: /pane-1/ });

    fireEvent.pointerDown(row, {
      pointerId: 1,
      button: 0,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(row, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 40 }); // >10px slop
    act(() => {
      vi.advanceTimersByTime(300); // hold timer must be dead by now
    });
    expect(row.getAttribute('data-dragging')).toBeNull();
    expect(bodyGhosts().length).toBe(0);
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 10, clientY: 40 });
    expect(onRequestMove).not.toHaveBeenCalled();
  });
});
