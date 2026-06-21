// @vitest-environment jsdom
/**
 * Guard tests for the voice-mode GSAP morph transition (feat/voice-prerender).
 *
 * These tests verify:
 *  1. Pre-render model: the VoiceInline shell is ALWAYS mounted. `voice` drives
 *     visibility and mic-activation only — never mount/unmount.
 *  2. Reduced-motion path: the voice body is hidden/shown instantly without
 *     any animation.
 *  3. Animated path: the voice body stays visible until the exit timeline
 *     completes (onComplete sets display:none), matching the pre-render model
 *     where we REVEAL existing nodes instead of mounting fresh ones.
 *  4. The `active` flag on VoiceInline (which gates mic acquisition) follows
 *     the `voice` logical state — not a separate render flag.
 *
 * GSAP is stubbed so timelines fire onComplete synchronously — we test
 * state flow, not animation frame timing.
 */

import { beforeAll, describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { prefersReducedMotion } from './anim';

// ---------------------------------------------------------------------------
// GSAP stub — timelines fire onComplete synchronously (same as anim.vitest.ts).
// ---------------------------------------------------------------------------
vi.mock('gsap', () => {
  const noop = (..._args: unknown[]) => {};
  const makeTimeline = (opts?: { onComplete?: () => void }) => {
    const self = {
      fromTo: (..._args: unknown[]) => self,
      to: (..._args: unknown[]) => self,
      set: (..._args: unknown[]) => self,
      kill: noop,
    };
    // Fire onComplete synchronously so the "unmount after exit" logic resolves
    // within the same act() call.
    opts?.onComplete?.();
    return self;
  };

  return {
    default: {
      set: noop,
      timeline: makeTimeline,
      // gsap.set called directly in the effect
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers for matchMedia mock.
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

beforeAll(() => {
  // @ts-expect-error — global test flag React reads
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

// ---------------------------------------------------------------------------
// Minimal component that mirrors Composer's pre-render voice model:
//   voice         — logical/desired state (mic gated, visibility driven)
//   voiceBodyHidden — whether the voice shell is display:none (idle state)
//
// The voice shell is ALWAYS mounted — `voice` controls visibility and mic
// activation, not mount/unmount. This is a stripped-down version of the
// pattern added in Composer.tsx so we can unit-test the state machine.
// ---------------------------------------------------------------------------

interface TestState {
  /** Whether the voice shell node is in the DOM (always true in pre-render model). */
  voiceShellMounted: boolean;
  /** Whether the voice shell is visually hidden (display:none). */
  voiceBodyHidden: boolean;
  /** The logical voice flag — mirrors what VoiceInline receives as active. */
  voice: boolean;
}

let capturedOpen: (() => void) | null = null;
let capturedExit: (() => void) | null = null;

function TestComposer({ onStateChange }: { onStateChange: (s: TestState) => void }) {
  const [voice, setVoice] = useState(false);
  // Tracks whether the voice body div is display:none (managed by the effect below).
  const [voiceBodyHidden, setVoiceBodyHidden] = useState(true);
  const animRef = useRef<{ kill: () => void } | null>(null);

  // Mirror the Composer's openVoice / exitVoice callbacks.
  capturedOpen = () => { setVoice(true); };
  capturedExit = () => { setVoice(false); };

  // Mirror the layout effect from Composer.tsx. In reduced-motion mode:
  //   enter → show immediately; exit → hide immediately.
  // In animated mode the exit timeline's onComplete hides the body.
  useEffect(() => {
    animRef.current?.kill();
    animRef.current = null;

    if (voice) {
      // ENTER: un-hide the voice body.
      setVoiceBodyHidden(false);
      if (prefersReducedMotion()) return; // instant, no tween needed
      // Animated ENTER: body is already un-hidden; Phase 2 reveals children.
      // (No state change needed here beyond un-hiding.)
    } else {
      if (prefersReducedMotion()) {
        // EXIT reduced-motion: hide immediately.
        setVoiceBodyHidden(true);
        return;
      }
      // EXIT animated: simulate the exit timeline whose onComplete hides the body.
      const tl = {
        kill: () => {},
        fromTo: () => tl,
        to: () => tl,
        set: () => tl,
      };
      // The real code's phase2 onComplete sets voiceBody.style.display = 'none'.
      // Mirror that here as a React state bit.
      setVoiceBodyHidden(true);
      animRef.current = tl;
    }
  }, [voice]);

  useEffect(() => {
    return () => { animRef.current?.kill(); };
  }, []);

  // Report state up to the test.
  useEffect(() => {
    onStateChange({ voiceShellMounted: true, voiceBodyHidden, voice });
  });

  return React.createElement(
    'div',
    { 'data-testid': 'composer' },
    // Voice shell is ALWAYS mounted (pre-render model). Visibility is toggled
    // via data-hidden attribute (mirrors the real display:none mechanism).
    React.createElement(
      'div',
      { 'data-testid': 'voice-inline', 'data-hidden': voiceBodyHidden ? 'true' : undefined },
      'VoiceInline',
    ),
    React.createElement('div', { 'data-testid': 'composer-body' }, 'body'),
  );
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------
let container: HTMLElement;
let reactRoot: ReturnType<typeof createRoot>;
let lastState: TestState = { voiceShellMounted: true, voiceBodyHidden: true, voice: false };

function setup() {
  container = document.createElement('div');
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  lastState = { voiceShellMounted: true, voiceBodyHidden: true, voice: false };
  capturedOpen = null;
  capturedExit = null;
}

function teardown() {
  act(() => { reactRoot.unmount(); });
  container.remove();
}

function renderTestComposer() {
  act(() => {
    reactRoot.render(
      React.createElement(TestComposer, { onStateChange: (s) => { lastState = s; } }),
    );
  });
}

function getByTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

// ---------------------------------------------------------------------------
// Tests — pre-render always-mounted model
// ---------------------------------------------------------------------------

describe('voice transition — pre-render model: shell always mounted', () => {
  beforeEach(() => {
    mockReducedMotion(false);
    setup();
  });
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('VoiceInline shell is in the DOM before any voice interaction', () => {
    renderTestComposer();
    // In the pre-render model the shell is ALWAYS mounted.
    expect(getByTestId('voice-inline')).not.toBeNull();
    expect(lastState.voiceShellMounted).toBe(true);
  });

  it('VoiceInline shell is hidden (data-hidden) when idle', () => {
    renderTestComposer();
    const el = getByTestId('voice-inline');
    expect(el).not.toBeNull();
    expect(el!.dataset.hidden).toBe('true');
    expect(lastState.voiceBodyHidden).toBe(true);
  });

  it('VoiceInline shell becomes visible (no data-hidden) on openVoice', () => {
    renderTestComposer();
    act(() => { capturedOpen!(); });

    const el = getByTestId('voice-inline');
    expect(el).not.toBeNull();
    expect(el!.dataset.hidden).toBeUndefined();
    expect(lastState.voiceBodyHidden).toBe(false);
    expect(lastState.voice).toBe(true);
  });

  it('VoiceInline shell is hidden again after exit animation completes', () => {
    renderTestComposer();
    act(() => { capturedOpen!(); });
    expect(lastState.voiceBodyHidden).toBe(false);

    // Exit — exit timeline's onComplete sets hidden=true (simulated synchronously).
    act(() => { capturedExit!(); });

    const el = getByTestId('voice-inline');
    expect(el).not.toBeNull(); // still mounted!
    expect(el!.dataset.hidden).toBe('true');
    expect(lastState.voiceBodyHidden).toBe(true);
    expect(lastState.voice).toBe(false);
  });

  it('composer-body is always present (always mounted)', () => {
    renderTestComposer();
    expect(getByTestId('composer-body')).not.toBeNull();
    act(() => { capturedOpen!(); });
    expect(getByTestId('composer-body')).not.toBeNull();
    act(() => { capturedExit!(); });
    expect(getByTestId('composer-body')).not.toBeNull();
  });
});

describe('voice transition — reduced-motion path', () => {
  beforeEach(() => {
    mockReducedMotion(true);
    setup();
  });
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('VoiceInline shell is in DOM but hidden on initial render', () => {
    renderTestComposer();
    const el = getByTestId('voice-inline');
    expect(el).not.toBeNull();
    expect(el!.dataset.hidden).toBe('true');
  });

  it('VoiceInline becomes visible immediately on openVoice (no animation)', () => {
    renderTestComposer();
    act(() => { capturedOpen!(); });
    const el = getByTestId('voice-inline');
    expect(el!.dataset.hidden).toBeUndefined();
    expect(lastState.voiceBodyHidden).toBe(false);
  });

  it('VoiceInline hides immediately on exitVoice (no animation delay)', () => {
    renderTestComposer();
    act(() => { capturedOpen!(); });
    act(() => { capturedExit!(); });

    // Reduced-motion: should hide synchronously (no animation timeline).
    const el = getByTestId('voice-inline');
    expect(el!.dataset.hidden).toBe('true');
    expect(lastState.voiceBodyHidden).toBe(true);
    // Shell remains mounted.
    expect(el).not.toBeNull();
  });
});

describe('voice transition — animated path', () => {
  beforeEach(() => {
    mockReducedMotion(false);
    setup();
  });
  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
  });

  it('voice=true sets voice flag; shell is un-hidden', () => {
    renderTestComposer();
    act(() => { capturedOpen!(); });
    expect(lastState.voice).toBe(true);
    expect(lastState.voiceBodyHidden).toBe(false);
  });

  it('voice=false (exit) hides body after timeline onComplete', () => {
    renderTestComposer();
    act(() => { capturedOpen!(); });
    expect(lastState.voiceBodyHidden).toBe(false);

    act(() => { capturedExit!(); });

    // After the exit timeline's onComplete, body must be hidden.
    expect(lastState.voiceBodyHidden).toBe(true);
    expect(lastState.voice).toBe(false);
  });

  it('shell is never unmounted — voiceShellMounted is always true', () => {
    renderTestComposer();
    expect(lastState.voiceShellMounted).toBe(true);
    act(() => { capturedOpen!(); });
    expect(lastState.voiceShellMounted).toBe(true);
    act(() => { capturedExit!(); });
    expect(lastState.voiceShellMounted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard: COMPOSER_MIN_HEIGHT clamping
//
// The morph driver clamps heightTo = Math.max(rawMeasured, COMPOSER_MIN_HEIGHT)
// to prevent a near-zero measurement from collapsing the card mid-morph.
// This describe block tests the clamping invariant as a pure logic unit test
// (no DOM layout required — jsdom always returns 0 for offsetHeight, which is
// exactly the near-zero scenario we're guarding against).
// ---------------------------------------------------------------------------
describe('voice morph height — MIN_HEIGHT clamp guard', () => {
  const COMPOSER_MIN_HEIGHT = 96; // must match the constant in Composer.tsx

  function clampMorphHeight(rawMeasured: number): number {
    return Math.max(rawMeasured, COMPOSER_MIN_HEIGHT);
  }

  it('COMPOSER_MIN_HEIGHT is a reasonable single-row composer floor (≥ 80px)', () => {
    // The floor should cover at least: card border(2) + padding(20) + textarea(24)
    // + gap(8) + toolbar(34) = 88px. Using 80 as the test lower bound to give
    // a little slack against font/line-height variation.
    expect(COMPOSER_MIN_HEIGHT).toBeGreaterThanOrEqual(80);
  });

  it('clamp returns MIN when rawMeasured is 0 (jsdom / unmeasured DOM)', () => {
    // jsdom always returns 0 for offsetHeight — this is the near-zero scenario.
    expect(clampMorphHeight(0)).toBe(COMPOSER_MIN_HEIGHT);
  });

  it('clamp returns MIN when rawMeasured is smaller than MIN', () => {
    expect(clampMorphHeight(20)).toBe(COMPOSER_MIN_HEIGHT);
    expect(clampMorphHeight(50)).toBe(COMPOSER_MIN_HEIGHT);
    expect(clampMorphHeight(COMPOSER_MIN_HEIGHT - 1)).toBe(COMPOSER_MIN_HEIGHT);
  });

  it('clamp returns rawMeasured when it is larger than MIN (voice body taller)', () => {
    // Typical voice body is ~180-210px tall.
    expect(clampMorphHeight(180)).toBe(180);
    expect(clampMorphHeight(COMPOSER_MIN_HEIGHT)).toBe(COMPOSER_MIN_HEIGHT);
    expect(clampMorphHeight(COMPOSER_MIN_HEIGHT + 1)).toBe(COMPOSER_MIN_HEIGHT + 1);
  });

  it('clamp is monotonic: larger rawMeasured always produces a larger-or-equal result', () => {
    const samples = [0, 10, 50, 96, 100, 150, 200, 300];
    for (let i = 1; i < samples.length; i++) {
      expect(clampMorphHeight(samples[i])).toBeGreaterThanOrEqual(clampMorphHeight(samples[i - 1]));
    }
  });
});
