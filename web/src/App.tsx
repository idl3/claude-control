import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useCockpit } from './hooks/useCockpit';
import { usePushNotifications } from './hooks/usePushNotifications';
import { convertMessages } from './lib/convert';
import { attachmentPath, createCockpitAttachmentAdapter } from './lib/attachments';
import { renameSession } from './lib/api';
import { SessionRail } from './components/SessionRail';
import { ResourceHud } from './components/ResourceHud';
import { Thread } from './components/Thread';
import { LivePane } from './components/LivePane';
import { Composer } from './components/Composer';
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
import type { ServerMessage } from './lib/types';

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

  // Composer send -> tmux reply. We do NOT optimistically append; Claude's
  // echo arrives via the WS transcript stream. The outgoing text is the user's
  // typed text plus each attachment's uploaded absolute path (paths after the
  // text, space-separated) — the adapter already uploaded them by send time.
  // Optimistic send echo: we don't get our own message back until Claude writes
  // it into the transcript (which can lag), so without this the composer feels
  // dead after sending. On send we immediately show the typed text as a user
  // bubble + a "working…" assistant indicator, cleared once real transcript
  // activity arrives (or the session changes / a safety timeout fires).
  const [optimistic, setOptimistic] = useState<{
    sessionId: string;
    text: string;
    baseCount: number;
    at: number;
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
        setOptimistic({
          sessionId: cockpit.selectedId,
          text: label,
          baseCount: cockpit.messages.length,
          at: Date.now(),
        });
      }
    },
    [cockpit, showToast],
  );

  // Clear the optimistic echo when real transcript content arrives for that
  // session, when the session changes, or after a 90s safety timeout.
  useEffect(() => {
    if (!optimistic) return;
    const stale =
      cockpit.selectedId !== optimistic.sessionId ||
      cockpit.messages.length > optimistic.baseCount;
    if (stale) {
      setOptimistic(null);
      return;
    }
    const t = setTimeout(() => setOptimistic(null), 90_000);
    return () => clearTimeout(t);
  }, [optimistic, cockpit.selectedId, cockpit.messages.length]);

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

  const convertedMessages = useMemo<ThreadMessageLike[]>(() => {
    const base =
      hiddenCount > 0 ? fullConverted.slice(hiddenCount) : fullConverted.slice();
    if (optimistic && optimistic.sessionId === cockpit.selectedId) {
      // User echo only for typed sends; answers (text === '') show just the
      // working indicator (the choice is already shown in the AskUserQuestion).
      if (optimistic.text) {
        base.push({
          role: 'user',
          id: 'optimistic-user',
          content: [{ type: 'text', text: optimistic.text }],
          metadata: { custom: { cockpitRole: 'user', optimistic: true } },
        } as ThreadMessageLike);
      }
      base.push({
        role: 'assistant',
        id: 'optimistic-working',
        content: [{ type: 'text', text: 'Working…' }],
        metadata: { custom: { cockpitRole: 'assistant', working: true } },
      } as ThreadMessageLike);
    }
    return base;
  }, [fullConverted, hiddenCount, cockpit.selectedId, optimistic]);

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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        className="app"
        data-detail={cockpit.selectedId && !railOpenMobile ? 'open' : 'closed'}
      >
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
          <aside className="rail">
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

            {selectedSession && !selectedSession.transcriptPath ? (
              // Transcript-less live session (e.g. a worktree cwd Claude records
              // under a different path): the assistant-ui thread would render an
              // empty "no messages yet", so show the live tmux pane instead. The
              // composer still works — replies go via tmux send-keys regardless
              // of whether a transcript was matched.
              <div className="thread-root">
                <LivePane
                  sessionId={selectedSession.id}
                  capture={cockpit.capture}
                  requestCapture={cockpit.requestCapture}
                  clearCapture={cockpit.clearCapture}
                />
                <Composer disabled={false} />
              </div>
            ) : (
              <Thread
                hasSelection={!!cockpit.selectedId}
                hiddenCount={hiddenCount}
                onLoadEarlier={loadEarlier}
              />
            )}
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
                setOptimistic({
                  sessionId: cockpit.selectedId,
                  text: '',
                  baseCount: cockpit.messages.length,
                  at: Date.now(),
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
            onKey={(key) => cockpit.sendPromptKey(key)}
            onClose={() => setDismissedPrompt(JSON.stringify(cockpit.prompt))}
          />
        ) : null}

        <ToastView toast={toast} />
      </div>
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
