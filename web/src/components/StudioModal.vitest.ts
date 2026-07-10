// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { StudioModal } from './StudioModal';
import { AppFrameLayer } from './AppFrameLayer';
import { ArtifactPanelProvider } from './ArtifactContext';
import { getHotkeySuppressed, setHotkeySuppressed } from '../lib/hotkeySuppression';

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

  it('editing a typed prop debounces the cc-props-set postMessage to ≤150ms, without an iframe reload', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    renderStudio();
    openStudio('apps/counter.html');

    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    await screen.findByLabelText('label');
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    const fetchCallsAtSettle = authFetchMock.mock.calls.length;

    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Widgets' } });
      expect(postSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(149);
      expect(postSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // 150ms total — the acceptance ceiling
      expect(postSpy).toHaveBeenCalledWith({ type: 'cc-props-set', props: { label: 'Widgets' } }, '*');
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

    // `count` is a number prop; force raw-JSON editing via its toggle, then
    // type a deliberately invalid (unparseable) value.
    const countRow = screen.getByLabelText('count').closest('.studio-prop-field') as HTMLElement;
    fireEvent.click(within(countRow).getByRole('button', { name: 'raw' }));
    fireEvent.change(within(countRow).getByLabelText('count raw JSON'), { target: { value: 'not-json' } });

    await vi.waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith({ type: 'cc-props-set', props: { count: 'not-json' } }, '*');
    });
  });

  it('Reset to defaults sends cc-props-reset immediately (no debounce)', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    renderStudio();
    openStudio('apps/counter.html');

    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    await screen.findByLabelText('label');
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(postSpy).toHaveBeenCalledWith({ type: 'cc-props-reset' }, '*');
  });
});
