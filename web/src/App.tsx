import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useCockpit } from './hooks/useCockpit';
import { usePushNotifications } from './hooks/usePushNotifications';
import { usePullToRefresh, PTR_THRESHOLD } from './hooks/usePullToRefresh';
import { convertMessages } from './lib/convert';
import { attachmentPath, createCockpitAttachmentAdapter } from './lib/attachments';
import { renameSession } from './lib/api';
import { SessionRail } from './components/SessionRail';
import { ResourceHud } from './components/ResourceHud';
import { Thread } from './components/Thread';
import { LiveThinkingContext } from './components/ThinkingContext';
import { ArtifactPanelProvider } from './components/ArtifactContext';
import { ArtifactPanel } from './components/ArtifactPanel';
import { LivePane } from './components/LivePane';
import { TerminalPane } from './components/TerminalPane';
import { Composer } from './components/Composer';
import { ShellContext } from './components/ShellContext';
import { AskModal } from './components/AskModal';
import { ToastView, type ToastMessage } from './components/Toast';
import { UpdateBanner } from './components/UpdateBanner';
import { ConfigModal } from './components/ConfigModal';
import { NewSessionForm } from './components/NewSessionForm';
import { TerminalPanel } from './components/TerminalPanel';
import { TokenGate } from './components/TokenGate';
import { PinModal } from './components/PinModal';
import { PromptModal } from './components/PromptModal';
import { SubAgentPanel } from './components/SubAgentPanel';
import type { Msg, ServerMessage } from './lib/types';
import { useIsNarrow } from './hooks/useIsNarrow';
import gsap, { prefersReducedMotion } from './lib/anim';

// Concatenate a transcript message's text blocks (to match a real user echo
// against a queued send).
function msgText(msg: Msg): string {
  return (msg.blocks ?? [])
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join(' ');
}

// How long a queued send waits for its transcript echo before we stop showing it.
// Keep an unconfirmed optimistic send visible for a long time: the user must
// ALWAYS see what they sent. The real transcript echo normally reconciles it
// away within seconds, but on a busy session the echo can lag minutes — the
// bubble must bridge that gap rather than vanish. This is only a last-resort
// cleanup for sends whose echo never arrives at all.
const PENDING_SEND_TTL_MS = 1_800_000;

// Per-session composer drafts (staged prompt text), persisted across reloads.
const DRAFTS_KEY = 'cc_drafts';
function loadDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* ignore storage failures */
  }
}

// How many trailing messages to render initially. assistant-ui (0.14.14) has no
// thread virtualizer, so it renders every message in the runtime's list; with the
// 500-message server cap, each potentially large, mounting all of them can jank
// on mobile. We feed the runtime only the last N converted messages and expose a
// "load earlier" affordance that reveals older ones in chunks. (Virtualization
// was evaluated and deferred — see the note in the change summary.)
const INITIAL_VISIBLE = 150;
const LOAD_EARLIER_STEP = 150;

// Extract the plain text the user typed in the composer.
function appendMessageText(message: AppendMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// The authenticated app. Mounted ONLY after TokenGate confirms access, so the
// WebSocket (opened by useCockpit on mount) never connects with a bad/absent
// token before the gate has cleared.
function AppInner() {
  const cockpit = useCockpit();
  const push = usePushNotifications();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback(
    (text: string, kind: 'ok' | 'error' | '' = '') => {
      setToast({ id: ++toastSeq.current, text, kind });
    },
    [],
  );

  // Surface WS ack errors / answer confirmations as toasts.
  useEffect(() => {
    const onAck = (e: Event) => {
      const ack = (e as CustomEvent<Extract<ServerMessage, { type: 'ack' }>>)
        .detail;
      if (!ack.ok) showToast(`${ack.op} failed: ${ack.error ?? 'error'}`, 'error');
      else if (ack.op === 'answer') showToast('Answer sent →', 'ok');
    };
    window.addEventListener('cockpit:ack', onAck);
    return () => window.removeEventListener('cockpit:ack', onAck);
  }, [showToast]);

  // Attachment adapter: uploads files on send and stashes the absolute server
  // path on each attachment (see lib/attachments). Memoized so the runtime
  // sees a stable adapter identity.
  const attachmentAdapter = useMemo(
    () => createCockpitAttachmentAdapter(showToast),
    [showToast],
  );

  // Shell ops for the composer's terminal mode (>_), provided via context so the
  // Composer (inside Thread, and standalone in the live-pane branch) can reach
  // the server-owned shell pane without prop-drilling.
  const shellApi = useMemo(
    () => ({
      output: cockpit.shellOutput,
      run: cockpit.sendShellInput,
      text: cockpit.sendShellText,
      key: cockpit.sendShellKey,
      poll: cockpit.requestShellCapture,
      clear: cockpit.clearShellOutput,
    }),
    [
      cockpit.shellOutput,
      cockpit.sendShellInput,
      cockpit.sendShellText,
      cockpit.sendShellKey,
      cockpit.requestShellCapture,
      cockpit.clearShellOutput,
    ],
  );

  // Composer send -> tmux reply. We do NOT optimistically append; Claude's
  // echo arrives via the WS transcript stream. The outgoing text is the user's
  // typed text plus each attachment's uploaded absolute path (paths after the
  // text, space-separated) — the adapter already uploaded them by send time.
  // Optimistic send echo: we don't get our own message back until Claude writes
  // it into the transcript (which can lag), so without this the composer feels
  // dead after sending. On send we immediately show the typed text as a user
  // bubble + a "working…" assistant indicator, cleared once real transcript
  // activity arrives (or the session changes / a safety timeout fires).
  // Queued / in-flight sends, FIFO. A send may sit in tmux's input queue while
  // Claude is busy, and the echo only appears later. Each entry persists as a
  // user bubble until ITS OWN echo (matched by text) lands in the transcript —
  // so unrelated chunks arriving in the meantime no longer make it vanish.
  // `text` = what was sent (for matching); `label` = what we display.
  const [pendingSends, setPendingSends] = useState<
    { key: number; sessionId: string; text: string; label: string; at: number }[]
  >([]);
  const sendSeq = useRef(0);
  // Working indicator after answering an AskUserQuestion — the answer is sent as
  // keystrokes (no transcript echo to match), so it clears on the next activity.
  const [answering, setAnswering] = useState<{
    sessionId: string;
    baseCount: number;
  } | null>(null);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const typed = appendMessageText(message).trim();
      const paths = (message.attachments ?? [])
        .map((att) => attachmentPath(att))
        .filter((p): p is string => !!p);
      const text = [typed, ...paths].filter(Boolean).join(' ');
      if (!text) return;
      const ok = cockpit.sendReply(text);
      showToast(ok ? 'Sent →' : 'Not connected — reconnecting…', ok ? 'ok' : 'error');
      if (ok && cockpit.selectedId) {
        const label =
          typed || (paths.length ? `📎 ${paths.length} attachment(s)` : text);
        setPendingSends((q) => [
          ...q,
          {
            key: ++sendSeq.current,
            sessionId: cockpit.selectedId as string,
            text,
            label,
            at: Date.now(),
          },
        ]);
      }
    },
    [cockpit, showToast],
  );

  // Reconcile queued sends: as new user messages arrive for the selected
  // session, drop the oldest queued send whose sent text matches (so multiple
  // queued messages clear one-by-one, in order). Per-session "processed length"
  // so transcript history is never re-matched.
  const processedRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const sid = cockpit.selectedId;
    if (!sid) return;
    const msgs = cockpit.messages;
    const prev = processedRef.current[sid];
    const start = prev == null ? msgs.length : Math.min(prev, msgs.length);
    if (msgs.length > start) {
      const echoes: string[] = [];
      for (let i = start; i < msgs.length; i++) {
        if (msgs[i].role !== 'user') continue;
        const t = msgText(msgs[i]).trim();
        if (t) echoes.push(t);
      }
      if (echoes.length) {
        setPendingSends((q) => {
          const next = [...q];
          for (const t of echoes) {
            const idx = next.findIndex(
              (e) => e.sessionId === sid && e.text.trim() === t,
            );
            if (idx >= 0) next.splice(idx, 1);
          }
          return next;
        });
      }
    }
    processedRef.current[sid] = msgs.length;
  }, [cockpit.selectedId, cockpit.messages]);

  // TTL backstop for queued sends whose echo never arrived.
  useEffect(() => {
    if (pendingSends.length === 0) return;
    const t = setInterval(() => {
      const cutoff = Date.now() - PENDING_SEND_TTL_MS;
      setPendingSends((q) =>
        q.some((e) => e.at < cutoff) ? q.filter((e) => e.at >= cutoff) : q,
      );
    }, 5_000);
    return () => clearInterval(t);
  }, [pendingSends.length]);

  // Clear the post-answer working indicator on the next activity / session change.
  useEffect(() => {
    if (!answering) return;
    if (
      cockpit.selectedId !== answering.sessionId ||
      cockpit.messages.length > answering.baseCount
    ) {
      setAnswering(null);
      return;
    }
    const t = setTimeout(() => setAnswering(null), 90_000);
    return () => clearTimeout(t);
  }, [answering, cockpit.selectedId, cockpit.messages.length]);

  // Render cap: how many trailing messages are currently shown. Reset whenever
  // the active session changes so reopening a long session starts capped again.
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [cockpit.selectedId]);

  // Convert the whole transcript at once so tool_result blocks (which arrive in
  // later messages) fold into their originating tool-call part, THEN cap to the
  // last `visibleCount` so the runtime only mounts the recent tail. We feed the
  // runtime already-converted messages with an identity convertMessage.
  const fullConverted = useMemo<ThreadMessageLike[]>(
    () => convertMessages(cockpit.messages),
    [cockpit.messages],
  );
  const hiddenCount = Math.max(0, fullConverted.length - visibleCount);

  const selectedPending = useMemo(
    () => pendingSends.filter((e) => e.sessionId === cockpit.selectedId),
    [pendingSends, cockpit.selectedId],
  );

  // When a prompt is active, surface the plan being approved (the most recent
  // ExitPlanMode tool-call's markdown) so it can be reviewed inside the modal.
  const planMarkdown = useMemo<string | null>(() => {
    if (!cockpit.prompt) return null;
    const msgs = cockpit.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      for (const b of msgs[i].blocks ?? []) {
        if (b.kind === 'tool_use' && b.name === 'ExitPlanMode') {
          const plan = (b.input as { plan?: unknown } | undefined)?.plan;
          if (typeof plan === 'string' && plan.trim()) return plan;
        }
      }
    }
    return null;
  }, [cockpit.prompt, cockpit.messages]);

  const convertedMessages = useMemo<ThreadMessageLike[]>(() => {
    const base =
      hiddenCount > 0 ? fullConverted.slice(hiddenCount) : fullConverted.slice();
    // Each still-unmatched queued send shows as a user bubble (oldest first).
    for (const e of selectedPending) {
      base.push({
        role: 'user',
        id: `queued-${e.key}`,
        content: [{ type: 'text', text: e.label }],
        metadata: { custom: { cockpitRole: 'user', optimistic: true } },
      } as ThreadMessageLike);
    }
    const working =
      selectedPending.length > 0 ||
      (answering !== null && answering.sessionId === cockpit.selectedId);
    if (working) {
      base.push({
        role: 'assistant',
        id: 'optimistic-working',
        content: [{ type: 'text', text: 'Working…' }],
        metadata: { custom: { cockpitRole: 'assistant', working: true } },
      } as ThreadMessageLike);
    }
    return base;
  }, [fullConverted, hiddenCount, cockpit.selectedId, selectedPending, answering]);

  const loadEarlier = useCallback(() => {
    setVisibleCount((c) => c + LOAD_EARLIER_STEP);
  }, []);

  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    isDisabled: !cockpit.selectedId,
    convertMessage: (msg: ThreadMessageLike) => msg,
    onNew,
    adapters: { attachments: attachmentAdapter },
  });

  // Per-session composer drafts: each session retains its staged prompt text
  // across switches AND reloads (localStorage). Attachments are still cleared on
  // switch (File objects can't be serialized) so they never bleed between sessions.
  const draftsRef = useRef<Record<string, string>>(loadDrafts());
  const draftSessionRef = useRef<string | null>(cockpit.selectedId);

  // Save the active session's draft as the composer text changes.
  useEffect(() => {
    const composer = runtime.thread.composer;
    const persist = () => {
      const sid = draftSessionRef.current;
      if (!sid) return;
      const text = composer.getState().text ?? '';
      if (text) draftsRef.current[sid] = text;
      else delete draftsRef.current[sid];
      saveDrafts(draftsRef.current);
    };
    return composer.subscribe(persist);
  }, [runtime]);

  // On session switch: load the incoming session's draft (read BEFORE reset so
  // the reset's empty save can't clobber it), clear attachments, restore text.
  useEffect(() => {
    const composer = runtime.thread.composer;
    const sid = cockpit.selectedId;
    const draft = sid ? draftsRef.current[sid] ?? '' : '';
    draftSessionRef.current = sid;
    try {
      composer.reset();
      if (draft) composer.setText(draft);
    } catch {
      /* no-op if the runtime isn't ready */
    }
  }, [cockpit.selectedId, runtime]);

  // Locally dismissed AskUserQuestion (keyed by toolUseId). The modal is driven
  // by server-pushed `pending`; dismissing hides it until a *new* question (new
  // toolUseId) arrives, without needing the server to clear pending first.
  const [dismissedAsk, setDismissedAsk] = useState<string | null>(null);

  // Settings modal.
  const [configOpen, setConfigOpen] = useState(false);

  // Raw-terminal escape hatch: the session id whose ttyd panel is open, or null.
  const [terminalId, setTerminalId] = useState<string | null>(null);

  // Pin-transcript modal, sub-agent side panel, and locally-hidden pane prompt
  // (keyed by JSON signature so it re-shows when the prompt changes). Reset when
  // the active session changes.
  const [pinOpen, setPinOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);
  useEffect(() => {
    setPinOpen(false);
    setPanelOpen(false);
  }, [cockpit.selectedId]);

  // Inline session rename: null when not editing, else the draft name. Opening
  // prefills the current name; saving POSTs to /api/session/rename (renames the
  // tmux window + types /rename into the pane). The rail picks up the new name
  // on the next ~4s registry refresh.
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Select-all only when ENTERING rename mode (open), never per-keystroke.
  // Depending on `renaming` re-selected the whole input after each character,
  // so the next keystroke replaced the entire value (only the last char stuck).
  // Depend on the open/closed boolean, which is stable while typing.
  const isRenaming = renaming !== null;
  useEffect(() => {
    if (isRenaming) renameInputRef.current?.select();
  }, [isRenaming]);

  const submitRename = useCallback(async () => {
    const id = cockpit.selectedId;
    const name = (renaming ?? '').trim();
    setRenaming(null);
    if (!id || !name) return;
    try {
      await renameSession(id, name);
      showToast('Renamed →', 'ok');
    } catch (err) {
      showToast(
        `rename failed: ${err instanceof Error ? err.message : 'error'}`,
        'error',
      );
    }
  }, [cockpit.selectedId, renaming, showToast]);

  // Mobile master/detail: reveal the chat pane once a session is selected.
  const [railOpenMobile, setRailOpenMobile] = useState(true);

  // Desktop focus mode: collapse the sidebar (persisted). On mobile the rail is
  // the master pane (handled by data-detail), so focus mode is desktop-only.
  const narrow = useIsNarrow();
  const railRef = useRef<HTMLElement>(null);
  const detailBodyRef = useRef<HTMLDivElement>(null);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cc:railCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleRail = useCallback(() => {
    setRailCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem('cc:railCollapsed', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Animate the desktop rail collapse/expand (width + opacity). On mobile, clear
  // inline styles so the responsive CSS controls the rail.
  const railAnimatedRef = useRef(false);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    if (narrow) {
      gsap.set(rail, { clearProps: 'width,flexBasis,opacity' });
      return;
    }
    const target = railCollapsed
      ? { width: 0, flexBasis: 0, opacity: 0 }
      : { width: 300, flexBasis: 300, opacity: 1 };
    if (prefersReducedMotion() || !railAnimatedRef.current) {
      gsap.set(rail, target); // instant on first paint / reduced motion
      railAnimatedRef.current = true;
      return;
    }
    gsap.to(rail, { ...target, duration: 0.3, ease: 'power3.out' });
  }, [railCollapsed, narrow]);

  // Subtle content transition when switching sessions (desktop + mobile).
  useEffect(() => {
    const el = detailBodyRef.current;
    if (!el || !cockpit.selectedId || prefersReducedMotion()) return;
    gsap.fromTo(
      el,
      { opacity: 0.35, y: 6 },
      { opacity: 1, y: 0, duration: 0.22, ease: 'power3.out' },
    );
  }, [cockpit.selectedId]);
  const select = useCallback(
    (id: string) => {
      cockpit.select(id);
      setRailOpenMobile(false);
      // Deep-link: reflect the selection in the URL hash so a reload restores
      // it. The token no longer lives in the URL (it's in localStorage), so the
      // hash is the only stateful part of the URL.
      window.location.hash = encodeURIComponent(id);
    },
    [cockpit],
  );

  // The service worker posts {type:'open-session', id} when a push notification
  // is tapped — jump straight to that session.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; id?: string } | undefined;
      if (data?.type === 'open-session' && data.id) select(data.id);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [select]);

  // One-line iOS hint: push only works after Add to Home Screen. Show it when on
  // iOS, push is supported-but-off (or unsupported because not yet installed),
  // and not already running as an installed standalone PWA.
  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
      // iOS Safari legacy flag
      (navigator as unknown as { standalone?: boolean }).standalone === true);
  const showIosHint = push.iosHint && !isStandalone && push.status !== 'on';
  // Restore the selected session from the URL hash on load (once the sessions
  // list arrives), and follow back/forward navigation.
  const restoredHash = useRef(false);
  useEffect(() => {
    const fromHash = () => {
      const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
      if (id && id !== cockpit.selectedId && cockpit.sessions.some((s) => s.id === id)) {
        cockpit.select(id);
        setRailOpenMobile(false);
      }
    };
    // Initial restore: wait until at least one session is known.
    if (!restoredHash.current && cockpit.sessions.length > 0) {
      restoredHash.current = true;
      fromHash();
    }
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [cockpit, cockpit.sessions, cockpit.selectedId]);

  const selectedSession = cockpit.sessions.find(
    (s) => s.id === cockpit.selectedId,
  );

  // The live "thinking" block is the trailing reasoning of the last real
  // transcript message, but only while the server says this session is actively
  // generating (`thinking`). Its message id is handed to the reasoning renderer
  // via context so that block — and only that block — flashes multicolour.
  const liveThinkingId =
    selectedSession?.thinking && fullConverted.length > 0
      ? (fullConverted[fullConverted.length - 1].id ?? null)
      : null;

  // Pull-to-refresh (mobile): pull down at the top of the thread/rail to hard-
  // reload and pick up a freshly-deployed bundle.
  const appRef = useRef<HTMLDivElement>(null);
  const { pull, refreshing } = usePullToRefresh(appRef);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
    <ArtifactPanelProvider>
      <div
        ref={appRef}
        className="app"
        data-detail={cockpit.selectedId && !railOpenMobile ? 'open' : 'closed'}
        data-rail-collapsed={!narrow && railCollapsed ? 'true' : undefined}
      >
        {/* Pull-to-refresh indicator: tracks the pull, becomes a spinner on
            release-to-refresh. */}
        {pull > 0 || refreshing ? (
          <div
            className="ptr-indicator"
            style={{ transform: `translate(-50%, ${Math.round(pull)}px)` }}
            data-ready={!refreshing && pull >= PTR_THRESHOLD ? 'true' : undefined}
            data-refreshing={refreshing ? 'true' : undefined}
            aria-hidden="true"
          >
            <span className="ptr-spinner" />
          </div>
        ) : null}
        {/* Hard-reload the app (bottom-left). Assets are hashed + served fresh,
            so a plain reload fetches the latest bundle. */}
        <button
          type="button"
          className="reload-btn"
          aria-label="Reload app"
          title="Reload app"
          onClick={() => window.location.reload()}
        >
          ↻
        </button>
        {/* Fixed top scrim: on mobile, focusing the composer makes iOS scroll the
            whole app up to clear the keyboard, pushing the nav bars off and
            sliding message text under the status bar. This dissolves that text
            into the background at the very top of the screen while typing. */}
        <div className="app-top-fade" aria-hidden="true" />
        <ResourceHud
          resources={cockpit.resources}
          conn={cockpit.conn}
          push={push}
        />
        <UpdateBanner />
        {showIosHint ? (
          <div className="ios-push-hint" role="note">
            On iPhone/iPad, add this site to your Home Screen to receive push
            notifications.
          </div>
        ) : null}

        <div className="app-body">
          <aside className="rail" ref={railRef}>
            <NewSessionForm
              onToast={showToast}
              onOpenSettings={() => setConfigOpen(true)}
            />
            <SessionRail
              sessions={cockpit.sessions}
              selectedId={cockpit.selectedId}
              onSelect={select}
            />
          </aside>

          <main className="detail">
            <header className="detail-head">
              <button
                type="button"
                className="back-btn"
                aria-label="Back to sessions"
                onClick={() => setRailOpenMobile(true)}
              >
                ‹
              </button>
              <button
                type="button"
                className="focus-toggle"
                aria-pressed={railCollapsed}
                aria-label={railCollapsed ? 'Show sidebar' : 'Focus mode (hide sidebar)'}
                title={railCollapsed ? 'Show sidebar' : 'Focus mode (hide sidebar)'}
                onClick={toggleRail}
              >
                {railCollapsed ? '⇥' : '⇤'}
              </button>
              <div className="detail-title">
                {renaming !== null ? (
                  <input
                    ref={renameInputRef}
                    className="detail-rename-input"
                    type="text"
                    value={renaming}
                    aria-label="Session name"
                    onChange={(e) => setRenaming(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void submitRename();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => void submitRename()}
                  />
                ) : (
                  <span className="detail-name-row">
                    <span className="detail-name">
                      {selectedSession?.name ||
                        cockpit.selectedId ||
                        'claude control'}
                    </span>
                    {selectedSession ? (
                      <>
                        <button
                          type="button"
                          className="rename-btn"
                          aria-label="Rename session"
                          title="Rename session"
                          onClick={() =>
                            setRenaming(
                              selectedSession.name ?? selectedSession.id,
                            )
                          }
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="rename-btn term-btn"
                          aria-label="Open raw terminal"
                          title="Raw terminal"
                          onClick={() => setTerminalId(selectedSession.id)}
                        >
                          ⛶
                        </button>
                        <button
                          type="button"
                          className="rename-btn pin-btn"
                          aria-pressed={!!selectedSession.pinned}
                          aria-label={
                            selectedSession.pinned ? 'Transcript pinned' : 'Pin a transcript'
                          }
                          title={
                            selectedSession.pinned ? 'Transcript pinned' : 'Pin a transcript'
                          }
                          onClick={() => setPinOpen(true)}
                        >
                          {selectedSession.pinned ? '📌' : '📍'}
                        </button>
                        {cockpit.subagents.length > 0 ? (
                          <button
                            type="button"
                            className="rename-btn agents-btn"
                            aria-pressed={panelOpen}
                            title="Sub-agents"
                            onClick={() => setPanelOpen((v) => !v)}
                          >
                            🤖 {cockpit.subagents.length}
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                )}
                {selectedSession?.cwd ? (
                  <span className="detail-cwd">{selectedSession.cwd}</span>
                ) : null}
              </div>
            </header>

            <div className="detail-body" ref={detailBodyRef}>
            <ShellContext.Provider value={shellApi}>
            {selectedSession && selectedSession.kind === 'terminal' ? (
              // Plain (non-Claude) pane: a fully interactive live terminal —
              // ANSI view + key bar + keystroke relay. No transcript, by design.
              <TerminalPane
                sessionId={selectedSession.id}
                capture={cockpit.capture}
                requestCapture={cockpit.requestCapture}
                clearCapture={cockpit.clearCapture}
                sendText={cockpit.sendPaneText}
                sendKey={cockpit.sendPaneKey}
              />
            ) : selectedSession && !selectedSession.transcriptPath ? (
              // Claude pane with no matched transcript (e.g. a worktree cwd Claude
              // records under a different path): show the live tmux pane so it
              // isn't an empty "no messages yet". The composer still replies via
              // tmux send-keys.
              <div className="thread-root">
                <div className="thread-fade" aria-hidden="true" />
                <LivePane
                  sessionId={selectedSession.id}
                  capture={cockpit.capture}
                  requestCapture={cockpit.requestCapture}
                  clearCapture={cockpit.clearCapture}
                />
                <Composer disabled={false} sessionId={cockpit.selectedId} />
              </div>
            ) : (
              <div className="detail-split">
                <LiveThinkingContext.Provider value={liveThinkingId}>
                  <Thread
                    hasSelection={!!cockpit.selectedId}
                    sessionId={cockpit.selectedId}
                    hiddenCount={hiddenCount}
                    onLoadEarlier={loadEarlier}
                  />
                </LiveThinkingContext.Provider>
                <ArtifactPanel />
              </div>
            )}
            </ShellContext.Provider>
            </div>
          </main>
        </div>

        {cockpit.pending &&
        cockpit.pending.toolUseId !== dismissedAsk ? (
          <AskModal
            key={cockpit.pending.toolUseId}
            pending={cockpit.pending}
            capture={cockpit.capture}
            onAnswer={(toolUseId, selections) => {
              cockpit.sendAnswer(toolUseId, selections);
              setDismissedAsk(toolUseId);
              cockpit.clearCapture();
              // Show a working indicator after answering (no user echo — the
              // choice is shown in the AskUserQuestion widget), cleared when the
              // agent's transcript activity arrives.
              if (cockpit.selectedId) {
                setAnswering({
                  sessionId: cockpit.selectedId,
                  baseCount: cockpit.messages.length,
                });
              }
            }}
            onCapture={cockpit.requestCapture}
            onClose={() => {
              setDismissedAsk(cockpit.pending?.toolUseId ?? null);
              cockpit.clearCapture();
            }}
          />
        ) : null}

        {configOpen ? (
          <ConfigModal
            onClose={() => setConfigOpen(false)}
            onToast={showToast}
          />
        ) : null}

        {terminalId ? (
          <TerminalPanel
            key={terminalId}
            sessionId={terminalId}
            label={
              cockpit.sessions.find((s) => s.id === terminalId)?.name ??
              terminalId
            }
            onClose={() => setTerminalId(null)}
          />
        ) : null}

        <SubAgentPanel
          subagents={cockpit.subagents}
          open={panelOpen && cockpit.subagents.length > 0}
          onClose={() => setPanelOpen(false)}
        />

        {pinOpen && selectedSession ? (
          <PinModal
            session={selectedSession}
            onClose={() => setPinOpen(false)}
            onToast={showToast}
            onPinned={() => cockpit.resubscribe()}
          />
        ) : null}

        {cockpit.prompt &&
        !cockpit.pending &&
        JSON.stringify(cockpit.prompt) !== dismissedPrompt ? (
          <PromptModal
            prompt={cockpit.prompt}
            planMarkdown={planMarkdown}
            onKey={(key) => cockpit.sendPromptKey(key)}
            onClose={() => setDismissedPrompt(JSON.stringify(cockpit.prompt))}
          />
        ) : null}

        <ToastView toast={toast} />
      </div>
    </ArtifactPanelProvider>
    </AssistantRuntimeProvider>
  );
}

// Root: gate the whole app behind the token login. TokenGate probes
// /api/health and only renders AppInner (which opens the WS) once authorized.
// Tokenless servers probe 200 → AppInner renders immediately, no prompt.
export default function App() {
  return (
    <TokenGate>
      <AppInner />
    </TokenGate>
  );
}
