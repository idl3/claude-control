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
  kind: 'tool' | 'code' | 'skill';
  title: string;
  language?: string;
  content: string;
  filePath?: string;
  /** Only present when kind === 'skill'. */
  skillFrontMatter?: Record<string, string>;
  /** Only present when kind === 'skill'. */
  skillSource?: 'user' | 'project' | 'plugin';
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
  open: (a: Artifact) => void;
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

function openReducer(state: PanelState, a: Artifact): PanelState {
  const existingIdx = state.artifacts.findIndex((x) => x.id === a.id);
  if (existingIdx >= 0) {
    const next = [state.artifacts[existingIdx], ...state.artifacts.filter((_, i) => i !== existingIdx)];
    return { artifacts: next, activeId: a.id };
  }
  const next = [a, ...state.artifacts];
  return {
    artifacts: next.length > LRU_CAP ? next.slice(0, LRU_CAP) : next,
    activeId: a.id,
  };
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

  const open = useCallback((a: Artifact) => {
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
