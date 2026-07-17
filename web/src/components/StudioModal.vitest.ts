// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { StudioModal, studioFitScale, studioAvailableWidth } from './StudioModal';
import { AppFrameLayer } from './AppFrameLayer';
import { ArtifactPanelProvider } from './ArtifactContext';
import { getHotkeySuppressed, setHotkeySuppressed } from '../lib/hotkeySuppression';
import { MAX_CC_CAPTURE_DATA_URL_LENGTH, CC_DOM_OUTLINE_RESULT_TYPE } from '../lib/appBridge';

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
//
// Mobile-UX fix #3: also stubs `window.innerWidth` to the same px.
// `useViewportWidth()` (StudioModal.tsx) reads raw `window.innerWidth`
// directly for the scale-to-fit computation AND the Feature 1 default
// category/orientation pick (`studioLayoutMode(viewportW)`) — a DIFFERENT
// mechanism from the matchMedia-based `useMinWidth()` that drives
// `columnMode`'s yes/no boundary check. Without this, `viewportW` stayed permanently at
// jsdom's default (1024) regardless of the mocked px, decoupled from every
// test's intended viewport width. A real browser's matchMedia and
// innerWidth always agree on the current viewport, so coupling them here
// under one px argument matches reality, not a divergence.
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
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: px });
}

function openStudio(url = 'apps/counter.html'): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }));
  });
}

beforeEach(() => {
  // Studio Phase E polish, F2: STUDIO_BODY_CHROME_WIDTH grew from 50 to 390
  // (now counts the 320px side panel + 20px `.studio-body` gap, not just
  // padding/border), so Desktop's real enable threshold is 1280 + 390 =
  // 1670 — 1800 clears all three device thresholds comfortably.
  mockViewportWidth(1800); // wide desktop by default
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

describe('StudioModal — pure helpers: studioFitScale / studioAvailableWidth', () => {
  it('studioFitScale scales down (never upscales) to fit the logical width inside the available width', () => {
    expect(studioFitScale(1280, 800, 366, Number.POSITIVE_INFINITY)).toBeCloseTo(0.2859, 4);
  });

  it('studioFitScale never upscales past 1 when there is more room than the logical width needs', () => {
    expect(studioFitScale(390, 844, 800, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('studioFitScale returns identity (1) when availableWidth is non-positive, rather than dividing by zero/negative', () => {
    expect(studioFitScale(390, 844, 0, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('studioAvailableWidth subtracts the column-mode padding in column mode', () => {
    expect(studioAvailableWidth(390, true)).toBe(366);
  });

  it('studioAvailableWidth subtracts the row-mode chrome width (side panel + gap) outside column mode', () => {
    expect(studioAvailableWidth(1600, false)).toBe(1210);
  });

  it('studioAvailableWidth floors at 0 rather than going negative', () => {
    expect(studioAvailableWidth(0, false)).toBe(0);
  });
});

// Graphite Inspector redesign, Finding 1: studioFitScale is now both-axis —
// the tighter of the width/height constraints wins.
describe('StudioModal — studioFitScale: both-axis fit (Graphite Inspector Finding 1)', () => {
  it('the height constraint binds when it is tighter than the width constraint', () => {
    expect(studioFitScale(1280, 800, 1410, 608)).toBeCloseTo(0.76, 4);
  });

  it('the width constraint binds when it is tighter than the height constraint', () => {
    expect(studioFitScale(768, 1024, 366, 900)).toBeCloseTo(0.4766, 4);
  });

  it('never upscales when neither axis constrains the preset', () => {
    expect(studioFitScale(390, 844, 1200, 2000)).toBe(1);
  });

  it('availableHeight = Infinity recovers the exact width-only behavior', () => {
    expect(studioFitScale(390, 844, 366, Number.POSITIVE_INFINITY)).toBeCloseTo(0.9385, 4);
  });

  it('returns identity (1) when availableHeight is non-positive', () => {
    expect(studioFitScale(390, 844, 366, 0)).toBe(1);
  });

  it('returns identity (1) when logicalHeight is non-positive', () => {
    expect(studioFitScale(390, 0, 366, 500)).toBe(1);
  });
});

describe('StudioModal — Feature 1: device category + select + orientation picker', () => {
  // Wave 1 replaces the old fixed 3-mode segmented control (Mobile/iPad/
  // Desktop, disabled-at-narrow-width gating) with a grouped registry
  // (studioDevices.ts): a category segmented control, an in-category native
  // <select>, and an orientation toggle. Every preset is still always
  // selectable — a preset that doesn't fit at 1:1 scales down instead of
  // disabling (Mobile-UX fix #3, preserved) — the B2 describe block below
  // covers the scaled-footprint assertions.
  it('opens to desktop/laptop/landscape on a dock-width viewport (studioLayoutMode(1800) === "dock")', () => {
    render(createElement(StudioModal)); // beforeEach mocks 1800px
    openStudio();

    expect(screen.getByRole('button', { name: 'Desktop' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('combobox', { name: 'Device' }) as HTMLSelectElement).value).toBe('laptop');
    const rotate = screen.getByRole('button', { name: 'Rotate orientation' }) as HTMLButtonElement;
    expect(rotate.disabled).toBe(true); // desktop is orientation-locked
  });

  it('opens to phone/iphone-13/portrait on a sheet-width viewport (studioLayoutMode(390) === "sheet")', () => {
    mockViewportWidth(390);
    render(createElement(StudioModal));
    openStudio();

    expect(screen.getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('combobox', { name: 'Device' }) as HTMLSelectElement).value).toBe('iphone-13');
    expect(screen.getByRole('button', { name: 'Rotate orientation' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('switching category picks that category\'s default device and resets orientation to portrait', () => {
    render(createElement(StudioModal)); // opens desktop/laptop/landscape
    openStudio();

    fireEvent.click(screen.getByRole('button', { name: 'Tablet' }));
    expect((screen.getByRole('combobox', { name: 'Device' }) as HTMLSelectElement).value).toBe('ipad-pro-11');
    expect(screen.getByRole('button', { name: 'Rotate orientation' }).getAttribute('aria-pressed')).toBe('false');

    // Rotate to landscape, then switch to Phone — orientation resets again.
    fireEvent.click(screen.getByRole('button', { name: 'Rotate orientation' }));
    expect(screen.getByRole('button', { name: 'Rotate orientation' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    expect((screen.getByRole('combobox', { name: 'Device' }) as HTMLSelectElement).value).toBe('iphone-13');
    expect(screen.getByRole('button', { name: 'Rotate orientation' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('switching device within a category keeps the current orientation', () => {
    mockViewportWidth(390);
    render(createElement(StudioModal)); // opens phone/iphone-13/portrait
    openStudio();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate orientation' }));
    expect(screen.getByRole('button', { name: 'Rotate orientation' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(screen.getByRole('combobox', { name: 'Device' }), { target: { value: 'pixel-8' } });
    expect((screen.getByRole('combobox', { name: 'Device' }) as HTMLSelectElement).value).toBe('pixel-8');
    expect(screen.getByRole('button', { name: 'Rotate orientation' }).getAttribute('aria-pressed')).toBe('true'); // preserved
  });

  it('the orientation toggle is disabled for desktop and enabled for phone/tablet', () => {
    render(createElement(StudioModal));
    openStudio();
    expect((screen.getByRole('button', { name: 'Rotate orientation' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    expect((screen.getByRole('button', { name: 'Rotate orientation' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Tablet' }));
    expect((screen.getByRole('button', { name: 'Rotate orientation' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('no category/device is ever disabled by viewport width — Mobile-UX fix #3 still holds', () => {
    mockViewportWidth(390);
    render(createElement(StudioModal));
    openStudio();

    for (const name of ['Phone', 'Tablet', 'Desktop']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('renders the zoom cluster; at open (Fit) the readout reads "Fit" and zoom-out/Fit are disabled', () => {
    mockViewportWidth(700);
    render(createElement(StudioModal));
    openStudio();

    // The cluster is always present (it replaced the old scaled-to-fit chip).
    const readout = screen.getByRole('button', { name: /Zoom: fit to view/ });
    expect(readout.textContent).toBe('Fit');
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Fit to view' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(false);

    // Switching device keeps the readout on Fit and carries the device dims in
    // the readout's title (no "scaled to fit" suffix — the label is Fit/NN%).
    fireEvent.click(screen.getByRole('button', { name: 'Desktop' })); // laptop 1280×800
    const readout2 = screen.getByRole('button', { name: /Zoom: fit to view/ });
    expect(readout2.textContent).toBe('Fit');
    expect(readout2.getAttribute('title')).toBe('Laptop · 1280×800');
  });

  it('the − / + buttons zoom in 25% grid steps and enable Fit / zoom-out', () => {
    // 700px column-mode: laptop 1280 logical px, 676 available → fitScale ≈ 0.53.
    mockViewportWidth(700);
    render(createElement(StudioModal));
    openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Desktop' }));

    // + snaps effective scale up onto the 25% grid: 0.53 (Fit) → 0.75 (75%).
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: /Zoom 75%/ }).textContent).toBe('75%');
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Fit to view' }) as HTMLButtonElement).disabled).toBe(false);

    // − steps back down to Fit (0.5 grid step would fall below fitScale ≈ 0.53).
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByRole('button', { name: /Zoom: fit to view/ }).textContent).toBe('Fit');
  });

  it('zoomed-in past 100% passes logical dims so the app keeps its true resolution (capture unaffected)', () => {
    // A phone preset that FITS at 1:1 (no logical dims at Fit) still gets
    // logical dims once zoomed past 1:1 — the app renders at true device px and
    // is merely magnified, so html-to-image capture stays at native resolution.
    mockViewportWidth(700);
    render(createElement(StudioModal));
    openStudio(); // iphone-13, fits at 1:1
    const ph = () => document.querySelector('[data-embed-app-context="studio"]') as HTMLElement;
    expect(ph().getAttribute('data-embed-app-logical-width')).toBeNull(); // 1:1, no scaling

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' })); // 100% → 125%
    expect(ph().getAttribute('data-embed-app-logical-width')).toBe('390');
    expect(ph().getAttribute('data-embed-app-logical-height')).toBe('844');
  });

  it('a scaled-down preset passes its true logical dims to the EmbeddedApp placeholder', () => {
    mockViewportWidth(390);
    render(createElement(StudioModal));
    openStudio();

    fireEvent.click(screen.getByRole('button', { name: 'Desktop' }));
    const placeholder = document.querySelector('[data-embed-app-context="studio"]') as HTMLElement;
    expect(placeholder.getAttribute('data-embed-app-logical-width')).toBe('1280');
    expect(placeholder.getAttribute('data-embed-app-logical-height')).toBe('800');
  });

  it('a preset that fits at 1:1 passes no logical dims — byte-for-byte the pre-fix-3 unscaled path', () => {
    render(createElement(StudioModal)); // beforeEach mocks 1800px — Desktop/laptop fits at 1:1
    openStudio();

    const placeholder = document.querySelector('[data-embed-app-context="studio"]') as HTMLElement;
    expect(placeholder.hasAttribute('data-embed-app-logical-width')).toBe(false);
    expect(placeholder.hasAttribute('data-embed-app-logical-height')).toBe(false);
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

  it('the device box (.studio-frame) is sized exactly to each default preset — laptop 1280x800, iphone-13 390x844, ipad-pro-11 834x1194', () => {
    renderStudio();
    openStudio('apps/device-size.html');

    const frame = document.querySelector('.studio-frame') as HTMLElement;
    // Desktop viewport (beforeEach mocks 1800px) defaults to desktop/laptop,
    // which fits at 1:1 (no scaling) per StudioPanel's initial-state logic.
    expect(frame.style.width).toBe('1280px');
    expect(frame.style.height).toBe('800px');

    fireEvent.click(screen.getByRole('button', { name: 'Phone' }));
    expect(frame.style.width).toBe('390px');
    expect(frame.style.height).toBe('844px');

    fireEvent.click(screen.getByRole('button', { name: 'Tablet' }));
    expect(frame.style.width).toBe('834px');
    expect(frame.style.height).toBe('1194px');

    // Feature 1: rotating a tablet/phone preset swaps the footprint too.
    fireEvent.click(screen.getByRole('button', { name: 'Rotate orientation' }));
    expect(frame.style.width).toBe('1194px');
    expect(frame.style.height).toBe('834px');
  });

  it('zero iframe reloads across a full category/device/orientation switch cycle — one html fetch, one iframe node, for the entire journey', async () => {
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

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Phone' })));
    await act(async () =>
      fireEvent.change(screen.getByRole('combobox', { name: 'Device' }), { target: { value: 'pixel-8' } }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Rotate orientation' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Tablet' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Desktop' })));
    await act(async () =>
      fireEvent.change(screen.getByRole('combobox', { name: 'Device' }), { target: { value: 'qhd-27' } }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Phone' })));

    await waitFor(() => {
      expect(screen.getByTitle('apps/no-reload-resize.html')).toBe(iframeAtOpen);
    });
    expect(authFetchMock).toHaveBeenCalledTimes(callsAtOpen); // no new fetches from any switch
  });

  it('a preset that does not fit at 1:1 is still selectable at a narrow viewport and the frame resizes to its SCALED footprint (Mobile-UX fix #3)', () => {
    mockViewportWidth(390);
    renderStudio();
    openStudio('apps/gated-small.html');

    const tablet = screen.getByRole('button', { name: 'Tablet' }) as HTMLButtonElement;
    const desktop = screen.getByRole('button', { name: 'Desktop' }) as HTMLButtonElement;
    expect(tablet.disabled).toBe(false);
    expect(desktop.disabled).toBe(false);

    fireEvent.click(tablet); // no longer disabled — scales down to fit instead of refusing the click
    const frame = document.querySelector('.studio-frame') as HTMLElement;
    // availableW = studioAvailableWidth(390, columnMode=true) = 390 - 24 = 366
    // scale = studioFitScale(834, 1194, 366, Infinity) = 366/834
    // footprint = floor(834*scale) x floor(1194*scale) = 366 x 523
    expect(frame.style.width).toBe('366px');
    expect(frame.style.height).toBe('523px');
  });

  it('a heavily-scaled desktop preset (qhd-27) still resizes the frame correctly in row mode', () => {
    renderStudio(); // beforeEach mocks 1800px — row mode (columnMode=false)
    openStudio('apps/qhd-scale.html');

    fireEvent.change(screen.getByRole('combobox', { name: 'Device' }), { target: { value: 'qhd-27' } });
    const frame = document.querySelector('.studio-frame') as HTMLElement;
    // availableW = studioAvailableWidth(1800, columnMode=false) = 1800 - 390 = 1410
    // scale = studioFitScale(2560, 1440, 1410, Infinity) = 1410/2560 = 0.55078125
    // footprint = floor(2560*scale) x floor(1440*scale) = 1410 x 793
    expect(frame.style.width).toBe('1410px');
    expect(frame.style.height).toBe('793px');
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

    // `theme` has 3 options (<= ENUM_SEGMENTED_MAX) — renders as a segmented
    // group, not a native <select>.
    const themeGroup = screen.getByRole('group', { name: 'theme' });
    const themeButtons = within(themeGroup).getAllByRole('button');
    expect(themeButtons).toHaveLength(3);
    const activeThemeButton = themeButtons.find((b) => b.textContent === 'light');
    expect(activeThemeButton?.getAttribute('aria-pressed')).toBe('true'); // default option is pressed

    // required marker: `.studio-prop-name` renders `{name}` immediately
    // followed by a separate `.studio-prop-required` span — no space.
    expect(document.querySelector('.studio-prop-name')?.textContent).toBe('label*');
    expect(document.querySelector('.studio-prop-required')).toBeTruthy();

    // example affordance: a button, not a static chip.
    expect(screen.getByRole('button', { name: 'Use example' })).toBeTruthy();

    // `onChange` (a function tsType) has no typed control — raw-JSON-only.
    expect(screen.queryByLabelText('onChange')).toBeNull();
    expect(screen.getByLabelText('onChange raw JSON')).toBeTruthy();
  });
});

// --- Phase B, B2: kind-gating -----------------------------------------
// A confirmed presentation kind (markdown|html|react) hides the whole
// Props/Inspector side panel; loading (undefined) and no-manifest (null —
// degrade path or pre-Phase-A prototype) both keep it, matching every
// prototype's existing behavior exactly.
describe('StudioModal — B2: Props/Inspector gated by artifactKind', () => {
  it('hides the Props tab and the whole side panel for a presentation-kind (markdown) artifact, but keeps the stage', async () => {
    mockManifestFetch({ 'schema-version': 1, artifactKind: 'markdown' });
    render(createElement(StudioModal));
    openStudio('apps/notes.html');

    // The stage (device frame) is present immediately regardless of manifest state.
    expect(document.querySelector('.studio-frame')).toBeTruthy();

    await waitFor(() => expect(document.querySelector('.studio-side-panel')).toBeNull());
    expect(document.getElementById('studio-tab-props')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Inspector' })).toBeNull();
  });

  it('hides the side panel for html and react artifactKinds too', async () => {
    mockManifestFetch({ 'schema-version': 1, artifactKind: 'html' });
    render(createElement(StudioModal));
    openStudio('apps/page.html');
    await waitFor(() => expect(document.querySelector('.studio-side-panel')).toBeNull());

    cleanup();
    mockManifestFetch({ 'schema-version': 1, artifactKind: 'react' });
    render(createElement(StudioModal));
    openStudio('apps/widget.html');
    await waitFor(() => expect(document.querySelector('.studio-side-panel')).toBeNull());
  });

  it('keeps the Props tab present for a prototype-kind artifact (explicit artifactKind)', async () => {
    mockManifestFetch({ ...FIXTURE_MANIFEST, artifactKind: 'prototype' });
    render(createElement(StudioModal));
    openStudio('apps/counter.html');

    await screen.findByLabelText('label');
    expect(document.getElementById('studio-tab-props')).toBeTruthy();
    expect(document.querySelector('.studio-side-panel')).toBeTruthy();
  });

  it('keeps the Props tab present for a manifest with no artifactKind at all (pre-Phase-A back-compat)', async () => {
    mockManifestFetch(FIXTURE_MANIFEST); // no artifactKind field
    render(createElement(StudioModal));
    openStudio('apps/counter.html');

    await screen.findByLabelText('label');
    expect(document.getElementById('studio-tab-props')).toBeTruthy();
  });

  it('keeps the Props tab present while the manifest is still loading, and for a null (404) manifest', async () => {
    // Loading: never resolves during this assertion window.
    authFetchMock.mockReset();
    authFetchMock.mockImplementation(() => new Promise(() => {}));
    render(createElement(StudioModal));
    openStudio('apps/counter.html');
    expect(document.getElementById('studio-tab-props')).toBeTruthy();
    expect(document.querySelector('.studio-side-panel')).toBeTruthy();
    cleanup();

    // Null manifest (404 / degrade path).
    mockManifestFetch(null);
    render(createElement(StudioModal));
    openStudio('apps/old-counter.html');
    await screen.findByText(/rebuild with a component entry/);
    expect(document.getElementById('studio-tab-props')).toBeTruthy();
    expect(document.querySelector('.studio-side-panel')).toBeTruthy();
  });
});

// Graphite Inspector redesign, Finding 9: the props dock is a bottom sheet on
// mobile — pure `expanded` state, no AppFrameLayer/bridge needed to exercise
// it, same as the C3 manifest-states block above.
describe('StudioModal — Graphite Inspector: props bottom-sheet peek/expand', () => {
  it('starts collapsed, expands on grip click, and collapses again on a second click', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/counter.html');
    await screen.findByLabelText('label');

    const container = document.querySelector('.studio-side-panel') as HTMLElement;
    expect(container.getAttribute('data-expanded')).toBe('false');

    const grip = screen.getByRole('button', { name: 'Expand props sheet' });
    expect(grip.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(grip);
    expect(container.getAttribute('data-expanded')).toBe('true');
    const gripExpanded = screen.getByRole('button', { name: 'Collapse props sheet' });
    expect(gripExpanded.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(gripExpanded);
    expect(container.getAttribute('data-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Expand props sheet' })).toBeTruthy();
  });

  // Feature 3b: a real Pointer Events drag (not a click) on the grip. Only
  // wired in sheet mode (<720px, studioLayoutMode) — beginDrag() no-ops
  // outside it. offsetHeight is stubbed since jsdom never lays anything out
  // (always 0), which would otherwise collapse collapsedOffset to 0 and make
  // every drag degenerate.
  it('a drag gesture on the grip moves the sheet and snaps per resolveSheetSnap, independent of click semantics', () => {
    mockViewportWidth(390); // sheet mode
    mockManifestFetch(FIXTURE_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/counter.html');

    const sheet = document.querySelector('.studio-side-panel') as HTMLElement;
    Object.defineProperty(sheet, 'offsetHeight', { configurable: true, value: 700 });
    expect(sheet.getAttribute('data-expanded')).toBe('false');
    expect(document.body.classList.contains('studio-sheet-open')).toBe(false);

    const grip = screen.getByRole('button', { name: 'Expand props sheet' });

    // Collapsed start: startOffset = collapsedOffset = 700 - 108 = 592.
    // Drag up (dy = -500, past the 6px tap threshold) → next = max(0, 592 -
    // 500) = 92, well under collapsedOffset/2 (296) → resolves 'expanded'
    // by position regardless of the velocity path (jsdom's synthetic event
    // timestamps can collapse dt to 0, so this assertion deliberately does
    // not depend on the velocity branch).
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 600 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 100 });
    expect(document.body.classList.contains('studio-sheet-open')).toBe(true); // dragging => sheet-open
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 100 });

    expect(sheet.getAttribute('data-expanded')).toBe('true');
    expect(document.body.classList.contains('studio-sheet-open')).toBe(true); // now expanded => still open

    // A drag that ends the gesture suppresses the trailing synthetic click a
    // real touch/mouse interaction would otherwise fire — onGripClick must
    // NOT also toggle it back to collapsed.
    fireEvent.click(grip);
    expect(sheet.getAttribute('data-expanded')).toBe('true');

    // The suppress flag is consumed by that one click — the NEXT plain click
    // (a real tap, no drag) toggles normally.
    fireEvent.click(grip);
    expect(sheet.getAttribute('data-expanded')).toBe('false');
  });

  it('a small movement under the 6px tap threshold does not start a drag — endDrag no-ops and a plain click still toggles', () => {
    mockViewportWidth(390);
    mockManifestFetch(FIXTURE_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/counter.html');

    const sheet = document.querySelector('.studio-side-panel') as HTMLElement;
    Object.defineProperty(sheet, 'offsetHeight', { configurable: true, value: 700 });
    const grip = screen.getByRole('button', { name: 'Expand props sheet' });

    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 600 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 597 }); // 3px, under threshold
    expect(document.body.classList.contains('studio-sheet-open')).toBe(false); // never entered dragging
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 597 });
    expect(sheet.getAttribute('data-expanded')).toBe('false'); // endDrag no-op (drag.moved stayed false)

    fireEvent.click(grip); // the tap itself still works
    expect(sheet.getAttribute('data-expanded')).toBe('true');
  });
});

// Graphite Inspector redesign, Finding 4: small enums (<= ENUM_SEGMENTED_MAX)
// render as a segmented control instead of a native <select>. A local fixture
// manifest (never mutates the shared FIXTURE_MANIFEST) exercises the
// segmented control's aria-pressed state transitions.
const SEGMENTED_ENUM_MANIFEST = {
  'schema-version': 1,
  component: 'Widget',
  props: [
    {
      name: 'size',
      tsType: '"sm" | "md" | "lg"',
      required: false,
      enumOptions: ['sm', 'md', 'lg'],
      default: 'md',
    },
  ],
};

describe('StudioModal — Graphite Inspector: segmented enum control (size)', () => {
  it('renders a 3-segment group with the default option pressed, and pressing a different segment moves the active state', async () => {
    mockManifestFetch(SEGMENTED_ENUM_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/widget.html');

    const group = await screen.findByRole('group', { name: 'size' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(3);

    const mdButton = buttons.find((b) => b.textContent === 'md') as HTMLButtonElement;
    const lgButton = buttons.find((b) => b.textContent === 'lg') as HTMLButtonElement;
    expect(mdButton.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(lgButton);
    expect(lgButton.getAttribute('aria-pressed')).toBe('true');
    expect(mdButton.getAttribute('aria-pressed')).toBe('false');
  });
});

// Graphite Inspector redesign, Finding 4: the segmented/select threshold sits
// at ENUM_SEGMENTED_MAX (4) — a 5-option enum stays a native <select>, a
// 3-option enum (in the same manifest) renders a segmented group.
const ENUM_THRESHOLD_MANIFEST = {
  'schema-version': 1,
  component: 'Scheduler',
  props: [
    { name: 'weekday', tsType: 'string', required: false, enumOptions: ['mon', 'tue', 'wed', 'thu', 'fri'] },
    { name: 'plan', tsType: '"free" | "pro" | "team"', required: false, enumOptions: ['free', 'pro', 'team'] },
  ],
};

describe('StudioModal — Graphite Inspector: enum segmented/select threshold', () => {
  it('a 5-option enum renders a native <select>, not a segmented group', async () => {
    mockManifestFetch(ENUM_THRESHOLD_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/scheduler.html');

    const weekdaySelect = await screen.findByLabelText('weekday');
    expect(weekdaySelect.tagName).toBe('SELECT');
    expect(screen.queryByRole('group', { name: 'weekday' })).toBeNull();
  });

  it('a 3-option enum in the same manifest renders a segmented group, not a <select>', async () => {
    mockManifestFetch(ENUM_THRESHOLD_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/scheduler.html');

    const planGroup = await screen.findByRole('group', { name: 'plan' });
    expect(within(planGroup).getAllByRole('button')).toHaveLength(3);
    expect(document.querySelector('select[aria-label="plan"]')).toBeNull();
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
    fireEvent.click(within(countRow).getByRole('button', { name: 'Edit as JSON' }));
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

describe('StudioModal — E1/E2: side-panel tab strip (Props / Inspector / Console)', () => {
  it('defaults to the Props tab; Inspector is not selected and Console is disabled with a "coming soon" tooltip', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/counter.html');
    await screen.findByLabelText('label');

    // Studio Phase E polish, F11: Console now carries a "soon" pill
    // (`studio-side-tab-soon`, aria-hidden) after its visible label, so a raw
    // textContent equality check against 'Console' alone would break on that
    // markup addition — the accessible-name check via `getByRole(..., {
    // name })` below is the real claim under test (it excludes aria-hidden
    // descendants per the accessible-name algorithm, so the pill can't
    // change Console's a11y identity), same as Props/Inspector already use.
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    // Props now appends an aria-hidden count chip (`.studio-side-tab-count`,
    // "4" for FIXTURE_MANIFEST's 4 props), so raw `.textContent` equality
    // would break on that markup addition — the accessible-name check below
    // excludes aria-hidden descendants, same discipline as the Console pill.
    expect(screen.getByRole('tab', { name: 'Props' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Inspector' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Props' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('false');

    const consoleTab = screen.getByRole('tab', { name: 'Console' }) as HTMLButtonElement;
    expect(consoleTab.disabled).toBe(true);
    expect(consoleTab.getAttribute('title')).toBe('Console — coming soon');
  });

  it('switching to the Inspector tab and back never resets an in-progress prop edit — Props stays mounted, only `hidden` toggles', async () => {
    mockManifestFetch(FIXTURE_MANIFEST);
    render(createElement(StudioModal));
    openStudio('apps/counter.html');
    await screen.findByLabelText('label');

    fireEvent.change(screen.getByLabelText('label'), { target: { value: 'Widgets' } });
    expect((screen.getByLabelText('label') as HTMLInputElement).value).toBe('Widgets');

    fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }));
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe('true');
    // Props' own input is still in the DOM (never unmounted) — just hidden.
    expect((screen.getByLabelText('label') as HTMLInputElement).value).toBe('Widgets');

    fireEvent.click(screen.getByRole('tab', { name: 'Props' }));
    expect((screen.getByLabelText('label') as HTMLInputElement).value).toBe('Widgets');
  });

  it('Inspector tab requests and renders a live outline from the hosted iframe (mounted with AppFrameLayer)', async () => {
    function mockRect(over: Partial<DOMRect>): DOMRect {
      const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
    }
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
    try {
      mockManifestFetch(FIXTURE_MANIFEST);
      render(
        createElement(ArtifactPanelProvider, null, createElement(StudioModal), createElement(AppFrameLayer)),
      );
      openStudio('apps/counter.html');

      const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
      await screen.findByLabelText('label');
      const win = iframe.contentWindow as Window;

      fireEvent.click(screen.getByRole('tab', { name: 'Inspector' }));

      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { data: { type: 'cc-bridge-ready', manifestVersion: 1 }, source: win }),
        );
      });
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: CC_DOM_OUTLINE_RESULT_TYPE,
              truncated: false,
              tree: {
                tag: 'div',
                id: 'app-root',
                className: null,
                textPreview: null,
                childCount: 0,
                children: [],
              },
            },
            source: win,
          }),
        );
      });

      expect(screen.getByText('div#app-root')).toBeTruthy();
    } finally {
      rectSpy.mockRestore();
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
    fireEvent.click(within(countRow).getByRole('button', { name: 'Edit as JSON' }));
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
    const call = postSpy.mock.calls.find((c: unknown[]) => (c[0] as { type?: string })?.type === 'cc-capture-request');
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
