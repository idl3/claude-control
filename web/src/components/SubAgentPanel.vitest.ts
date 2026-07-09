// @vitest-environment jsdom
/**
 * Regression test for the "transcript image click doesn't open the Lightbox"
 * bug when the image lives inside a sub-agent's nested thread (SubAgentPanel
 * drawer).
 *
 * Root cause: `.sa-panel` is `position: fixed` and is animated in via
 * `gsap.fromTo(panelRef.current, { x: 28, ... }, { x: 0, ... })`. GSAP writes
 * the `x` tween as an inline CSS `transform` and never auto-clears it back to
 * `none` once the tween settles at `x: 0`. Per the CSS Transforms spec, any
 * element with a non-`none` `transform` becomes the *containing block* for
 * all of its `position: fixed` (and `position: absolute`) descendants. Since
 * the image Lightbox (`AttachmentPreview.tsx`) is rendered as a DOM
 * descendant of `.sa-panel` (via SubAgentThread -> Messages -> EmbeddedMedia
 * -> Lightbox), a lingering transform on `.sa-panel` makes the Lightbox
 * resolve its `position:fixed; inset:0` against the drawer's box instead of
 * the viewport — squishing/misplacing it into the drawer strip rather than
 * covering the screen. Live-confirmed via Playwright against localhost:4317:
 * before the fix, `.sa-panel` computed `transform: matrix(1, 0, 0, 1, 0, 0)`
 * after the open animation settled, and an element planted as its child with
 * `.lightbox-backdrop`'s real CSS resolved to rect {x:641,y:0,w:639,h:1800}
 * (the drawer's box) instead of the full {x:0,y:0,w:1280,h:1800} viewport.
 *
 * jsdom has no layout engine (getBoundingClientRect is always zeroed), so
 * this test asserts the precise DOM-level invariant that causes the bug: the
 * `.sa-panel` element must not retain an inline `transform` once its entrance
 * animation completes. The GSAP mock below replicates the real library's
 * "leaves the inline transform behind" behavior, so this test FAILS against
 * the pre-fix component and PASSES once the `onComplete: () => gsap.set(...,
 * { clearProps: 'transform' })` clears it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import type { SubAgent } from '../lib/types';

// ---------------------------------------------------------------------------
// Mock gsap: replicate the real-world quirk this bug hinges on — `fromTo`
// writes an inline `transform` for the `x` tween and does NOT clear it on
// completion; only an explicit `gsap.set(el, { clearProps: 'transform' })`
// removes it (implemented for real here, matching GSAP's own clearProps
// semantics: delete the named inline style properties).
// ---------------------------------------------------------------------------
vi.mock('../lib/anim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/anim')>();
  const noop = () => {};
  const mockGsap = {
    fromTo: (target: HTMLElement | null, _from: unknown, to: { x?: number; onComplete?: () => void }) => {
      if (target && typeof to.x === 'number') {
        target.style.transform = `translate(${to.x}px, 0px)`;
      }
      to.onComplete?.();
      return { kill: noop };
    },
    set: (target: HTMLElement | null, vars: { clearProps?: string }) => {
      if (!target || !vars.clearProps) return;
      for (const prop of vars.clearProps.split(',')) {
        target.style.removeProperty(prop.trim());
      }
    },
    timeline: () => ({ fromTo: () => ({}), to: () => ({}), kill: noop }),
  };
  return { ...actual, default: mockGsap };
});

import { SubAgentPanel } from './SubAgentPanel';

afterEach(cleanup);

// jsdom has no ResizeObserver; assistant-ui's ThreadPrimitive.Viewport (used
// by SubAgentThread in the detail view) needs one internally. A no-op stub is
// enough for these DOM-shape assertions (see SkillInvocation.vitest.ts).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

beforeEach(() => {
  // Force the animated path (not the prefers-reduced-motion early-return),
  // since the bug only manifests when the GSAP tween actually runs.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

const noSubAgents: SubAgent[] = [];

describe('SubAgentPanel — drawer open animation (containing-block regression)', () => {
  it('clears the inline transform on .sa-panel once the entrance tween settles', () => {
    const { container } = render(
      createElement(SubAgentPanel, { subagents: noSubAgents, open: true, onClose: () => {} }),
    );
    const panel = container.querySelector<HTMLElement>('.sa-panel');
    expect(panel).not.toBeNull();

    // The mocked tween fires onComplete synchronously, so by the time render()
    // returns the effect (and its onComplete) has already run.
    expect(panel!.style.transform).toBe('');
    expect(getComputedStyle(panel!).transform).toBe('none');
  });

  it('re-clears the transform when switching from the list to a detail view', () => {
    const agent: SubAgent = {
      agentId: 'a1',
      toolUseId: null,
      agentType: 'coder',
      description: null,
      status: 'done',
      messages: [],
    };
    const { container, rerender } = render(
      createElement(SubAgentPanel, { subagents: [agent], open: true, onClose: () => {} }),
    );
    // Jump straight into the detail view via focusAgentId, exercising the
    // same panelRef + effect a second time (dependency array includes
    // `!!selected`).
    rerender(
      createElement(SubAgentPanel, {
        subagents: [agent],
        open: true,
        onClose: () => {},
        focusAgentId: 'a1',
      }),
    );
    const panel = container.querySelector<HTMLElement>('.sa-panel');
    expect(panel).not.toBeNull();
    expect(panel!.style.transform).toBe('');
  });
});
