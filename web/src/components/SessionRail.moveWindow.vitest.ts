// @vitest-environment jsdom
//
// Rail drag-and-drop entry point for "move window to another session": a
// pane row is dragged onto a DIFFERENT tmux-session group's header, which
// fires onRequestMove(srcId, destSessionName) on drop — it does NOT perform
// the move itself (App.tsx opens MoveWindowModal with that presetDest so the
// operator still confirms). Dropping onto the dragged pane's OWN group is a
// guarded no-op. See SessionRail.tsx's onDragStart/onDragOver/onDrop wiring
// and MoveWindowModal.tsx for the confirm step this drop leads to.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { SessionRail } from './SessionRail';
import type { Session } from '../lib/types';

afterEach(() => cleanup());

function makeSession(partial: Partial<Session>): Session {
  return { id: 'pane-1', sessionName: 'work', windowIndex: 0, kind: 'claude', ...partial };
}

function renderRail(overrides: Partial<Parameters<typeof SessionRail>[0]> = {}) {
  const onRequestMove = vi.fn();
  const sessions: Session[] = [
    makeSession({ id: 'pane-1', sessionName: 'work' }),
    makeSession({ id: 'pane-2', sessionName: 'scratch' }),
  ];
  render(
    createElement(SessionRail, {
      sessions,
      selectedId: null,
      onSelect: () => {},
      filter: 'all',
      collapsed: new Set<string>(),
      onToggleCollapse: () => {},
      hotkeyById: new Map<string, string>(),
      onRequestMove,
      ...overrides,
    }),
  );
  return { onRequestMove, sessions };
}

// jsdom has no native DataTransfer implementation usable across dragstart ->
// drop, so we hand every fireEvent the SAME plain-object stand-in — mirrors
// how a real drag carries one DataTransfer instance through its lifecycle.
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? '',
    dropEffect: '',
    effectAllowed: '',
  };
}

describe('SessionRail — move-window drag-and-drop', () => {
  it('dragging a pane onto a DIFFERENT group header fires onRequestMove(srcId, destSessionName)', () => {
    const { onRequestMove } = renderRail();
    const dataTransfer = makeDataTransfer();

    const row = screen.getByRole('option', { name: /pane-1/ });
    fireEvent.dragStart(row, { dataTransfer });

    const destHead = screen.getByText('scratch').closest('.session-group-head')!;
    fireEvent.dragOver(destHead, { dataTransfer });
    fireEvent.drop(destHead, { dataTransfer });

    expect(onRequestMove).toHaveBeenCalledWith('pane-1', 'scratch');
  });

  it('dropping onto the dragged pane\'s OWN group does NOT fire onRequestMove', () => {
    const { onRequestMove } = renderRail();
    const dataTransfer = makeDataTransfer();

    const row = screen.getByRole('option', { name: /pane-1/ });
    fireEvent.dragStart(row, { dataTransfer });

    const ownHead = screen.getByText('work').closest('.session-group-head')!;
    fireEvent.dragOver(ownHead, { dataTransfer });
    fireEvent.drop(ownHead, { dataTransfer });

    expect(onRequestMove).not.toHaveBeenCalled();
  });
});
