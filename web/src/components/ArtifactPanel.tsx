import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useArtifactPanel, type Artifact } from './ArtifactContext';
import { useIsNarrow } from '../hooks/useIsNarrow';
import { highlightCode, resolveLanguage } from '../lib/highlight';
import { AssistantMessage, UserMessage } from './Messages';

// ── Size cap for highlighting ────────────────────────────────────────────────
const HIGHLIGHT_SIZE_CAP = 256 * 1024; // 256 KB

// ── Sheet drag constants ─────────────────────────────────────────────────────
const SNAP_PEEK = 40; // dvh units
const SNAP_FULL = 90;
const SNAP_DISMISS = 25; // dvh below this → close
const CLAMP_MIN = 15;
const CLAMP_MAX = 95;

// ── Escape html for plain pre rendering ─────────────────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── SkillLegend: renders skill front-matter + markdown body ──────────────────

const _skillMsgComponents = {
  UserMessage,
  AssistantMessage,
  SystemMessage: AssistantMessage,
} as const;

function SkillBodyRenderer({ markdown }: { markdown: string }) {
  const messages = useMemo<ThreadMessageLike[]>(
    () => [
      {
        role: 'assistant',
        id: 'skill-legend-body',
        content: [{ type: 'text', text: markdown }],
        metadata: { custom: { cockpitRole: 'assistant' } },
      } as ThreadMessageLike,
    ],
    [markdown],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    isDisabled: true,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="skill-body-thread">
        <ThreadPrimitive.Viewport className="skill-body-viewport">
          <ThreadPrimitive.Messages components={_skillMsgComponents} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

/** Chip-style value renderer for front-matter entries like tools/model lists. */
function FmValue({ val }: { val: string }) {
  // Split comma- or space-separated lists into chips when the value looks like
  // multiple tokens (e.g. "bash, read, write" or "claude-opus-4").
  const parts = val.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return <span className="skill-fm-val">{val}</span>;
  }
  return (
    <span className="skill-fm-val skill-fm-chips">
      {parts.map((p) => (
        <span key={p} className="skill-fm-chip">{p}</span>
      ))}
    </span>
  );
}

interface SkillLegendProps {
  artifact: Artifact;
}

function SkillLegend({ artifact }: SkillLegendProps) {
  const fm = artifact.skillFrontMatter ?? {};
  const fmEntries = Object.entries(fm);

  return (
    <div className="skill-legend">
      {/* Source badge */}
      {artifact.skillSource ? (
        <div className="skill-legend-source-row">
          <span
            className="skill-legend-source-badge"
            data-source={artifact.skillSource}
            title={artifact.skillSource === 'project' ? 'Project-local skill' : 'User skill'}
          >
            {artifact.skillSource === 'project' ? 'project' : 'user'}
          </span>
        </div>
      ) : null}

      {/* Front-matter */}
      {fmEntries.length > 0 && (
        <dl className="skill-fm">
          {fmEntries.map(([key, val]) => (
            <div key={key} className="skill-fm-row">
              <dt className="skill-fm-key">{key}</dt>
              <FmValue val={val} />
            </div>
          ))}
        </dl>
      )}

      {/* Markdown body */}
      {artifact.content.length > 0 ? (
        <div className="skill-body-wrap">
          <SkillBodyRenderer markdown={artifact.content} />
        </div>
      ) : null}
    </div>
  );
}

// ── ArtifactBody: highlights content of the active artifact ─────────────────

interface ArtifactBodyProps {
  language: string | undefined;
  content: string;
  artifactId: string;
}

function ArtifactBody({ language, content, artifactId }: ArtifactBodyProps) {
  const [html, setHtml] = useState<string | null>(null);
  const tooLarge = content.length > HIGHLIGHT_SIZE_CAP;
  const resolved = resolveLanguage(language);
  const canHighlight = !tooLarge && resolved !== null;

  useEffect(() => {
    if (!canHighlight) {
      setHtml(null);
      return;
    }
    let alive = true;
    setHtml(null);
    highlightCode(language, content)
      .then((res) => {
        if (alive) setHtml(res);
      })
      .catch(() => {
        if (alive) setHtml(null);
      });
    return () => {
      alive = false;
    };
    // Re-run when artifact identity or content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId, content, canHighlight, language]);

  if (tooLarge) {
    return (
      <div className="artifact-body-wrap">
        <p className="artifact-large-note">(large file — shown as plain text)</p>
        <pre className="artifact-pre">
          <code>{content}</code>
        </pre>
      </div>
    );
  }

  if (canHighlight && html !== null) {
    return (
      <div className="artifact-body-wrap">
        <pre className="artifact-pre">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    );
  }

  // Plain fallback — escape manually since we're outside React's renderer
  // for the highlighted path, but for the plain path we just use React children.
  return (
    <div className="artifact-body-wrap">
      <pre className="artifact-pre">
        <code
          className={canHighlight ? 'hljs' : undefined}
          dangerouslySetInnerHTML={{ __html: escapeHtml(content) }}
        />
      </pre>
    </div>
  );
}

// ── ArtifactPanel ────────────────────────────────────────────────────────────

export function ArtifactPanel() {
  const { artifacts, activeId, setActive, close } = useArtifactPanel();
  const narrow = useIsNarrow();
  const panelRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const tabPanelId = useId();

  // Sheet height in dvh (mobile only).
  const [sheetH, setSheetH] = useState(SNAP_PEEK);

  // Drag state (ref so pointer handlers don't capture stale values).
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const activeArtifact = artifacts.find((a) => a.id === activeId) ?? null;
  const isOpen = activeArtifact !== null;

  // Reset sheet height to peek when a new artifact opens.
  useEffect(() => {
    if (isOpen) setSheetH(SNAP_PEEK);
  }, [isOpen]);

  // Focus management: when panel opens, focus the active tab or the panel itself.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = isOpen;
    if (!wasOpen && isOpen) {
      // Short delay so the panel is visible before focusing.
      requestAnimationFrame(() => {
        const firstTab = tablistRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
        if (firstTab) firstTab.focus();
        else panelRef.current?.focus();
      });
    }
    if (wasOpen && !isOpen) {
      // Return focus to chat on close.
      const chat = document.querySelector<HTMLElement>('.thread-root');
      if (chat) {
        if (!chat.hasAttribute('tabindex')) chat.setAttribute('tabindex', '-1');
        chat.focus();
      }
    }
  }, [isOpen]);

  // Esc closes the active tab.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeId) {
        e.preventDefault();
        close(activeId);
      }
    },
    [activeId, close],
  );

  // Roving tabindex: arrow keys navigate between tabs.
  const onTablistKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tabs = Array.from(
        tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
      );
      const focused = document.activeElement as HTMLButtonElement;
      const idx = tabs.indexOf(focused);
      if (idx < 0) return;
      const next =
        e.key === 'ArrowRight'
          ? tabs[(idx + 1) % tabs.length]
          : tabs[(idx - 1 + tabs.length) % tabs.length];
      next?.focus();
      const tabId = next?.dataset.artifactId;
      if (tabId) setActive(tabId);
    },
    [setActive],
  );

  // ── Bottom-sheet drag handlers ────────────────────────────────────────────

  const onDragPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      dragRef.current = { startY: e.clientY, startH: sheetH };
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [sheetH],
  );

  const onDragPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const { startY, startH } = dragRef.current;
      const delta = ((startY - e.clientY) / window.innerHeight) * 100;
      const newH = Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, startH + delta));
      setSheetH(newH);
    },
    [],
  );

  const onDragPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
      setDragging(false);
      // Snap or dismiss.
      setSheetH((h) => {
        if (h < SNAP_DISMISS) {
          if (activeId) close(activeId);
          return SNAP_PEEK;
        }
        const distPeek = Math.abs(h - SNAP_PEEK);
        const distFull = Math.abs(h - SNAP_FULL);
        return distPeek <= distFull ? SNAP_PEEK : SNAP_FULL;
      });
    },
    [activeId, close],
  );

  if (!isOpen) return null;

  // ── Desktop split ─────────────────────────────────────────────────────────
  if (!narrow) {
    return (
      <div
        className="artifact-panel"
        role="region"
        aria-label="Artifact panel"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="artifact-panel-head">
          <div
            role="tablist"
            aria-label="Open artifacts"
            ref={tablistRef}
            className="artifact-tablist"
            onKeyDown={onTablistKeyDown}
          >
            {artifacts.map((a) => {
              const isActive = a.id === activeId;
              const tabId = `artifact-tab-${a.id}`;
              return (
                <div key={a.id} role="presentation" className="artifact-tab-wrap">
                  <button
                    role="tab"
                    id={tabId}
                    className="artifact-tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    data-artifact-id={a.id}
                    onClick={() => setActive(a.id)}
                  >
                    {a.title}
                  </button>
                  <button
                    className="artifact-tab-close"
                    aria-label={`Close ${a.title}`}
                    tabIndex={-1}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      close(a.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
          <button
            className="artifact-close-all"
            aria-label="Close artifact panel"
            onClick={() => activeId && close(activeId)}
          >
            ×
          </button>
        </div>

        {activeArtifact && (
          <div
            role="tabpanel"
            id={`${tabPanelId}-body`}
            aria-labelledby={`artifact-tab-${activeArtifact.id}`}
            className="artifact-panel-body"
          >
            {activeArtifact.kind === 'skill' ? (
              <SkillLegend artifact={activeArtifact} />
            ) : (
              <ArtifactBody
                language={activeArtifact.language}
                content={activeArtifact.content}
                artifactId={activeArtifact.id}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Mobile bottom sheet ───────────────────────────────────────────────────
  return (
    <div
      className="artifact-panel"
      data-mode="sheet"
      style={{ height: `${sheetH}dvh` }}
      data-dragging={dragging ? 'true' : 'false'}
      role="region"
      aria-label="Artifact panel"
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {/* Drag handle */}
      <div
        className="artifact-drag-handle"
        role="separator"
        aria-label="Resize panel"
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
      >
        <div className="artifact-drag-pip" aria-hidden="true" />
      </div>

      <div className="artifact-panel-head">
        <div
          role="tablist"
          aria-label="Open artifacts"
          ref={tablistRef}
          className="artifact-tablist"
          onKeyDown={onTablistKeyDown}
        >
          {artifacts.map((a) => {
            const isActive = a.id === activeId;
            const tabId = `artifact-tab-${a.id}`;
            return (
              <div key={a.id} role="presentation" className="artifact-tab-wrap">
                <button
                  role="tab"
                  id={tabId}
                  className="artifact-tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  data-artifact-id={a.id}
                  onClick={() => setActive(a.id)}
                >
                  {a.title}
                </button>
                <button
                  className="artifact-tab-close"
                  aria-label={`Close ${a.title}`}
                  tabIndex={-1}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    close(a.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="artifact-close-all"
          aria-label="Close artifact panel"
          onClick={() => activeId && close(activeId)}
        >
          ×
        </button>
      </div>

      {activeArtifact && (
        <div
          role="tabpanel"
          id={`${tabPanelId}-body`}
          aria-labelledby={`artifact-tab-${activeArtifact.id}`}
          className="artifact-panel-body"
        >
          <ArtifactBody
            language={activeArtifact.language}
            content={activeArtifact.content}
            artifactId={activeArtifact.id}
          />
        </div>
      )}
    </div>
  );
}
