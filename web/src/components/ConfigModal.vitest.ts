// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { ConfigModal } from './ConfigModal';
import type { ControlConfig, ModelsInfo } from '../lib/api';

// ConfigModal calls the named wrapper functions (getConfig/saveConfig/
// getModels/getVersion), not authFetch directly. Those wrappers close over
// authFetch from *within* lib/api.ts's own module scope, so spreading
// `actual` and overriding only `authFetch` (the StudioModal.vitest.ts idiom)
// never reaches them — the real fetch still runs underneath. Mock the named
// exports ConfigModal actually calls instead.
const getConfigMock = vi.fn();
const saveConfigMock = vi.fn();
const getModelsMock = vi.fn();
const getVersionMock = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    getConfig: (...args: unknown[]) => getConfigMock(...args),
    saveConfig: (...args: unknown[]) => saveConfigMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
    getVersion: (...args: unknown[]) => getVersionMock(...args),
  };
});

// Stub GSAP so useModalTransition's enter/exit timelines resolve synchronously
// — same stub as StudioModal.vitest.ts / lib/anim.vitest.ts.
vi.mock('gsap', () => {
  const noop = () => {};
  const makeTimeline = (opts?: { onComplete?: () => void }) => {
    const self = { fromTo: () => self, to: () => self, kill: noop };
    opts?.onComplete?.();
    return self;
  };
  return { default: { set: noop, timeline: makeTimeline } };
});

const FIXTURE_CONFIG: ControlConfig = {
  launchCommand: 'claude',
  claudeBin: '',
  codexLaunchCommand: 'codex',
  codexBin: '',
  defaultCwd: '/Users/dev/project',
  optimizeModel: 'claude-sonnet',
  optimizeBackend: 'mlx',
  mlxModel: 'qwen-7b',
  transcriptFontSize: 0,
  externalFontSize: 0,
  projectDirs: [],
  restartSupported: false,
  skipPermissions: true,
};

const FIXTURE_MODELS: ModelsInfo = {
  machine: { ramGB: 32, arch: 'arm64', platform: 'darwin', appleSilicon: true },
  mlxModels: [{ id: 'qwen-7b', label: 'Qwen 7B', sizeGB: 4, minRamGB: 8, installed: true }],
  claudeModels: [{ id: 'claude-sonnet', label: 'Sonnet' }],
  codexModels: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
  claudexModels: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (Codex)' }],
  claudemiModels: [{ id: 'kimi-k3', label: 'Kimi K3' }],
  recommendedMlxModel: 'qwen-7b',
  recommendedClaudeModel: 'claude-sonnet',
};

function mockApi(config: ControlConfig = FIXTURE_CONFIG): void {
  getConfigMock.mockReset().mockResolvedValue(config);
  saveConfigMock.mockReset().mockImplementation((partial: Partial<ControlConfig>) =>
    Promise.resolve({ ...config, ...partial }),
  );
  getModelsMock.mockReset().mockResolvedValue(FIXTURE_MODELS);
  getVersionMock.mockReset().mockResolvedValue(null);
}

// `.config-field` wraps the label span + control + a `.config-hint` span in
// one <label>, so the computed accessible name is "Transcript font size" +
// the full hint sentence, not the exact label text alone. getByLabelText
// does an exact-string match against that concatenated name and can never
// resolve it — getByRole with a regex `name` does a substring/regex test
// against the same accname instead, which does resolve.
function fontSizeSelect(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: /Transcript font size/ }) as HTMLSelectElement;
}
function defaultCwdInput(): HTMLInputElement {
  return screen.getByRole('textbox', { name: /Default cwd/ }) as HTMLInputElement;
}

async function renderModal() {
  const onClose = vi.fn();
  const onToast = vi.fn();
  render(createElement(ConfigModal, { onClose, onToast }));
  // Wait for getConfig() to resolve — General (the default section) gates its
  // fields on `loading`, so the Transcript font size select re-enabling is the
  // signal the fetch has landed.
  await waitFor(() => expect(fontSizeSelect().disabled).toBe(false));
  return { onClose, onToast };
}

beforeEach(() => mockApi());
afterEach(cleanup);

describe('ConfigModal — sections', () => {
  it('renders the 4-item left nav and defaults to the General section', async () => {
    await renderModal();

    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
    const navItems = ['General', 'Harness', 'Voice Control', 'Session Defaults'];
    for (const label of navItems) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: /General/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /Harness/ }).getAttribute('aria-current')).toBeNull();

    // General section fields visible; other sections' fields are not mounted.
    expect(screen.getByText('Transcript font size')).toBeTruthy();
    expect(screen.queryByText('Enhancer backend')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Default cwd/ })).toBeNull();
  });

  it('clicking a nav item swaps the visible section — Harness fields appear, General fields disappear, aria-current moves', async () => {
    await renderModal();

    fireEvent.click(screen.getByRole('button', { name: /Harness/ }));

    expect(screen.getByRole('button', { name: /Harness/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /General/ }).getAttribute('aria-current')).toBeNull();

    // Harness section now visible (Claude Code + Codex + OpenCode placeholder).
    expect(screen.getAllByText('Command to run').length).toBeGreaterThan(0);
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('Coming soon')).toBeTruthy();

    // General's fields are gone (only one section renders at a time).
    expect(screen.queryByText('Transcript font size')).toBeNull();
    expect(screen.queryByText('Live preview')).toBeNull();
  });

  it('the OpenCode placeholder is disabled and unwired — no live state, present purely as a preview', async () => {
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Harness/ }));

    const group = screen.getByText('OpenCode').closest('.config-agent-group') as HTMLElement;
    expect(group.getAttribute('data-disabled')).toBe('true');
    const inputs = group.querySelectorAll('input');
    inputs.forEach((input) => expect((input as HTMLInputElement).disabled).toBe(true));
  });

  it('Voice Control section shows the enhancer/model fields; Session Defaults shows cwd + project dirs', async () => {
    await renderModal();

    fireEvent.click(screen.getByRole('button', { name: /Voice Control/ }));
    expect(screen.getByText('Enhancer backend')).toBeTruthy();
    expect(screen.getByText('MLX model')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Session Defaults/ }));
    expect(defaultCwdInput()).toBeTruthy();
    expect(screen.getByText('Project directories')).toBeTruthy();
    expect(screen.queryByText('Enhancer backend')).toBeNull();
  });
});

describe('ConfigModal — Save persists the full payload regardless of active section', () => {
  it('editing a field on one section, then switching sections, still saves that edit as part of the complete payload', async () => {
    const { onToast, onClose } = await renderModal();

    // Edit a Session Defaults field, then navigate away to Voice Control
    // before saving — the shared form state must survive the section switch.
    fireEvent.click(screen.getByRole('button', { name: /Session Defaults/ }));
    fireEvent.change(defaultCwdInput(), { target: { value: '/Users/dev/other-project' } });
    fireEvent.click(screen.getByRole('button', { name: /Voice Control/ }));
    expect(screen.queryByRole('textbox', { name: /Default cwd/ })).toBeNull(); // unmounted, but state persists

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    const body = saveConfigMock.mock.calls[0][0] as Partial<ControlConfig>;

    // Full payload — every field Save ever sends, not just the one edited on
    // the currently-active section.
    expect(Object.keys(body).sort()).toEqual(
      [
        'launchCommand',
        'claudeBin',
        'codexLaunchCommand',
        'codexBin',
        'defaultCwd',
        'optimizeModel',
        'optimizeBackend',
        'mlxModel',
        'transcriptFontSize',
        'externalFontSize',
        'projectDirs',
        'skipPermissions',
      ].sort(),
    );
    expect(body.defaultCwd).toBe('/Users/dev/other-project'); // the edit survived the section switch
    expect(body.launchCommand).toBe(FIXTURE_CONFIG.launchCommand); // untouched fields still included

    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Config saved', 'ok'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ConfigModal — General section: live preview', () => {
  it('the live preview font-size follows the Transcript font size select, with no save required', async () => {
    await renderModal();

    const select = fontSizeSelect();
    fireEvent.change(select, { target: { value: '16' } });

    const previewMsg = document.querySelector('.config-preview-msg') as HTMLElement;
    expect(previewMsg.style.fontSize).toBe('16px');

    fireEvent.change(select, { target: { value: '0' } });
    expect(previewMsg.style.fontSize).toBe('');
  });
});

describe('ConfigModal — Harness section: skip permission prompts toggle', () => {
  it('defaults to checked (ON) when the server config omits skipPermissions', async () => {
    mockApi({ ...FIXTURE_CONFIG, skipPermissions: undefined as unknown as boolean });
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Harness/ }));

    const checkbox = screen.getByRole('checkbox', {
      name: /Skip permission prompts/,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('reflects skipPermissions: false from the server, and saving after unchecking sends false', async () => {
    mockApi({ ...FIXTURE_CONFIG, skipPermissions: false });
    const { onToast } = await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Harness/ }));

    const checkbox = screen.getByRole('checkbox', {
      name: /Skip permission prompts/,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Config saved', 'ok'));
    const body = saveConfigMock.mock.calls[0][0] as Partial<ControlConfig>;
    expect(body.skipPermissions).toBe(true);
  });
});

// Fix 3 (cloud-local-tabs): the "Olam cloud" settings section is a read-only
// setup guide — explains the olam.json shape, lists configured orgs with
// LIVE health (green/red + reason + exact re-auth command), and the
// zero-orgs empty state points at how to create olam.json. Never renders a
// secret value — only reasons/commands/spaBase (server.js's olamOrgs +
// olamHealth fields, GET /api/config).
describe('ConfigModal — Olam cloud section (Fix 3 setup guide)', () => {
  it('zero configured orgs shows guidance on how to create olam.json, not an org list', async () => {
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Olam cloud/ }));

    expect(screen.getByText(/No Olam cloud clusters configured yet/)).toBeTruthy();
    expect(screen.getByText('olam.json')).toBeTruthy();
    expect(screen.getByText('~/.claude-control/olam.json')).toBeTruthy();
    expect(document.querySelector('.config-olam-orgs')).toBeNull();
  });

  it('a red (unhealthy) org lists its health dot + the exact re-auth command, never a secret value', async () => {
    mockApi({
      ...FIXTURE_CONFIG,
      olamOrgs: [{ org: 'grain', spaBase: 'https://grain.olam.example' }],
      olamHealth: {
        grain: {
          status: 'red',
          reason: 'Access session expired — run: cloudflared access login https://grain.olam.example',
        },
      },
    });
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Olam cloud/ }));

    expect(screen.getByText('grain')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'https://grain.olam.example' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://grain.olam.example/');
    const reason = screen.getByRole('note');
    expect(reason.textContent).toBe(
      'Access session expired — run: cloudflared access login https://grain.olam.example',
    );
    const dot = document.querySelector('.remote-health') as HTMLElement;
    expect(dot.className).toContain('remote-health-red');
  });

  it('a healthy org shows no reason banner and no capped notice', async () => {
    mockApi({
      ...FIXTURE_CONFIG,
      olamOrgs: [{ org: 'atlas', spaBase: 'https://atlas.olam.example' }],
      olamHealth: { atlas: { status: 'green', reason: null } },
    });
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Olam cloud/ }));

    expect(screen.getByText('atlas')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    expect(document.querySelector('.config-olam-org-capped')).toBeNull();
    const dot = document.querySelector('.remote-health') as HTMLElement;
    expect(dot.className).toContain('remote-health-green');
  });

  it('a capped org surfaces the lower-bound notice', async () => {
    mockApi({
      ...FIXTURE_CONFIG,
      olamOrgs: [{ org: 'atlas', spaBase: 'https://atlas.olam.example' }],
      olamHealth: { atlas: { status: 'green', reason: null, capped: true } },
    });
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Olam cloud/ }));

    expect(screen.getByText(/hit the fetch page limit/)).toBeTruthy();
  });

  it('an org missing from olamHealth entirely still renders (unknown status), never crashes', async () => {
    mockApi({
      ...FIXTURE_CONFIG,
      olamOrgs: [{ org: 'pleri', spaBase: null }],
      olamHealth: {},
    });
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Olam cloud/ }));

    expect(screen.getByText('pleri')).toBeTruthy();
    const dot = document.querySelector('.remote-health') as HTMLElement;
    expect(dot.className).toContain('remote-health-unknown');
  });
});

describe('ConfigModal — a11y', () => {
  it('the active nav item is the only one carrying aria-current="page"', async () => {
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Session Defaults/ }));

    const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('Session Defaults');
  });
});
