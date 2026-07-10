// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('StudioModal — device-mode gating', () => {
  it('at 390px, only Mobile is enabled', () => {
    mockViewportWidth(390);
    render(createElement(StudioModal));
    openStudio();

    const mobile = screen.getByRole('button', { name: /Mobile 390/ }) as HTMLButtonElement;
    const ipad = screen.getByRole('button', { name: /iPad 768/ }) as HTMLButtonElement;
    const desktop = screen.getByRole('button', { name: /Desktop 1280/ }) as HTMLButtonElement;
    expect(mobile.disabled).toBe(false);
    expect(ipad.disabled).toBe(true);
    expect(desktop.disabled).toBe(true);
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
    mockViewportWidth(390);
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

  it('zero iframe reloads across a full mode-switch cycle — one fetch, one iframe node, for the entire journey', async () => {
    renderStudio();
    openStudio('apps/no-reload-resize.html');

    const iframeAtOpen = await screen.findByTitle('apps/no-reload-resize.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    for (const label of [/Mobile 390/, /iPad 768/, /Desktop 1280/, /Mobile 390/]) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: label }));
      });
    }

    await waitFor(() => {
      expect(screen.getByTitle('apps/no-reload-resize.html')).toBe(iframeAtOpen);
    });
    expect(authFetchMock).toHaveBeenCalledTimes(1); // still just the initial fetch
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
