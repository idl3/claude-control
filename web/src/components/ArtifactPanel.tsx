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
import { EmbeddedApp } from './EmbeddedApp';
import { APP_HEIGHT_DEFAULT } from '../lib/embeds';
import { authFetch } from '../lib/api';
import { appNameFromUrl, flatAppUrl, versionedAppUrl, type AppVersionListing } from '../lib/appVersion';
import { XIcon } from './icons';

// ── Size cap for highlighting ────────────────────────────────────────────────
const HIGHLIGHT_SIZE_CAP = 256 * 1024; // 256 KB

// Phase C, C2: cap on simultaneously-live (fetched, real-iframe) pinned app
// artifacts in the panel — an unbounded pin count must not mean an unbounded
// iframe count. See selectLiveAppIds below.
const LIVE_APP_CAP = 6;

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
            title={
              artifact.skillSource === 'project'
                ? 'Project-local skill'
                : artifact.skillSource === 'plugin'
                  ? 'Plugin skill'
                  : 'User skill'
            }
          >
            {artifact.skillSource}
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

// ── App stack: always-mounted panel bodies for every open 'app' artifact ────

/**
 * Which pinned app artifacts get a real, fetched iframe this render vs. a
 * "suspended — tap to wake" placeholder. `mruAppIds` is already MRU-first
 * (ArtifactContext's own ordering) — the first `cap` are live by default,
 * covering the common case (a handful of pinned apps, all recently touched)
 * with zero clicks. `wokenIds` adds anything the user explicitly tapped to
 * wake, regardless of its MRU position, so a wake survives its app being
 * pushed past the cap by newer opens.
 *
 * Deliberately does NOT also live-promote the currently active tab: if it
 * did, switching to a suspended tab would silently fetch it, defeating the
 * whole point of "tap to wake" as a user-initiated, visible gesture (and
 * making the cap easy to blow through by just clicking across tabs).
 */
export function selectLiveAppIds(mruAppIds: string[], wokenIds: Set<string>, cap = LIVE_APP_CAP): Set<string> {
  const live = new Set(mruAppIds.slice(0, cap));
  for (const id of wokenIds) {
    if (mruAppIds.includes(id)) live.add(id);
  }
  return live;
}

// ── D4: per-tab version pin / track-latest ──────────────────────────────────
// Each app TAB (not each app name) remembers its own mode: either "latest"
// (default — hot-reloads on every media-app-changed frame, via D2's
// trackLatest) or "pinned" to one concrete version's filename (immune to
// rebuild frames — see effectiveAppUrl). Keyed by artifact id, not app name,
// so two tabs open on the same app can independently pin different versions.

export const APP_TAB_VERSION_PREFIX = 'cc_app_tab_version:';

export type AppTabVersionMode = { kind: 'latest' } | { kind: 'pinned'; filename: string };

export function loadAppTabVersion(artifactId: string): AppTabVersionMode {
  try {
    const raw = localStorage.getItem(APP_TAB_VERSION_PREFIX + artifactId);
    if (!raw) return { kind: 'latest' };
    const parsed = JSON.parse(raw);
    if (parsed && parsed.kind === 'pinned' && typeof parsed.filename === 'string') return parsed;
    return { kind: 'latest' };
  } catch {
    return { kind: 'latest' };
  }
}

export function saveAppTabVersion(artifactId: string, mode: AppTabVersionMode): void {
  try {
    localStorage.setItem(APP_TAB_VERSION_PREFIX + artifactId, JSON.stringify(mode));
  } catch {
    /* localStorage unavailable/full — the pin just doesn't survive reload. */
  }
}

/**
 * The url/trackLatest EmbeddedApp actually renders for one app artifact,
 * given its persisted/overridden mode. "latest" is the existing D2 behavior
 * unchanged (flat url, trackLatest on). "pinned" resolves to a concrete
 * versioned url with trackLatest off, so D2's hot-reload gate never fires
 * for this tab — exported for direct unit testing (mirrors selectLiveAppIds).
 */
export function effectiveAppUrl(a: Artifact, mode: AppTabVersionMode): { url: string; trackLatest: boolean } {
  if (mode.kind === 'pinned') {
    const name = appNameFromUrl(a.appUrl ?? '');
    if (name) return { url: versionedAppUrl(name, mode.filename), trackLatest: false };
  }
  return { url: a.appUrl ?? '', trackLatest: true };
}

/**
 * Version dropdown for the active app tab's header. Deliberately does NOT
 * probe the D3 listing endpoint just because a tab becomes active — that
 * would fire one extra authFetch per tab switch across every open app tab,
 * for apps that mostly have no other versions at all. Instead it fetches
 * lazily on first focus (a real user gesture, not a re-render), then caches
 * per app name for the rest of this mount. ponytail: a non-versioned app's
 * control briefly shows before that first fetch resolves ("Latest" only,
 * same as today) — upgrade to an eager probe only if that flash of an inert
 * control ever bothers anyone in practice.
 */
function AppVersionPicker({
  name,
  mode,
  onChange,
}: {
  name: string;
  mode: AppTabVersionMode;
  onChange: (mode: AppTabVersionMode) => void;
}) {
  const [listing, setListing] = useState<AppVersionListing | null>(null);
  const fetchedForRef = useRef<string | null>(null);

  const ensureFetched = useCallback(() => {
    if (fetchedForRef.current === name) return;
    fetchedForRef.current = name;
    // M1 (Codex review): stale-response guard. `fetchedForRef.current` is
    // reassigned synchronously by the NEXT ensureFetched call (a tab switch,
    // or the rebuild-refresh effect's reset+re-fetch below) before this
    // promise can resolve — so if it no longer equals what we requested by
    // the time we land, a newer request has since superseded this one and
    // the response must not overwrite `listing` with stale/wrong-app data.
    const requestedName = name;
    authFetch(`/api/media-apps/${encodeURIComponent(name)}/versions`)
      .then((res) => (res.ok ? (res.json() as Promise<AppVersionListing>) : null))
      .then((data) => {
        if (fetchedForRef.current !== requestedName) return;
        setListing(data);
      })
      .catch(() => {
        if (fetchedForRef.current !== requestedName) return;
        setListing(null);
      });
  }, [name]);

  useEffect(() => {
    // Reset when the active tab's app name changes.
    fetchedForRef.current = null;
    setListing(null);
  }, [name]);

  useEffect(() => {
    // Keep the dropdown fresh after a rebuild, but only once it's already
    // been opened this session — a rebuild frame must never be what
    // triggers the FIRST probe for an app nobody has checked yet.
    function onChanged(ev: Event) {
      const frame = (ev as CustomEvent<{ path?: string }>).detail;
      if (fetchedForRef.current === name && frame?.path === flatAppUrl(name)) {
        fetchedForRef.current = null;
        ensureFetched();
      }
    }
    window.addEventListener('cockpit:media-app-changed', onChanged);
    return () => window.removeEventListener('cockpit:media-app-changed', onChanged);
  }, [name, ensureFetched]);

  const versions = listing?.versions ?? [];
  const value = mode.kind === 'pinned' ? mode.filename : 'latest';
  // A persisted pin from a prior session, shown before the listing (re-)loads.
  const pinnedOptionMissing = mode.kind === 'pinned' && !versions.some((v) => v.filename === mode.filename);

  return (
    <select
      className="app-version-picker"
      aria-label="App version"
      value={value}
      onFocus={ensureFetched}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === 'latest' ? { kind: 'latest' } : { kind: 'pinned', filename: v });
      }}
    >
      <option value="latest">Latest (auto-reload)</option>
      {pinnedOptionMissing && <option value={mode.filename}>{mode.filename}</option>}
      {versions.map((v) => (
        <option key={v.filename} value={v.filename}>
          {v.label ? `${v.version} · ${v.label}` : v.version}
        </option>
      ))}
    </select>
  );
}

interface ArtifactAppStackProps {
  appArtifacts: Artifact[];
  activeId: string | null;
  liveAppIds: Set<string>;
  everLiveIds: Set<string>;
  onWake: (id: string) => void;
  versionModeFor: (artifactId: string) => AppTabVersionMode;
}

/**
 * Renders EVERY open app artifact's placeholder simultaneously (visibility
 * toggled per-slot, never display:none — see EmbeddedApp's doc comment for
 * why), stacked via CSS absolute positioning over `.artifact-panel-body` so
 * tab switches never tear a placeholder down (that would reload the iframe).
 * A no-op (renders nothing) when there are no open app artifacts.
 */
function ArtifactAppStack({
  appArtifacts,
  activeId,
  liveAppIds,
  everLiveIds,
  onWake,
  versionModeFor,
}: ArtifactAppStackProps) {
  if (appArtifacts.length === 0) return null;
  return (
    <div className="artifact-app-stack">
      {appArtifacts.map((a) => {
        const isActiveTab = a.id === activeId;
        const { url, trackLatest } = effectiveAppUrl(a, versionModeFor(a.id));
        return (
          <div key={a.id} className="artifact-app-slot" data-active={isActiveTab ? 'true' : 'false'}>
            {liveAppIds.has(a.id) ? (
              <EmbeddedApp
                url={url}
                height={a.appHeight ?? APP_HEIGHT_DEFAULT}
                context="panel"
                hidden={!isActiveTab}
                trackLatest={trackLatest}
              />
            ) : (
              <>
                <button type="button" className="artifact-app-suspended" onClick={() => onWake(a.id)}>
                  {/* CP3-C FIX 2: distinguish "was live, state discarded on cap
                      demotion" from "never loaded" — honest about whether
                      waking re-fetches fresh vs. re-fetches lost state. */}
                  {everLiveIds.has(a.id) ? 'suspended — tap to reload' : 'tap to open'}
                </button>
                {/* H2 (Codex review): a marker-only EmbeddedApp — never
                    fetches or hosts anything (see EmbeddedApp.tsx's doc
                    comment) — tells AppFrameLayer's host arbitration this
                    url is suspended in the panel right now, so it can bar
                    hosting everywhere (including a still-mounted transcript
                    placeholder) instead of silently falling back to hosting
                    the live iframe there and defeating LIVE_APP_CAP. */}
                <EmbeddedApp
                  url={url}
                  height={a.appHeight ?? APP_HEIGHT_DEFAULT}
                  context="panel"
                  suspended
                />
              </>
            )}
          </div>
        );
      })}
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

  // Phase C, C2: app artifacts get an always-mounted placeholder stack (see
  // ArtifactAppStack) instead of the plain code/skill body — kept separate
  // from `artifacts` so its identity is stable across renders that don't
  // touch app artifacts at all.
  const appArtifacts = useMemo(() => artifacts.filter((a) => a.kind === 'app'), [artifacts]);
  const [wokenIds, setWokenIds] = useState<Set<string>>(new Set());
  const onWakeApp = useCallback((id: string) => {
    setWokenIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const liveAppIds = useMemo(
    () => selectLiveAppIds(appArtifacts.map((a) => a.id), wokenIds),
    [appArtifacts, wokenIds],
  );
  // CP3-C FIX 2: accumulate every app id that has EVER been live, so a
  // cap-demoted-then-suspended app can tell the user their state was
  // discarded ("tap to reload") rather than lying that it's a fresh,
  // never-opened app ("tap to open"). Accumulate-only (mirrors wokenIds'
  // pattern) but keyed off the computed `liveAppIds`, not a user click —
  // needs its own effect since it must react to demotion/promotion, not
  // just onWake.
  const [everLiveIds, setEverLiveIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setEverLiveIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of liveAppIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [liveAppIds]);

  // M2 (Codex review): prune both accumulate-only sets to the ids still
  // present in appArtifacts. Bug: wokenIds/everLiveIds only ever grew, so
  // once an app tab closed (its id dropped out of appArtifacts) the ids
  // stayed in both sets forever. Since appArtifactId derives deterministically
  // from the app's url (see ArtifactContext), re-pinning the SAME app later
  // reused the same id and silently rehydrated its stale membership — the
  // freshly re-pinned tab would auto-count as "already woken" (skipping the
  // cap's wake gesture) and misreport "suspended — tap to reload" instead of
  // the honest "tap to open" for what is, from the user's perspective, a
  // brand new session. Pruning on every appArtifacts change means a close
  // followed by a re-pin always requires a fresh wake gesture again.
  useEffect(() => {
    const openIds = new Set(appArtifacts.map((a) => a.id));
    setWokenIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (openIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    setEverLiveIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (openIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [appArtifacts]);

  // D4: per-tab version pin/track-latest. `versionOverrides` shadows
  // localStorage for the current mount only (avoids a read-on-every-render);
  // loadAppTabVersion is the fallback for any artifact id not yet touched
  // this session.
  const [versionOverrides, setVersionOverrides] = useState<Record<string, AppTabVersionMode>>({});
  const versionModeFor = useCallback(
    (id: string): AppTabVersionMode => versionOverrides[id] ?? loadAppTabVersion(id),
    [versionOverrides],
  );
  const setVersionMode = useCallback((id: string, mode: AppTabVersionMode) => {
    saveAppTabVersion(id, mode);
    setVersionOverrides((prev) => ({ ...prev, [id]: mode }));
  }, []);
  const activeAppName = activeArtifact?.kind === 'app' ? appNameFromUrl(activeArtifact.appUrl ?? '') : null;
  const activeMode = activeArtifact ? versionModeFor(activeArtifact.id) : { kind: 'latest' as const };

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
                    <XIcon size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          {activeAppName && (
            <AppVersionPicker
              name={activeAppName}
              mode={activeMode}
              onChange={(m) => activeArtifact && setVersionMode(activeArtifact.id, m)}
            />
          )}
          <button
            className="artifact-close-all"
            aria-label="Close artifact panel"
            onClick={() => activeId && close(activeId)}
          >
            <XIcon size={16} />
          </button>
        </div>

        {activeArtifact && (
          <div
            role="tabpanel"
            id={`${tabPanelId}-body`}
            aria-labelledby={`artifact-tab-${activeArtifact.id}`}
            className="artifact-panel-body"
          >
            <ArtifactAppStack
              appArtifacts={appArtifacts}
              activeId={activeId}
              liveAppIds={liveAppIds}
              everLiveIds={everLiveIds}
              onWake={onWakeApp}
              versionModeFor={versionModeFor}
            />
            {activeArtifact.kind === 'app' ? null : activeArtifact.kind === 'skill' ? (
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
                  <XIcon size={13} />
                </button>
              </div>
            );
          })}
        </div>
        {activeAppName && (
          <AppVersionPicker
            name={activeAppName}
            mode={activeMode}
            onChange={(m) => activeArtifact && setVersionMode(activeArtifact.id, m)}
          />
        )}
        <button
          className="artifact-close-all"
          aria-label="Close artifact panel"
          onClick={() => activeId && close(activeId)}
        >
          <XIcon size={16} />
        </button>
      </div>

      {activeArtifact && (
        <div
          role="tabpanel"
          id={`${tabPanelId}-body`}
          aria-labelledby={`artifact-tab-${activeArtifact.id}`}
          className="artifact-panel-body"
        >
          <ArtifactAppStack
            appArtifacts={appArtifacts}
            activeId={activeId}
            liveAppIds={liveAppIds}
            everLiveIds={everLiveIds}
            onWake={onWakeApp}
            versionModeFor={versionModeFor}
          />
          {activeArtifact.kind !== 'app' && (
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
