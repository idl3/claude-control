// @vitest-environment jsdom
import { createElement } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { Composer, type ComposerServices } from './Composer';

// jsdom has no ResizeObserver; assistant-ui internals may probe for one (see
// the established precedent in Thread.vitest.ts).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const identityConvertMessage = (msg: ThreadMessageLike): ThreadMessageLike => msg;

// Stub network-backed services so mounting Composer never hits real fetch
// (loadSkills/loadAgents fire on every mount regardless of sessionId).
const STUB_SERVICES: Partial<ComposerServices> = {
  loadSkills: async () => [],
  loadAgents: async () => [],
  optimizePrompt: async (text: string) => ({ optimized: text, rationale: [], changes: [], mode: 'rules' as const }),
};

interface HarnessProps {
  disabled: boolean;
  onNew?: (message: ThreadMessageLike) => Promise<void>;
  services?: Partial<ComposerServices>;
}

function Harness({ disabled, onNew, services }: HarnessProps) {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    isDisabled: false,
    convertMessage: identityConvertMessage,
    onNew: onNew ?? (async () => {}),
  });
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(Composer, {
      disabled,
      sessionId: 'session-1',
      onToast: () => {},
      services: services ?? STUB_SERVICES,
    }),
  );
}

/** Minimal DataTransfer stand-in: real jsdom DragEvents don't populate
 *  dataTransfer from EventInit reliably, so tests build one directly (mirrors
 *  the established pattern in SessionRail.moveWindow.vitest.ts). `types`
 *  including 'Files' is what Composer's dragHasFiles() gates on. */
function makeFileDataTransfer(files: File[] = [new File(['x'], 'note.txt', { type: 'text/plain' })]) {
  return {
    types: ['Files'],
    files,
    dropEffect: '',
    effectAllowed: '',
  };
}

function composerCard(): HTMLElement {
  return document.querySelector('.composer-card') as HTMLElement;
}

afterEach(cleanup);

describe('Composer drag-and-drop — never navigates away on a stray drop', () => {
  it('onDragOver prevents the browser default even while disabled (dragEnabled=false)', () => {
    render(createElement(Harness, { disabled: true }));
    const card = composerCard();
    expect(card).toBeTruthy();

    // fireEvent returns false when any handler called preventDefault() on a
    // cancelable event — the direct signal that navigation was suppressed.
    const notCancelled = fireEvent.dragOver(card, { dataTransfer: makeFileDataTransfer() });
    expect(notCancelled).toBe(false);
  });

  it('onDrop prevents the browser default even while disabled (dragEnabled=false)', () => {
    render(createElement(Harness, { disabled: true }));
    const card = composerCard();

    const notCancelled = fireEvent.drop(card, { dataTransfer: makeFileDataTransfer() });
    expect(notCancelled).toBe(false);
    // Gated attach logic never engaged: no drop overlay left behind.
    expect(document.querySelector('.composer-drop-overlay')).toBeNull();
  });

  it('onDragOver and onDrop still prevent default in the normal enabled path', () => {
    render(createElement(Harness, { disabled: false }));
    const card = composerCard();

    expect(fireEvent.dragOver(card, { dataTransfer: makeFileDataTransfer() })).toBe(false);
    expect(fireEvent.drop(card, { dataTransfer: makeFileDataTransfer() })).toBe(false);
  });
});

describe('Composer drag overlay — never gets stuck when drag mode flips off mid-drag', () => {
  it('clears the drop overlay + depth counter once dragEnabled flips false', () => {
    const { rerender } = render(createElement(Harness, { disabled: false }));
    const card = composerCard();

    fireEvent.dragEnter(card, { dataTransfer: makeFileDataTransfer() });
    expect(document.querySelector('.composer-drop-overlay')).toBeTruthy();

    // Flip dragEnabled false mid-drag (e.g. the composer becomes disabled) —
    // the overlay must clear itself rather than persisting forever.
    rerender(createElement(Harness, { disabled: true }));
    expect(document.querySelector('.composer-drop-overlay')).toBeNull();
  });
});

// Keybindings were inverted: ⌘/Ctrl+Enter is now the default raw send, and
// ⌘/Ctrl+Shift+Enter now runs the prompt optimiser (previously the reverse).
// These prove the chord → action wiring directly, independent of button
// styling, so a future accidental re-swap of the keydown branches fails loud.
describe('Composer keybindings — ⌘/Ctrl+Enter sends raw, ⌘/Ctrl+Shift+Enter optimises', () => {
  function textarea(): HTMLTextAreaElement {
    return document.querySelector('.composer-input') as HTMLTextAreaElement;
  }

  it('⌘+Enter (no shift) sends the raw composer text — bypasses the optimiser', async () => {
    const onNew = vi.fn(async () => {});
    const optimizePrompt = vi.fn(async (text: string) => ({
      optimized: text,
      rationale: [],
      changes: [],
      mode: 'rules' as const,
    }));
    render(createElement(Harness, { disabled: false, onNew, services: { ...STUB_SERVICES, optimizePrompt } }));

    fireEvent.change(textarea(), { target: { value: 'ship the fix' } });
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true });

    // composer.send() → append() is async (it awaits an internal tool-call
    // abort check before invoking onNew), so the call lands a microtask
    // after the synchronous keydown dispatch — wait for it rather than
    // asserting immediately.
    await vi.waitFor(() => {
      expect(onNew).toHaveBeenCalledTimes(1);
    });
    expect(optimizePrompt).not.toHaveBeenCalled();
  });

  it('⌘+Shift+Enter runs the prompt optimiser — does NOT send', async () => {
    const onNew = vi.fn(async () => {});
    const optimizePrompt = vi.fn(async (text: string) => ({
      optimized: text,
      rationale: [],
      changes: [],
      mode: 'rules' as const,
    }));
    render(createElement(Harness, { disabled: false, onNew, services: { ...STUB_SERVICES, optimizePrompt } }));

    fireEvent.change(textarea(), { target: { value: 'ship the fix' } });
    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true, shiftKey: true });

    // EXACTLY once: the ⌘/Ctrl+⇧+↵ chord was previously wired in TWO listeners
    // (a window-level capture-phase one + the textarea's own onKeyDown), both
    // firing runEnhance() for one keypress → optimizePrompt() called twice.
    // Fixed: the window handler now early-returns when the event target is the
    // composer input (`.composer-input`), since the input's own onKeyDown
    // already covers the focused case. This asserts the double-invoke is gone.
    await vi.waitFor(() => {
      expect(optimizePrompt).toHaveBeenCalled();
    });
    expect(optimizePrompt).toHaveBeenCalledTimes(1);
    expect(optimizePrompt).toHaveBeenCalledWith('ship the fix');
    expect(onNew).not.toHaveBeenCalled();
  });

  it('the raw Send button is the FAR-RIGHT (trailing) button; Optimize sits to its left', () => {
    render(createElement(Harness, { disabled: false }));
    const send = document.querySelector('button.composer-send[aria-label="Send"]');
    const optimize = document.querySelector('button.composer-enhance[aria-label="Optimize prompt"]');
    expect(send).toBeTruthy();
    expect(optimize).toBeTruthy();
    // DOM order == visual left-to-right order: Optimize precedes Send.
    expect(optimize!.compareDocumentPosition(send!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
