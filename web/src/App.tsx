import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useCockpit } from './hooks/useCockpit';
import { convertMessages } from './lib/convert';
import { attachmentPath, createCockpitAttachmentAdapter } from './lib/attachments';
import { SessionRail } from './components/SessionRail';
import { ResourceHud } from './components/ResourceHud';
import { Thread } from './components/Thread';
import { AskModal } from './components/AskModal';
import { ToastView, type ToastMessage } from './components/Toast';
import { UpdateBanner } from './components/UpdateBanner';
import { ConfigModal } from './components/ConfigModal';
import { NewSessionForm } from './components/NewSessionForm';
import type { ServerMessage } from './lib/types';

// Extract the plain text the user typed in the composer.
function appendMessageText(message: AppendMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export default function App() {
  const cockpit = useCockpit();
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

  // Convert the whole transcript at once so tool_result blocks (which arrive in
  // later messages) fold into their originating tool-call part. We feed the
  // runtime already-converted messages with an identity convertMessage.
  const convertedMessages = useMemo<ThreadMessageLike[]>(() => {
    const base = convertMessages(cockpit.messages);
    if (optimistic && optimistic.sessionId === cockpit.selectedId) {
      base.push({
        role: 'user',
        id: 'optimistic-user',
        content: [{ type: 'text', text: optimistic.text }],
        metadata: { custom: { cockpitRole: 'user', optimistic: true } },
      } as ThreadMessageLike);
      base.push({
        role: 'assistant',
        id: 'optimistic-working',
        content: [{ type: 'text', text: 'Working…' }],
        metadata: { custom: { cockpitRole: 'assistant', working: true } },
      } as ThreadMessageLike);
    }
    return base;
  }, [cockpit.messages, cockpit.selectedId, optimistic]);

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

  // Mobile master/detail: reveal the chat pane once a session is selected.
  const [railOpenMobile, setRailOpenMobile] = useState(true);
  const select = useCallback(
    (id: string) => {
      cockpit.select(id);
      setRailOpenMobile(false);
    },
    [cockpit],
  );

  const selectedSession = cockpit.sessions.find(
    (s) => s.id === cockpit.selectedId,
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        className="app"
        data-detail={cockpit.selectedId && !railOpenMobile ? 'open' : 'closed'}
      >
        <ResourceHud resources={cockpit.resources} conn={cockpit.conn} />
        <UpdateBanner />

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
                <span className="detail-name">
                  {selectedSession?.name || cockpit.selectedId || 'cockpit'}
                </span>
                {selectedSession?.cwd ? (
                  <span className="detail-cwd">{selectedSession.cwd}</span>
                ) : null}
              </div>
            </header>

            <Thread hasSelection={!!cockpit.selectedId} />
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

        <ToastView toast={toast} />
      </div>
    </AssistantRuntimeProvider>
  );
}
