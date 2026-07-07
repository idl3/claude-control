import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import {
  remoteComposerMode,
  remoteModeLabel,
  remoteModeTitle,
  shouldSteerDoor,
  blocksResumeResend,
  REMOTE_REFUSAL_MESSAGES,
  type SessionLiveness,
} from './lib/olamMode';
import { sessionDisplayLabel } from './lib/olamLabel';
import { useCockpit } from './hooks/useCockpit';
import { usePushNotifications } from './hooks/usePushNotifications';
import { usePullToRefresh, PTR_THRESHOLD } from './hooks/usePullToRefresh';
import { convertMessages, transcriptHasToolUse } from './lib/convert';
import { attachmentPath, createCockpitAttachmentAdapter } from './lib/attachments';
import { renameSession, createSession, getConfig, resetBinding, rematchAll, olamTerminalToken, olamSessionLiveness, type CreateSessionResult } from './lib/api';
import { SessionRail, claudeWorking, type SessionFilter } from './components/SessionRail';
import { ResourceHud } from './components/ResourceHud';
import { Thread } from './components/Thread';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LiveThinkingContext } from './components/ThinkingContext';
import { AgentKindContext } from './components/AgentContext';
import { ArtifactPanelProvider } from './components/ArtifactContext';
import { ArtifactPanel } from './components/ArtifactPanel';
import { TerminalPane } from './components/TerminalPane';
import { ShellContext } from './components/ShellContext';
import { ToastView, type ToastMessage } from './components/Toast';
import { UpdateBanner } from './components/UpdateBanner';
import { PermissionBanner } from './components/PermissionBanner';
import { ConfigModal } from './components/ConfigModal';
import { NewSessionForm } from './components/NewSessionForm';
import { NewSessionDraft } from './components/NewSessionDraft';
import { TerminalPanel } from './components/TerminalPanel';
import { TokenGate } from './components/TokenGate';
import type { ActivePrompt } from './components/AskInline';
import { SubAgentPanel } from './components/SubAgentPanel';
import { ProcessPanel } from './components/ProcessPanel';
import { RawEventPanel } from './components/RawEventPanel';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { HotkeyHints } from './components/HotkeyHints';
import {
  PencilIcon,
  TerminalSquareIcon,
  BotIcon,
  PanelLeftIcon,
  EllipsisIcon,
  SettingsIcon,
  ActivityIcon,
  SearchIcon,
  RefreshIcon,
  SteeringWheelIcon,
  ExternalLinkIcon,
} from './components/icons';
import { TranscriptSearch } from './components/TranscriptSearch';
import type { Msg, Pending, ServerMessage } from './lib/types';
import { hasOpenQuestion } from './lib/askGuard';
import { shouldShowPrompt, shouldShowSynthesizedAsk, SETTLE_CAP_MS } from './lib/answerSettle';
import { applySubAgentPrefix, type SubAgentMode } from './lib/subAgent';
import { useIsNarrow } from './hooks/useIsNarrow';
import { useModifierHeld } from './hooks/useModifierHeld';
import gsap, { prefersReducedMotion } from './lib/anim';

// Sentinel toolUseId used when the inline AskBody is synthesized from the
// session's boolean `pending` flag rather than a full structured Pending object
// (tailer-less sessions only carry the flag). The server will not recognise this
// id, which is acceptable — the goal is to never leave the user blind.
const FLAG_PENDING_TOOL_USE_ID = '__flag__';

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
// Backstop for a dormant-session resume send (Phase C, C5): the WS round trip
// covers BOTH resuming the session AND delivering the message, so it can take
// far longer than a normal steer ack. p95 is ~2min; this gives real headroom
// before assuming the ack was lost (dropped connection, etc.) and re-enabling
// the composer for a retry.
const RESUME_TIMEOUT_MS = 150_000;
// Optimistic sends are persisted here so a page reload doesn't drop an un-echoed
// message — on load they rehydrate and the transcript reconcile resolves them.
const PENDING_SENDS_LS_KEY = 'cc:pendingSends';

type PendingSend = {
  key: number;
  reqId: string;
  sessionId: string;
  text: string;
  label: string;
  at: number;
  status: 'queued' | 'sent' | 'failed';
};

function loadPendingSends(): PendingSend[] {
  try {
    const raw = localStorage.getItem(PENDING_SENDS_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const cutoff = Date.now() - PENDING_SEND_TTL_MS;
    // Prune stale entries on load; keep failed ones (loud until acknowledged).
    return arr.filter(
      (e): e is PendingSend =>
        e && typeof e.at === 'number' && (e.status === 'failed' || e.at >= cutoff),
    );
  } catch {
    return [];
  }
}

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

// Per-session sub-agent mode: true | false | agent-name-string.
// Defaults to true for any session without a stored value.
const SUBAGENT_KEY = 'cc_subagent';
function loadSubAgentModes(): Record<string, SubAgentMode> {
  try {
    return JSON.parse(localStorage.getItem(SUBAGENT_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveSubAgentModes(modes: Record<string, SubAgentMode>): void {
  try {
    localStorage.setItem(SUBAGENT_KEY, JSON.stringify(modes));
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

  // Tag <body> with is-ipad / is-external-display so CSS can drop the
  // home-indicator bottom padding when the iPad is driving an external display
  // (no home indicator there). Bind the resize listener ONCE (the original
  // snippet re-added it on every call → listener leak).
  useEffect(() => {
    const detect = () => {
      // Apple tablets: iPadOS UA or MacIntel+touch (iPadOS desktop-mode UA).
      const isAppleTablet =
        /iPad/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      // Non-Apple touch tablets (e.g. Android): coarse primary pointer + no
      // hover + at least one touch point. Real external monitors are driven by
      // desktops with a fine pointer / hover capability, so they won't match.
      const isTouchTablet =
        navigator.maxTouchPoints > 0 &&
        window.matchMedia('(pointer: coarse)').matches &&
        window.matchMedia('(hover: none)').matches;
      // Keep is-ipad iOS-only: that class governs iOS home-indicator safe-area
      // padding which Android tablets don't have.
      const isIPad = isAppleTablet;
      // External-display sizing fires on ≥2K viewports but NOT on non-Apple
      // touch tablets (e.g. a 2560px Nxtpaper whose own screen is large).
      // A desktop driving a 2K monitor has a fine pointer so isTouchTablet is
      // false → still classified as external. An iPad driving an external 2K
      // monitor has isAppleTablet true so the exclusion doesn't apply → still
      // classified as external.
      const isExternal =
        window.matchMedia('(min-width: 2000px)').matches &&
        !(isTouchTablet && !isAppleTablet);
      document.body.classList.toggle('is-ipad', isIPad);
      document.body.classList.toggle('is-external-display', isExternal);
    };
    detect();
    window.addEventListener('resize', detect);
    return () => window.removeEventListener('resize', detect);
  }, []);

  // Load font-size config once at startup and apply --txt-transcript to the
  // document root. Two independent settings:
  //  - transcriptFontSize: base (iPad + non-external desktop)
  //  - externalFontSize:   applies ONLY when body.is-external-display is set
  // 0 = use the CSS default (no inline override). Re-applies on resize so the
  // external-display switch mid-session is handled.
  useEffect(() => {
    let basePx = 0;
    let extPx = 0;
    let alive = true;

    // The chosen px is the transcript size; we express it as a GLOBAL scale
    // (relative to the 13.5px mobile baseline) so every text token — transcript,
    // meta, composer — scales together off the one setting.
    const BASELINE_PX = 13.5;
    const apply = () => {
      if (!alive) return;
      const isExternal = document.body.classList.contains('is-external-display');
      const chosen = isExternal && extPx > 0 ? extPx : basePx > 0 ? basePx : 0;
      if (chosen > 0) {
        document.documentElement.style.setProperty('--ui-scale', String(chosen / BASELINE_PX));
      } else {
        document.documentElement.style.removeProperty('--ui-scale');
      }
    };

    getConfig()
      .then((c) => {
        if (!alive) return;
        basePx = c.transcriptFontSize ?? 0;
        extPx = c.externalFontSize ?? 0;
        apply();
      })
      .catch(() => { /* non-fatal — keep CSS defaults */ });

    // Live update when the font size is saved in Settings (no reload needed).
    const onFontSize = (e: Event) => {
      const d = (e as CustomEvent<{ transcriptFontSize?: number; externalFontSize?: number }>).detail;
      if (!d) return;
      basePx = d.transcriptFontSize ?? 0;
      extPx = d.externalFontSize ?? 0;
      apply();
    };

    window.addEventListener('resize', apply);
    window.addEventListener('cockpit:fontsize', onFontSize);
    return () => {
      alive = false;
      window.removeEventListener('resize', apply);
      window.removeEventListener('cockpit:fontsize', onFontSize);
    };
  }, []);

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
  // Composer (inside Thread) can reach the server-owned shell pane without
  // prop-drilling.
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
  // `status` is the delivery-assurance signal, driven by the server ack (NOT by
  // WS-write): 'queued' = handed to the socket, awaiting the server's ack that
  // tmux accepted it; 'sent' = ack confirmed, awaiting the transcript echo;
  // 'failed' = the server reported the send never landed (loud red, no TTL).
  const [pendingSends, setPendingSends] = useState<PendingSend[]>(loadPendingSends);

  // Persist optimistic sends so a reload doesn't lose an un-echoed message.
  useEffect(() => {
    try {
      localStorage.setItem(PENDING_SENDS_LS_KEY, JSON.stringify(pendingSends));
    } catch {
      /* quota / private mode — non-fatal, in-memory state still works */
    }
  }, [pendingSends]);
  const sendSeq = useRef(0);
  // Tracks whether the Composer's >_ terminal mode is active — updated by the
  // Composer via onTerminalModeChange. Used to gate the sub-agent prefix.
  const composerTerminalRef = useRef(false);
  const onTerminalModeChange = useCallback((active: boolean) => {
    composerTerminalRef.current = active;
  }, []);
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
      // Apply the sub-agent prefix when: mode is on for this session AND the
      // composer is NOT in >_ terminal mode (that would corrupt shell commands).
      const sid = cockpit.selectedId;
      // Block sends while Claude is compacting — the TUI ignores input during
      // compaction, so a send would silently vanish and look like a hang.
      const sess = cockpit.sessions.find((s) => s.id === sid);
      if (sess?.compacting) {
        showToast('Compacting conversation… hold on', 'error');
        return;
      }
      // A normal composer reply must NEVER be sent as raw keystrokes while an
      // AskUserQuestion picker is open — Enter would select an option rather than
      // type a reply. Block it and direct the user to the inline question component.
      if (hasOpenQuestion(cockpit.pending, sess?.pending, cockpit.pickerOpen)) {
        showToast('A question is open — answer it above (or pick "Type something")', 'error');
        // Expand the minimised ask bar so the user can see the question.
        document.querySelector<HTMLElement>('.ask-min-bar')?.click();
        return;
      }
      const mode = sid != null ? (subAgentModesRef.current[sid] ?? true) : false;
      const inTerminal = composerTerminalRef.current;
      const prefixedTyped =
        !inTerminal && typed ? applySubAgentPrefix(typed, mode) : typed;
      const text = [prefixedTyped, ...paths].filter(Boolean).join(' ');
      if (!text) return;
      // Remote steer: read-only/unknown refuse locally (fast path — the
      // server's preSendGate is the authoritative re-check, see server.js's
      // WS 'reply' handler); dormant instead resumes-and-sends in one call
      // (Phase C, C5) — else pass the hard-steer flag. remoteLivenessRef
      // (not the remoteLiveness state var) is read here because onNew is a
      // stable useCallback whose deps deliberately omit render-time values
      // (matches the pre-existing selectedSession-via-closure pattern below).
      let isResumeSend = false;
      if (selectedSession?.kind === 'remote') {
        const mode = remoteComposerMode(selectedSession, remoteLivenessRef.current);
        if (mode === 'read-only') {
          showToast('This session is read-only — steering disabled.', 'error');
          return;
        }
        if (mode === 'unknown') {
          showToast(REMOTE_REFUSAL_MESSAGES.unknown, 'error');
          return;
        }
        if (mode === 'dormant') {
          // Re-click guard: a resume ack round-trip can take up to ~2min, far
          // longer than React needs to flush the composer's disabled state —
          // check the ref synchronously so a rapid double-Enter can't fire a
          // second resume for the same session. blocksResumeResend is pure
          // (lib/olamMode.ts) so this predicate is unit-testable without
          // mounting App.tsx.
          if (blocksResumeResend(resumingRef.current, sid)) {
            showToast('Resume already in progress — hold on', 'error');
            return;
          }
          isResumeSend = true;
        }
      }
      const reqId = cockpit.sendReply(
        text,
        paths.length,
        false,
        selectedSession?.kind === 'remote' ? steerHardRef.current : false,
      );
      if (!reqId) {
        // The socket couldn't even write the frame — nothing was dispatched, so
        // show NO optimistic bubble (the old code's danger: a bubble that lied).
        showToast('Not connected — reconnecting…', 'error');
        return;
      }
      if (isResumeSend && sid) {
        setResumeIssue(null);
        setResuming({ sessionId: sid, reqId });
        showToast('Resuming session & sending…', 'ok');
      } else if (
        // Deliberately "Queued", not "Sent": delivery is only confirmed when the
        // server's ack for this reqId arrives (handled below). A SOFT steer-door
        // send (Phase B, B3) queues onto the ledger rather than dispatching
        // immediately — it's claimed (and actually applied) at the NEXT turn
        // boundary, so the copy says so instead of implying instant delivery.
        selectedSession?.kind === 'remote' &&
        !steerHardRef.current &&
        shouldSteerDoor(selectedSession, remoteLivenessRef.current)
      ) {
        showToast('Queued → applies at the next turn boundary', 'ok');
      } else {
        showToast('Queued →', 'ok');
      }
      if (sid) {
        // The displayed label mirrors what was sent so the bubble matches reality.
        const label =
          prefixedTyped || (paths.length ? `📎 ${paths.length} attachment(s)` : text);
        setPendingSends((q) => [
          ...q,
          {
            key: ++sendSeq.current,
            reqId,
            sessionId: sid,
            text,
            label,
            at: Date.now(),
            status: 'queued',
          },
        ]);
      }
    },
    [cockpit, showToast],
  );

  // Delivery assurance: the server echoes each reply's reqId in its ack once
  // tmux has actually accepted (or rejected) the send. Flip the matching queued
  // bubble to 'sent' (delivered — now awaiting the transcript echo) or 'failed'
  // (loud: the send did NOT land, so the user is never misled that it did).
  useEffect(() => {
    const onAck = (ev: Event) => {
      const d = (ev as CustomEvent).detail as {
        op?: string;
        ok?: boolean;
        reqId?: string;
        error?: string;
        transport?: string;
        prUrl?: string;
      };
      if (d?.op !== 'reply' || !d.reqId) return;
      setPendingSends((q) =>
        q.map((e) =>
          e.reqId === d.reqId ? { ...e, status: d.ok ? 'sent' : 'failed' } : e,
        ),
      );
      if (!d.ok) showToast(`Send failed: ${d.error ?? 'not delivered'}`, 'error');
      // Phase C (task C5): a resume ack resolves the in-flight "resuming…"
      // state started in onNew, matched by reqId (not just session id) so a
      // stale ack from a superseded resume can't clobber a newer one.
      if (d.transport === 'resume' && resumingRef.current?.reqId === d.reqId) {
        const sid = resumingRef.current.sessionId;
        setResuming(null);
        if (d.ok) {
          // No new WS plumbing needed for the transcript (chunks continue
          // streaming automatically) — re-probe liveness so the mode pill
          // flips dormant→steer once the server confirms the session is live.
          olamSessionLiveness(sid).then((liveness) => {
            if (remoteLivenessSessionRef.current === sid) setRemoteLiveness(liveness);
          });
        } else {
          setResumeIssue({ sessionId: sid, message: d.error ?? 'resume failed', prUrl: d.prUrl });
        }
      }
    };
    window.addEventListener('cockpit:ack', onAck);
    return () => window.removeEventListener('cockpit:ack', onAck);
  }, [showToast]);

  // Reconcile optimistic sends against the transcript. A pending clears when a
  // user message matches its text AND lands at/after the send time (ts ≥ at − skew)
  // — the timestamp guard stops an identical OLDER message in history from clearing
  // a fresh send. Each transcript echo is claimed once, so multiple same-text sends
  // resolve one-for-one in FIFO order. Scanning the FULL transcript (not just newly
  // arrived messages) is what lets a pending rehydrated from localStorage after a
  // page reload resolve against history that was already loaded.
  useEffect(() => {
    const sid = cockpit.selectedId;
    if (!sid || !pendingSends.some((e) => e.sessionId === sid)) return;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const toMs = (ts: unknown) =>
      typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) || 0 : 0;
    const SKEW = 5000; // clock-skew tolerance between send time and transcript ts
    const echoes = cockpit.messages
      .filter((m) => m.role === 'user')
      .map((m) => ({ t: norm(msgText(m)), ts: toMs(m.ts) }))
      .filter((e) => e.t);
    setPendingSends((q) => {
      const claimed = new Set<number>();
      const next = q.filter((e) => {
        if (e.sessionId !== sid) return true; // leave other sessions untouched
        const text = norm(e.text);
        const label = norm(e.label);
        const idx = echoes.findIndex(
          (ec, i) =>
            !claimed.has(i) &&
            ec.ts >= e.at - SKEW &&
            (ec.t === text || ec.t === label || ec.t.startsWith(label) || text.startsWith(ec.t)),
        );
        if (idx >= 0) {
          claimed.add(idx);
          return false; // matched a real transcript bubble → drop the optimistic one
        }
        return true; // still pending
      });
      return next.length === q.length ? q : next;
    });
  }, [cockpit.selectedId, cockpit.messages, pendingSends]);

  // TTL backstop for queued/sent bubbles whose transcript echo never arrived.
  // FAILED sends are exempt — they must stay loud until the user sees them.
  useEffect(() => {
    if (pendingSends.length === 0) return;
    const t = setInterval(() => {
      const cutoff = Date.now() - PENDING_SEND_TTL_MS;
      setPendingSends((q) =>
        q.some((e) => e.status !== 'failed' && e.at < cutoff)
          ? q.filter((e) => e.status === 'failed' || e.at >= cutoff)
          : q,
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
    // Pending sends pin to the BOTTOM (near the composer), FIFO, NOT interleaved
    // by time. While a send is un-echoed it isn't really in the transcript yet,
    // so floating it up among the agent's streaming reply reads as "my message
    // moved / the transcript isn't updating" (the reported confusion). Keeping it
    // anchored + clearly tagged (queued/sent/failed) makes its state unambiguous;
    // once the real transcript echo lands, this bubble is removed and the genuine
    // message already sits in its correct chronological place.
    for (const e of selectedPending) {
      base.push({
        role: 'user',
        id: `queued-${e.key}`,
        createdAt: new Date(e.at),
        content: [{ type: 'text', text: e.label }],
        metadata: { custom: { cockpitRole: 'user', optimistic: true, sendStatus: e.status } },
      } as ThreadMessageLike);
    }
    // The "Working…" loader mirrors the session activity icon: same claudeWorking
    // signal (thinking / recent activity), so the two never disagree. A freshly
    // answered AskUserQuestion bridges the brief gap before the pane shows work.
    const sess = cockpit.sessions.find((s) => s.id === cockpit.selectedId);
    const working =
      (!!sess && claudeWorking(sess)) ||
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
  }, [fullConverted, hiddenCount, cockpit.selectedId, cockpit.sessions, selectedPending, answering]);

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

  // Per-session sub-agent mode. Defaults to true for unseen sessions.
  const subAgentModesRef = useRef<Record<string, SubAgentMode>>(loadSubAgentModes());
  const [subAgentModes, setSubAgentModes] = useState<Record<string, SubAgentMode>>(
    () => loadSubAgentModes(),
  );
  const setSubAgentMode = useCallback(
    (sid: string, mode: SubAgentMode) => {
      setSubAgentModes((prev) => {
        const next = { ...prev, [sid]: mode };
        subAgentModesRef.current = next;
        saveSubAgentModes(next);
        return next;
      });
    },
    [],
  );

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

  // Settings modal + Cmd/Ctrl+K command palette.
  const [configOpen, setConfigOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Transcript links: http(s) links from transcript markdown (.aui-md) open in
  // a new browser tab. ⌘/Ctrl/Shift/middle-click already opens a regular new
  // tab natively (delegated click handler bails for those).

  // Delegated capture-phase click handler: intercepts http(s) link clicks that
  // originate inside transcript markdown (.aui-md) and opens them in a new
  // browser tab (markdown anchors have no target="_blank" of their own). Falls
  // through for modifier-key clicks (Cmd/Ctrl/Shift) and middle-mouse so power
  // users still get native tab behavior.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Ignore non-primary clicks and modifier-key clicks (open in new tab).
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const a = target.closest('a');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      // Only intercept http(s) links inside transcript markdown.
      if (!/^https?:\/\//i.test(href)) return;
      if (!a.closest('.aui-md')) return;
      e.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // In-transcript search (⌘/).
  const [searchOpen, setSearchOpen] = useState(false);

  // Raw-terminal escape hatch with an LRU of warm ttyd panels. The server caps
  // ttyd at 4 live (and self-evicts its oldest), so we keep at most the 4 most-
  // recently-used terminals mounted in the background — reopening a recent one
  // is instant; older ones unmount (the server reaps them). `terminalShown`
  // toggles the CURRENT session's panel; switching sessions hides it.
  const TERM_WARM_MAX = 4;
  const [warmTerms, setWarmTerms] = useState<string[]>([]);
  const [terminalShown, setTerminalShown] = useState(false);

  // Bump `id` to most-recently-used; cap the warm set at 4 (drop the oldest).
  const touchWarm = useCallback((id: string) => {
    setWarmTerms((w) => {
      const next = [...w.filter((x) => x !== id), id];
      return next.length > TERM_WARM_MAX ? next.slice(next.length - TERM_WARM_MAX) : next;
    });
  }, []);

  // Preload the selected session's terminal in the background WHEN there's room
  // (≤4 live), debounced so fast switching doesn't thrash ttyd. Once 4 are warm,
  // browsing further doesn't preload — opening one then evicts the oldest.
  useEffect(() => {
    setTerminalShown(false);
    const id = cockpit.selectedId;
    if (!id) return;
    const t = setTimeout(() => {
      setWarmTerms((w) => {
        if (w.includes(id)) return [...w.filter((x) => x !== id), id]; // refresh recency
        if (w.length < TERM_WARM_MAX) return [...w, id];
        return w; // full → leave it; openTerminal will evict-and-load on demand
      });
    }, 500);
    return () => clearTimeout(t);
  }, [cockpit.selectedId]);

  // Open: ensure the current session's panel is warm + visible. Toggle: same key
  // (⌘J) flips it back out. Close keeps it warm for an instant reopen.
  const openTerminal = useCallback(() => {
    const id = cockpit.selectedId;
    if (!id) return;
    touchWarm(id);
    setTerminalShown(true);
  }, [cockpit.selectedId, touchWarm]);
  const toggleTerminal = useCallback(() => {
    const id = cockpit.selectedId;
    if (!id) return;
    setTerminalShown((v) => {
      if (!v) touchWarm(id);
      return !v;
    });
  }, [cockpit.selectedId, touchWarm]);

  // Sub-agent side panel, process monitor, and locally-hidden pane prompt
  // (keyed by JSON signature so it re-shows when the prompt changes). Reset the
  // sub-agent panel when the active session changes.
  const [panelOpen, setPanelOpen] = useState(false);
  // When the panel is opened from a strip row, focus that specific agent.
  const [panelAgentId, setPanelAgentId] = useState<string | null>(null);
  // Inline agent transcript: set by clicking a pill, cleared on session switch or back.
  const [viewingAgentId, setViewingAgentId] = useState<string | null>(null);
  const [processOpen, setProcessOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  // Show/hide the header action-button bar (rename/reset/terminal/search/…),
  // toggled by the ⋯ button in the title row. Persisted so the choice sticks.
  const [actionsOpen, setActionsOpen] = useState(() => {
    try {
      return localStorage.getItem('cc:actionsOpen') !== 'false';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('cc:actionsOpen', String(actionsOpen));
    } catch {
      /* private mode — non-fatal */
    }
  }, [actionsOpen]);
  useEffect(() => {
    setPanelOpen(false);
    setViewingAgentId(null);
    setRawOpen(false);
  }, [cockpit.selectedId]);
  // Pill click → show inline transcript; does NOT open the side panel.
  const openAgent = useCallback((agentId: string) => {
    setViewingAgentId((prev) => (prev === agentId ? null : agentId));
  }, []);
  const closeAgent = useCallback(() => setViewingAgentId(null), []);

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
    // No-op if the name didn't actually change — don't POST or toast.
    const current = cockpit.sessions.find((s) => s.id === id)?.name;
    if (name === current) return;
    try {
      await renameSession(id, name);
      showToast('Renamed →', 'ok');
    } catch (err) {
      showToast(
        `rename failed: ${err instanceof Error ? err.message : 'error'}`,
        'error',
      );
    }
  }, [cockpit.selectedId, cockpit.sessions, renaming, showToast]);

  // Mobile master/detail: reveal the chat pane once a session is selected.
  const [railOpenMobile, setRailOpenMobile] = useState(true);

  // New-session draft screen: shown in the main content area in place of the
  // transcript (mirrors the mobile rail→content navigation a real session
  // selection uses). Closed by Cancel/Esc or by successfully creating a
  // session (onDraftCreated selects the new session, which unmounts this).
  const [draftOpen, setDraftOpen] = useState(false);
  const openDraft = useCallback(() => {
    setDraftOpen(true);
    setRailOpenMobile(false); // mobile: navigate rail → content, same as select()
  }, []);
  const closeDraft = useCallback(() => setDraftOpen(false), []);

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

  // Rail filter (all / claude / terminal) + per-session accordion collapse, both
  // persisted. ⌘1-9 only addresses sessions that are VISIBLE (filter-allowed and
  // in an expanded group), so the badges and the jump stay in lockstep.
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>(() => {
    try {
      const v = localStorage.getItem('cc:sessionFilter');
      return v === 'claude' || v === 'codex' || v === 'terminal' ? v : 'all';
    } catch {
      return 'all';
    }
  });
  const cycleFilter = useCallback(() => {
    setSessionFilter((f) => {
      const next: SessionFilter =
        f === 'all' ? 'agents'
        : f === 'agents' ? 'claude'
        : f === 'claude' ? 'codex'
        : f === 'codex' ? 'terminal'
        : 'all';
      try {
        localStorage.setItem('cc:sessionFilter', next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('cc:collapsedSessions') || '[]'));
    } catch {
      return new Set();
    }
  });
  const toggleCollapse = useCallback((name: string) => {
    setCollapsedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem('cc:collapsedSessions', JSON.stringify([...next]));
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
    // COLLAPSED → width 0. EXPANDED → the rail width is CSS-driven (responsive +
    // ~460px on an external display), so we must NEVER pin an inline width on
    // expand — that overrides the CSS (the old `width:300` bug). Instead clear
    // inline width/flex and let CSS govern; animate up to the CSS width, then
    // clear again so future responsive/external changes apply.
    if (!railCollapsed) {
      if (prefersReducedMotion() || !railAnimatedRef.current) {
        gsap.set(rail, { clearProps: 'width,flexBasis', opacity: 1 });
        railAnimatedRef.current = true;
        return;
      }
      gsap.set(rail, { clearProps: 'width,flexBasis' });
      const targetW = rail.offsetWidth; // the CSS-defined width to animate up to
      gsap.fromTo(
        rail,
        { width: 0, flexBasis: 0, opacity: 0 },
        {
          width: targetW, flexBasis: targetW, opacity: 1, duration: 0.3, ease: 'power3.out',
          onComplete: () => gsap.set(rail, { clearProps: 'width,flexBasis' }),
        },
      );
      return;
    }
    const target = { width: 0, flexBasis: 0, opacity: 0 };
    if (prefersReducedMotion() || !railAnimatedRef.current) {
      gsap.set(rail, target); // instant on first paint / reduced motion
      railAnimatedRef.current = true;
      return;
    }
    gsap.to(rail, { ...target, duration: 0.3, ease: 'power3.out' });
  }, [railCollapsed, narrow]);

  // Subtle content transition when switching sessions (desktop + mobile).
  // Scoped to the thread/live-pane content element only — the .composer is
  // explicitly excluded so it NEVER opacity-fades or y-shifts on session
  // open/switch.  The user requirement is zero animation on the composer
  // except for the voice enter/exit morph.
  useEffect(() => {
    const el = detailBodyRef.current;
    if (!el || !cockpit.selectedId || prefersReducedMotion()) return;
    // Target the scrollable content container.  Priority:
    //   1. .thread-viewport  — transcript sessions (messages scroller)
    //   2. .live-pane        — no-transcript sessions (raw tmux pane)
    //   3. .terminal-pane-root — plain terminal sessions
    // The .composer lives INSIDE .thread-root (a sibling/ancestor of these
    // targets), never as a direct child of .detail-body, so it is not reached.
    const contentEl =
      el.querySelector<HTMLElement>('.thread-viewport') ??
      el.querySelector<HTMLElement>('.live-pane') ??
      el.querySelector<HTMLElement>('.terminal-pane-root');
    if (!contentEl) return; // content not mounted yet — skip (next switch will catch)
    gsap.fromTo(
      contentEl,
      { opacity: 0.35, y: 6 },
      { opacity: 1, y: 0, duration: 0.22, ease: 'power3.out' },
    );
  }, [cockpit.selectedId]);

  // Sticky tail: while PINNED (the viewport sits at the bottom) every new,
  // streaming, OR reflowing message scrolls to the latest — no Ctrl+. needed.
  // `pinned` is simply "are we at the bottom?", recomputed on every scroll: a
  // programmatic tail lands at the bottom → stays pinned; a user scroll-UP off
  // the bottom → detached; scrolling back to the bottom → re-attached. A
  // ResizeObserver tails through late image/code reflow so entering a session
  // (and content that grows after mount) settles AT the bottom instead of
  // latching detached. The programmatic tail is suppressed during an active
  // finger drag / fresh wheel so it never fights the user's gesture.
  useEffect(() => {
    if (!cockpit.selectedId) return;
    let vp: HTMLElement | null = null;
    let btn: HTMLElement | null = null;
    let mo: MutationObserver | null = null;
    let ro: ResizeObserver | null = null;
    let composerRo: ResizeObserver | null = null;
    let raf = 0;
    let tailRaf = 0;
    let tries = 0;
    let pinned = true;
    let touching = false;
    let wheelUntil = 0; // suppress programmatic tail briefly after a wheel
    const THRESHOLD = 80; // px from true bottom that still counts as "at bottom"

    const atBottom = () => !!vp && vp.scrollHeight - vp.scrollTop - vp.clientHeight < THRESHOLD;
    const busy = () => touching || Date.now() < wheelUntil;
    const updateBtn = () => {
      if (btn) btn.dataset.show = vp && !atBottom() ? 'true' : '';
    };
    const tail = () => {
      if (!pinned || busy() || tailRaf) return;
      tailRaf = requestAnimationFrame(() => {
        tailRaf = 0;
        if (vp && pinned && !busy()) vp.scrollTop = vp.scrollHeight;
      });
    };
    // pinned tracks the bottom on every scroll (programmatic tail → bottom →
    // stays pinned; user scroll-up → unpinned). Skipped mid-drag (touchend
    // recomputes it) so an in-flight momentum frame can't transiently unpin.
    const onScroll = () => {
      if (!touching) pinned = atBottom();
      updateBtn();
    };
    const onWheel = () => { wheelUntil = Date.now() + 250; };
    const onTouchStart = () => { touching = true; };
    const onTouchEnd = () => {
      touching = false;
      pinned = atBottom();
      updateBtn();
    };

    const attach = () => {
      vp = document.querySelector('.thread-viewport');
      btn = document.querySelector('.scroll-to-bottom');
      if (!vp) {
        if (tries++ < 60) raf = requestAnimationFrame(attach);
        return;
      }
      pinned = true;
      vp.scrollTop = vp.scrollHeight;
      updateBtn();
      vp.addEventListener('scroll', onScroll, { passive: true });
      vp.addEventListener('touchstart', onTouchStart, { passive: true });
      vp.addEventListener('touchend', onTouchEnd, { passive: true });
      vp.addEventListener('touchcancel', onTouchEnd, { passive: true });
      vp.addEventListener('wheel', onWheel, { passive: true });
      // New / streaming messages (DOM changes) → tail.
      mo = new MutationObserver(tail);
      mo.observe(vp, { childList: true, subtree: true, characterData: true });
      // Size/reflow changes — image + code-highlight loads grow height with NO
      // DOM mutation — also tail, so a freshly-entered (or settling) transcript
      // lands AT the bottom instead of latching detached just above it.
      if ('ResizeObserver' in window) {
        ro = new ResizeObserver(tail);
        const content = vp.firstElementChild;
        if (content) ro.observe(content);
      }

      // Keep the ↓ button + transcript viewport above the composer at any height,
      // and re-tail when the composer grows (e.g. the AskInline morph) so the
      // latest context stays visible. (Respects the pinned guard.)
      const root = vp.closest<HTMLElement>('.thread-root');
      const composer = root?.querySelector<HTMLElement>('.composer') ?? null;
      if (root && composer && 'ResizeObserver' in window) {
        const setH = () => {
          root.style.setProperty('--composer-h', `${composer.offsetHeight}px`);
          tail();
        };
        setH();
        composerRo = new ResizeObserver(setH);
        composerRo.observe(composer);
      }
    };
    raf = requestAnimationFrame(attach);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(tailRaf);
      if (vp) {
        vp.removeEventListener('scroll', onScroll);
        vp.removeEventListener('touchstart', onTouchStart);
        vp.removeEventListener('touchend', onTouchEnd);
        vp.removeEventListener('touchcancel', onTouchEnd);
        vp.removeEventListener('wheel', onWheel);
      }
      if (mo) mo.disconnect();
      if (ro) ro.disconnect();
      if (composerRo) composerRo.disconnect();
    };
  }, [cockpit.selectedId]);
  const select = useCallback(
    (id: string) => {
      cockpit.select(id);
      setRailOpenMobile(false);
      setDraftOpen(false); // selecting a session abandons an open draft
      // Deep-link: reflect the selection in the URL hash so a reload restores
      // it. The token no longer lives in the URL (it's in localStorage), so the
      // hash is the only stateful part of the URL.
      window.location.hash = encodeURIComponent(id);
    },
    [cockpit],
  );

  // New session created from the draft screen: land the user in its
  // transcript, same as tapping it in the rail (the rail itself picks it up
  // on the next ~4s registry refresh).
  const onDraftCreated = useCallback(
    (result: CreateSessionResult) => select(result.target),
    [select],
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
    // hashchange = user pressed back/forward mid-session: always open the
    // transcript (close the rail) just like a manual select() call.
    const fromHash = () => {
      const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
      if (id && id !== cockpit.selectedId && cockpit.sessions.some((s) => s.id === id)) {
        cockpit.select(id);
        setRailOpenMobile(false);
      }
    };
    // Initial restore: wait until at least one session is known. On mobile
    // (narrow) we keep the rail visible so the user lands in the sidebar, not
    // the transcript. The selection is still restored so opening it shows the
    // right session.
    if (!restoredHash.current && cockpit.sessions.length > 0) {
      restoredHash.current = true;
      const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
      if (id && id !== cockpit.selectedId && cockpit.sessions.some((s) => s.id === id)) {
        cockpit.select(id);
        if (!narrow) setRailOpenMobile(false);
      }
    }
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [cockpit, cockpit.sessions, cockpit.selectedId, narrow]);

  const selectedSession = cockpit.sessions.find(
    (s) => s.id === cockpit.selectedId,
  );

  // Phase A (cloud-session-chat task A4) + CP3 audit follow-up (Finding 1):
  // on-demand liveness for the selected remote session, held as SEPARATE
  // component state — never folded onto the polled Session row (that's the
  // 10s-tick object; this is fetched only here, on select, and re-checked
  // server-side immediately before a send). ALWAYS fetched for every remote
  // session on select — isExecuteShaped(selectedSession) with no liveness
  // arg (the `pool` signal) no longer gates whether the fetch happens. That
  // preflight was a circularity trap: a dormant execute session after a
  // cockpit restart has pool=null (a fresh process never observed it
  // inFlight), so the fetch was skipped and the composer silently stayed
  // 'steer'. isExecuteShaped still gates whether the FETCHED result demotes
  // the composer (see remoteComposerMode below) — a plain chat session's
  // liveness result still can't lock it out.
  const [remoteLiveness, setRemoteLiveness] = useState<SessionLiveness | null>(null);
  const remoteLivenessRef = useRef<SessionLiveness | null>(null);
  remoteLivenessRef.current = remoteLiveness;
  const remoteLivenessSessionRef = useRef<string | null>(null);

  // Dormant-session "Resume & send" in-flight + failure state (Phase C, C5).
  // `resuming` mirrors Composer's `compacting` prop shape: it blocks further
  // sends and shows a progress strip until the resume ack lands (or times
  // out). `resumingRef` backs the synchronous re-click guard in onNew.
  const [resuming, setResuming] = useState<{ sessionId: string; reqId: string } | null>(null);
  const resumingRef = useRef<typeof resuming>(null);
  resumingRef.current = resuming;
  const [resumeIssue, setResumeIssue] = useState<{ sessionId: string; message: string; prUrl?: string } | null>(null);

  useEffect(() => {
    // Selection changed: never let a previous session's resume state (or its
    // banner) linger onto a newly-selected one.
    setResuming(null);
    setResumeIssue(null);
  }, [cockpit.selectedId]);

  useEffect(() => {
    if (!resuming) return;
    const id = setTimeout(() => {
      if (resumingRef.current?.reqId !== resuming.reqId) return; // already resolved
      setResuming(null);
      showToast('Resume is taking longer than expected — check the session and retry if needed', 'error');
    }, RESUME_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [resuming, showToast]);

  useEffect(() => {
    // Selection changed: drop the previous session's liveness immediately —
    // a stale dormant/unknown flag from session A must never linger and gate
    // session B's composer for even one render.
    setRemoteLiveness(null);
    remoteLivenessSessionRef.current = null;
    const id = cockpit.selectedId;
    if (!id || selectedSession?.kind !== 'remote') return;
    remoteLivenessSessionRef.current = id;
    olamSessionLiveness(id).then((liveness) => {
      if (remoteLivenessSessionRef.current !== id) return; // selection moved on while awaiting
      setRemoteLiveness(liveness);
    });
    // selectedSession is re-derived from cockpit.selectedId + cockpit.sessions
    // every render; keying on cockpit.selectedId alone (mirroring the reset
    // effect below) avoids re-fetching on every unrelated session-list
    // refresh (the 10s tick, R5) while still reading the fresh value via
    // closure when the effect actually runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cockpit.selectedId]);

  // Remote (olam) composer mode + hard-steer toggle (Phase C; liveness Phase A).
  const remoteMode = useMemo(
    () => (selectedSession?.kind === 'remote' ? remoteComposerMode(selectedSession, remoteLiveness) : null),
    [selectedSession, remoteLiveness],
  );
  // Phase B (task B3): the same routing predicate the server's
  // dispatchLiveSteer uses to pick the steer door over cloud-dispatch. Drives
  // the hard-steer toggle's gating (OQ6 — hard steer needs a live session)
  // and the next-turn-boundary copy on a queued soft send.
  const remoteLiveSteerDoor = useMemo(
    () => (selectedSession?.kind === 'remote' ? shouldSteerDoor(selectedSession, remoteLiveness) : false),
    [selectedSession, remoteLiveness],
  );
  const [steerHard, setSteerHard] = useState(false);
  const steerHardRef = useRef(false);
  steerHardRef.current = steerHard;

  // Selection changed: hard steer must never silently carry over from a
  // previous live session into a newly-selected one. It now gates a real
  // functional choice (Phase B) rather than being purely cosmetic, so a
  // stale `true` shouldn't linger even though the disabled toggle already
  // blocks re-enabling it on a non-live session. Mirrors the liveness reset
  // effect above.
  useEffect(() => {
    setSteerHard(false);
  }, [cockpit.selectedId]);

  // A session whose sandbox has very likely been torn down can't offer a
  // live terminal — the runner HMAC mint would just fail or point at a dead
  // sandbox. `archived` (lib/olam-archive.js deriveArchived) already folds in
  // halted / terminal canonical status / phase:'done', so it's the single
  // signal to check here. Render a placeholder instead of attempting to open one.
  const remoteSandboxEnded = selectedSession?.kind === 'remote' && selectedSession.archived === true;

  // Phase D / inline-terminal — a remote session's live terminal renders INLINE
  // (the runner's self-contained xterm.js page already carries its own `?t=`
  // HMAC token, so it iframes fine cross-origin; no CF Access needed for it).
  // uiUrl is cached per session id so re-toggling doesn't re-mint the token on
  // every open; switching sessions resets the panel closed.
  const [remoteTermOpen, setRemoteTermOpen] = useState(false);
  const [remoteTermUrl, setRemoteTermUrl] = useState<string | null>(null);
  const [remoteTermLoading, setRemoteTermLoading] = useState(false);
  const remoteTermSessionRef = useRef<string | null>(null);

  useEffect(() => {
    // Selection changed: close the panel and drop the cached URL (a stale
    // token for the PREVIOUS session must never render for the new one).
    setRemoteTermOpen(false);
    setRemoteTermUrl(null);
    remoteTermSessionRef.current = null;
  }, [cockpit.selectedId]);

  const toggleRemoteTerminal = useCallback(async () => {
    const id = cockpit.selectedId;
    if (!id) return;
    setRemoteTermOpen((v) => !v);
    if (remoteTermSessionRef.current === id && remoteTermUrl) return; // already minted for this session
    remoteTermSessionRef.current = id;
    setRemoteTermLoading(true);
    try {
      const { uiUrl } = await olamTerminalToken(id);
      if (remoteTermSessionRef.current !== id) return; // selection moved on while awaiting
      if (uiUrl) setRemoteTermUrl(uiUrl);
      else showToast('No terminal URL available for this session', 'error');
    } catch (err) {
      showToast(`Terminal token failed: ${(err as Error).message}`, 'error');
    } finally {
      if (remoteTermSessionRef.current === id) setRemoteTermLoading(false);
    }
  }, [cockpit.selectedId, remoteTermUrl, showToast]);

  // "Answer settling" state: suppresses the scrape prompt / synthesized-ask
  // from reflashing after the user answers, until the TUI picker has visually
  // disappeared. See web/src/lib/answerSettle.ts for design rationale.
  //
  // WHY NOT the old fixed-1800ms timer: the server re-scrapes every ~2000ms and
  // re-broadcasts {type:'prompt'} while the picker is still on screen. Once
  // 1800ms elapsed but the picker was still up, activePrompt re-opened → flash.
  // This state is instead cleared by the AUTHORITATIVE pickerOpen=false signal.
  const [answerSettling, setAnswerSettling] = useState(false);
  const [settleDeadline, setSettleDeadline] = useState(0);

  // Clear settling once BOTH signals confirm the answer is fully processed:
  //   1. pickerOpen=false — {type:'picker', open:false} frame: picker is gone.
  //   2. cockpit.prompt falsy — scrape prompt has cleared; no stale frame remains.
  //
  // WHY BOTH: the two frames are separate WebSocket messages with no ordering
  // guarantee. If we clear answerSettling on pickerOpen=false alone, a stale
  // scrape {type:'prompt'} frame that hasn't yet cleared will cause
  // shouldShowPrompt to return true for one render (the frame-ordering flash).
  // Waiting for both signals closes that window entirely. The safety cap in
  // markAnswered() bounds the worst-case duration so this can never suppress
  // indefinitely when the prompt never clears (e.g. server bug / new question).
  useEffect(() => {
    if (!cockpit.pickerOpen && !cockpit.prompt && answerSettling) {
      setAnswerSettling(false);
      setSettleDeadline(0);
    }
  // Re-run whenever either signal changes; answerSettling read via closure is fine.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cockpit.pickerOpen, cockpit.prompt]);

  const markAnswered = useCallback(() => {
    const deadline = Date.now() + SETTLE_CAP_MS;
    setAnswerSettling(true);
    setSettleDeadline(deadline);
    // Safety cap: release after SETTLE_CAP_MS even if pickerOpen never flips.
    // Prevents permanent suppression if the server never sends picker=false.
    // Extra 50ms skew avoids racing the exact deadline boundary.
    window.setTimeout(() => {
      setAnswerSettling(false);
      setSettleDeadline(0);
    }, SETTLE_CAP_MS + 50);
  }, []);

  // Compute the single active prompt for the inline morph. Prefer structured
  // `pending` (AskUserQuestion) over the screen-scrape `prompt` (PanePrompt).
  const activePrompt = useMemo<ActivePrompt | null>(() => {
    if (cockpit.pending) return { kind: 'ask', pending: cockpit.pending };
    // Fallback: the session's boolean flag is set but no tailer-supplied Pending
    // object is available (tailer-less sessions). Synthesize a minimal Pending so
    // AskBody renders and the user is never left unable to answer. The FLAG sentinel
    // id is intentional — onAnswer will fail silently server-side, and onReply
    // routes the typed text normally. AskBody appends free-text rows itself.
    //
    // GUARD: `selectedSession.pending` is the MERGED registry flag — it is also
    // true for pane-scrape pickers (permission / trust / plan / numbered menus),
    // which MUST render via the structured `kind:'prompt'` branch below, not this
    // free-text ask fallback. So only synthesize when there is NO scrape prompt
    // (`!cockpit.prompt`). That isolates the real gap: an AskUserQuestion flagged
    // open on a tailer-less session, where neither `cockpit.pending` nor a scrape
    // `cockpit.prompt` is available — exactly the blind state we're fixing.
    if (
      !cockpit.prompt &&
      selectedSession?.pending === true &&
      shouldShowSynthesizedAsk({
        pickerOpen: cockpit.pickerOpen,
        answerSettling,
        settleDeadline,
        now: Date.now(),
      })
    ) {
      const flagQuestion = (
        selectedSession.pendingQuestion || 'Claude is asking a question'
      ).trim();
      const synthesized: Pending = {
        toolUseId: FLAG_PENDING_TOOL_USE_ID,
        questions: [{ question: flagQuestion, options: [] }],
      };
      return { kind: 'ask', pending: synthesized };
    }
    if (
      shouldShowPrompt({
        hasPrompt: !!cockpit.prompt,
        pickerOpen: cockpit.pickerOpen,
        answerSettling,
        settleDeadline,
        now: Date.now(),
      })
    ) {
      return {
        kind: 'prompt',
        prompt: cockpit.prompt!,
        planMarkdown,
        agentName: selectedSession?.kind === 'codex' ? 'Codex' : 'Claude',
      };
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cockpit.pending, cockpit.prompt, cockpit.pickerOpen, planMarkdown, selectedSession?.kind, selectedSession?.pending, selectedSession?.pendingQuestion, answerSettling, settleDeadline]);

  const askActive = activePrompt !== null;

  // The live unanswered AskUserQuestion to surface in the transcript timeline.
  // Claude Code records the question turn to the JSONL only when answered (and
  // sub-agent questions live in agent-*.jsonl, never the main transcript), so the
  // chat would otherwise show nothing until the answer lands. Render it from the
  // live pending state — UNLESS the real tool_use is already in the transcript
  // (main-agent written-on-open), where AskAnsweredPart already shows it (no dup).
  const incomingAsk = useMemo<Pending | null>(() => {
    if (activePrompt?.kind !== 'ask') return null;
    const id = activePrompt.pending.toolUseId;
    const alreadyInTranscript = transcriptHasToolUse(cockpit.messages, 'AskUserQuestion', id);
    return alreadyInTranscript ? null : activePrompt.pending;
  }, [activePrompt, cockpit.messages]);

  // True while the selected Claude session is actively generating/thinking,
  // OR while a just-sent message is still unconfirmed (bridges the ~2-4s poll
  // gap so the working indicator fires immediately on send). Capped at 20s so a
  // stray send that never echoes back doesn't stick forever.
  const SEND_BRIDGE_MS = 20_000;
  const hasFreshPending =
    selectedPending.length > 0 &&
    selectedPending.some((e) => Date.now() - e.at < SEND_BRIDGE_MS);
  const agentWorking =
    (!!selectedSession && claudeWorking(selectedSession)) || hasFreshPending;

  // Cancel in-flight generation: send Escape to the Claude pane.
  const handleStop = useCallback(() => {
    cockpit.sendPromptKey('Escape');
    showToast('Canceled →');
  }, [cockpit, showToast]);

  // Free-text reply from the inline prompt: same path as a normal composer send.
  const onInlineReply = useCallback((text: string) => {
    if (!text.trim()) return;
    // viaAnswer=true: this is the trailing free-text of a deliberate answer routed
    // through the inline component (which already navigated the picker), so the
    // server's open-question reply guard must allow it through.
    cockpit.sendReply(text, 0, true);
    markAnswered();
  }, [cockpit, markAnswered]);

  // Active session's sub-agent mode (default true for unseen sessions).
  const activeSubAgentMode: SubAgentMode =
    cockpit.selectedId != null
      ? (subAgentModes[cockpit.selectedId] ?? true)
      : true;
  const onActiveSubAgentModeChange = useCallback(
    (mode: SubAgentMode) => {
      if (cockpit.selectedId) setSubAgentMode(cockpit.selectedId, mode);
    },
    [cockpit.selectedId, setSubAgentMode],
  );

  // ⌘K / Ctrl-K toggles the command palette (swap sessions/terminals, jump to
  // the raw tmux window, run global actions) from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Detail-head shortcuts (these mirror the header icon buttons + their reveal
  // badges): ⌘J raw terminal · ⌘U sub-agents · ⌘B minimise sidebar. (Rename has
  // NO shortcut — ⌘/Ctrl+E is left free; Ctrl+E is end-of-line in the shell.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        toggleRail();
      } else if (k === 'j' && selectedSession) {
        e.preventDefault();
        toggleTerminal();
      } else if (k === 'u' && cockpit.subagents.length > 0) {
        e.preventDefault();
        setPanelAgentId(null); // ⌘U opens the list, not a focused agent
        setPanelOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedSession, cockpit.subagents.length, toggleRail, toggleTerminal]);

  // Claude panes ⌘1-9 can address: VISIBLE ones only — filter must allow Claude
  // (not 'terminal') and the session group must be expanded — in rail order. The
  // rail's badges read from the same list, so badge ⌘N always selects row N.
  const addressableClaude = useMemo(() => {
    if (sessionFilter === 'terminal') return [];
    return cockpit.sessions
      .filter((s) => s.kind !== 'terminal' && !collapsedSessions.has(s.sessionName ?? '?'))
      .sort(
        (a, b) =>
          (a.sessionName ?? '').localeCompare(b.sessionName ?? '', undefined, { numeric: true }) ||
          (a.windowIndex ?? 0) - (b.windowIndex ?? 0) ||
          (a.paneIndex ?? 0) - (b.paneIndex ?? 0),
      );
  }, [cockpit.sessions, sessionFilter, collapsedSessions]);
  const railHotkeys = useMemo(() => {
    const m = new Map<string, string>();
    addressableClaude.slice(0, 9).forEach((s, i) => m.set(s.id, `⌘${i + 1}`));
    return m;
  }, [addressableClaude]);

  // ⌘/Ctrl+1‑9 jumps to the Nth addressable Claude session. Skipped while the
  // command palette is open — it uses ⌘N for its own quick-select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paletteOpen) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const target = addressableClaude[Number(e.key) - 1];
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        // Release a stuck ttyd iframe first (it swallows keydowns in its own
        // document, so the window listener wouldn't fire while it holds focus).
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae.tagName === 'IFRAME') ae.blur();
        // Close any open ttyd overlay BEFORE select() so React batches both state
        // updates — otherwise the new session's TerminalPanel can briefly see
        // visible=true and steal focus into its iframe.
        setTerminalShown(false);
        select(target.id);
        // Land focus in the composer so you can type immediately (the default on
        // every switch). For terminal sessions there's no .composer-input, so the
        // visible terminal pane keeps its own focus. The hidden-terminal focus
        // steal is handled separately (TerminalPanel's in-iframe guard).
        const focusComposer = () => {
          document
            .querySelector<HTMLTextAreaElement>('.composer-input')
            ?.focus({ preventScroll: true });
        };
        const rafId = requestAnimationFrame(() => {
          focusComposer();
          // Bring the just-selected session into view in the rail on every switch.
          document
            .querySelector<HTMLElement>('.session-item[data-selected="true"]')
            ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
        // The ask/voice morph-exit also focuses the composer ~200ms later; re-assert
        // once past that so the composer reliably ends up focused across the morph.
        const reassert = window.setTimeout(focusComposer, 320);
        return () => {
          cancelAnimationFrame(rafId);
          clearTimeout(reassert);
        };
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [addressableClaude, paletteOpen, select, setTerminalShown]);

  // ⌘/Ctrl+Enter from anywhere jumps focus back INTO the composer — but only when
  // focus isn't already in a text field (where ⌘Enter means send/optimise) and no
  // modal is open (whose own ⌘Enter handler should win).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return; // a dialog owns ⌘Enter
      const composer = document.querySelector<HTMLTextAreaElement>('.composer .composer-input');
      if (composer) {
        e.preventDefault();
        composer.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Escape-to-cancel: when the selected session is actively generating,
  // pressing Esc sends an Escape keystroke to the Claude pane (same as clicking
  // the STOP button). Bail if a dialog, skill-ac dropdown, or terminal mode owns
  // the Esc so those handlers win.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[aria-modal="true"]')) return; // dialog owns Esc
      if (document.querySelector('.skill-ac')) return;           // autocomplete owns Esc
      if (composerTerminalRef.current) return;                   // terminal mode owns Esc
      if (!agentWorking) return;                                 // nothing in flight
      e.preventDefault();
      cockpit.sendPromptKey('Escape');
      showToast('Canceled →');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [agentWorking, cockpit, showToast]);

  // ⌘/Ctrl+. scrolls the transcript to the latest (re-attaches tailing — the
  // controller's scroll listener flips back to pinned once it reaches bottom).
  // (⌘. not ↓: iPad/Safari reserves ⌘↓.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isPeriod = e.key === '.' || e.code === 'Period';
      if (!isPeriod || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return; // let dialogs handle keys
      const vp = document.querySelector<HTMLElement>('.thread-viewport');
      if (vp) {
        e.preventDefault();
        vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
      }
    };
    // Capture phase to beat any browser handling of ⌘.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Count of sub-agents actively running (drives the animated Agents button +
  // the above-composer strip). Done agents stay reachable via the panel.
  const runningAgents = cockpit.subagents.filter((a) => a.status === 'running').length;

  // ⌘/Ctrl+/ toggles the in-transcript search box. Capture phase so it never
  // leaks to the browser's built-in quick-find (⌘F). Esc to close is handled
  // inside TranscriptSearch itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Palette command list: one switch entry per pane, then global actions
  // (including "View raw tmux window" for the current session).
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const base = (cwd?: string) => (cwd ? cwd.replace(/\/$/, '').split('/').pop() || cwd : '');
    const cmds: PaletteCommand[] = [];
    // Sessions BEFORE Terminals; within each, mirror the rail's natural tmux
    // order (session name → window → pane) so positions feel stable.
    const ordered = [...cockpit.sessions].sort((a, b) => {
      const at = a.kind === 'terminal' ? 1 : 0;
      const bt = b.kind === 'terminal' ? 1 : 0;
      if (at !== bt) return at - bt;
      return (
        (a.sessionName ?? '').localeCompare(b.sessionName ?? '', undefined, { numeric: true }) ||
        (a.windowIndex ?? 0) - (b.windowIndex ?? 0) ||
        (a.paneIndex ?? 0) - (b.paneIndex ?? 0)
      );
    });
    for (const s of ordered) {
      const term = s.kind === 'terminal';
      cmds.push({
        id: `switch:${s.id}`,
        label: s.name || s.title || s.tmuxName || s.id,
        hint: [term ? 'terminal' : base(s.cwd), s.pending ? 'ASK' : ''].filter(Boolean).join(' · '),
        keywords: `${s.sessionName ?? ''} ${s.cwd ?? ''} ${s.id}`,
        group: term ? 'Terminals' : 'Sessions',
        run: () => select(s.id),
      });
    }
    cmds.push(
      {
        id: 'act:tmux-window',
        label: 'View raw tmux window',
        hint: selectedSession ? selectedSession.name || selectedSession.id : 'select a session first',
        group: 'Actions',
        keywords: 'terminal ttyd pane window',
        run: () => openTerminal(),
      },
      {
        id: 'act:new-session',
        label: 'New session',
        group: 'Actions',
        keywords: 'create start claude',
        run: () => {
          showToast('Creating session…');
          createSession({})
            .then((r) => showToast(`Session created → ${r.name}`, 'ok'))
            .catch((err) => showToast(`New session failed: ${(err as Error).message}`, 'error'));
        },
      },
      {
        id: 'act:processes',
        label: 'Processes & system',
        group: 'Actions',
        keywords: 'ps aux kill cpu memory battery power',
        run: () => setProcessOpen(true),
      },
      {
        id: 'act:settings',
        label: 'Settings',
        group: 'Actions',
        keywords: 'config preferences model mlx',
        run: () => setConfigOpen(true),
      },
      {
        id: 'act:toggle-sidebar',
        label: railCollapsed ? 'Show sidebar' : 'Hide sidebar (focus mode)',
        group: 'Actions',
        keywords: 'rail collapse focus',
        run: () => toggleRail(),
      },
      {
        id: 'act:rematch-all',
        label: 'Re-match all windows (clear stale pins)',
        group: 'Actions',
        keywords: 'rebind pin transcript stale stuck old conversation rematch',
        run: () => {
          showToast('Re-matching all windows…');
          rematchAll()
            .then(() => showToast('All windows re-matched →', 'ok'))
            .catch((err) => showToast(`Re-match failed: ${(err as Error).message}`, 'error'));
        },
      },
      {
        id: 'act:reload',
        label: 'Reload app',
        group: 'Actions',
        keywords: 'refresh',
        run: () => window.location.reload(),
      },
    );
    return cmds;
  }, [cockpit.sessions, cockpit.selectedId, selectedSession, railCollapsed, select, toggleRail, showToast, openTerminal]);

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

  // Holding ⌘/Ctrl reveals hotkey affordances (incl. the scroll-to-bottom
  // button + its ⌘. badge). Same 500ms hold the HotkeyHints overlay uses.
  const cmdHeld = useModifierHeld(500);

  // Focus-steal guard: warm/hidden ttyd panels keep their <iframe> loaded, and
  // ttyd/xterm INSIDE the iframe calls .focus() on itself (on load + on poll).
  // `inert` + delayed `visibility:hidden` don't reliably stop an iframe's own
  // document from grabbing focus, so a hidden terminal can silently steal it —
  // popping the keyboard and eating every hotkey. Catch focus landing on any
  // term iframe whose overlay isn't currently visible and bounce it back out.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.tagName !== 'IFRAME' || !t.classList.contains('term-frame')) return;
      const overlay = t.closest('.term-overlay');
      if (overlay && overlay.getAttribute('data-visible') === 'true') return; // legit, visible
      (t as HTMLIFrameElement).blur();
      // Land in the composer (ready to type) rather than parking on the body.
      const ci = document.querySelector<HTMLTextAreaElement>('.composer-input');
      if (ci) ci.focus({ preventScroll: true });
      else {
        const host = document.querySelector<HTMLElement>('.detail-body') ?? document.body;
        host.setAttribute('tabindex', '-1');
        host.focus({ preventScroll: true });
      }
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, []);


  return (
    <AssistantRuntimeProvider runtime={runtime}>
    <ArtifactPanelProvider>
      <div
        ref={appRef}
        className="app"
        data-detail={(cockpit.selectedId || draftOpen) && !railOpenMobile ? 'open' : 'closed'}
        data-rail-collapsed={!narrow && railCollapsed ? 'true' : undefined}
        data-cmd-held={cmdHeld ? 'true' : undefined}
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
        <PermissionBanner show={cockpit.sessions.some((s) => s.permIssue)} />
        {showIosHint ? (
          <div className="ios-push-hint" role="note">
            On iPhone/iPad, add this site to your Home Screen to receive push
            notifications.
          </div>
        ) : null}

        <div className="app-body">
          <aside className="rail" ref={railRef}>
            <NewSessionForm onOpenDraft={openDraft} filter={sessionFilter} onCycleFilter={cycleFilter} />
            <div className="rail-scroll">
              <SessionRail
                sessions={cockpit.sessions}
                selectedId={cockpit.selectedId}
                onSelect={select}
                filter={sessionFilter}
                collapsed={collapsedSessions}
                onToggleCollapse={toggleCollapse}
                hotkeyById={railHotkeys}
                workingOverrideId={agentWorking ? cockpit.selectedId : null}
                runningSubagentCountById={cockpit.runningSubagentCountById}
              />
            </div>
            {/* Bottom bar: reload + settings + process monitor, all on one level
                at the sidebar foot. */}
            <div className="rail-foot">
              <button
                type="button"
                className="rail-foot-btn rail-foot-icon reload-foot"
                aria-label="Reload app"
                title="Reload app"
                onClick={() => window.location.reload()}
              >
                <span className="reload-glyph" aria-hidden="true">↻</span>
              </button>
              <button
                type="button"
                className="rail-foot-btn"
                aria-label="Settings"
                title="Settings"
                onClick={() => setConfigOpen(true)}
              >
                <SettingsIcon size={16} />
                <span>Settings</span>
              </button>
              <button
                type="button"
                className="rail-foot-btn rail-foot-icon"
                aria-label="Processes & system"
                title="Processes & system"
                onClick={() => setProcessOpen(true)}
              >
                <ActivityIcon size={16} />
              </button>
            </div>
          </aside>

          <main className="detail">
            {draftOpen ? (
              <NewSessionDraft
                filter={sessionFilter}
                onToast={showToast}
                onCancel={closeDraft}
                onCreated={onDraftCreated}
              />
            ) : (
              <>
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
                  <>
                    <span className="detail-name">
                      {sessionDisplayLabel(selectedSession, cockpit.selectedId)}
                    </span>
                    {selectedSession?.cwd ? (
                      <span className="detail-cwd" title={selectedSession.cwd}>
                        {selectedSession.cwd.replace(/\/$/, '').split('/').pop() || selectedSession.cwd}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
              {/* ⋯ toggle: show/hide the action bar. Lives OUTSIDE .detail-actions
                  (which collapses) so it stays visible to bring the bar back. */}
              {selectedSession && renaming === null ? (
                <button
                  type="button"
                  className="detail-action detail-actions-toggle"
                  aria-pressed={actionsOpen}
                  data-on={actionsOpen ? 'true' : undefined}
                  aria-label={actionsOpen ? 'Hide actions' : 'Show actions'}
                  title={actionsOpen ? 'Hide actions' : 'Show actions'}
                  onClick={() => setActionsOpen((v) => !v)}
                >
                  <EllipsisIcon />
                </button>
              ) : null}
              {/* All actions live on the RIGHT, as uniform small icon buttons. */}
              <div className="detail-actions" data-collapsed={!actionsOpen ? 'true' : undefined}>
                {selectedSession && renaming === null ? (
                  <>
                    <button
                      type="button"
                      className="detail-action"
                      aria-label="Rename session"
                      title="Rename session"
                      onClick={() => setRenaming(selectedSession.name ?? selectedSession.id)}
                    >
                      <PencilIcon />
                    </button>
                    <button
                      type="button"
                      className="detail-action"
                      aria-label="Reset transcript binding"
                      title="Reset binding — re-match this window to its current transcript (after /clear or a new session)"
                      onClick={async () => {
                        const id = selectedSession.id;
                        try {
                          await resetBinding(id);
                          showToast('Re-matching transcript →', 'ok');
                        } catch (err) {
                          showToast(`Reset failed: ${(err as Error).message}`, 'error');
                        }
                      }}
                    >
                      <RefreshIcon />
                    </button>
                    <button
                      type="button"
                      className="detail-action"
                      aria-label="Open raw terminal"
                      title="Raw terminal (⌘J)"
                      data-hotkey="⌘J"
                      data-hotkey-dir="down"
                      onClick={openTerminal}
                    >
                      <TerminalSquareIcon />
                    </button>
                    <button
                      type="button"
                      className="detail-action"
                      aria-pressed={searchOpen}
                      data-on={searchOpen ? 'true' : undefined}
                      aria-label="Search transcript"
                      title="Search transcript (⌘/)"
                      data-hotkey="⌘/"
                      data-hotkey-dir="down"
                      onClick={() => setSearchOpen((v) => !v)}
                    >
                      <SearchIcon />
                    </button>
                    <button
                      type="button"
                      className="detail-action detail-action--count"
                      aria-pressed={rawOpen}
                      data-on={rawOpen ? 'true' : undefined}
                      aria-label="Raw events"
                      title="Raw events"
                      onClick={() => setRawOpen((v) => !v)}
                    >
                      <ActivityIcon />
                      {cockpit.rawEvents.length > 0 ? (
                        <span className="detail-action-count">{Math.min(cockpit.rawEvents.length, 99)}</span>
                      ) : null}
                    </button>
                    {cockpit.subagents.length > 0 ? (
                      <button
                        type="button"
                        className="detail-action detail-action--count"
                        aria-pressed={panelOpen}
                        data-on={panelOpen ? 'true' : undefined}
                        data-running={runningAgents > 0 ? 'true' : undefined}
                        aria-label={
                          runningAgents > 0
                            ? `${runningAgents} sub-agent${runningAgents === 1 ? '' : 's'} running`
                            : 'Sub-agents'
                        }
                        title="Sub-agents (⌘U)"
                        data-hotkey="⌘U"
                        data-hotkey-dir="down"
                        onClick={() => { setPanelAgentId(null); setPanelOpen((v) => !v); }}
                      >
                        <BotIcon />
                        {runningAgents > 0 ? (
                          <span className="detail-action-count">{runningAgents}</span>
                        ) : null}
                      </button>
                    ) : null}
                    {/* Olam (remote) controls — folded into the shared action bar
                        (was a standalone .olam-steer-bar row in the transcript area).
                        Green-accented so they read as remote-specific at a glance;
                        absent entirely for local sessions since remoteMode is null. */}
                    {remoteMode ? (
                      <>
                        <button
                          type="button"
                          className="detail-action detail-action--olam"
                          aria-pressed={remoteTermOpen}
                          data-on={remoteTermOpen ? 'true' : undefined}
                          disabled={remoteSandboxEnded}
                          aria-label="Remote terminal"
                          title={
                            remoteSandboxEnded
                              ? 'Sandbox ended — no live terminal'
                              : remoteTermOpen
                                ? 'Close the inline terminal'
                                : 'Open a live terminal into this sandbox'
                          }
                          onClick={() => void toggleRemoteTerminal()}
                        >
                          <TerminalSquareIcon />
                        </button>
                        {remoteMode === 'steer' ? (
                          <button
                            type="button"
                            className="detail-action detail-action--olam"
                            aria-pressed={steerHard}
                            data-on={steerHard ? 'true' : undefined}
                            disabled={!remoteLiveSteerDoor}
                            aria-label={steerHard ? 'Hard steer on' : 'Hard steer off'}
                            title={
                              !remoteLiveSteerDoor
                                ? 'Hard steer needs a confirmed-live session — replies queue as a soft steer until then'
                                : steerHard
                                  ? `Hard steer on — replies interrupt ${selectedSession?.org ?? 'the agent'} immediately`
                                  : `Hard steer off — replies queue for ${selectedSession?.org ?? 'the agent'}`
                            }
                            onClick={() => setSteerHard((v) => !v)}
                          >
                            <SteeringWheelIcon />
                          </button>
                        ) : null}
                        {/* Exhaustive by construction: remoteModeLabel/remoteModeTitle switch
                            on every RemoteComposerMode value and fail TS compilation (never
                            never) if a new mode is added without a pill — no silent 'steer'
                            fallback for dormant/unknown (task A4). */}
                        <span
                          className={`detail-action-pill detail-action-pill--${remoteMode}`}
                          role="status"
                          title={
                            remoteMode === 'steer'
                              ? `steering ${selectedSession?.org ?? ''}`
                              : remoteModeTitle(remoteMode)
                          }
                        >
                          {remoteModeLabel(remoteMode)}
                        </span>
                        {selectedSession?.prs?.length ? (
                          <a
                            href={selectedSession.prs[0].url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="detail-action detail-action--olam"
                            aria-label="Open PR"
                            title={
                              selectedSession.prs.length > 1
                                ? `${selectedSession.prs.length} PRs — open the first`
                                : `Open PR #${selectedSession.prs[0].number ?? ''}`
                            }
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLinkIcon />
                            {selectedSession.prs.length > 1 ? (
                              <span className="detail-action-count">{selectedSession.prs.length}</span>
                            ) : null}
                          </a>
                        ) : null}
                      </>
                    ) : null}
                  </>
                ) : null}
                <button
                  type="button"
                  className="detail-action focus-toggle"
                  aria-pressed={railCollapsed}
                  aria-label={railCollapsed ? 'Show sidebar' : 'Focus mode (hide sidebar)'}
                  title={railCollapsed ? 'Show sidebar (⌘B)' : 'Focus mode (hide sidebar) (⌘B)'}
                  data-hotkey="⌘B"
                  data-hotkey-dir="down"
                  onClick={toggleRail}
                >
                  <PanelLeftIcon />
                </button>
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
            ) : (
              <div className="detail-split">
                {cockpit.degraded?.degraded ? (
                  <div className="olam-degraded-banner" role="status">
                    ⚠ log tail only — live conversation stream unavailable
                    {cockpit.degraded.reason ? ` (${cockpit.degraded.reason})` : ''}
                  </div>
                ) : null}
                {resumeIssue?.sessionId === cockpit.selectedId ? (
                  <div className="olam-resume-banner" role="alert">
                    ⚠ {resumeIssue.message}
                    {resumeIssue.prUrl ? (
                      <a href={resumeIssue.prUrl} target="_blank" rel="noopener noreferrer">
                        open PR ↗
                      </a>
                    ) : null}
                    <button type="button" onClick={() => setResumeIssue(null)} aria-label="Dismiss">
                      ✕
                    </button>
                  </div>
                ) : null}
                {remoteTermOpen && selectedSession?.kind === 'remote' ? (
                  <div className="olam-terminal-panel">
                    <div className="olam-terminal-panel-head">
                      <span>Live terminal</span>
                      <button
                        type="button"
                        className="olam-terminal-panel-close"
                        aria-label="Close terminal"
                        onClick={() => setRemoteTermOpen(false)}
                      >
                        ✕
                      </button>
                    </div>
                    {remoteSandboxEnded ? (
                      <div className="olam-terminal-placeholder">
                        Sandbox ended — no live terminal (transcript is still available)
                      </div>
                    ) : remoteTermLoading && !remoteTermUrl ? (
                      <div className="olam-terminal-placeholder">Minting terminal token…</div>
                    ) : remoteTermUrl ? (
                      <>
                        <iframe
                          src={remoteTermUrl}
                          className="olam-terminal-frame"
                          title="Remote sandbox terminal"
                        />
                        <a
                          className="olam-terminal-newtab"
                          href={remoteTermUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          open in new tab ↗
                        </a>
                      </>
                    ) : (
                      <div className="olam-terminal-placeholder">No terminal URL available for this session</div>
                    )}
                  </div>
                ) : null}
                <AgentKindContext.Provider value={selectedSession?.kind === 'remote' ? 'claude' : selectedSession?.kind ?? 'claude'}>
                <LiveThinkingContext.Provider value={liveThinkingId}>
                  {/* Catch a render crash in the transcript so one bad message
                      can't white-screen the whole app; resets on session switch. */}
                  <ErrorBoundary
                    resetKey={cockpit.selectedId ?? undefined}
                    label="This conversation failed to render"
                  >
                  <Thread
                    hasSelection={!!cockpit.selectedId}
                    agentName={selectedSession?.kind === 'codex' ? 'Codex' : 'Claude'}
                    loading={!cockpit.messagesLoaded}
                    emptyState={
                      selectedSession?.kind === 'remote'
                        ? { heading: 'No transcript yet — waiting for the agent' }
                        : null
                    }
                    sessionId={cockpit.selectedId}
                    hiddenCount={hiddenCount}
                    onLoadEarlier={loadEarlier}
                    subAgentMode={activeSubAgentMode}
                    onSubAgentModeChange={onActiveSubAgentModeChange}
                    onTerminalModeChange={onTerminalModeChange}
                    subagents={cockpit.subagents}
                    onOpenAgent={openAgent}
                    viewingAgent={
                      viewingAgentId
                        ? (cockpit.subagents.find((a) => a.agentId === viewingAgentId) ?? null)
                        : null
                    }
                    onCloseAgent={closeAgent}
                    working={agentWorking}
                    compacting={!!selectedSession?.compacting}
                    resuming={resuming?.sessionId === cockpit.selectedId}
                    errored={!!selectedSession?.errored}
                    onRetry={() => {
                      const ok = cockpit.sendReply('Continue');
                      showToast(ok ? 'Retry → Continue' : 'Not connected', ok ? 'ok' : 'error');
                    }}
                    onStop={handleStop}
                    askActive={askActive}
                    activePrompt={activePrompt}
                    incomingAsk={incomingAsk}
                    onAnswer={(toolUseId, selections) => {
                      cockpit.sendAnswer(toolUseId, selections);
                      cockpit.clearCapture();
                      markAnswered();
                      if (cockpit.selectedId) {
                        setAnswering({
                          sessionId: cockpit.selectedId,
                          baseCount: cockpit.messages.length,
                        });
                      }
                    }}
                    onKey={(key) => { cockpit.sendPromptKey(key); markAnswered(); }}
                    onSelect={(labels) => {
                      markAnswered();
                      return cockpit.selectedId
                        ? cockpit.sendPromptSelect(cockpit.selectedId, labels)
                        : false;
                    }}
                    onReply={onInlineReply}
                  />
                  </ErrorBoundary>
                </LiveThinkingContext.Provider>
                </AgentKindContext.Provider>
                <ArtifactPanel />
                {rawOpen ? (
                  <RawEventPanel
                    events={cockpit.rawEvents}
                    onClose={() => setRawOpen(false)}
                  />
                ) : null}
                <TranscriptSearch
                  open={searchOpen}
                  onClose={() => setSearchOpen(false)}
                />
              </div>
            )}
            </ShellContext.Provider>
            </div>
              </>
            )}
          </main>
        </div>

        {configOpen ? (
          <ConfigModal
            onClose={() => setConfigOpen(false)}
            onToast={showToast}
          />
        ) : null}

        {/* Up to 4 warm ttyd panels stay mounted (LRU); only the current
            session's, when shown, is visible — `visible` fades+zooms it in/out
            so opening never waits on a fresh ttyd load. */}
        {warmTerms.map((id) => (
          <TerminalPanel
            key={id}
            sessionId={id}
            visible={id === cockpit.selectedId && terminalShown}
            label={cockpit.sessions.find((s) => s.id === id)?.name ?? id}
            sendKey={cockpit.sendPaneKey}
            onClose={() => setTerminalShown(false)}
          />
        ))}

        <SubAgentPanel
          subagents={cockpit.subagents}
          open={panelOpen && cockpit.subagents.length > 0}
          onClose={() => setPanelOpen(false)}
          focusAgentId={panelAgentId}
        />

        {processOpen ? (
          <ProcessPanel
            power={cockpit.resources.snapshot?.power ?? null}
            history={cockpit.resourceHistory}
            onClose={() => setProcessOpen(false)}
            onToast={showToast}
          />
        ) : null}

        {paletteOpen ? (
          <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        ) : null}

        <HotkeyHints />
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
