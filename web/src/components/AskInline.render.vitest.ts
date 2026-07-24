// @vitest-environment jsdom
/**
 * DOM integration tests for the AskInline shell + @idl3/agent-ui-kit renderer.
 * The logic suite (AskInline.vitest.ts) never mounts the tree, so it can't see
 * composition regressions — these assert the composed DOM shape (kit root under
 * the cockpit shell, class names the CSS + Composer morph driver rely on) and
 * that the host adapter wires toolUseId/sentinel routing correctly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, createRef } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AskInline, type ActivePrompt } from './AskInline';
import { FLAG_PENDING_TOOL_USE_ID } from '../lib/answerSettle';

afterEach(cleanup);

function mount(activePrompt: ActivePrompt, handlers: Partial<{
  onAnswer: (toolUseId: string, selections: unknown) => void;
  onReply: (text: string) => void;
}> = {}) {
  const bodyRef = createRef<HTMLDivElement>();
  return render(
    createElement(AskInline, {
      activePrompt,
      bodyRef,
      onAnswer: handlers.onAnswer ?? (() => {}),
      onKey: () => {},
      onSelect: () => {},
      onReply: handlers.onReply ?? (() => {}),
    }),
  );
}

const askPrompt = (toolUseId: string): ActivePrompt => ({
  kind: 'ask',
  pending: {
    toolUseId,
    questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
  },
});

describe('AskInline + kit composition (kind=ask)', () => {
  it('mounts the kit renderer inside the cockpit shell with the expected classes', () => {
    const { container } = mount(askPrompt('tu-1'));
    // Shell chrome the Composer morph driver + CSS rely on:
    expect(container.querySelector('.ask-inline-body')).toBeTruthy();
    expect(container.querySelector('.ask-inline-full.agent-ui-kit')).toBeTruthy();
    expect(container.querySelector('.ask-min-btn')).toBeTruthy();
    // Kit-rendered structure:
    expect(container.querySelector('.agent-ui-kit .question')).toBeTruthy();
    expect(container.querySelectorAll('.option-btn').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('.ask-inline-foot .btn-primary')).toBeTruthy();
  });

  it('routes a structured answer through onAnswer with the pending toolUseId', () => {
    const onAnswer = vi.fn();
    mount(askPrompt('tu-42'), { onAnswer });
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByRole('button', { name: 'Send Answer' }));
    expect(onAnswer).toHaveBeenCalledWith('tu-42', [['A']]);
  });

  it('sentinel pending routes free-text through onReply, not onAnswer', () => {
    const onAnswer = vi.fn();
    const onReply = vi.fn();
    mount(askPrompt(FLAG_PENDING_TOOL_USE_ID), { onAnswer, onReply });
    fireEvent.click(screen.getByText('Type something'));
    fireEvent.change(screen.getByPlaceholderText('Type your reply…'), {
      target: { value: 'hello there' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onReply).toHaveBeenCalledWith('hello there');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('real pending routes free-text as a structured directive via onAnswer', () => {
    const onAnswer = vi.fn();
    const onReply = vi.fn();
    mount(askPrompt('tu-real'), { onAnswer, onReply });
    fireEvent.click(screen.getByText('Type something'));
    fireEvent.change(screen.getByPlaceholderText('Type your reply…'), {
      target: { value: 'custom' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onAnswer).toHaveBeenCalledWith('tu-real', [{ kind: 'text', text: 'custom' }]);
    expect(onReply).not.toHaveBeenCalled();
  });

  it('minimize collapses to the amber bar and maximise restores the question', () => {
    const { container } = mount(askPrompt('tu-min'));
    fireEvent.click(screen.getByLabelText('Minimise question'));
    expect(container.querySelector('.ask-min-bar')).toBeTruthy();
    expect(container.querySelector('.agent-ui-kit .question')).toBeNull();
    fireEvent.click(screen.getByLabelText('Maximise question'));
    expect(container.querySelector('.agent-ui-kit .question')).toBeTruthy();
  });
});
