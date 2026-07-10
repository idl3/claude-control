import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/** An artifact captured at open time for display in the side panel. */
export interface Artifact {
  id: string;
  kind: 'tool' | 'code' | 'skill' | 'app';
  title: string;
  language?: string;
  content: string;
  filePath?: string;
  /** Only present when kind === 'skill'. */
  skillFrontMatter?: Record<string, string>;
  /** Only present when kind === 'skill'. */
  skillSource?: 'user' | 'project' | 'plugin';
  /** Only present when kind === 'app'. Source url for the embedded micro-app iframe. */
  appUrl?: string;
  /** Only present when kind === 'app'. Reserved box height (px) from the transcript embed. */
  appHeight?: number;
  /**
   * Phase C: pinned artifacts are exempt from LRU eviction (see capUnpinnedOverflow
   * below) — the cap governs the unpinned subset only. `close()` still removes a
   * pinned artifact outright; pinned only protects against the *automatic* LRU cap.
   */
  pinned: boolean;
}

/**
 * `open()`'s input shape. `pinned` is optional here (undefined means "leave
 * the existing pinned state unchanged on re-open, default false on first
 * open") so existing callers (ToolPart, CodeHeader — kind 'tool'/'code') that
 * never think about pinning don't need to change. Callers that DO care about
 * pinning (the C3 pin-to-panel affordance) pass `pinned: true` explicitly,
 * which openReducer always honors, including on re-open of an already-open
 * artifact — that's what makes re-clicking "pin" on an unpinned-but-still-open
 * app artifact re-pin it.
 */
export type OpenArtifactInput = Omit<Artifact, 'pinned'> & { pinned?: boolean };

/** Stable `app-…` id for an app artifact — url-derived, so pinning the same
 * url twice (from transcript or panel) always resolves to the same artifact
 * (no duplicates), matching codeArtifactId's content-addressed convention
 * above for the 'code' kind. */
export function appArtifactId(url: string): string {
  return 'app-' + djb2(url);
}

/**
 * djb2 string hash → base36 short string.
 * Produces a stable id for code artifacts (content-addressed).
 */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(36);
}

/** Produce a stable `code-…` id for a code artifact. */
export function codeArtifactId(language: string | undefined, content: string): string {
  return 'code-' + djb2((language ?? '') + '\n' + content);
}

const LRU_CAP = 8;

export interface ArtifactPanelValue {
  artifacts: Artifact[];
  activeId: string | null;
  open: (a: OpenArtifactInput) => void;
  setActive: (id: string) => void;
  close: (id: string) => void;
}

const ArtifactPanelContext = createContext<ArtifactPanelValue | null>(null);

export function useArtifactPanel(): ArtifactPanelValue {
  const ctx = useContext(ArtifactPanelContext);
  if (!ctx) {
    throw new Error('useArtifactPanel must be used inside <ArtifactPanelProvider>');
  }
  return ctx;
}

interface PanelState {
  artifacts: Artifact[];
  activeId: string | null;
}

/** Shared, never-mutated empty slice — the value read for any session that
 * has never opened an artifact this page load (and has nothing persisted). */
const EMPTY_PANEL_STATE: PanelState = { artifacts: [], activeId: null };

/** Fallback bucket key for a provider mounted with no `sessionId` prop (or
 * `null`, e.g. no session selected yet) — behaves as a single shared slice,
 * matching this module's pre-session-scoping behavior exactly. */
const NO_SESSION_KEY = '__no-session__';

/**
 * LRU-cap the UNPINNED subset only, preserving the MRU-first relative order
 * of everything kept — pinned artifacts are never dropped by this pass,
 * regardless of how many there are or where they sit in the list. `list`
 * must already be MRU-ordered (most-recently-opened/touched first); this is
 * re-run after every open() call (including pin-flag changes on re-open) so
 * the invariant holds at every state transition, not just "eventually, on
 * the next open."
 */
function capUnpinnedOverflow(list: Artifact[]): Artifact[] {
  let unpinnedKept = 0;
  const out: Artifact[] = [];
  for (const item of list) {
    if (item.pinned) {
      out.push(item);
    } else if (unpinnedKept < LRU_CAP) {
      out.push(item);
      unpinnedKept++;
    }
    // else: overflow past the cap — drop the least-recently-used unpinned artifact.
  }
  return out;
}

function openReducer(state: PanelState, a: OpenArtifactInput): PanelState {
  const existingIdx = state.artifacts.findIndex((x) => x.id === a.id);
  if (existingIdx >= 0) {
    const existing = state.artifacts[existingIdx];
    // Re-open keeps the EXISTING artifact object (deliberate — see the
    // pre-Phase-C precedent this preserves: re-opening a code/tool artifact
    // never refreshes its content from the new call). The one field a
    // re-open call CAN change is `pinned`, and only when the caller passes
    // it explicitly — this is what lets the C3 pin affordance re-pin an
    // artifact that's still open but was since unpinned.
    const updated: Artifact =
      a.pinned !== undefined && a.pinned !== existing.pinned
        ? { ...existing, pinned: a.pinned }
        : existing;
    const next = [updated, ...state.artifacts.filter((_, i) => i !== existingIdx)];
    return { artifacts: capUnpinnedOverflow(next), activeId: a.id };
  }
  const created: Artifact = { ...a, pinned: a.pinned ?? false };
  const next = [created, ...state.artifacts];
  return { artifacts: capUnpinnedOverflow(next), activeId: a.id };
}

function closeReducer(state: PanelState, id: string): PanelState {
  const idx = state.artifacts.findIndex((x) => x.id === id);
  if (idx < 0) return state;
  const next = state.artifacts.filter((_, i) => i !== idx);
  let nextActive = state.activeId;
  if (state.activeId === id) {
    if (next.length === 0) {
      nextActive = null;
    } else {
      // Prefer same index position, clamped to the new length.
      const newIdx = Math.min(idx, next.length - 1);
      nextActive = next[newIdx].id;
    }
  }
  return { artifacts: next, activeId: nextActive };
}

// ── Persistence ──────────────────────────────────────────────────────────
//
// Per-session panel state persists across reloads under one localStorage
// key, mirroring App.tsx's loadDrafts/saveDrafts idiom (read via JSON.parse
// wrapped in try/catch, written via JSON.stringify wrapped in try/catch, no
// eviction of entries for sessions that no longer exist — same as drafts).
//
// Only the 'app' kind round-trips. Every Artifact field is technically JSON
// serializable today (no functions/blobs), but 'code'/'skill' artifacts can
// carry arbitrarily large file/markdown bodies — persisting those forever,
// per session, risks silently blowing the ~5-10MB localStorage quota shared
// with drafts and sub-agent mode. Those kinds stay SESSION-MEMORY-ONLY: they
// are still correctly hidden/restored when switching sessions within the
// same page load (they live in the same per-session bucket in memory), they
// just don't survive a hard reload — an acceptable loss since they're cheap
// to re-open from the transcript. 'app' is the pinned-prototype use case
// this feature exists for, so it's what persists.
const SESSION_PANELS_KEY = 'cc:session-panels';

interface PersistedPanelState {
  artifacts: Artifact[];
  activeId: string | null;
}

function isPersistableArtifact(v: unknown): v is Artifact {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    a.kind === 'app' &&
    typeof a.title === 'string' &&
    typeof a.content === 'string' &&
    typeof a.pinned === 'boolean'
  );
}

function isPersistedPanelState(v: unknown): v is PersistedPanelState {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    Array.isArray(p.artifacts) &&
    p.artifacts.every(isPersistableArtifact) &&
    (p.activeId === null || typeof p.activeId === 'string')
  );
}

/**
 * Reduces one session's live state to its persistable slice: 'app'-kind
 * artifacts only, MRU order preserved. Returns null when there is nothing
 * worth persisting (session dropped from storage entirely rather than kept
 * as an empty entry). `activeId` falls back to the first surviving artifact
 * when the live active tab was a non-persisted kind — otherwise rehydrating
 * would restore artifacts with no active tab, which the panel renders as
 * closed (see ArtifactPanel's `isOpen = activeArtifact !== null`).
 */
function toPersisted(state: PanelState): PersistedPanelState | null {
  const appOnly = state.artifacts.filter((a) => a.kind === 'app');
  if (appOnly.length === 0) return null;
  const activeId = appOnly.some((a) => a.id === state.activeId) ? state.activeId : appOnly[0].id;
  return { artifacts: appOnly, activeId };
}

export function loadSessionPanels(): Record<string, PersistedPanelState> {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_PANELS_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, PersistedPanelState> = {};
    for (const [sid, p] of Object.entries(raw as Record<string, unknown>)) {
      if (isPersistedPanelState(p)) out[sid] = p;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSessionPanels(all: Record<string, PersistedPanelState>): void {
  try {
    localStorage.setItem(SESSION_PANELS_KEY, JSON.stringify(all));
  } catch {
    /* ignore storage failures (quota, privacy mode, etc.) */
  }
}

interface ArtifactPanelProviderProps {
  // Optional (not just "always passed at runtime" — App.tsx and every test
  // caller do pass it) so `createElement(ArtifactPanelProvider, { sessionId },
  // child)` typechecks: TS's 3-arg createElement overload validates the
  // `props` argument against the FULL props type before merging in the rest
  // children, and fails if a mandatory `children` key is absent from that
  // object — even though React merges it in from the rest args at runtime.
  children?: ReactNode;
  /**
   * Current session id. Panel state (open artifacts, active tab) is scoped
   * to this id — every op (open/setActive/close) reads and writes only the
   * current session's slice, and switching sessions swaps which slice the
   * hook exposes. `undefined`/`null` (no session selected, or a caller that
   * doesn't care about session-scoping) falls back to one shared, still-
   * persisted-under-its-own-key bucket — this is what keeps every pre-
   * existing test/caller that mounts `<ArtifactPanelProvider>` with no
   * `sessionId` prop behaving exactly as before.
   */
  sessionId?: string | null;
}

/**
 * Owns a per-session artifact list (most-recent-first) and active tab id.
 *
 * open(a)       – dedup by id (move-to-front) or prepend + LRU-cap at 8,
 *                 scoped to the current session.
 * setActive(id) – plain tab selection, does NOT reorder.
 * close(id)     – remove; select neighbour (next at same idx, else prev) or
 *                 null.
 *
 * `sessionId` is a prop, not something the provider is remounted for — the
 * same provider instance stays mounted across session switches (App.tsx
 * mounts it once), so all sessions' state accumulates in one `byId` map and
 * a switch is just "which key of the map does the hook read/write now."
 */
export function ArtifactPanelProvider({ children, sessionId }: ArtifactPanelProviderProps) {
  const key = sessionId ?? NO_SESSION_KEY;

  const [byId, setById] = useState<Record<string, PanelState>>(() => {
    const persisted = loadSessionPanels();
    const initial: Record<string, PanelState> = {};
    for (const [sid, p] of Object.entries(persisted)) {
      // NO_SESSION_KEY is a same-page-load fallback bucket, not a real
      // session — never rehydrate into it (see the matching skip in the
      // persist effect below for why nothing is ever written there either).
      if (sid === NO_SESSION_KEY) continue;
      initial[sid] = { artifacts: p.artifacts, activeId: p.activeId };
    }
    return initial;
  });

  const state = byId[key] ?? EMPTY_PANEL_STATE;

  const open = useCallback(
    (a: OpenArtifactInput) => {
      setById((prev) => ({ ...prev, [key]: openReducer(prev[key] ?? EMPTY_PANEL_STATE, a) }));
    },
    [key],
  );

  const setActive = useCallback(
    (id: string) => {
      setById((prev) => {
        const cur = prev[key] ?? EMPTY_PANEL_STATE;
        return { ...prev, [key]: { ...cur, activeId: id } };
      });
    },
    [key],
  );

  const close = useCallback(
    (id: string) => {
      setById((prev) => ({ ...prev, [key]: closeReducer(prev[key] ?? EMPTY_PANEL_STATE, id) }));
    },
    [key],
  );

  // Persist on every state change across every session, not just the
  // current one — a background session's app tabs (opened earlier, now
  // switched away from) must still survive a reload. NO_SESSION_KEY is
  // deliberately excluded: it's a same-page-load fallback for "no session
  // selected yet" (and for the many pre-existing tests/callers that mount
  // `<ArtifactPanelProvider>` with no `sessionId` prop at all) — persisting
  // it would let unrelated no-session mounts silently accumulate and
  // rehydrate each other's artifacts across page loads (or, in a real
  // browser/CI localStorage rather than this repo's broken-by-default dev
  // shadow, across supposedly-isolated test runs in the same file).
  useEffect(() => {
    const out: Record<string, PersistedPanelState> = {};
    for (const [sid, s] of Object.entries(byId)) {
      if (sid === NO_SESSION_KEY) continue;
      const p = toPersisted(s);
      if (p) out[sid] = p;
    }
    saveSessionPanels(out);
  }, [byId]);

  const value = useMemo<ArtifactPanelValue>(
    () => ({
      artifacts: state.artifacts,
      activeId: state.activeId,
      open,
      setActive,
      close,
    }),
    [state, open, setActive, close],
  );

  return (
    <ArtifactPanelContext.Provider value={value}>
      {children}
    </ArtifactPanelContext.Provider>
  );
}
