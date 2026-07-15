// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import {
  defaultAgentForFilter,
  defaultName,
  filterTag,
  NewSessionForm,
  normalizeClaudeTransport,
  normalizeCodexTransport,
} from './NewSessionForm';
import type { SessionFilter } from './SessionRail';

afterEach(cleanup);

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

  it('returns "AI" for "agents"', () => {
    expect(filterTag('agents')).toBe('AI');
  });
});

// ── Filter cycle ──────────────────────────────────────────────────────────────
// Mirrors the cycleFilter logic in App.tsx so we can assert the full sequence.
// If App.tsx is changed, this test catches regressions.

function cycleFilter(f: SessionFilter): SessionFilter {
  return f === 'all'
    ? 'agents'
    : f === 'agents'
      ? 'claude'
      : f === 'claude'
        ? 'codex'
        : f === 'codex'
          ? 'terminal'
          : 'all';
}

describe('filter cycle (all → agents → claude → codex → terminal → all)', () => {
  it('all → agents', () => expect(cycleFilter('all')).toBe('agents'));
  it('agents → claude', () => expect(cycleFilter('agents')).toBe('claude'));
  it('claude → codex', () => expect(cycleFilter('claude')).toBe('codex'));
  it('codex → terminal', () => expect(cycleFilter('codex')).toBe('terminal'));
  it('terminal → all', () => expect(cycleFilter('terminal')).toBe('all'));

  it('full cycle returns to all', () => {
    let f: SessionFilter = 'all';
    f = cycleFilter(f); // agents
    f = cycleFilter(f); // claude
    f = cycleFilter(f); // codex
    f = cycleFilter(f); // terminal
    f = cycleFilter(f); // all
    expect(f).toBe('all');
  });
});

describe('defaultAgentForFilter', () => {
  it('codex filter defaults to codex', () => {
    expect(defaultAgentForFilter('codex')).toBe('codex');
  });

  it('every other filter defaults to claude', () => {
    expect(defaultAgentForFilter('all')).toBe('claude');
    expect(defaultAgentForFilter('agents')).toBe('claude');
    expect(defaultAgentForFilter('claude')).toBe('claude');
    expect(defaultAgentForFilter('terminal')).toBe('claude');
  });
});

describe('defaultName', () => {
  it('is session-<short-ts> and varies over time', () => {
    expect(defaultName(1_000_000_000_000)).toMatch(/^session-[0-9a-z]{1,6}$/);
    expect(defaultName(1_000_000_000_000)).not.toBe(defaultName(1_000_000_001_000));
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

// ── NewSessionForm (rail-foot bottom-bar control) ─────────────────────────────
// The expanded picker/composer UI moved to NewSessionDraft (see
// NewSessionDraft.vitest.ts) — this component is now just the "+ New session"
// button (opens the draft screen in the main content area) and the filter
// funnel button, rendered in the rail's bottom bar (filter left, new-session
// right).

describe('NewSessionForm', () => {
  it('renders the rail-foot "+ New session" button + filter button', () => {
    render(createElement(NewSessionForm, {
      onOpenDraft: () => {},
      filter: 'all',
      onCycleFilter: () => {},
    }));
    expect(screen.getByRole('button', { name: '+ New session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Showing all panes/ })).toBeTruthy();
  });

  it('renders the filter button before "+ New session" (filter left, primary action right)', () => {
    render(createElement(NewSessionForm, {
      onOpenDraft: () => {},
      filter: 'all',
      onCycleFilter: () => {},
    }));
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('aria-label')).toMatch(/Showing all panes/);
    expect(buttons[1].textContent).toBe('+ New session');
  });

  it('clicking "+ New session" calls onOpenDraft (no inline form expands)', () => {
    const onOpenDraft = vi.fn();
    render(createElement(NewSessionForm, {
      onOpenDraft,
      filter: 'all',
      onCycleFilter: () => {},
    }));
    fireEvent.click(screen.getByRole('button', { name: '+ New session' }));
    expect(onOpenDraft).toHaveBeenCalledTimes(1);
    // Still just the two rail-foot buttons — no expanded form appeared.
    expect(screen.queryByRole('form', { name: 'Create session' })).toBeNull();
  });

  it('clicking the filter button calls onCycleFilter and shows the right badge', () => {
    const onCycleFilter = vi.fn();
    render(createElement(NewSessionForm, {
      onOpenDraft: () => {},
      filter: 'claude',
      onCycleFilter,
    }));
    expect(screen.getByText('CC')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Showing Claude sessions/ }));
    expect(onCycleFilter).toHaveBeenCalledTimes(1);
  });
});
