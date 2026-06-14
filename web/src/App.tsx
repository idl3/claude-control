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
import { buildPath, parsePath } from './lib/route';
import { SessionRail } from './components/SessionRail';
import { ResourceHud } from './components/ResourceHud';
import { Thread } from './components/Thread';
import { AskModal } from './components/AskModal';
import { ToastView, type ToastMessage } from './components/Toast';
import { UpdateBanner } from './components/UpdateBanner';
import { LightboxProvider } from './components/Lightbox';
import { SubAgentPanel } from './components/SubAgentPanel';
import { PinModal } from './components/PinModal';
import type { Msg, ServerMessage } from './lib/types';

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

// Concatenate the text blocks of a transcript message (used to match a real
// user echo against a queued send).
function msgText(msg: Msg): string {
  return (msg.blocks ?? [])
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join(' ');
}

// How long a queued send waits for its transcript echo before we give up
// showing it (safety backstop — normally the echo clears it far sooner).
const PENDING_SEND_TTL_MS = 90_000;

export default function App() {
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
  // Queued / in-flight sends. We don't get our own message back until Claude
  // writes it into the transcript, and messages sent while Claude is busy sit in
  // tmux's input queue — so without this the composer feels dead and queued
  // messages are invisible. Each send shows immediately as a "queued" user
  // bubble; it clears only when its OWN echo (matched by text, oldest-first)
  // appears in the real transcript, or after a TTL backstop. `text` is what was
  // sent (used to match the echo); `label` is what we show.
  const [pendingSends, setPendingSends] = useState<
    { key: number; sessionId: string; text: string; label: string; at: number }[]
  >([]);
  const sendSeq = useRef(0);

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

  // Reconcile queued sends against the real transcript: as new user messages
  // arrive for the selected session, drop the oldest queued send whose sent text
  // matches (so multiple queued messages clear one-by-one in order). Tracks a
  // per-session "processed length" so history is never re-matched.
  const processedRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const sid = cockpit.selectedId;
    if (!sid) return;
    const msgs = cockpit.messages;
    const prev = processedRef.current[sid];
    // First time we see a session, treat everything as history (skip it).
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

  // TTL backstop: drop queued sends whose echo never arrived.
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

  const convertedMessages = useMemo<ThreadMessageLike[]>(() => {
    const base =
      hiddenCount > 0 ? fullConverted.slice(hiddenCount) : fullConverted.slice();
    for (const e of selectedPending) {
      base.push({
        role: 'user',
        id: `queued-${e.key}`,
        content: [{ type: 'text', text: e.label }],
        metadata: { custom: { cockpitRole: 'user', queued: true } },
      } as ThreadMessageLike);
    }
    if (selectedPending.length > 0) {
      base.push({
        role: 'assistant',
        id: 'optimistic-working',
        content: [{ type: 'text', text: 'Working…' }],
        metadata: { custom: { cockpitRole: 'assistant', working: true } },
      } as ThreadMessageLike);
    }
    return base;
  }, [fullConverted, hiddenCount, selectedPending]);

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

  // Mobile master/detail: reveal the chat pane once a session is selected.
  const [railOpenMobile, setRailOpenMobile] = useState(true);
  // Sub-agent side panel (drawer) visibility; reset when the session changes.
  const [panelOpen, setPanelOpen] = useState(false);
  // Pin-transcript modal.
  const [pinOpen, setPinOpen] = useState(false);
  useEffect(() => {
    setPanelOpen(false);
    setPinOpen(false);
  }, [cockpit.selectedId]);
  // Select a session AND reflect it in the URL (/<session>/<window>/<pane>) so
  // it's deep-linkable and back/forward works. The token query is preserved.
  const select = useCallback(
    (id: string) => {
      cockpit.select(id);
      setRailOpenMobile(false);
      const next = buildPath(id, window.location.search);
      if (next !== window.location.pathname + window.location.search) {
        window.history.pushState({ id }, '', next);
      }
    },
    [cockpit],
  );

  // Select from the URL without pushing a new history entry (initial load +
  // back/forward navigation).
  const selectFromRoute = useCallback(
    (id: string) => {
      cockpit.select(id);
      setRailOpenMobile(false);
    },
    [cockpit],
  );

  // Deep-link on first load: if the path names a session, open it. Runs once.
  const didInitRoute = useRef(false);
  useEffect(() => {
    if (didInitRoute.current) return;
    didInitRoute.current = true;
    const id = parsePath(window.location.pathname);
    if (id) selectFromRoute(id);
  }, [selectFromRoute]);

  // Back/forward: re-select the session named by the new URL.
  useEffect(() => {
    const onPop = () => {
      const id = parsePath(window.location.pathname);
      if (id) selectFromRoute(id);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [selectFromRoute]);

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

  const selectedSession = cockpit.sessions.find(
    (s) => s.id === cockpit.selectedId,
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <LightboxProvider>
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
                <span className="detail-name">
                  {selectedSession?.name || cockpit.selectedId || 'cockpit'}
                </span>
                {selectedSession?.cwd ? (
                  <span className="detail-cwd">{selectedSession.cwd}</span>
                ) : null}
              </div>
              {cockpit.selectedId ? (
                <button
                  type="button"
                  className="pin-toggle"
                  aria-pressed={!!selectedSession?.pinned}
                  title={selectedSession?.pinned ? 'Transcript pinned' : 'Pin a transcript'}
                  onClick={() => setPinOpen(true)}
                >
                  {selectedSession?.pinned ? '📌' : '📍'}
                </button>
              ) : null}
              {cockpit.subagents.length > 0 ? (
                <button
                  type="button"
                  className="subagents-toggle"
                  aria-pressed={panelOpen}
                  title="Sub-agents"
                  onClick={() => setPanelOpen((v) => !v)}
                >
                  agents
                  <span className="subagents-badge">{cockpit.subagents.length}</span>
                </button>
              ) : null}
            </header>

            <Thread
              hasSelection={!!cockpit.selectedId}
              hiddenCount={hiddenCount}
              onLoadEarlier={loadEarlier}
            />
          </main>

          <SubAgentPanel
            subagents={cockpit.subagents}
            open={panelOpen && cockpit.subagents.length > 0}
            onClose={() => setPanelOpen(false)}
          />
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
            }}
            onCapture={cockpit.requestCapture}
            onClose={() => {
              setDismissedAsk(cockpit.pending?.toolUseId ?? null);
              cockpit.clearCapture();
            }}
          />
        ) : null}

        <ToastView toast={toast} />

        {pinOpen && selectedSession ? (
          <PinModal
            session={selectedSession}
            onClose={() => setPinOpen(false)}
            onToast={showToast}
            onPinned={() => cockpit.resubscribe()}
          />
        ) : null}
      </div>
      </LightboxProvider>
    </AssistantRuntimeProvider>
  );
}
