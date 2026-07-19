import { describe, it, expect } from 'vitest';
import type { Session } from '../lib/types';
import type { SessionFilter } from './SessionRail';

// ── Codex filter logic ───────────────────────────────────────────────────────
// Mirrors the filter predicate in SessionRail's useMemo so the codex branch
// can be unit-tested without rendering.
//
// CP3 Fix 1: claudex (kind 'claudex') is the PRIMARY codex-flavored option
// (design decision 7, locked) — it now surfaces under the 'codex' filter
// bucket, NOT 'claude'. Pane TREATMENT (icon/aria-label, tested below) stays
// claude-like; only the filter BUCKET is codex-flavored. Claudemi (kind
// 'claudemi' — the same claude binary, pointed at Kimi via the olam
// auth-worker) is claudex's sibling and folds into the same 'codex' bucket.

function applyFilter(sessions: Session[], filter: SessionFilter): Session[] {
  return sessions.filter((s) => {
    if (filter === 'all') return true;
    if (filter === 'terminal') return s.kind === 'terminal';
    if (filter === 'codex') return s.kind === 'codex' || s.kind === 'claudex' || s.kind === 'claudemi';
    // 'claude': claude-only — kind === 'claude' or kind unset
    return s.kind === 'claude' || s.kind === undefined;
  });
}

function makeSession(partial: Partial<Session>): Session {
  return { id: 'test', ...partial };
}

describe('SessionRail codex filter', () => {
  const claude = makeSession({ id: 'c1', kind: 'claude' });
  const claudex = makeSession({ id: 'cx0', kind: 'claudex' });
  const claudemi = makeSession({ id: 'cm0', kind: 'claudemi' });
  const codex = makeSession({ id: 'cx1', kind: 'codex' });
  const terminal = makeSession({ id: 't1', kind: 'terminal' });
  const unknown = makeSession({ id: 'u1' }); // kind unset

  it('filter="all" shows all session kinds', () => {
    const result = applyFilter([claude, claudex, claudemi, codex, terminal, unknown], 'all');
    expect(result).toHaveLength(6);
  });

  it('filter="codex" shows codex, claudex, AND claudemi sessions (codex-flavored bucket)', () => {
    const result = applyFilter([claude, claudex, claudemi, codex, terminal, unknown], 'codex');
    expect(result.map((s) => s.id).sort()).toEqual(['cm0', 'cx0', 'cx1']);
  });

  it('filter="claude" excludes claudex, claudemi, codex, and terminal', () => {
    const result = applyFilter([claude, claudex, claudemi, codex, terminal, unknown], 'claude');
    // Includes 'claude' kind and 'unknown' (no kind) but not claudex, claudemi, codex, or terminal.
    expect(result.some((s) => s.kind === 'claudex')).toBe(false);
    expect(result.some((s) => s.kind === 'claudemi')).toBe(false);
    expect(result.some((s) => s.kind === 'codex')).toBe(false);
    expect(result.some((s) => s.kind === 'terminal')).toBe(false);
    expect(result.find((s) => s.id === 'c1')).toBeTruthy();
    expect(result.find((s) => s.id === 'u1')).toBeTruthy();
  });

  it('filter="terminal" shows only terminal sessions', () => {
    const result = applyFilter([claude, claudex, claudemi, codex, terminal, unknown], 'terminal');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });

  it('filter="codex" returns empty when no codex/claudex/claudemi sessions exist', () => {
    const result = applyFilter([claude, terminal], 'codex');
    expect(result).toHaveLength(0);
  });
});

// ── Codex badge rendering logic ───────────────────────────────────────────────
// The PaneRow determines data-kind from s.kind. Verify the kind derivation:
//   terminal → 'terminal'
//   codex    → 'codex'
//   claude   → 'claude'
//   claudex  → 'claude' (pane TREATMENT stays claude-like — only the rail
//              FILTER bucket above is codex-flavored; isCodex only ever
//              matches the literal 'codex' kind)
//   claudemi → 'claude' (same pane-TREATMENT story as claudex)
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

  it('claudex session gets data-kind="claude" (pane treatment, not filter bucket)', () => {
    expect(deriveDataKind(makeSession({ kind: 'claudex' }))).toBe('claude');
  });

  it('claudemi session gets data-kind="claude" (pane treatment, not filter bucket)', () => {
    expect(deriveDataKind(makeSession({ kind: 'claudemi' }))).toBe('claude');
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

  it('claudex session gets "Claude pane" aria-label (same claude TUI, just a different upstream)', () => {
    expect(deriveAriaLabel(makeSession({ kind: 'claudex' }))).toBe('Claude pane');
  });

  it('claudemi session gets "Claude pane" aria-label (same claude TUI, just a different upstream)', () => {
    expect(deriveAriaLabel(makeSession({ kind: 'claudemi' }))).toBe('Claude pane');
  });

  it('terminal session gets "terminal pane" aria-label', () => {
    expect(deriveAriaLabel(makeSession({ kind: 'terminal' }))).toBe('terminal pane');
  });
});
