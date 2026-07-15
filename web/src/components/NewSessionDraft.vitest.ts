// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { NewSessionDraft } from './NewSessionDraft';
import type { SpawnAgentInfo } from '../lib/api';

afterEach(cleanup);

// ── SpawnAgentInfo type contract ─────────────────────────────────────────────
// Light type-level smoke test that the shape NewSessionDraft consumes is
// correct (moved here from NewSessionForm.vitest.ts along with the pickers).

describe('SpawnAgentInfo type contract', () => {
  it('claude available entry has no reason', () => {
    const info: SpawnAgentInfo = { id: 'claude', available: true, defaultTransport: 'tmux', transports: ['tmux', 'print'] };
    expect(info.id).toBe('claude');
    expect(info.available).toBe(true);
    expect(info.reason).toBeUndefined();
    expect(info.transports).toEqual(['tmux', 'print']);
  });

  it('codex unavailable entry has a reason', () => {
    const info: SpawnAgentInfo = { id: 'codex', available: false, reason: 'not found' };
    expect(info.available).toBe(false);
    expect(info.reason).toBe('not found');
  });
});

function stubApi({
  claudeAvailable = true,
  codexAvailable = true,
  createResponse,
  tmuxSessions,
}: {
  claudeAvailable?: boolean;
  codexAvailable?: boolean;
  createResponse?: (body: Record<string, unknown>) => Response;
  tmuxSessions?: { name: string; windows: number; grouped?: boolean; groupSize?: number }[];
} = {}) {
  const createCalls: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/tmux/sessions')) {
      return new Response(JSON.stringify({ sessions: tmuxSessions ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/spawn-agents')) {
      return new Response(JSON.stringify({
        agents: [
          {
            id: 'claude',
            available: claudeAvailable,
            reason: claudeAvailable ? undefined : 'claude missing',
            defaultTransport: 'tmux',
            transports: ['tmux', 'print'],
          },
          {
            id: 'codex',
            available: codexAvailable,
            reason: codexAvailable ? undefined : 'codex missing',
            defaultTransport: 'rpc',
            transports: ['rpc', 'tmux'],
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/config')) {
      return new Response(JSON.stringify({ defaultCwd: '/workspace', projectDirs: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/session/new')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      createCalls.push(body);
      if (createResponse) return createResponse(body);
      return new Response(JSON.stringify({
        ok: true,
        target: 'claude-control:1',
        name: body.name || 'session-abc123',
        agent: body.agent || 'claude',
        transport: body.claudeTransport || body.codexTransport || 'tmux',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }));
  return { createCalls };
}

describe('NewSessionDraft agent, mode, and model controls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps unavailable agent options selectable and shows Claude mode + model controls', async () => {
    stubApi({ claudeAvailable: false, codexAvailable: false });

    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const claudeButton = await screen.findByRole('button', { name: 'Claude' });
    const codexButton = await screen.findByRole('button', { name: 'Codex' });
    expect((claudeButton as HTMLButtonElement).disabled).toBe(false);
    expect((codexButton as HTMLButtonElement).disabled).toBe(false);

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Claude mode' })).toBeTruthy();
      expect(screen.getByRole('group', { name: 'Model' })).toBeTruthy();
    });
    // Model picker shows all four options, default active.
    const defaultBtn = screen.getByRole('button', { name: 'Default' }) as HTMLButtonElement;
    expect(defaultBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Opus' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sonnet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Haiku' })).toBeTruthy();

    fireEvent.click(codexButton);

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Codex mode' })).toBeTruthy();
    });
    // Model picker (Claude-only) disappears for Codex.
    expect(screen.queryByRole('group', { name: 'Model' })).toBeNull();
    expect(screen.getByText('Codex has no session name')).toBeTruthy();
  });

  it('selecting a model updates aria-pressed on the segmented control', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    const opusBtn = await screen.findByRole('button', { name: 'Opus' });
    fireEvent.click(opusBtn);
    expect(opusBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('NewSessionDraft submit payload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a session with the typed prompt and selected model', async () => {
    const { createCalls } = stubApi();
    const onCreated = vi.fn();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated,
    }));

    fireEvent.click(await screen.findByRole('button', { name: 'Sonnet' }));
    const textarea = screen.getByLabelText('Initial prompt');
    fireEvent.change(textarea, { target: { value: 'fix the failing test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].model).toBe('sonnet');
    expect(createCalls[0].prompt).toBe('fix the failing test');
    expect(createCalls[0].agent).toBe('claude');

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0][0].target).toBe('claude-control:1');
  });

  it('omits model and prompt entirely when left at defaults', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].model).toBeUndefined();
    expect(createCalls[0].prompt).toBeUndefined();
  });

  it('trims whitespace-only prompt to omitted (no prompt sent)', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const textarea = await screen.findByLabelText('Initial prompt');
    fireEvent.change(textarea, { target: { value: '   \n  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].prompt).toBeUndefined();
  });

  it('does not send a model for codex even if one was picked while on claude', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    fireEvent.click(await screen.findByRole('button', { name: 'Opus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].agent).toBe('codex');
    expect(createCalls[0].model).toBeUndefined();
  });

  it('on failure, keeps the draft open with the typed prompt intact and shows an error toast', async () => {
    const onToast = vi.fn();
    const onCreated = vi.fn();
    stubApi({
      createResponse: () => new Response(JSON.stringify({ error: 'agent binary unavailable' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast,
      onCancel: () => {},
      onCreated,
    }));

    const textarea = await screen.findByLabelText('Initial prompt');
    fireEvent.change(textarea, { target: { value: 'do not lose me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('New session failed'), 'error');
    });
    expect(onCreated).not.toHaveBeenCalled();
    // The prompt text must survive the failed submit.
    expect((textarea as HTMLTextAreaElement).value).toBe('do not lose me');
  });
});

describe('NewSessionDraft tmux target picker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists fetched tmux sessions in the dropdown alongside default + New tmux session…', async () => {
    stubApi({ tmuxSessions: [{ name: 'work', windows: 3 }, { name: 'claude-control', windows: 1 }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const select = await screen.findByLabelText('Tmux session') as HTMLSelectElement;
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'work (3 windows)' })).toBeTruthy();
    });
    expect(screen.getByRole('option', { name: 'claude-control (1 window)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'New tmux session…' })).toBeTruthy();
    // Default selection preserves today's behavior (neither field sent).
    expect(select.value).toBe('');
  });

  it('appends a "shared (N linked)" hint for a collapsed session GROUP entry', async () => {
    stubApi({
      tmuxSessions: [
        { name: 'claude-control & olam', windows: 20, grouped: true, groupSize: 4 },
        { name: 'cc_14517', windows: 2 },
      ],
    });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: 'claude-control & olam (20 windows) · shared (4 linked)' }),
      ).toBeTruthy();
    });
    // Non-grouped entries render exactly as before, no hint appended.
    expect(screen.getByRole('option', { name: 'cc_14517 (2 windows)' })).toBeTruthy();
  });

  it('selecting "New tmux session…" reveals the name input; picking an existing session hides it', async () => {
    stubApi({ tmuxSessions: [{ name: 'work', windows: 1 }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const select = await screen.findByLabelText('Tmux session') as HTMLSelectElement;
    expect(screen.queryByLabelText('New tmux session name')).toBeNull();

    fireEvent.change(select, { target: { value: '__new__' } });
    expect(await screen.findByLabelText('New tmux session name')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'work' } });
    expect(screen.queryByLabelText('New tmux session name')).toBeNull();
  });

  it('default selection sends neither tmuxSession nor newTmuxSession (today\'s behavior, unchanged)', async () => {
    const { createCalls } = stubApi({ tmuxSessions: [{ name: 'work', windows: 1 }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    await screen.findByLabelText('Tmux session');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].tmuxSession).toBeUndefined();
    expect(createCalls[0].newTmuxSession).toBeUndefined();
  });

  it('selecting an existing session sends tmuxSession, not newTmuxSession', async () => {
    const { createCalls } = stubApi({ tmuxSessions: [{ name: 'work', windows: 1 }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    const select = await screen.findByLabelText('Tmux session');
    fireEvent.change(select, { target: { value: 'work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].tmuxSession).toBe('work');
    expect(createCalls[0].newTmuxSession).toBeUndefined();
  });

  it('typing a new-session name sends newTmuxSession, not tmuxSession', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    const select = await screen.findByLabelText('Tmux session');
    fireEvent.change(select, { target: { value: '__new__' } });
    const nameInput = await screen.findByLabelText('New tmux session name');
    fireEvent.change(nameInput, { target: { value: 'my-feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].newTmuxSession).toBe('my-feature');
    expect(createCalls[0].tmuxSession).toBeUndefined();
  });

  it('a fetchTmuxSessions failure is non-fatal — the picker still offers default + New tmux session…', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/tmux/sessions')) return new Response('', { status: 500 });
      if (url.endsWith('/api/spawn-agents')) {
        return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/api/config')) {
        return new Response(JSON.stringify({ defaultCwd: '/workspace', projectDirs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }));
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const select = await screen.findByLabelText('Tmux session') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: 'New tmux session…' })).toBeTruthy();
  });
});

describe('NewSessionDraft cancel / escape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Cancel button calls onCancel', async () => {
    stubApi();
    const onCancel = vi.fn();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel,
      onCreated: () => {},
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape key calls onCancel', async () => {
    stubApi();
    const onCancel = vi.fn();
    const { container } = render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel,
      onCreated: () => {},
    }));
    await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.keyDown(container.querySelector('.new-session-draft') as Element, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('NewSessionDraft agent default from filter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to codex when opened from the codex filter', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'codex',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    const codexButton = await screen.findByRole('button', { name: 'Codex' });
    expect(codexButton.getAttribute('aria-pressed')).toBe('true');
  });

  it('defaults to claude for every other filter', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'terminal',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    const claudeButton = await screen.findByRole('button', { name: 'Claude' });
    expect(claudeButton.getAttribute('aria-pressed')).toBe('true');
  });
});
