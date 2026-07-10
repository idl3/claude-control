// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { StudioModal } from './StudioModal';
import { AppFrameLayer } from './AppFrameLayer';
import { ArtifactPanelProvider } from './ArtifactContext';
import { getHotkeySuppressed, setHotkeySuppressed } from '../lib/hotkeySuppression';
import { MAX_CC_CAPTURE_DATA_URL_LENGTH } from '../lib/appBridge';

// B2: device-mode resize tests mount AppFrameLayer alongside StudioModal so
// they can observe the actual hosted iframe (AppFrameLayer.vitest.ts's
// "Phase B, B1" suite already covers pickHost/elevation/chip mechanics in
// isolation — this file only needs the StudioModal-specific claim: switching
// device modes resizes the placeholder box, not the live iframe identity).
// Same authFetch-mock idiom as AppFrameLayer.vitest.ts/ArtifactPanel.vitest.ts.
const authFetchMock = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, authFetch: (...args: Parameters<typeof actual.authFetch>) => authFetchMock(...args) };
});

// Stub GSAP so useModalTransition's enter/exit timelines resolve
// synchronously — same stub as lib/anim.vitest.ts. We care about the
// studio's own behavior, not animation timing.
let gsapNeverComplete = false;
vi.mock('gsap', () => {
  const noop = () => {};
  const makeTimeline = (opts?: { onComplete?: () => void }) => {
    const self = {
      fromTo: () => self,
      to: () => self,
      kill: noop,
    };
    if (!gsapNeverComplete) opts?.onComplete?.();
    return self;
  };
  return {
    default: {
      set: noop,
      timeline: makeTimeline,
    },
  };
});

// jsdom implements no matchMedia at all. Mocks any `(min-width:Npx)` query
// against a fake viewport width; anything else (e.g. prefers-reduced-motion)
// defaults to non-matching, same as a real browser at default settings.
function mockViewportWidth(px: number): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => {
      const m = /^\(min-width:(\d+)px\)$/.exec(query);
      const matches = m ? px >= Number(m[1]) : false;
      return {
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function openStudio(url = 'apps/counter.html'): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }));
  });
}

beforeEach(() => {
  mockViewportWidth(1400); // wide desktop by default
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  setHotkeySuppressed(false); // reset the A3 singleton between tests
});

describe('StudioModal — open/close', () => {
  it('renders nothing until cockpit:studio-open fires', () => {
    render(createElement(StudioModal));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens with the derived app name + version tag, and closes via the close button', () => {
    render(createElement(StudioModal));
    openStudio('apps/counter/2026-07-08T23-32-05Z.html');

    expect(screen.getByRole('dialog', { name: 'counter studio' })).toBeTruthy();
    expect(screen.getByText('counter')).toBeTruthy();
    expect(screen.getByText('2026-07-08T23-32-05Z')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Close studio'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('flat (unversioned) urls show "latest" as the version tag', () => {
    render(createElement(StudioModal));
    openStudio('apps/counter.html');
    expect(screen.getByText('latest')).toBeTruthy();
  });

  it('z-order classname is present on the overlay (sits above panel-sheet/210 hoists, below the lightbox)', () => {
    render(createElement(StudioModal));
    openStudio();
    expect(document.querySelector('.studio-overlay')).toBeTruthy();
  });

  it('renders a context="studio" EmbeddedApp placeholder for the open url — no <iframe> of its own (AppFrameLayer owns hosting, see AppFrameLayer.vitest.ts)', () => {
    render(createElement(StudioModal));
    openStudio('apps/counter.html');
    expect(document.querySelector('iframe')).toBeNull();
    const placeholder = document.querySelector('[data-embed-app-context="studio"]');
    expect(placeholder).toBeTruthy();
    expect(placeholder?.getAttribute('data-embed-app-url')).toBe('apps/counter.html');
  });
});

describe('StudioModal — Studio Phase B CP3 audit, FIX 4: rapid app swap is ignored until the studio closes', () => {
  it("opening a second app while a first app's studio is open is ignored (no jump-cut); the second open succeeds once the first is closed", () => {
    render(createElement(StudioModal));
    openStudio('apps/appa.html');
    expect(screen.getByRole('dialog', { name: 'appa studio' })).toBeTruthy();

    // Pre-fix: `setOpenUrl(url)` applied unconditionally on every open
    // event. `<StudioPanel key={openUrl} ...>` is keyed by url, so this
    // second open force-unmounted appa's StudioPanel outright (a React key
    // change tears down and remounts) — bypassing useModalTransition's exit
    // tween entirely, a visible jump-cut instead of the studio's normal
    // close animation.
    openStudio('apps/appb.html');
    expect(screen.getByRole('dialog', { name: 'appa studio' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'appb studio' })).toBeNull();

    fireEvent.click(screen.getByLabelText('Close studio'));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Reopening for appb now succeeds — the guard is "ignore until closed,"
    // not "ignore forever."
    openStudio('apps/appb.html');
    expect(screen.getByRole('dialog', { name: 'appb studio' })).toBeTruthy();
  });
});

describe('StudioModal — device-mode gating', () => {
  // Studio Phase B CP3 audit, FIX 3: gating now requires the raw device
  // width PLUS `.studio-body`'s own chrome width (STUDIO_BODY_CHROME_WIDTH
  // = 50 in StudioModal.tsx), so Mobile's real threshold is 390 + 50 = 440,
  // not the raw 390. 500px sits above that threshold (Mobile enabled) but
  // below iPad's 768 + 50 = 818 (iPad/Desktop stay disabled) — the same
  // "only Mobile fits" shape the old 390px case asserted, just at the
  // width that's actually enabled post-fix.
  it('at 500px, only Mobile is enabled', () => {
    mockViewportWidth(500);
    render(createElement(StudioModal));
    openStudio();

    const mobile = screen.getByRole('button', { name: /Mobile 390/ }) as HTMLButtonElement;
    const ipad = screen.getByRole('button', { name: /iPad 768/ }) as HTMLButtonElement;
    const desktop = screen.getByRole('button', { name: /Desktop 1280/ }) as HTMLButtonElement;
    expect(mobile.disabled).toBe(false);
    expect(ipad.disabled).toBe(true);
    expect(desktop.disabled).toBe(true);
  });

  // Regression test proving the boundary-band bug FIX 3 closes: pre-fix,
  // Mobile enabled the instant the window matched its RAW 390px width, even
  // though `.studio-body`'s 24px padding (both sides) + `.studio-frame`'s
  // 1px border (both sides) — 50px total — meant a 390px window could not
  // actually fit a 390px device box without `.studio-body`'s own
  // `overflow: auto` kicking in (a boundary-band horizontal scrollbar).
  it('at exactly the raw device width (390px), Mobile is now disabled — the pre-fix boundary-band bug', () => {
    mockViewportWidth(390);
    render(createElement(StudioModal));
    openStudio();

    const mobile = screen.getByRole('button', { name: /Mobile 390/ }) as HTMLButtonElement;
    expect(mobile.disabled).toBe(true);
  });

  it('at exactly the chrome-aware threshold (440px = 390 + 50), Mobile is enabled', () => {
    mockViewportWidth(440);
    render(createElement(StudioModal));
    openStudio();

    const mobile = screen.getByRole('button', { name: /Mobile 390/ }) as HTMLButtonElement;
    expect(mobile.disabled).toBe(false);
  });

  it('at 1400px, all three modes are enabled', () => {
    render(createElement(StudioModal)); // beforeEach already mocks 1400px
    openStudio();

    const mobile = screen.getByRole('button', { name: /Mobile 390/ }) as HTMLButtonElement;
    const ipad = screen.getByRole('button', { name: /iPad 768/ }) as HTMLButtonElement;
    const desktop = screen.getByRole('button', { name: /Desktop 1280/ }) as HTMLButtonElement;
    expect(mobile.disabled).toBe(false);
    expect(ipad.disabled).toBe(false);
    expect(desktop.disabled).toBe(false);
  });

  it('disabled modes carry a "screen too small" tooltip', () => {
    mockViewportWidth(500); // FIX 3: see "at 500px, only Mobile is enabled" above
    render(createElement(StudioModal));
    openStudio();
    expect(screen.getByRole('button', { name: /iPad 768/ }).getAttribute('title')).toBe(
      'screen too small',
    );
    expect(screen.getByRole('button', { name: /Mobile 390/ }).getAttribute('title')).toBeNull();
  });
});

describe('StudioModal — B2: device-mode resize (mounted with AppFrameLayer)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
  });

  function renderStudio() {
    render(
      createElement(ArtifactPanelProvider, null, createElement(StudioModal), createElement(AppFrameLayer)),
    );
  }

  it('the device box (.studio-frame) is sized exactly to each preset — Mobile 390x844, iPad 768x1024, Desktop 1280x800', () => {
    renderStudio();
    openStudio('apps/device-size.html');

    const frame = document.querySelector('.studio-frame') as HTMLElement;
    // Desktop viewport (beforeEach mocks 1400px) defaults to the largest
    // enabled mode, Desktop, per StudioPanel's initial-mode logic.
    expect(frame.style.width).toBe('1280px');
    expect(frame.style.height).toBe('800px');

    fireEvent.click(screen.getByRole('button', { name: /Mobile 390/ }));
    expect(frame.style.width).toBe('390px');
    expect(frame.style.height).toBe('844px');

    fireEvent.click(screen.getByRole('button', { name: /iPad 768/ }));
    expect(frame.style.width).toBe('768px');
    expect(frame.style.height).toBe('1024px');
  });

  it('zero iframe reloads across a full mode-switch cycle — one html fetch, one iframe node, for the entire journey', async () => {
    renderStudio();
    openStudio('apps/no-reload-resize.html');

    const iframeAtOpen = await screen.findByTitle('apps/no-reload-resize.html');
    // C3: StudioPanel also fires one manifest fetch on mount (a sibling
    // authFetch call — this describe block's beforeEach mocks a `.text()`-
    // only response, so the manifest fetch's `res.json()` throws, caught by
    // fetchAppManifest, degrading to null — expected here since this url
    // carries no fixture manifest). The claim under test — no REFETCH across
    // mode switches — only cares that the call count stays flat afterward.
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const callsAtOpen = authFetchMock.mock.calls.length;

    for (const label of [/Mobile 390/, /iPad 768/, /Desktop 1280/, /Mobile 390/]) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: label }));
      });
    }

    await waitFor(() => {
      expect(screen.getByTitle('apps/no-reload-resize.html')).toBe(iframeAtOpen);
    });
    expect(authFetchMock).toHaveBeenCalledTimes(callsAtOpen); // no new fetches from mode switches
  });

  it('gated modes stay unreachable at small screens even with AppFrameLayer mounted (Phase A gating unchanged)', () => {
    mockViewportWidth(390);
    renderStudio();
    openStudio('apps/gated-small.html');

    const ipad = screen.getByRole('button', { name: /iPad 768/ }) as HTMLButtonElement;
    const desktop = screen.getByRole('button', { name: /Desktop 1280/ }) as HTMLButtonElement;
    expect(ipad.disabled).toBe(true);
    expect(desktop.disabled).toBe(true);

    fireEvent.click(ipad); // disabled — StudioPanel's onClick guards `enabled &&`
    const frame = document.querySelector('.studio-frame') as HTMLElement;
    expect(frame.style.width).toBe('390px'); // stays on the only enabled mode, Mobile
  });
});

describe('StudioModal — hotkey suppression (A3 composition)', () => {
  it('defaults ON when the studio opens, and is restored to OFF when it closes', () => {
    render(createElement(StudioModal));
    openStudio();

    const toggle = screen.getByLabelText('Disable cockpit hotkeys') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(getHotkeySuppressed()).toBe(true);

    fireEvent.click(screen.getByLabelText('Close studio'));
    expect(getHotkeySuppressed()).toBe(false);
  });

  it('persists the toggle across opens via sessionStorage (not reset to ON every time)', () => {
    render(createElement(StudioModal));
    openStudio();
    fireEvent.click(screen.getByLabelText('Disable cockpit hotkeys')); // user turns it OFF
    expect(getHotkeySuppressed()).toBe(false);
    fireEvent.click(screen.getByLabelText('Close studio'));
    expect(getHotkeySuppressed()).toBe(false); // restore-on-close is a no-op here (already off)

    openStudio(); // reopen in the same session
    const toggle = screen.getByLabelText('Disable cockpit hotkeys') as HTMLInputElement;
    expect(toggle.checked).toBe(false); // remembers OFF, does not reset to default ON
  });

  it('Escape closes the studio even while suppression is ON, and still restores suppression to OFF', () => {
    render(createElement(StudioModal));
    openStudio();
    expect(getHotkeySuppressed()).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getHotkeySuppressed()).toBe(false);
  });
});
describe('CP3-A HIGH regression: suppression release is not animation-gated', () => {
  it('releases suppression at close-request time even if the close animation never completes', () => {
    // Flip the module-level gsap stub into never-complete mode: onComplete is
    // swallowed, so unmount (and its cleanup effect) never runs. The eager
    // release in onClose must clear suppression anyway (T4 fail-safe).
    gsapNeverComplete = true;
    try {
      render(createElement(StudioModal));
      openStudio();
      expect(getHotkeySuppressed()).toBe(true);
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });
      expect(getHotkeySuppressed()).toBe(false);
    } finally {
      gsapNeverComplete = false;
    }
  });
});

// --- Phase C, C3: Props panel ------------------------------------------
// A permanently-visible sibling of `.studio-frame` (see StudioModal.tsx's
// StudioPropsPanel doc comment) — never a hide/show tab, so these tests
// never need to worry about the panel unmounting the iframe. Each describe
// block below scopes its own `authFetchMock` implementation (same locally-
// scoped pattern as the "B2: device-mode resize" block above) so the
// manifest fetch's response is explicit and doesn't leak between tests.
const FIXTURE_MANIFEST = {
  'schema-version': 1,
  component: 'Counter',
  props: [
    { name: 'label', tsType: 'string', required: true, example: 'Clicks' },
    { name: 'count', tsType: 'number', required: false, default: 0 },
    {
      name: 'theme',
      tsType: '"light" | "dark" | "auto"',
      required: false,
      enumOptions: ['light', 'dark', 'auto'],
      default: 'light',
    },
    { name: 'onChange', tsType: '(labels: string[]) => void', required: false },
  ],
};

function mockManifestFetch(manifest: unknown | null): void {
  authFetchMock.mockReset();
  authFetchMock.mockImplementation((url: string) => {
    if (url.endsWith('.manifest.json')) {
      if (manifest === null) return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(manifest) });
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve('<html>app</html>') });
  });
}

describe('StudioModal — C3: props panel manifest states', () => {
  it('degrade path: a manifest-less (404) artifact shows the rebuild-command message, not a form', async () => {
    mockManifestFetch(null);
    render(createElement(StudioModal));
    openStudio('apps/old-counter.html');

    await screen.findByText(/rebuild with a component entry/);
    expect(document.querySelector('.studio-props-degrade-cmd')?.textContent).toContain('old-counter');
    expect(screen.queryByLabelText('label')).toBeNull();
  });

  it('renders a typed form generated from the manifest — enum select, number/string inputs, required marker, example chip', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/counter.html');

    await screen.findByLabelText('label'); // string input
    expect(screen.getByLabelText('count')).toBeTruthy(); // number input
    expect(screen.getByLabelText('theme').tagName).toBe('SELECT'); // enum select
    expect(document.querySelector('.studio-prop-name')?.textContent).toBe('label *'); // required marker
    expect(screen.getByText('example: Clicks')).toBeTruthy();

    // `onChange` (a function tsType) has no typed control — raw-JSON-only.
    expect(screen.queryByLabelText('onChange')).toBeNull();
    expect(screen.getByLabelText('onChange raw JSON')).toBeTruthy();
  });
});

describe('StudioModal — C3: props panel live injection (mounted with AppFrameLayer)', () => {
  // Same rect stub as "B2: device-mode resize" above — AppFrameLayer only
  // hoists a real <iframe> once its placeholder reports non-zero bounds.
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }
  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
    vi.useRealTimers();
  });

  function renderStudio() {
    render(
      createElement(ArtifactPanelProvider, null, createElement(StudioModal), createElement(AppFrameLayer)),
    );
  }

  // Studio Phase C CP3 audit, FIX 1: simulates the artifact's real
  // `cc-bridge-ready` announcement (ccBridgeRuntime.tsx's withCcBridge posts
  // this on its own mount) — same `window.dispatchEvent(new MessageEvent(...))`
  // idiom as embeds.vitest.ts's cc-app-error beacon tests, `source` set to
  // the tracked iframe's own contentWindow so `isValidCcBridgeReady`'s
  // source-identity check passes.
  function sendBridgeReady(win: Window): void {
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'cc-bridge-ready', manifestVersion: 1 }, source: win }),
      );
    });
  }

  it('editing a typed prop debounces the cc-props-set postMessage to ≤150ms once the bridge is ready, without an iframe reload', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    renderStudio();
    openStudio('apps/counter.html');

    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    await screen.findByLabelText('label');
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    const fetchCallsAtSettle = authFetchMock.mock.calls.length;

    // FIX 1: sends only proceed once a validated cc-bridge-ready has been
    // seen from this app's own iframe — see the queued/flushed test below
    // for the no-ready-yet case this closes.
    sendBridgeReady(iframe.contentWindow as Window);

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Widgets' } });
      expect(postSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(149);
      expect(postSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // 150ms total — the acceptance ceiling
      expect(postSpy).toHaveBeenCalledWith({ type: 'cc-props-set', props: { label: 'Widgets' } }, '*');
      expect(postSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    // Never reloads the iframe — same node, no new fetch.
    expect(screen.getByTitle('apps/counter.html')).toBe(iframe);
    expect(authFetchMock.mock.calls.length).toBe(fetchCallsAtSettle);
  });

  it('the raw-JSON override forwards an invalid (non-JSON) value as-is — the artifact must exercise its own error path, not have it validated away', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    renderStudio();
    openStudio('apps/counter.html');

    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    await screen.findByLabelText('count');
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    sendBridgeReady(iframe.contentWindow as Window);

    // `count` is a number prop; force raw-JSON editing via its toggle, then
    // type a deliberately invalid (unparseable) value.
    const countRow = screen.getByLabelText('count').closest('.studio-prop-field') as HTMLElement;
    fireEvent.click(within(countRow).getByRole('button', { name: 'raw' }));
    fireEvent.change(within(countRow).getByLabelText('count raw JSON'), { target: { value: 'not-json' } });

    await vi.waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith({ type: 'cc-props-set', props: { count: 'not-json' } }, '*');
    });
  });

  it('Reset to defaults sends cc-props-reset immediately (no debounce), regardless of bridge readiness', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    renderStudio();
    openStudio('apps/counter.html');

    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    await screen.findByLabelText('label');
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');

    // Deliberately no sendBridgeReady() call here — reset is ungated (see
    // StudioModal.tsx's reset() doc comment) and must fire even before the
    // bridge has announced itself.
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(postSpy).toHaveBeenCalledWith({ type: 'cc-props-reset' }, '*');
  });

  it('a props-set committed before cc-bridge-ready arrives is queued (not sent), then flushed exactly once when a valid ready lands', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    renderStudio();
    openStudio('apps/counter.html');

    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    await screen.findByLabelText('label');
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Widgets' } });
      vi.advanceTimersByTime(150); // debounce fires, but the bridge isn't ready — queued, not sent
      expect(postSpy).not.toHaveBeenCalled();

      // A second edit before ready lands must coalesce to the newest value,
      // not queue a backlog — only 'Final' should ever reach the artifact.
      fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Final' } });
      vi.advanceTimersByTime(150);
      expect(postSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    // Ready arrives (valid shape + matching iframe window) — flushes
    // immediately, no further debounce wait, exactly once.
    sendBridgeReady(win);
    expect(postSpy).toHaveBeenCalledWith({ type: 'cc-props-set', props: { label: 'Final' } }, '*');
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("a cc-bridge-ready message from a window other than this app's own iframe is ignored — the gate stays closed and the props-set stays queued", async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    renderStudio();
    openStudio('apps/counter.html');

    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    await screen.findByLabelText('label');
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');

    // Same-shape ready message, but sourced from the top frame itself
    // (never the tracked iframe's contentWindow) — same spoofed-source idiom
    // as embeds.vitest.ts's "ignores a spoofed-source beacon" test. Must not
    // flip the gate: the source-identity check now runs live against a real
    // listener, not just in isolation (appBridge.vitest.ts already covers
    // isValidCcBridgeReady in isolation).
    sendBridgeReady(window);

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Widgets' } });
      vi.advanceTimersByTime(150);
      expect(postSpy).not.toHaveBeenCalled(); // spoofed ready never opened the gate
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('StudioModal — Studio Phase C CP3 audit, FIX 2: reset clears stale raw-JSON textareas', () => {
  it('after Reset to defaults, a raw-JSON-only field (no typed control) with stale/invalid text is cleared, not left stale', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/counter.html');

    // `onChange` is a function tsType — always raw-JSON-only, no typed-
    // control toggle exists to force a remount another way (the exact
    // "unrecoverable for raw-only props" case FIX 2 targets).
    await screen.findByLabelText('onChange raw JSON');
    const textarea = screen.getByLabelText('onChange raw JSON') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'not valid json {{{' } });
    expect(textarea.value).toBe('not valid json {{{');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    const textareaAfterReset = screen.getByLabelText('onChange raw JSON') as HTMLTextAreaElement;
    expect(textareaAfterReset.value).toBe('');
  });

  it('reset also clears a raw-JSON override on a field that HAS a typed control (toggled into raw mode)', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/counter.html');

    await screen.findByLabelText('count');
    const countRow = screen.getByLabelText('count').closest('.studio-prop-field') as HTMLElement;
    fireEvent.click(within(countRow).getByRole('button', { name: 'raw' }));
    const raw = within(countRow).getByLabelText('count raw JSON') as HTMLTextAreaElement;
    fireEvent.change(raw, { target: { value: 'not-json' } });
    expect(raw.value).toBe('not-json');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    // Still in raw mode after reset (FIX 2 only remounts the textarea, not
    // the whole field — the rawMode toggle choice survives, matching the
    // "typed"/"raw" button's own persisted-choice UX elsewhere in this
    // panel) — its value is cleared.
    const rawAfterReset = within(countRow).getByLabelText('count raw JSON') as HTMLTextAreaElement;
    expect(rawAfterReset.value).toBe('');
  });
});

// --- Phase D: D1 (capture) + D3 (save-to-media-root) ----------------------
// D1's cc-capture-request/result round-trips through the same real,
// AppFrameLayer-hoisted iframe as the C3 props-panel bridge tests above
// (findAppIframeWindow matches by `title === url`, same as those). D2's
// StudioAnnotate is exercised for real here (mounted inside the review
// overlay) but its own pure geometry/composite functions get isolated unit
// coverage in StudioAnnotate.vitest.ts — this file only proves the capture
// state machine + requestId correlation + save wiring.
describe('StudioModal — D1/D3: Screenshot capture + save (mounted with AppFrameLayer)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }
  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderStudio() {
    render(
      createElement(ArtifactPanelProvider, null, createElement(StudioModal), createElement(AppFrameLayer)),
    );
  }

  function captureRequestId(postSpy: ReturnType<typeof vi.spyOn>): string {
    const call = postSpy.mock.calls.find((c) => (c[0] as { type?: string })?.type === 'cc-capture-request');
    return (call?.[0] as { requestId: string }).requestId;
  }

  /**
   * Studio Phase D CP3 audit, FIX 1: jsdom's HTMLImageElement never fires
   * `load`/`error` for a `src` assignment at all (verified directly — see
   * StudioAnnotate.vitest.ts's own copy of this helper) — StudioAnnotate's
   * decode-detection (imgReady, gating Save) needs a synthetic Image that
   * actually fires one or the other. `failSrcs` opts a specific dataUrl into
   * the failure (onerror) path; every other src succeeds. Tests that want to
   * exercise the "still decoding" default (Save must stay disabled/blocked)
   * simply don't call this at all.
   */
  function stubImageLoad(failSrcs: Set<string> = new Set()) {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 400;
      naturalHeight = 320;
      set src(value: string) {
        queueMicrotask(() => {
          if (failSrcs.has(value)) this.onerror?.();
          else this.onload?.();
        });
      }
    }
    vi.stubGlobal('Image', FakeImage);
  }

  it('Screenshot click sends cc-capture-request; a matching cc-capture-result opens the review overlay with the annotate canvas', async () => {
    renderStudio();
    openStudio('apps/counter.html');
    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'cc-capture-request' }), '*');
    const requestId = captureRequestId(postSpy);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cc-capture-result', requestId, ok: true, dataUrl: 'data:image/png;base64,AAAA' },
          source: win,
        }),
      );
    });

    expect(document.querySelector('.studio-capture-review')).toBeTruthy();
    expect(screen.getByTestId('studio-annotate-canvas')).toBeTruthy();
  });

  it('toggles body.studio-capture-reviewing while the review overlay is showing, and clears it on unmount (regression: the studio-context hoisted live-app iframe at z-index 310 otherwise sits above .studio-capture-overlay and swallows every click meant for the canvas/Save/Cancel — caught only via live-browser evidence-gathering, since jsdom performs no real stacking-context/hit-testing)', async () => {
    renderStudio();
    openStudio('apps/counter.html');
    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');

    expect(document.body.classList.contains('studio-capture-reviewing')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
    const requestId = captureRequestId(postSpy);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cc-capture-result', requestId, ok: true, dataUrl: 'data:image/png;base64,AAAA' },
          source: win,
        }),
      );
    });

    expect(document.querySelector('.studio-capture-review')).toBeTruthy();
    expect(document.body.classList.contains('studio-capture-reviewing')).toBe(true);

    cleanup();
    expect(document.body.classList.contains('studio-capture-reviewing')).toBe(false);
  });

  it('capture times out after 10s with no result — an error chip renders and Screenshot re-enables', async () => {
    renderStudio();
    openStudio('apps/counter.html');
    await screen.findByTitle('apps/counter.html');

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
      expect(screen.getByRole('button', { name: 'Capturing…' })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByRole('alert').textContent).toContain('capture timed out');
      expect(screen.getByRole('button', { name: 'Screenshot' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cc-capture-result from a spoofed source (not the tracked iframe) is ignored — stays in the capturing state', async () => {
    renderStudio();
    openStudio('apps/counter.html');
    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
    const requestId = captureRequestId(postSpy);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cc-capture-result', requestId, ok: true, dataUrl: 'data:image/png;base64,AAAA' },
          source: window, // spoofed: never the tracked iframe's contentWindow
        }),
      );
    });

    expect(document.querySelector('.studio-capture-review')).toBeNull();
    expect(screen.getByRole('button', { name: 'Capturing…' })).toBeTruthy();
  });

  it('a stale cc-capture-result carrying an unrecognized requestId (e.g. from a prior, already-timed-out request) is ignored', async () => {
    renderStudio();
    openStudio('apps/counter.html');
    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    const win = iframe.contentWindow as Window;

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'cc-capture-result',
            requestId: 'some-other-stale-request-id',
            ok: true,
            dataUrl: 'data:image/png;base64,AAAA',
          },
          source: win,
        }),
      );
    });

    expect(document.querySelector('.studio-capture-review')).toBeNull();
    expect(screen.getByRole('button', { name: 'Capturing…' })).toBeTruthy();
  });

  it('D3: Save posts the composited PNG to the captures endpoint and renders a copyable <embedded-image> tag', async () => {
    stubImageLoad(); // real decode success — Save only enables once StudioAnnotate's imgReady flips true
    renderStudio();
    openStudio('apps/counter.html');
    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
    const requestId = captureRequestId(postSpy);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cc-capture-result', requestId, ok: true, dataUrl: 'data:image/png;base64,AAAA' },
          source: win,
        }),
      );
    });

    // saveCapture() lives in lib/api.ts and calls `authFetch` via that
    // module's OWN internal binding, not the one StudioModal.tsx imports —
    // so the `vi.mock('../lib/api', ...)` partial-mock swap above (which
    // only rebinds `authFetch` for EXTERNAL importers) never intercepts it.
    // Stubbing the underlying global `fetch` reaches it regardless of which
    // module made the call.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/captures')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, path: 'captures/counter/2026-01-01T00-00-00Z.png' }),
        } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('<html>app</html>') } as Response);
    });

    // Studio Phase D CP3 audit, FIX 1: Save starts disabled until the review
    // image has actually decoded — wait for it to enable before clicking,
    // same as a real user would have to.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/media-apps/counter/captures',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(
      await screen.findByText('<embedded-image url="captures/counter/2026-01-01T00-00-00Z.png" />'),
    ).toBeTruthy();
    fetchSpy.mockRestore();
  });

  // Studio Phase D CP3 audit, FIX 1 coverage: a malformed/undecodable or
  // oversize capture must never silently produce a blank-canvas save — Save
  // stays disabled/blocked and no POST ever fires.

  it('Save stays disabled while the review image has not (yet, or ever) finished decoding — no POST fires on click', async () => {
    // No stubImageLoad() here: default jsdom never fires onload/onerror at
    // all, which is exactly the "still decoding" state Save must block on.
    renderStudio();
    openStudio('apps/counter.html');
    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
    const requestId = captureRequestId(postSpy);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cc-capture-result', requestId, ok: true, dataUrl: 'data:image/png;base64,AAAA' },
          source: win,
        }),
      );
    });

    const saveBtn = (await screen.findByRole('button', { name: 'Save' })) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    fireEvent.click(saveBtn);
    expect(fetchSpy).not.toHaveBeenCalledWith(
      '/api/media-apps/counter/captures',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchSpy.mockRestore();
  });

  it('a malformed capture image (source onerror) surfaces a real error stage, matching the capture-failed chip idiom, instead of leaving Save silently exportable', async () => {
    const malformed = 'data:image/png;base64,not-actually-a-png';
    stubImageLoad(new Set([malformed]));
    renderStudio();
    openStudio('apps/counter.html');
    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
    const requestId = captureRequestId(postSpy);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cc-capture-result', requestId, ok: true, dataUrl: malformed },
          source: win,
        }),
      );
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('capture image failed to decode'));
    expect(document.querySelector('.studio-capture-review')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalledWith(
      '/api/media-apps/counter/captures',
      expect.objectContaining({ method: 'POST' }),
    );
    fetchSpy.mockRestore();
  });

  it('an oversize cc-capture-result dataUrl (over the 15MB base64 ceiling) is rejected at the message boundary with the capture-failed error chip, never entering review', async () => {
    renderStudio();
    openStudio('apps/counter.html');
    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    const win = iframe.contentWindow as Window;
    const postSpy = vi.spyOn(win, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: 'Screenshot' }));
    const requestId = captureRequestId(postSpy);
    const oversizeDataUrl = `data:image/png;base64,${'A'.repeat(MAX_CC_CAPTURE_DATA_URL_LENGTH + 1)}`;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cc-capture-result', requestId, ok: true, dataUrl: oversizeDataUrl },
          source: win,
        }),
      );
    });

    expect(screen.getByRole('alert').textContent).toContain('capture too large to review');
    expect(document.querySelector('.studio-capture-review')).toBeNull();
  });
});
