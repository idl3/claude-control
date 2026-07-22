// @vitest-environment jsdom
/**
 * Unit tests for AskInline pure logic, plus DOM-level Dismiss/errored-note
 * coverage for the stale-question escape hatch (component-level tests need
 * jsdom; the pure-logic describes above don't care and stay unaffected).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { AskInline, questionHasPreview, isFreeTextOption, promptHeader } from './AskInline';
import type { PendingQuestion, Pending, PanePrompt } from '../lib/types';

afterEach(cleanup);

describe('promptHeader (minimized bar label)', () => {
  it('prefers the structured question header, falls back to the question text', () => {
    const withHeader: Pending = { toolUseId: 't', questions: [{ header: 'PIVOT', question: 'Proceed?', options: [] }] };
    expect(promptHeader({ kind: 'ask', pending: withHeader })).toBe('PIVOT');
    const noHeader: Pending = { toolUseId: 't', questions: [{ question: 'Proceed?', options: [] }] };
    expect(promptHeader({ kind: 'ask', pending: noHeader })).toBe('Proceed?');
  });
  it('uses the prompt question, or the agent fallback, for scrape prompts', () => {
    const prompt: PanePrompt = { question: 'How to proceed?', options: [] };
    expect(promptHeader({ kind: 'prompt', prompt, planMarkdown: null, agentName: 'Claude' })).toBe('How to proceed?');
    const bare: PanePrompt = { question: '', options: [] };
    expect(promptHeader({ kind: 'prompt', prompt: bare, planMarkdown: null, agentName: 'Codex' })).toBe('Codex needs a choice');
  });
  it('returns empty for no prompt', () => {
    expect(promptHeader(null)).toBe('');
  });
});

// ── Builders ──────────────────────────────────────────────────────────────────

function makeQuestion(partial: Partial<PendingQuestion>): PendingQuestion {
  return { question: 'Choose an option', options: [], ...partial };
}

function makePending(questions: PendingQuestion[]): Pending {
  return { toolUseId: 'tu-1', questions };
}

function makePanePrompt(partial: Partial<PanePrompt>): PanePrompt {
  return {
    question: 'What do you want to do?',
    options: [],
    ...partial,
  };
}

// ── questionHasPreview ────────────────────────────────────────────────────────

describe('questionHasPreview', () => {
  it('returns false when no options have a preview', () => {
    const q = makeQuestion({ options: [{ label: 'A' }, { label: 'B', description: 'desc' }] });
    expect(questionHasPreview(q)).toBe(false);
  });

  it('returns true when at least one option has a non-empty preview', () => {
    const q = makeQuestion({
      options: [{ label: 'A', preview: '┌──┐\n└──┘' }, { label: 'B' }],
    });
    expect(questionHasPreview(q)).toBe(true);
  });

  it('returns false when preview is an empty string', () => {
    expect(questionHasPreview(makeQuestion({ options: [{ label: 'A', preview: '' }] }))).toBe(false);
  });

  it('returns false for an empty options array', () => {
    expect(questionHasPreview(makeQuestion({ options: [] }))).toBe(false);
  });

  it('returns true even when only the last option has a preview', () => {
    const q = makeQuestion({
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C', preview: 'diagram' }],
    });
    expect(questionHasPreview(q)).toBe(true);
  });
});

// ── isFreeTextOption ──────────────────────────────────────────────────────────

describe('isFreeTextOption', () => {
  it('matches "Type something" (case-insensitive)', () => {
    expect(isFreeTextOption('Type something')).toBe(true);
    expect(isFreeTextOption('type something')).toBe(true);
    expect(isFreeTextOption('TYPE SOMETHING')).toBe(true);
  });

  it('matches "Chat about this" (case-insensitive)', () => {
    expect(isFreeTextOption('Chat about this')).toBe(true);
    expect(isFreeTextOption('chat about this')).toBe(true);
  });

  it('returns false for normal option labels', () => {
    expect(isFreeTextOption('Yes')).toBe(false);
    expect(isFreeTextOption('No')).toBe(false);
    expect(isFreeTextOption('Approve')).toBe(false);
    expect(isFreeTextOption('Cancel')).toBe(false);
  });

  it('matches when label contains the phrase', () => {
    expect(isFreeTextOption('Or type something else')).toBe(true);
  });
});

// ── Selection logic (mirrors AskBody toggle + initSelections) ─────────────────

function initSelections(pending: Pending): Set<string>[] {
  return pending.questions.map(() => new Set<string>());
}

function toggle(prev: Set<string>[], qIdx: number, label: string, multi: boolean): Set<string>[] {
  const next = prev.map((s) => new Set(s));
  const set = next[qIdx];
  if (multi) {
    if (set.has(label)) set.delete(label);
    else set.add(label);
  } else {
    next[qIdx] = new Set([label]);
  }
  return next;
}

describe('AskInline selection logic (kind=ask)', () => {
  it('initialises every question with an empty Set', () => {
    const p = makePending([makeQuestion({ options: [{ label: 'A' }] }), makeQuestion({ options: [{ label: 'X' }] })]);
    const sels = initSelections(p);
    expect(sels).toHaveLength(2);
    expect(sels[0].size).toBe(0);
    expect(sels[1].size).toBe(0);
  });

  it('single-select replaces the selection with the new label', () => {
    const p = makePending([makeQuestion({ options: [{ label: 'A' }, { label: 'B' }] })]);
    let s = initSelections(p);
    s = toggle(s, 0, 'A', false);
    expect([...s[0]]).toEqual(['A']);
    s = toggle(s, 0, 'B', false);
    expect([...s[0]]).toEqual(['B']);
  });

  it('multi-select toggles labels independently', () => {
    const p = makePending([makeQuestion({ options: [{ label: 'A' }, { label: 'B' }], multiSelect: true })]);
    let s = initSelections(p);
    s = toggle(s, 0, 'A', true);
    s = toggle(s, 0, 'B', true);
    expect(s[0].has('A')).toBe(true);
    expect(s[0].has('B')).toBe(true);
    s = toggle(s, 0, 'A', true);
    expect(s[0].has('A')).toBe(false);
  });

  it('toggling one question does not affect a sibling question', () => {
    const p = makePending([
      makeQuestion({ options: [{ label: 'A' }] }),
      makeQuestion({ options: [{ label: 'X' }] }),
    ]);
    let s = initSelections(p);
    s = toggle(s, 0, 'A', false);
    expect(s[1].size).toBe(0);
  });

  it('ready gate: all questions must have ≥1 selection', () => {
    const isReady = (sels: Set<string>[]) =>
      sels.length > 0 && sels.every((s) => s.size > 0);

    const p = makePending([
      makeQuestion({ options: [{ label: 'A' }, { label: 'B', preview: 'ascii' }] }),
      makeQuestion({ options: [{ label: 'X' }] }),
    ]);
    let s = initSelections(p);
    expect(isReady(s)).toBe(false);
    s = toggle(s, 0, 'A', false);
    expect(isReady(s)).toBe(false); // q[1] still empty
    s = toggle(s, 1, 'X', false);
    expect(isReady(s)).toBe(true);
  });
});

// ── PanePrompt single-select logic ────────────────────────────────────────────

describe('AskInline pane-prompt single-select (kind=prompt)', () => {
  it('defaults to the pre-selected option key', () => {
    const prompt = makePanePrompt({
      options: [
        { key: '1', label: 'Yes' },
        { key: '2', label: 'No', selected: true },
      ],
    });
    const pre = prompt.options.find((o) => o.selected);
    expect(pre?.key).toBe('2');
  });

  it('falls back to the first key when no option is pre-selected', () => {
    const prompt = makePanePrompt({
      options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    });
    const defaultKey = prompt.options.find((o) => o.selected)?.key ?? prompt.options[0]?.key ?? null;
    expect(defaultKey).toBe('1');
  });
});

// ── PanePrompt multi-select logic ─────────────────────────────────────────────

describe('AskInline pane-prompt multi-select (kind=prompt)', () => {
  it('initialises from `checked` flags', () => {
    const prompt = makePanePrompt({
      multiSelect: true,
      options: [
        { key: '1', label: 'Alpha', checked: true },
        { key: '2', label: 'Beta' },
        { key: '3', label: 'Gamma', checked: true },
      ],
    });
    const init = new Set(prompt.options.filter((o) => o.checked).map((o) => o.label));
    expect(init.has('Alpha')).toBe(true);
    expect(init.has('Beta')).toBe(false);
    expect(init.has('Gamma')).toBe(true);
    expect(init.size).toBe(2);
  });

  it('multi-select toggle adds and removes labels', () => {
    let sel = new Set<string>(['Alpha']);
    const toggleMulti = (label: string) => {
      const next = new Set(sel);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      sel = next;
    };
    toggleMulti('Beta');
    expect(sel.has('Beta')).toBe(true);
    toggleMulti('Alpha');
    expect(sel.has('Alpha')).toBe(false);
  });
});

// ── Plan-review mode detection ─────────────────────────────────────────────────

describe('AskInline plan-review mode (kind=prompt + planMarkdown)', () => {
  it('isPlan is true when planMarkdown is a non-empty string', () => {
    const planMarkdown = '# Plan\n- Step 1\n- Step 2';
    const isPlan = typeof planMarkdown === 'string' && planMarkdown.length > 0;
    expect(isPlan).toBe(true);
  });

  it('isPlan is false when planMarkdown is null', () => {
    const planMarkdown = null as unknown as string | null;
    const isPlan = planMarkdown != null && planMarkdown.length > 0;
    expect(isPlan).toBe(false);
  });
});

// ── Codex single-select detection (agentName) ─────────────────────────────────

type SessionKind = 'claude' | 'claudex' | 'claudemi' | 'codex' | 'terminal';

function deriveAgentName(kind: SessionKind | undefined): string {
  return kind === 'codex' ? 'Codex' : 'Claude';
}

describe('AskInline agentName derivation', () => {
  it('uses "Codex" for codex sessions', () => {
    expect(deriveAgentName('codex')).toBe('Codex');
  });

  it('uses "Claude" for claude sessions', () => {
    expect(deriveAgentName('claude')).toBe('Claude');
  });

  // CP3 Fix 1: claudex (the claude binary pointed at the olam auth-worker)
  // renders as "Claude" here — only the rail FILTER bucket is codex-flavored
  // (design decision 7); pane-level agentName/icon treatment stays claude-like.
  it('uses "Claude" for claudex sessions', () => {
    expect(deriveAgentName('claudex')).toBe('Claude');
  });

  // claudemi (the same claude binary, pointed at Kimi via the olam
  // auth-worker) mirrors claudex's pane-level treatment exactly.
  it('uses "Claude" for claudemi sessions', () => {
    expect(deriveAgentName('claudemi')).toBe('Claude');
  });

  it('uses "Claude" for terminal sessions', () => {
    expect(deriveAgentName('terminal')).toBe('Claude');
  });

  it('uses "Claude" when kind is undefined', () => {
    expect(deriveAgentName(undefined)).toBe('Claude');
  });
});

// ── Free-text option → textarea mode ─────────────────────────────────────────

describe('free-text mode detection', () => {
  it('identifies Claude "Type something" option', () => {
    expect(isFreeTextOption('Type something')).toBe(true);
  });

  it('identifies "Chat about this" option', () => {
    expect(isFreeTextOption('Chat about this')).toBe(true);
  });

  it('does NOT match non-free-text options like "Yes" or "Approve"', () => {
    expect(isFreeTextOption('Yes')).toBe(false);
    expect(isFreeTextOption('Approve')).toBe(false);
    expect(isFreeTextOption('1. Continue')).toBe(false);
  });
});

// ── activePrompt derivation (kind priority) ───────────────────────────────────

describe('activePrompt derivation', () => {
  it('prefers pending (kind=ask) over prompt (kind=prompt) when both are present', () => {
    const pending: Pending = makePending([makeQuestion({ options: [{ label: 'A' }] })]);
    const prompt: PanePrompt = makePanePrompt({ options: [{ key: '1', label: 'Yes' }] });

    // Simulates the App.tsx useMemo logic.
    const activePrompt = pending
      ? { kind: 'ask' as const, pending }
      : prompt
        ? { kind: 'prompt' as const, prompt, planMarkdown: null, agentName: 'Claude' }
        : null;

    expect(activePrompt?.kind).toBe('ask');
  });

  it('falls back to prompt (kind=prompt) when pending is null', () => {
    const pending = null;
    const prompt: PanePrompt = makePanePrompt({ options: [{ key: '1', label: 'Yes' }] });

    const activePrompt = pending
      ? { kind: 'ask' as const, pending }
      : prompt
        ? { kind: 'prompt' as const, prompt, planMarkdown: null, agentName: 'Claude' }
        : null;

    expect(activePrompt?.kind).toBe('prompt');
  });

  it('returns null when both pending and prompt are null', () => {
    const activePrompt = null;
    expect(activePrompt).toBeNull();
  });
});

// ── Dismiss control + errored note (DOM) ───────────────────────────────────
//
// Root cause under test: a stale AskUserQuestion dialog (the session hit a
// usage-limit/API error and stalled) had no way to be dismissed — Dismiss
// must fire onDismiss and NEVER onAnswer/onReply (dismissal sends nothing),
// and the errored note must only render when `errored` is true.

function renderAsk(overrides: {
  errored?: boolean;
  onAnswer?: (toolUseId: string, selections: unknown[]) => void;
  onReply?: (text: string) => void;
  onDismiss?: () => void;
} = {}) {
  const pending: Pending = {
    toolUseId: 'tu-errored-1',
    questions: [{ question: 'Proceed with the migration?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  };
  const onAnswer = overrides.onAnswer ?? vi.fn();
  const onReply = overrides.onReply ?? vi.fn();
  const onDismiss = overrides.onDismiss ?? vi.fn();
  const bodyRef = { current: null };
  render(
    createElement(AskInline, {
      activePrompt: { kind: 'ask', pending },
      bodyRef,
      onAnswer,
      onKey: () => {},
      onSelect: () => {},
      onReply,
      onDismiss,
      errored: overrides.errored ?? false,
    }),
  );
  return { onAnswer, onReply, onDismiss };
}

describe('AskInline Dismiss control', () => {
  it('clicking Dismiss fires onDismiss and does NOT fire onAnswer or onReply', () => {
    const { onAnswer, onReply, onDismiss } = renderAsk();
    fireEvent.click(screen.getByRole('button', { name: /dismiss question/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();
  });

  it('the Dismiss control is present even when the session is not errored', () => {
    renderAsk({ errored: false });
    expect(screen.getByRole('button', { name: /dismiss question/i })).toBeTruthy();
    expect(screen.queryByText(/hit a usage limit/i)).toBeNull();
  });

  it('shows the errored note (and a second Dismiss action) when errored is true', () => {
    const { onDismiss } = renderAsk({ errored: true });
    expect(screen.getByText(/hit a usage limit/i)).toBeTruthy();
    expect(screen.getByText(/can.t be delivered/i)).toBeTruthy();
    // The prominent errored-note Dismiss button also just dismisses — never answers.
    fireEvent.click(screen.getByRole('button', { name: /^dismiss$/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not block the normal answer flow — selecting an option still calls onAnswer', () => {
    const { onAnswer } = renderAsk();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onAnswer).toHaveBeenCalledWith('tu-errored-1', [['Yes']]);
  });
});
