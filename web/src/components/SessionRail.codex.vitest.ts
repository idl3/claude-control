import { describe, it, expect } from 'vitest';
import type { Session } from '../lib/types';
import type { SessionFilter } from './SessionRail';

// ── Codex filter logic ───────────────────────────────────────────────────────
// Mirrors the filter predicate in SessionRail's useMemo so the codex branch
// can be unit-tested without rendering.

function applyFilter(sessions: Session[], filter: SessionFilter): Session[] {
  return sessions.filter((s) => {
    if (filter === 'all') return true;
    if (filter === 'terminal') return s.kind === 'terminal';
    if (filter === 'codex') return s.kind === 'codex';
    // 'claude': show panes that are not terminal and not codex
    return s.kind !== 'terminal' && s.kind !== 'codex';
  });
}

function makeSession(partial: Partial<Session>): Session {
  return { id: 'test', ...partial };
}

describe('SessionRail codex filter', () => {
  const claude = makeSession({ id: 'c1', kind: 'claude' });
  const codex = makeSession({ id: 'cx1', kind: 'codex' });
  const terminal = makeSession({ id: 't1', kind: 'terminal' });
  const unknown = makeSession({ id: 'u1' }); // kind unset

  it('filter="all" shows all session kinds', () => {
    const result = applyFilter([claude, codex, terminal, unknown], 'all');
    expect(result).toHaveLength(4);
  });

  it('filter="codex" shows only codex sessions', () => {
    const result = applyFilter([claude, codex, terminal, unknown], 'codex');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cx1');
  });

  it('filter="claude" excludes codex and terminal', () => {
    const result = applyFilter([claude, codex, terminal, unknown], 'claude');
    // Includes 'claude' kind and 'unknown' (no kind) but not codex or terminal
    expect(result.some((s) => s.kind === 'codex')).toBe(false);
    expect(result.some((s) => s.kind === 'terminal')).toBe(false);
    expect(result.find((s) => s.id === 'c1')).toBeTruthy();
  });

  it('filter="terminal" shows only terminal sessions', () => {
    const result = applyFilter([claude, codex, terminal, unknown], 'terminal');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });

  it('filter="codex" returns empty when no codex sessions exist', () => {
    const result = applyFilter([claude, terminal], 'codex');
    expect(result).toHaveLength(0);
  });
});

// ── Codex badge rendering logic ───────────────────────────────────────────────
// The PaneRow determines data-kind from s.kind. Verify the kind derivation:
//   terminal → 'terminal'
//   codex    → 'codex'
//   claude   → 'claude'
//   default  → 'claude' (s.kind ?? 'claude')

function deriveDataKind(s: Session): string {
  const isTerminal = s.kind === 'terminal';
  const isCodex = s.kind === 'codex';
  return isTerminal ? 'terminal' : isCodex ? 'codex' : 'claude';
}

describe('SessionRail codex badge data-kind derivation', () => {
  it('terminal session gets data-kind="terminal"', () => {
    expect(deriveDataKind(makeSession({ kind: 'terminal' }))).toBe('terminal');
  });

  it('codex session gets data-kind="codex"', () => {
    expect(deriveDataKind(makeSession({ kind: 'codex' }))).toBe('codex');
  });

  it('claude session gets data-kind="claude"', () => {
    expect(deriveDataKind(makeSession({ kind: 'claude' }))).toBe('claude');
  });

  it('session with no kind defaults to "claude" (consistent with data-kind={s.kind ?? "claude"})', () => {
    expect(deriveDataKind(makeSession({}))).toBe('claude');
  });
});

// ── aria-label derivation for codex rows ─────────────────────────────────────

function deriveAriaLabel(s: Session): string {
  const isTerminal = s.kind === 'terminal';
  const isCodex = s.kind === 'codex';
  return isTerminal ? 'terminal pane' : isCodex ? 'Codex pane' : 'Claude pane';
}

describe('SessionRail codex aria-label', () => {
  it('codex session gets "Codex pane" aria-label', () => {
    expect(deriveAriaLabel(makeSession({ kind: 'codex' }))).toBe('Codex pane');
  });

  it('claude session gets "Claude pane" aria-label', () => {
    expect(deriveAriaLabel(makeSession({ kind: 'claude' }))).toBe('Claude pane');
  });

  it('terminal session gets "terminal pane" aria-label', () => {
    expect(deriveAriaLabel(makeSession({ kind: 'terminal' }))).toBe('terminal pane');
  });
});
