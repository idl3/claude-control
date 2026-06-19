// @vitest-environment jsdom
/**
 * Tests for useModalTransition focus management (PLE-46).
 *
 * Strategy: mount the hook in a minimal React tree using react-dom/client +
 * act (no @testing-library/react needed). GSAP is stubbed so timelines never
 * actually run — we only care about focus behaviour, not animation timing.
 * The reduced-motion path is exercised by mocking matchMedia to return `true`
 * for the `prefers-reduced-motion: reduce` query, making the tests fully
 * deterministic and fast.
 *
 * Each of the three main assertions is designed to FAIL against the original
 * hook (which did zero focus management).
 */

import { beforeAll, describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useModalTransition } from './anim';

// Configure React to know we're in an act()-aware test environment.
beforeAll(() => {
  // @ts-expect-error — global test flag React reads
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

// ---------------------------------------------------------------------------
// Stub GSAP — we care about focus, not animation timing.
// The timeline stub fires onComplete synchronously so the animated close path
// behaves the same as the reduced-motion path in tests.
// ---------------------------------------------------------------------------
vi.mock('gsap', () => {
  const noop = () => {};
  const makeTimeline = (opts?: { onComplete?: () => void }) => {
    const self = {
      fromTo: () => self,
      to: () => self,
      kill: noop,
    };
    // Fire onComplete immediately (synchronous stub).
    opts?.onComplete?.();
    return self;
  };

  return {
    default: {
      set: noop,
      timeline: makeTimeline,
    },
  };
});

// ---------------------------------------------------------------------------
// Mock matchMedia to simulate prefers-reduced-motion: reduce.
// ---------------------------------------------------------------------------
function mockReducedMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ---------------------------------------------------------------------------
// Minimal React component that uses the hook.
// Structure: <div ref={rootRef}> <div data-testid="panel"> [children] </div> </div>
// The close button lives inside the panel but is hidden so it is excluded from
// the focusable list (display:none is detected by the hook's getFocusable).
// ---------------------------------------------------------------------------
interface ModalProps {
  onClose: () => void;
  children?: React.ReactNode;
}

// Expose requestClose imperatively via a module-level ref so tests can trigger
// it without wiring event handlers.
let capturedRequestClose: (() => void) | null = null;

function TestModal({ onClose, children }: ModalProps) {
  const { rootRef, requestClose } = useModalTransition(onClose);
  capturedRequestClose = requestClose;
  return React.createElement(
    'div',
    { ref: rootRef, 'data-testid': 'backdrop' },
    React.createElement('div', { 'data-testid': 'panel' }, children),
  );
}

// ---------------------------------------------------------------------------
// Test lifecycle helpers
// ---------------------------------------------------------------------------

let container: HTMLElement;
let reactRoot: ReturnType<typeof createRoot>;

function setup() {
  container = document.createElement('div');
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  capturedRequestClose = null;
}

function teardown() {
  act(() => {
    reactRoot.unmount();
  });
  container.remove();
}

/**
 * Render the modal with `focusableCount` visible buttons inside the panel.
 * All buttons are plain `<button>` elements — visible by default (no
 * display:none), so getFocusable will include them.
 */
function renderModal(onClose: () => void, focusableCount = 3) {
  const buttons = Array.from({ length: focusableCount }, (_, i) =>
    React.createElement('button', { key: i, 'data-idx': String(i) }, `Btn ${i}`),
  );
  act(() => {
    reactRoot.render(React.createElement(TestModal, { onClose }, ...buttons));
  });
}

/** Dispatch a Tab keydown on the document, return the event. */
function pressTab(shift = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useModalTransition — focus management (PLE-46)', () => {
  beforeEach(() => {
    // Use reduced-motion throughout: synchronous paths, no GSAP timers needed.
    mockReducedMotion(true);
    setup();
  });

  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Initial focus: moves inside the panel on mount.
  //    FAILS on original hook (which never called .focus()).
  // -------------------------------------------------------------------------
  it('moves focus into the panel on mount, away from the external trigger', () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'trigger');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    renderModal(() => {});

    const panel = container.querySelector<HTMLElement>('[data-testid="panel"]');
    expect(panel).not.toBeNull();

    // After mount, active element must be inside the panel — not the trigger.
    expect(panel!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);

    trigger.remove();
  });

  // -------------------------------------------------------------------------
  // 2a. Focus trap: Tab at the last focusable wraps to the first.
  //     FAILS on original hook (Tab dispatched to document is unhandled).
  // -------------------------------------------------------------------------
  it('wraps Tab from the last focusable back to the first', () => {
    renderModal(() => {});

    const panel = container.querySelector<HTMLElement>('[data-testid="panel"]')!;
    const btns = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-idx]'));
    expect(btns).toHaveLength(3);

    // Put focus on the last button.
    btns[btns.length - 1].focus();
    expect(document.activeElement).toBe(btns[btns.length - 1]);

    // Tab — should wrap to first.
    pressTab(false);

    // Focus must have moved to the first button.
    expect(document.activeElement).toBe(btns[0]);
  });

  // -------------------------------------------------------------------------
  // 2b. Focus trap: Shift+Tab at the first focusable wraps to the last.
  //     FAILS on original hook (Shift+Tab unhandled).
  // -------------------------------------------------------------------------
  it('wraps Shift+Tab from the first focusable back to the last', () => {
    renderModal(() => {});

    const panel = container.querySelector<HTMLElement>('[data-testid="panel"]')!;
    const btns = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-idx]'));
    expect(btns).toHaveLength(3);

    // Put focus on the first button.
    btns[0].focus();
    expect(document.activeElement).toBe(btns[0]);

    // Shift+Tab — should wrap to last.
    pressTab(true);

    expect(document.activeElement).toBe(btns[btns.length - 1]);
  });

  // -------------------------------------------------------------------------
  // 3. Restore: after requestClose + unmount, focus returns to the trigger.
  //    FAILS on original hook (no restore logic).
  // -------------------------------------------------------------------------
  it('restores focus to the pre-open element after requestClose', () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'trigger');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    let onCloseFired = false;
    const onClose = () => {
      onCloseFired = true;
      // Simulate the parent unmounting the modal on close.
      act(() => {
        reactRoot.unmount();
        // Recreate root so afterEach teardown() doesn't double-unmount.
        reactRoot = createRoot(container);
      });
    };

    renderModal(onClose);

    // Verify focus moved into the modal.
    const panel = container.querySelector<HTMLElement>('[data-testid="panel"]');
    expect(panel!.contains(document.activeElement)).toBe(true);

    // Trigger close (synchronous via reduced-motion path).
    act(() => {
      capturedRequestClose!();
    });

    expect(onCloseFired).toBe(true);
    // After close + unmount, focus should be back on the trigger.
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });
});
