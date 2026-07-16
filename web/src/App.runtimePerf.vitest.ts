// @vitest-environment jsdom
/**
 * Runtime re-render / re-conversion perf guard for App.tsx's useExternalStoreRuntime
 * usage.
 *
 * App feeds the runtime an already-memoized `convertedMessages` list plus an
 * IDENTITY `convertMessage`. assistant-ui's ExternalStoreThreadRuntimeCore resets
 * its per-message ThreadMessageConverter cache whenever `convertMessage`'s IDENTITY
 * changes (external-store-thread-runtime-core.js:110) and only takes its fast-path
 * "no work" bail when `messages` is referentially unchanged AND `convertMessage` is
 * stable (line 111). So an inline `convertMessage: (m) => m` (a fresh arrow every
 * render) wiped that cache on EVERY render — every WS frame, incl. 5s resources ticks
 * and frames for OTHER sessions — re-converting the whole transcript each time.
 *
 * These tests measure that mechanism: a stable convertMessage ref does far less
 * conversion work than a fresh-arrow-per-render one. App.tsx now hoists the identity
 * fn to a module constant (`identityConvertMessage`), so it gets the stable behavior
 * the first test asserts. If someone reverts to an inline arrow, the ratio these
 * tests document is the regression that reintroduces.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { useExternalStoreRuntime } from '@assistant-ui/react';
import type { ThreadMessageLike } from '@assistant-ui/react';

afterEach(cleanup);

// One referentially-STABLE messages array — mirrors App feeding the runtime a
// memoized list that does NOT change identity on unrelated re-renders.
const MESSAGES: ThreadMessageLike[] = [
  { role: 'assistant', content: [{ type: 'text', text: 'alpha' }] },
  { role: 'user', content: [{ type: 'text', text: 'beta' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'gamma' }] },
];

const RERENDERS = 6;

function Harness({
  tick,
  convertMessage,
}: {
  tick: number;
  convertMessage: (m: ThreadMessageLike) => ThreadMessageLike;
}) {
  useExternalStoreRuntime({
    messages: MESSAGES,
    isDisabled: false,
    convertMessage,
    onNew: async () => {},
  });
  // `tick` forces a parent-driven re-render with the SAME messages reference,
  // simulating a resources tick / other-session WS frame in App.
  return createElement('div', null, String(tick));
}

describe('App runtime: convertMessage identity governs re-conversion cost', () => {
  it('a stable convertMessage ref does far less conversion work than a fresh arrow per render', () => {
    // STABLE: same fn reference across every render (the fixed App.tsx behavior).
    const stableSpy = vi.fn((m: ThreadMessageLike) => m);
    const { rerender: rerenderStable } = render(
      createElement(Harness, { tick: 0, convertMessage: stableSpy }),
    );
    for (let i = 1; i <= RERENDERS; i++) {
      rerenderStable(createElement(Harness, { tick: i, convertMessage: stableSpy }));
    }
    cleanup();

    // UNSTABLE: a fresh wrapper identity every render (the pre-fix App.tsx pattern).
    const unstableSpy = vi.fn((m: ThreadMessageLike) => m);
    const { rerender: rerenderUnstable } = render(
      createElement(Harness, { tick: 0, convertMessage: (m: ThreadMessageLike) => unstableSpy(m) }),
    );
    for (let i = 1; i <= RERENDERS; i++) {
      rerenderUnstable(
        createElement(Harness, { tick: i, convertMessage: (m: ThreadMessageLike) => unstableSpy(m) }),
      );
    }

    const stableCalls = stableSpy.mock.calls.length;
    const unstableCalls = unstableSpy.mock.calls.length;

    // The measured win: the unstable arrow re-converts every message on every
    // render; the stable ref converts ~once and then bails.
    expect(unstableCalls).toBeGreaterThan(stableCalls);
    // Concretely: unstable scales with (messages x renders); stable stays near a
    // single pass regardless of how many unrelated re-renders happen.
    expect(unstableCalls).toBeGreaterThanOrEqual(MESSAGES.length * RERENDERS);
    expect(stableCalls).toBeLessThan(MESSAGES.length * RERENDERS);
  });
});
