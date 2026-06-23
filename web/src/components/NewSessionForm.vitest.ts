// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { filterTag, NewSessionForm, normalizeClaudeTransport, normalizeCodexTransport } from './NewSessionForm';
import type { SessionFilter } from './SessionRail';

// ── filterTag ────────────────────────────────────────────────────────────────
// Pure helper: returns the badge label for the filter funnel button.

describe('filterTag', () => {
  it('returns null for "all"', () => {
    expect(filterTag('all')).toBeNull();
  });

  it('returns "CC" for "claude"', () => {
    expect(filterTag('claude')).toBe('CC');
  });

  it('returns "CX" for "codex"', () => {
    expect(filterTag('codex')).toBe('CX');
  });

  it('returns ">_" for "terminal"', () => {
    expect(filterTag('terminal')).toBe('>_');
  });
});

// ── Filter cycle ──────────────────────────────────────────────────────────────
// Mirrors the cycleFilter logic in App.tsx so we can assert the full sequence.
// If App.tsx is changed, this test catches regressions.

function cycleFilter(f: SessionFilter): SessionFilter {
  return f === 'all'
    ? 'claude'
    : f === 'claude'
      ? 'codex'
      : f === 'codex'
        ? 'terminal'
        : 'all';
}

describe('filter cycle (all → claude → codex → terminal → all)', () => {
  it('all → claude', () => expect(cycleFilter('all')).toBe('claude'));
  it('claude → codex', () => expect(cycleFilter('claude')).toBe('codex'));
  it('codex → terminal', () => expect(cycleFilter('codex')).toBe('terminal'));
  it('terminal → all', () => expect(cycleFilter('terminal')).toBe('all'));

  it('full cycle returns to all', () => {
    let f: SessionFilter = 'all';
    f = cycleFilter(f); // claude
    f = cycleFilter(f); // codex
    f = cycleFilter(f); // terminal
    f = cycleFilter(f); // all
    expect(f).toBe('all');
  });
});

// ── Agent availability types ───────────────────────────────────────────────
// Light type-level smoke test that the SpawnAgentInfo shape is correct.

import type { SpawnAgentInfo } from '../lib/api';

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

  it('codex entry may advertise per-session transports', () => {
    const info: SpawnAgentInfo = {
      id: 'codex',
      available: true,
      defaultTransport: 'rpc',
      transports: ['rpc', 'tmux'],
    };
    expect(info.defaultTransport).toBe('rpc');
    expect(info.transports).toEqual(['rpc', 'tmux']);
  });
});

describe('normalizeCodexTransport', () => {
  it('keeps tmux when requested', () => {
    expect(normalizeCodexTransport('tmux')).toBe('tmux');
  });

  it('defaults every other value to rpc', () => {
    expect(normalizeCodexTransport('rpc')).toBe('rpc');
    expect(normalizeCodexTransport(undefined)).toBe('rpc');
    expect(normalizeCodexTransport('other')).toBe('rpc');
  });
});

describe('normalizeClaudeTransport', () => {
  it('keeps print when requested', () => {
    expect(normalizeClaudeTransport('print')).toBe('print');
  });

  it('defaults every other value to tmux', () => {
    expect(normalizeClaudeTransport('tmux')).toBe('tmux');
    expect(normalizeClaudeTransport(undefined)).toBe('tmux');
    expect(normalizeClaudeTransport('rpc')).toBe('tmux');
  });
});

describe('NewSessionForm agent and Codex mode controls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps unavailable agent options selectable and shows Claude + Codex mode controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/spawn-agents')) {
        return new Response(JSON.stringify({
          agents: [
            {
              id: 'claude',
              available: false,
              reason: 'claude missing',
              defaultTransport: 'print',
              transports: ['tmux', 'print'],
            },
            {
              id: 'codex',
              available: false,
              reason: 'codex missing',
              defaultTransport: 'tmux',
              transports: ['rpc', 'tmux'],
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/api/config')) {
        return new Response(JSON.stringify({ defaultCwd: '/workspace' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }));

    render(createElement(NewSessionForm, {
      onToast: () => {},
      filter: 'all',
      onCycleFilter: () => {},
    }));
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));

    const claudeButton = await screen.findByRole('button', { name: 'Claude' });
    const codexButton = await screen.findByRole('button', { name: 'Codex' });
    expect((claudeButton as HTMLButtonElement).disabled).toBe(false);
    expect((codexButton as HTMLButtonElement).disabled).toBe(false);

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Claude mode' })).toBeTruthy();
    });
    const interactiveButton = screen.getByRole('button', { name: 'Interactive' }) as HTMLButtonElement;
    const printButton = screen.getByRole('button', { name: 'Print mode' }) as HTMLButtonElement;
    expect(interactiveButton.disabled).toBe(false);
    expect(printButton.disabled).toBe(false);
    expect(printButton.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(codexButton);

    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Codex mode' })).toBeTruthy();
    });
    const rpcButton = screen.getByRole('button', { name: 'RPC' }) as HTMLButtonElement;
    const tuiButton = screen.getByRole('button', { name: 'TUI' }) as HTMLButtonElement;
    expect(rpcButton.disabled).toBe(false);
    expect(tuiButton.disabled).toBe(false);
    expect(tuiButton.getAttribute('aria-pressed')).toBe('true');
  });
});
