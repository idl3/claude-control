// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { NewSessionDraft } from './NewSessionDraft';
import type { SpawnAgentInfo } from '../lib/api';

// GSAP drives the center<->bottom slide-on-submit + idle centering. Stub it
// so timelines resolve synchronously regardless of prefers-reduced-motion —
// matching the established pattern in lib/anim.vitest.ts. These tests care
// about payload/DOM state, not animation timing, and jsdom has no layout
// engine anyway (offsetHeight is always 0), so there's nothing meaningful to
// assert about the actual lift/slide distances here.
vi.mock('gsap', () => {
  const noop = () => {};
  const makeTimeline = (opts?: { onComplete?: () => void }) => {
    const self = { fromTo: () => self, to: () => self, kill: noop };
    opts?.onComplete?.();
    return self;
  };
  return { default: { set: noop, timeline: makeTimeline } };
});

afterEach(cleanup);

// ── DOM helpers for the Dropdown/segmented-control chrome ───────────────────
// The agent/model/cwd/tmux pickers are no longer native <select> elements
// (see NewSessionDraft.tsx + Dropdown.tsx), so tests drive them by clicking
// the trigger button (labeled via aria-label, same as a native select would
// be via getByLabelText) and then the rendered `role="option"` row, scoped to
// the open `role="listbox"` to avoid colliding with the trigger's own label
// text (e.g. both can render "Opus 4.8" at once while the menu is open).

/** Opens a Dropdown by its aria-label and returns the resulting listbox. */
function openDropdown(ariaLabel: string): HTMLElement {
  fireEvent.click(screen.getByLabelText(ariaLabel));
  return screen.getByRole('listbox');
}

/** Clicks the option row (scoped to an open listbox) whose visible text is `labelText`. */
function pickOption(menu: HTMLElement, labelText: string) {
  fireEvent.click(within(menu).getByText(labelText).closest('[role="option"]') as HTMLElement);
}

/** The segmented Harness control (Claude | Codex). */
function harnessGroup(): HTMLElement {
  return screen.getByRole('group', { name: 'Harness' });
}

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

describe('NewSessionDraft welcome hero', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the shared WelcomeHero (heading + chips) instead of a bespoke "New session" title', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    expect(screen.getByText('What are we shipping today?')).toBeTruthy();
    expect(screen.queryByText('New session')).toBeNull();
    // Toolbar row (harness/model/etc.) still renders alongside the hero.
    expect(await screen.findByRole('group', { name: 'Harness' })).toBeTruthy();
    expect(screen.getByLabelText('Model')).toBeTruthy();
  });

  it('renders every welcome chip', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    // role="listitem" has "Name from: prohibited" per the ARIA spec, so
    // getByRole(..., {name}) never matches these buttons on text content —
    // query by text instead, and assert the ARIA structure (5 listitems)
    // separately.
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Plan with /plan-hard')).toBeTruthy();
    expect(screen.getByText('Browse skills (/)')).toBeTruthy();
    expect(screen.getByText('Mention an agent (@)')).toBeTruthy();
    expect(screen.getByText('Dictate (⌘S)')).toBeTruthy();
    expect(screen.getByText('Run a shell command (>_)')).toBeTruthy();
  });

  it('clicking a clickable chip inserts its text into the prompt and focuses it', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const textarea = await screen.findByLabelText('Initial prompt') as HTMLTextAreaElement;
    fireEvent.click(screen.getByText('Plan with /plan-hard'));
    expect(textarea.value).toBe('/plan-hard ');
    expect(document.activeElement).toBe(textarea);
  });

  it('a decorative chip (no insert text) does not touch the prompt', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const textarea = await screen.findByLabelText('Initial prompt') as HTMLTextAreaElement;
    fireEvent.click(screen.getByText('Dictate (⌘S)'));
    expect(textarea.value).toBe('');
  });

  it('submit still calls createSession once, hero rendered alongside the composer', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByText('What are we shipping today?');
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(createCalls.length).toBe(1));
  });
});

/** Mirrors lib/models.js CLAUDE_MODELS — kept in sync by the model-id
 *  assertion test below (asserts the real ids, not this fixture). */
const FIXTURE_CLAUDE_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

function stubApi({
  claudeAvailable = true,
  codexAvailable = true,
  createResponse,
  tmuxSessions,
  projectDirs,
}: {
  claudeAvailable?: boolean;
  codexAvailable?: boolean;
  createResponse?: (body: Record<string, unknown>) => Response;
  tmuxSessions?: { name: string; windows: number; grouped?: boolean; groupSize?: number }[];
  projectDirs?: { label: string; path: string }[];
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
    if (url.endsWith('/api/models')) {
      return new Response(JSON.stringify({
        machine: { ramGB: 32, arch: 'arm64', platform: 'darwin', appleSilicon: true },
        mlxModels: [],
        claudeModels: FIXTURE_CLAUDE_MODELS,
        codexModels: [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.4', label: 'GPT-5.4' }],
        recommendedMlxModel: '',
        recommendedClaudeModel: 'claude-haiku-4-5-20251001',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
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
      return new Response(JSON.stringify({ defaultCwd: '/workspace', projectDirs: projectDirs ?? [] }), {
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

describe('NewSessionDraft harness segmented control + model dropdown', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an unavailable agent disabled in the Harness control, with the reason as its title', async () => {
    stubApi({ codexAvailable: false });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const group = harnessGroup();
    const codexBtn = await waitFor(() => within(group).getByRole('button', { name: 'Codex (unavailable)' }));
    expect((codexBtn as HTMLButtonElement).disabled).toBe(true);
    expect(codexBtn.getAttribute('title')).toBe('codex missing');
    // Claude is the only available agent, so it stays selected.
    expect(within(group).getByRole('button', { name: 'Claude' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('labels the default model row with the real flagship name plus a muted "Default" badge, never the literal word "Default", and never duplicates the flagship row', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    // ASSUMPTION under test (see the same comment in NewSessionDraft.tsx):
    // modelOptions[0] is the harness default — the trigger must show its
    // real name, never the literal word "Default".
    const trigger = await screen.findByLabelText('Model');
    await waitFor(() => expect(trigger.textContent).toContain('Opus 4.8'));

    const menu = openDropdown('Model');
    const options = within(menu).getAllByRole('option');
    // Default(Opus 4.8) + Sonnet 5 + Fable 5 + Haiku 4.5 — exactly 4 rows;
    // Opus 4.8 appears ONCE, as the badged default row, never a second time.
    expect(options).toHaveLength(4);
    expect(within(menu).getByText('Default')).toBeTruthy();
    expect(within(menu).getAllByText('Opus 4.8')).toHaveLength(1);
  });

  it('lists every fetched Claude model in the open dropdown', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    const menu = openDropdown('Model');
    await waitFor(() => expect(within(menu).getByText('Sonnet 5')).toBeTruthy());
    expect(within(menu).getByText('Fable 5')).toBeTruthy();
    expect(within(menu).getByText('Haiku 4.5')).toBeTruthy();
  });

  it('selecting a non-default model updates the trigger label and submits its real id', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    const menu = openDropdown('Model');
    await waitFor(() => expect(within(menu).getByText('Fable 5')).toBeTruthy());
    pickOption(menu, 'Fable 5');
    expect(screen.getByLabelText('Model').textContent).toContain('Fable 5');

    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].model).toBe('claude-fable-5');
  });

  it('switching harness from Claude to Codex re-defaults the model, swaps the revealed mode group, and swaps in the "no session name" note', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    fireEvent.click(await screen.findByRole('button', { name: /Advanced/ }));
    expect(screen.getByRole('group', { name: 'Claude mode' })).toBeTruthy();

    // Pick a non-default model before switching, to prove the switch resets it.
    let menu = openDropdown('Model');
    await waitFor(() => expect(within(menu).getByText('Sonnet 5')).toBeTruthy());
    pickOption(menu, 'Sonnet 5');
    expect(screen.getByLabelText('Model').textContent).toContain('Sonnet 5');

    fireEvent.click(within(harnessGroup()).getByRole('button', { name: 'Codex' }));

    await waitFor(() => expect(screen.getByLabelText('Model').textContent).toContain('GPT-5.5'));
    expect(screen.getByRole('group', { name: 'Codex mode' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Claude mode' })).toBeNull();
    expect(screen.getByText('Codex has no session name')).toBeTruthy();
  });
});

describe('NewSessionDraft Codex model options', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the Model dropdown defaulted to the real flagship label (GPT-5.5), plus every fetched Codex model', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'codex',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const trigger = await screen.findByLabelText('Model');
    await waitFor(() => expect(trigger.textContent).toContain('GPT-5.5'));

    const menu = openDropdown('Model');
    await waitFor(() => expect(within(menu).getByText('GPT-5.4')).toBeTruthy());
    // GPT-5.5 appears once — as the badged default row, not duplicated.
    expect(within(menu).getAllByText('GPT-5.5')).toHaveLength(1);
  });

  it('sends the selected codexModel id on create, and omits it when left at Default', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'codex',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    const menu = openDropdown('Model');
    await waitFor(() => expect(within(menu).getByText('GPT-5.4')).toBeTruthy());
    pickOption(menu, 'GPT-5.4');
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].codexModel).toBe('gpt-5.4');
    expect(createCalls[0].agent).toBe('codex');
  });

  it('omits codexModel when left at Default', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'codex',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].codexModel).toBeUndefined();
  });

  it('does not send codexModel for claude even if one was picked while on codex', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'codex',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    const menu = openDropdown('Model');
    await waitFor(() => expect(within(menu).getByText('GPT-5.4')).toBeTruthy());
    pickOption(menu, 'GPT-5.4');

    fireEvent.click(within(harnessGroup()).getByRole('button', { name: 'Claude' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].agent).toBe('claude');
    expect(createCalls[0].codexModel).toBeUndefined();
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

    await screen.findByLabelText('Model');
    const menu = openDropdown('Model');
    await waitFor(() => expect(within(menu).getByText('Sonnet 5')).toBeTruthy());
    pickOption(menu, 'Sonnet 5');

    const textarea = screen.getByLabelText('Initial prompt');
    fireEvent.change(textarea, { target: { value: 'fix the failing test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].model).toBe('claude-sonnet-5');
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

    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

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

    await screen.findByLabelText('Model');
    // Opus 4.8 is already the (badged) default row — pick a genuinely
    // distinct, explicit model id instead, so a real value is in flight
    // when we switch harness.
    const menu = openDropdown('Model');
    await waitFor(() => expect(within(menu).getByText('Haiku 4.5')).toBeTruthy());
    pickOption(menu, 'Haiku 4.5');

    fireEvent.click(within(harnessGroup()).getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

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

  it('lists fetched tmux sessions in the dropdown and defaults the selection to the first one', async () => {
    stubApi({ tmuxSessions: [{ name: 'work', windows: 3 }, { name: 'claude-control', windows: 1 }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const trigger = await screen.findByLabelText('Tmux session');
    // New default behavior: auto-selects the first fetched session (rather
    // than leaving the picker on "(default)").
    await waitFor(() => expect(trigger.textContent).toContain('work (3 windows)'));

    const menu = openDropdown('Tmux session');
    expect(within(menu).getByText('claude-control (1 window)')).toBeTruthy();
    expect(within(menu).getByText('New tmux session…')).toBeTruthy();
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

    const trigger = await screen.findByLabelText('Tmux session');
    await waitFor(() => expect(trigger.textContent).toContain('claude-control & olam'));
    const menu = openDropdown('Tmux session');
    expect(within(menu).getByText('claude-control & olam (20 windows) · shared (4 linked)')).toBeTruthy();
    // Non-grouped entries render exactly as before, no hint appended.
    expect(within(menu).getByText('cc_14517 (2 windows)')).toBeTruthy();
  });

  it('selecting "New tmux session…" reveals the name input; picking an existing session hides it', async () => {
    stubApi({ tmuxSessions: [{ name: 'work', windows: 1 }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const trigger = await screen.findByLabelText('Tmux session');
    await waitFor(() => expect(trigger.textContent).toContain('work (1 window)'));
    expect(screen.queryByLabelText('New tmux session name')).toBeNull();

    pickOption(openDropdown('Tmux session'), 'New tmux session…');
    expect(await screen.findByLabelText('New tmux session name')).toBeTruthy();

    pickOption(openDropdown('Tmux session'), 'work (1 window)');
    expect(screen.queryByLabelText('New tmux session name')).toBeNull();
  });

  it('auto-selects the first fetched tmux session as the default, sending it on create', async () => {
    const { createCalls } = stubApi({ tmuxSessions: [{ name: 'work', windows: 1 }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    const trigger = await screen.findByLabelText('Tmux session');
    await waitFor(() => expect(trigger.textContent).toContain('work (1 window)'));
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].tmuxSession).toBe('work');
    expect(createCalls[0].newTmuxSession).toBeUndefined();
  });

  it('explicitly selecting an existing session sends tmuxSession, not newTmuxSession', async () => {
    const { createCalls } = stubApi({ tmuxSessions: [{ name: 'work', windows: 1 }, { name: 'other', windows: 2 }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    const trigger = await screen.findByLabelText('Tmux session');
    await waitFor(() => expect(trigger.textContent).toContain('work (1 window)'));
    pickOption(openDropdown('Tmux session'), 'other (2 windows)');
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].tmuxSession).toBe('other');
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
    await screen.findByLabelText('Tmux session');
    pickOption(openDropdown('Tmux session'), 'New tmux session…');
    const nameInput = await screen.findByLabelText('New tmux session name');
    fireEvent.change(nameInput, { target: { value: 'my-feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }));

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

    const trigger = await screen.findByLabelText('Tmux session');
    expect(trigger.textContent).toContain('(default)');
    const menu = openDropdown('Tmux session');
    expect(within(menu).getByText('New tmux session…')).toBeTruthy();
  });
});

describe('NewSessionDraft directory picker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults the working-directory dropdown to the entry matching this workspace', async () => {
    stubApi({
      projectDirs: [
        { label: 'other-project', path: '/Users/x/Projects/other-project' },
        { label: 'pleri-org', path: '/Users/x/Projects/pleri-org' },
      ],
    });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const trigger = await screen.findByLabelText('Working directory');
    await waitFor(() => expect(trigger.textContent).toContain('pleri-org'));
  });

  it('falls back to the (default) option when no directory matches this workspace', async () => {
    stubApi({ projectDirs: [{ label: 'other-project', path: '/Users/x/Projects/other-project' }] });
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const trigger = await screen.findByLabelText('Working directory');
    await waitFor(() => expect(trigger.textContent).toContain('(default)'));
    const menu = openDropdown('Working directory');
    expect(within(menu).getByText('other-project')).toBeTruthy();
  });
});

describe('NewSessionDraft advanced toggle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides the harness-mode pills by default and reveals/hides them via the Advanced toggle', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const toggle = await screen.findByRole('button', { name: /Advanced/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Claude mode' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: 'Claude mode' })).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Claude mode' })).toBeNull();
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
    const group = await screen.findByRole('group', { name: 'Harness' });
    expect(within(group).getByRole('button', { name: 'Codex' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Claude' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('defaults to claude for every other filter', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'terminal',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));
    const group = await screen.findByRole('group', { name: 'Harness' });
    expect(within(group).getByRole('button', { name: 'Claude' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Codex' }).getAttribute('aria-pressed')).toBe('false');
  });
});

// ── Bottom action bar: [attach] [mic] [raw] [send], shared leaves from
// ComposerActionBar.tsx — same cluster the live Composer.tsx renders. See
// NewSessionDraft.tsx's bottom `.composer-toolbar`.
describe('NewSessionDraft bottom action bar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders attach, mic, raw-send, and send buttons', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Voice input' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create session (raw)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create session' })).toBeTruthy();
  });

  it('send stays enabled with an empty prompt — starting a session does not require a message', async () => {
    stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    const textarea = await screen.findByLabelText('Initial prompt') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    const sendBtn = screen.getByRole('button', { name: 'Create session' }) as HTMLButtonElement;
    const rawBtn = screen.getByRole('button', { name: 'Create session (raw)' }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    expect(rawBtn.disabled).toBe(false);
  });

  it('raw-send also creates a session (best-effort: same submit() as primary send)', async () => {
    const { createCalls } = stubApi();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast: () => {},
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    fireEvent.click(screen.getByRole('button', { name: 'Create session (raw)' }));
    await waitFor(() => expect(createCalls.length).toBe(1));
  });

  it('attach is best-effort — surfaces a toast instead of silently no-opping (createSession has no attachment field)', async () => {
    stubApi();
    const onToast = vi.fn();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast,
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }));
    expect(onToast).toHaveBeenCalledWith('Attachments available once the session starts');
  });

  it('mic click starts recording, and an environment error (no getUserMedia in jsdom) surfaces via onToast and resets to idle', async () => {
    stubApi();
    const onToast = vi.fn();
    render(createElement(NewSessionDraft, {
      filter: 'all',
      onToast,
      onCancel: () => {},
      onCreated: () => {},
    }));

    await screen.findByLabelText('Model');
    const micBtn = screen.getByRole('button', { name: 'Voice input' });
    expect(micBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(micBtn);

    // jsdom has no getUserMedia, so useVoiceRecorder rejects almost
    // immediately; the draft surfaces the error via onToast and resets the
    // mic back to idle rather than leaving it stuck "recording" with no way
    // out — proving the mic is wired to a real recorder, not a stub.
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(expect.any(String), 'error');
    });
    expect(screen.getByRole('button', { name: 'Voice input' }).getAttribute('aria-pressed')).toBe('false');
  });
});
