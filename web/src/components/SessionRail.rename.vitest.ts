// @vitest-environment jsdom
//
// Inline tmux-SESSION rename affordance on the sidebar's session-group header
// (e.g. "0") — double-click the name or the hover-reveal pencil button opens
// an inline input; Enter submits (calls renameTmuxSession), Escape cancels.
// Distinct from the per-window rename already covered elsewhere (App's
// submitRename / renameSession) — this exercises the group-header control.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { SessionRail, sanitizeGroupName } from './SessionRail';
import type { Session } from '../lib/types';

const renameTmuxSessionMock = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    renameTmuxSession: (...args: unknown[]) => renameTmuxSessionMock(...args),
  };
});

afterEach(() => {
  cleanup();
  renameTmuxSessionMock.mockReset();
});

function makeSession(partial: Partial<Session>): Session {
  return { id: 'pane-1', sessionName: 'work', windowIndex: 0, kind: 'claude', ...partial };
}

function renderRail(overrides: Partial<Parameters<typeof SessionRail>[0]> = {}) {
  const onToast = vi.fn();
  render(
    createElement(SessionRail, {
      sessions: [makeSession({})],
      selectedId: null,
      onSelect: () => {},
      filter: 'all',
      collapsed: new Set<string>(),
      onToggleCollapse: () => {},
      hotkeyById: new Map<string, string>(),
      onToast,
      ...overrides,
    }),
  );
  return { onToast };
}

// ── sanitizeGroupName ────────────────────────────────────────────────────

describe('sanitizeGroupName', () => {
  it('strips control chars and newlines', () => {
    expect(sanitizeGroupName('hi\nrm -rf /')).toBe('hi rm -rf /');
    expect(sanitizeGroupName('a\r\nb')).toBe('a b');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeGroupName('  my   session  ')).toBe('my session');
  });

  it('caps length at 80 and handles empty/nullish input', () => {
    expect(sanitizeGroupName('a'.repeat(200)).length).toBe(80);
    expect(sanitizeGroupName('')).toBe('');
    expect(sanitizeGroupName('   ')).toBe('');
  });
});

// ── Rename affordance (rendered component) ──────────────────────────────

describe('SessionRail — tmux session-group rename', () => {
  it('double-clicking the group name enters rename mode with the current name prefilled', () => {
    renderRail();
    fireEvent.doubleClick(screen.getByText('work'));
    const input = screen.getByRole('textbox', { name: 'Rename tmux session work' });
    expect((input as HTMLInputElement).value).toBe('work');
  });

  it('the hover-reveal pencil button also enters rename mode', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Rename tmux session work' }));
    expect(screen.getByRole('textbox', { name: 'Rename tmux session work' })).toBeTruthy();
  });

  it('Enter submits the new name, calls renameTmuxSession, and closes the input', async () => {
    renameTmuxSessionMock.mockResolvedValue(undefined);
    const { onToast } = renderRail();

    fireEvent.doubleClick(screen.getByText('work'));
    const input = screen.getByRole('textbox', { name: 'Rename tmux session work' });
    fireEvent.change(input, { target: { value: 'scratch' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Input closes immediately (optimistic), before the API call resolves.
    expect(screen.queryByRole('textbox', { name: 'Rename tmux session work' })).toBeNull();

    await waitFor(() => expect(renameTmuxSessionMock).toHaveBeenCalledWith('work', 'scratch'));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Renamed session → scratch', 'ok'));
  });

  it('Escape cancels without calling renameTmuxSession', () => {
    renderRail();
    fireEvent.doubleClick(screen.getByText('work'));
    const input = screen.getByRole('textbox', { name: 'Rename tmux session work' });
    fireEvent.change(input, { target: { value: 'scratch' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Rename tmux session work' })).toBeNull();
    expect(renameTmuxSessionMock).not.toHaveBeenCalled();
    // The group header still shows the original name — nothing was applied.
    expect(screen.getByText('work')).toBeTruthy();
  });

  it('submitting an unchanged name is a no-op (no API call)', async () => {
    renderRail();
    fireEvent.doubleClick(screen.getByText('work'));
    const input = screen.getByRole('textbox', { name: 'Rename tmux session work' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByRole('textbox', { name: 'Rename tmux session work' })).toBeNull();
    expect(renameTmuxSessionMock).not.toHaveBeenCalled();
  });

  it('submitting a name that sanitizes to blank is a no-op (no API call)', async () => {
    renderRail();
    fireEvent.doubleClick(screen.getByText('work'));
    const input = screen.getByRole('textbox', { name: 'Rename tmux session work' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(renameTmuxSessionMock).not.toHaveBeenCalled();
  });

  it('surfaces a failure via onToast when renameTmuxSession rejects', async () => {
    renameTmuxSessionMock.mockRejectedValue(new Error('no such tmux session'));
    const { onToast } = renderRail();

    fireEvent.doubleClick(screen.getByText('work'));
    const input = screen.getByRole('textbox', { name: 'Rename tmux session work' });
    fireEvent.change(input, { target: { value: 'scratch' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('rename failed: no such tmux session', 'error'),
    );
  });

  it('blurring the input submits, same as Enter', async () => {
    renameTmuxSessionMock.mockResolvedValue(undefined);
    renderRail();

    fireEvent.doubleClick(screen.getByText('work'));
    const input = screen.getByRole('textbox', { name: 'Rename tmux session work' });
    fireEvent.change(input, { target: { value: 'scratch' } });
    fireEvent.blur(input);

    await waitFor(() => expect(renameTmuxSessionMock).toHaveBeenCalledWith('work', 'scratch'));
  });
});
