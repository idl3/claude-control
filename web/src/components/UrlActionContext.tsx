import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../lib/terminalClipboard';
import { computeMenuPosition, framingFallbackState, type RectLike } from '../lib/linkify';
import { isNativeShell, openExternal, openInAppWindow } from '../lib/nativeShell';
import { XIcon } from './icons';

/**
 * Shared tap-anchored popover + inline-preview overlay for every clickable
 * URL in the transcript (see UrlLink.tsx). Mirrors ArtifactContext.tsx's
 * provider shape: a context object exposing imperative `show*` actions, with
 * the actual popover/overlay UI portaled to `document.body` from inside the
 * provider itself so callers (UrlLink instances scattered arbitrarily deep
 * in the message tree) never need to think about stacking context or DOM
 * placement — they just call `showMenu`/`showInline`.
 */

export interface UrlActionsValue {
  /** Opens the 3-item action menu, anchored to `anchorEl`'s current rect. */
  showMenu: (url: string, anchorEl: HTMLElement) => void;
  /** Opens the inline iframe-preview overlay directly (used by the menu's
   * "Open inline" action, but exposed here in case another caller ever
   * wants to skip the menu). */
  showInline: (url: string) => void;
}

const UrlActionsContext = createContext<UrlActionsValue | null>(null);

export function useUrlActions(): UrlActionsValue {
  const ctx = useContext(UrlActionsContext);
  if (!ctx) {
    throw new Error('useUrlActions must be used inside <UrlActionProvider>');
  }
  return ctx;
}

interface MenuState {
  url: string;
  rect: RectLike;
}

interface InlineState {
  url: string;
}

export function UrlActionProvider({ children }: { children?: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [inline, setInline] = useState<InlineState | null>(null);

  const showMenu = useCallback((url: string, anchorEl: HTMLElement) => {
    const r = anchorEl.getBoundingClientRect();
    setMenu({ url, rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const showInline = useCallback((url: string) => {
    // Desktop shell: the iframe overlay below is a dead end — most sites send
    // X-Frame-Options/CSP frame-ancestors and refuse to be framed, so "Open
    // inline" showed the refused-to-frame fallback for the URLs people
    // actually click (GitHub, docs, dashboards). The shell's native "browser"
    // child window is a TOP-LEVEL browsing context those headers don't apply
    // to — open there instead. Browsers keep the iframe overlay (framing
    // fallback and all): no native window exists to offer.
    if (isNativeShell) {
      openInAppWindow(url);
      return;
    }
    setInline({ url });
  }, []);

  const closeInline = useCallback(() => setInline(null), []);

  const value = useMemo<UrlActionsValue>(() => ({ showMenu, showInline }), [showMenu, showInline]);

  return (
    <UrlActionsContext.Provider value={value}>
      {children}
      {menu ? (
        <UrlActionMenu
          url={menu.url}
          rect={menu.rect}
          onClose={closeMenu}
          onOpenInline={() => {
            closeMenu();
            showInline(menu.url);
          }}
        />
      ) : null}
      {inline ? <UrlInlineOverlay url={inline.url} onClose={closeInline} /> : null}
    </UrlActionsContext.Provider>
  );
}

// ── Action menu ────────────────────────────────────────────────────────────

// A reasonable estimate used for the very first layout pass (before the
// menu's real rendered size is known) — corrected against the actual
// getBoundingClientRect in the layout effect below, so this only affects
// whether there's a visible first-frame jump, never correctness.
const MENU_SIZE_ESTIMATE = { width: 200, height: 124 };

function UrlActionMenu({
  url,
  rect,
  onClose,
  onOpenInline,
}: {
  url: string;
  rect: RectLike;
  onClose: () => void;
  onOpenInline: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState(() =>
    computeMenuPosition(rect, MENU_SIZE_ESTIMATE, { width: window.innerWidth, height: window.innerHeight }),
  );
  const [copied, setCopied] = useState(false);

  // Re-measure against the actual rendered menu box once mounted.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const size = el.getBoundingClientRect();
    setPos(
      computeMenuPosition(rect, { width: size.width, height: size.height }, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
    // Only re-run when the anchor itself changes — re-measuring on every
    // render (e.g. the `copied` state flip below) would fight the menu's
    // own size, which never actually changes after the "Copy" label flips.
  }, [rect]);

  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  const handleNewTab = () => {
    // Browser: a plain new tab. Desktop shell: the native "browser" child
    // window (window.open is a silent WKWebView no-op there).
    openExternal(url);
    onClose();
  };

  const handleCopy = () => {
    copyText(url);
    setCopied(true);
    window.setTimeout(onClose, 1200);
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${url}`}
      className="cc-url-menu"
      style={{ top: pos.top, left: pos.left }}
    >
      <button ref={firstItemRef} type="button" role="menuitem" className="cc-url-menu-item" onClick={onOpenInline}>
        Open inline
      </button>
      <button type="button" role="menuitem" className="cc-url-menu-item" onClick={handleNewTab}>
        Open in new tab
      </button>
      <button type="button" role="menuitem" className="cc-url-menu-item" onClick={handleCopy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>,
    document.body,
  );
}

// ── Inline preview overlay ──────────────────────────────────────────────────

// How long we give the iframe's `load` event before treating the site as
// having refused to be framed (see framingFallbackState's doc comment in
// lib/linkify.ts for why this is a heuristic, not a certainty).
const FRAMING_TIMEOUT_MS = 2500;

function UrlInlineOverlay({ url, onClose }: { url: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [loadFired, setLoadFired] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), FRAMING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [url]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const state = framingFallbackState({ loadFired, timedOut });

  return createPortal(
    <div
      className="cc-url-inline-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Inline preview: ${url}`}
      ref={dialogRef}
      tabIndex={-1}
      onClick={onClose}
    >
      <div className="cc-url-inline-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cc-url-inline-header">
          <span className="cc-url-inline-url" title={url}>
            {url}
          </span>
          <a className="cc-url-inline-newtab" href={url} target="_blank" rel="noopener noreferrer">
            Open in new tab
          </a>
          <button type="button" className="cc-url-inline-close" aria-label="Close" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="cc-url-inline-body">
          <iframe
            src={url}
            className="cc-url-inline-iframe"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            title="Inline preview"
            onLoad={() => setLoadFired(true)}
          />
          {state === 'blocked' ? (
            <div className="cc-url-inline-blocked-card" role="status">
              <p>This site blocked embedding.</p>
              <a href={url} target="_blank" rel="noopener noreferrer">
                Open in new tab
              </a>
            </div>
          ) : null}
        </div>
        {/* Persistent correctness backstop — always visible regardless of the
            onload/timeout heuristic above, since XFO refusal isn't reliably
            auto-detectable cross-origin (a blocked frame can render blank
            without ever firing a distinguishable error). */}
        <div className="cc-url-inline-fallback-bar">
          If the page is blank, it blocked embedding —{' '}
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open in new tab
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
