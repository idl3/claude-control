import {
  createContext,
  useCallback,
  useContext,
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

interface ArtifactPanelProviderProps {
  children: ReactNode;
}

/**
 * Owns the artifact list (most-recent-first) and the active tab id.
 *
 * open(a)       – dedup by id (move-to-front) or prepend + LRU-cap at 8.
 * setActive(id) – plain tab selection, does NOT reorder.
 * close(id)     – remove; select neighbour (next at same idx, else prev) or null.
 */
export function ArtifactPanelProvider({ children }: ArtifactPanelProviderProps) {
  const [state, setState] = useState<PanelState>({ artifacts: [], activeId: null });

  const open = useCallback((a: OpenArtifactInput) => {
    setState((prev) => openReducer(prev, a));
  }, []);

  const setActive = useCallback((id: string) => {
    setState((prev) => ({ ...prev, activeId: id }));
  }, []);

  const close = useCallback((id: string) => {
    setState((prev) => closeReducer(prev, id));
  }, []);

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
