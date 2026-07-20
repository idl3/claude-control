// @vitest-environment jsdom
//
// Confirm-step modal for moving a tmux WINDOW (a client session) to another
// tmux SESSION — covers both entry-point shapes: presetDest (rail drag-drop,
// direct-confirm sentence) and no presetDest (Cmd+K palette, destination
// picker). See App.tsx's MoveWindowModal wiring + SessionRail's drag handlers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { MoveWindowModal } from './MoveWindowModal';
import type { Session } from '../lib/types';

// Stub GSAP so useModalTransition's enter/exit timelines resolve
// synchronously — same stub as ConfigModal.vitest.ts / StudioModal.vitest.ts.
vi.mock('gsap', () => {
  const noop = () => {};
  const makeTimeline = (opts?: { onComplete?: () => void }) => {
    const self = { fromTo: () => self, to: () => self, kill: noop };
    opts?.onComplete?.();
    return self;
  };
  return { default: { set: noop, timeline: makeTimeline } };
});

afterEach(() => cleanup());

function makeSession(partial: Partial<Session>): Session {
  return { id: 'pane-1', sessionName: 'work', name: 'Claude', ...partial };
}

function renderModal(overrides: Partial<Parameters<typeof MoveWindowModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const onToast = vi.fn();
  const source = makeSession({});
  const sessions: Session[] = [
    source,
    makeSession({ id: 'pane-2', sessionName: 'scratch' }),
    makeSession({ id: 'pane-3', sessionName: 'infra' }),
  ];
  render(
    createElement(MoveWindowModal, {
      source,
      sessions,
      onConfirm,
      onClose,
      onToast,
      ...overrides,
    }),
  );
  return { onConfirm, onClose, onToast, source, sessions };
}

describe('MoveWindowModal', () => {
  it('presetDest: renders a direct-confirm sentence and Confirm calls onConfirm(presetDest)', () => {
    const { onConfirm, onClose } = renderModal({ presetDest: 'scratch' });

    expect(document.querySelector('.move-window-sentence')?.textContent).toContain('scratch');
    expect(screen.queryByRole('combobox')).toBeNull(); // no picker in preset mode

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('scratch');
    expect(onClose).toHaveBeenCalled();
  });

  it('no presetDest: the picker excludes the source session, Confirm calls onConfirm(selected)', () => {
    const { onConfirm } = renderModal();

    const select = screen.getByRole('combobox', { name: /destination/i }) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).not.toContain('work'); // source's own sessionName never offered
    expect(optionValues).toEqual(['infra', 'scratch']); // unique, sorted

    fireEvent.change(select, { target: { value: 'infra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('infra');
  });

  it('Cancel calls onClose, not onConfirm', () => {
    const { onConfirm, onClose } = renderModal({ presetDest: 'scratch' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('picker mode: Confirm is disabled when only one tmux session exists (no valid destination)', () => {
    const onConfirm = vi.fn();
    const source = makeSession({});
    render(
      createElement(MoveWindowModal, {
        source,
        sessions: [source], // the only session — no other destination candidates
        onConfirm,
        onClose: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
