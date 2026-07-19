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
import { buildThreadMessages, initialSendSeq } from './lib/thread-messages';
import { attachmentPath, createCockpitAttachmentAdapter } from './lib/attachments';
import { renameSession, getConfig, resetBinding, rematchAll, olamTerminalToken, olamSessionLiveness, type CreateSessionResult } from './lib/api';
import { SessionRail, claudeWorking, type SessionFilter } from './components/SessionRail';
import { ResourceHud } from './components/ResourceHud';
import { Thread } from './components/Thread';
import type { ComposerHandle } from './components/Composer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LiveThinkingContext } from './components/ThinkingContext';
import { AgentKindContext } from './components/AgentContext';
import { WorkflowContext, type WorkflowContextValue } from './components/WorkflowContext';
import { ArtifactPanelProvider } from './components/ArtifactContext';
import { UrlActionProvider } from './components/UrlActionContext';
import { ArtifactPanel } from './components/ArtifactPanel';
import { ArtifactGallery } from './components/ArtifactGallery';
import { loadGalleryOpen, saveGalleryOpen } from './lib/sessionArtifacts';
import { loadFontSize } from './lib/fontSizePrefs';
import { keyboardIsUp } from './lib/keyboardViewport';
import { TerminalPane } from './components/TerminalPane';
import { ShellContext } from './components/ShellContext';
import { ToastView, type ToastMessage } from './components/Toast';
import { UpdateBanner } from './components/UpdateBanner';
import { PermissionBanner } from './components/PermissionBanner';
import { ConfigModal } from './components/ConfigModal';
import { NewSessionForm } from './components/NewSessionForm';
import { NewSessionDraft } from './components/NewSessionDraft';
import { TokenGate } from './components/TokenGate';
import type { ActivePrompt } from './components/AskInline';
import { SubAgentPanel } from './components/SubAgentPanel';
import { WorkflowAgentView } from './components/WorkflowAgentView';
import { ProcessPanel } from './components/ProcessPanel';
import { RawEventPanel } from './components/RawEventPanel';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { PerfDiagnostics } from './components/PerfDiagnostics';
import { HotkeyHints } from './components/HotkeyHints';
import { AppFrameLayer } from './components/AppFrameLayer';
import { useHotkeySuppressionInterceptor } from './lib/hotkeySuppression';
import { StudioModal } from './components/StudioModal';
import {
  PencilIcon,
  TerminalSquareIcon,
  BotIcon,
  PanelLeftIcon,
  EllipsisIcon,
  ActivityIcon,
  SearchIcon,
  RefreshIcon,
  SteeringWheelIcon,
  ExternalLinkIcon,
  GalleryIcon,
} from './components/icons';
import { TranscriptSearch } from './components/TranscriptSearch';
import type { AnswerSelection, Pending, ServerMessage, Workflow } from './lib/types';
import { hasOpenQuestion } from './lib/askGuard';
import {
  echoMatches,
  hasDeliveredEcho,
  msgHasImage,
  msgText,
  PENDING_SENDS_LS_KEY,
  removePendingSend,
  toMs,
} from './lib/pendingSend';
import { shouldShowPrompt, shouldShowSynthesizedAsk, SETTLE_CAP_MS, FLAG_PENDING_TOOL_USE_ID } from './lib/answerSettle';
import { applySubAgentPrefix, type SubAgentMode } from './lib/subAgent';
import { useIsNarrow } from './hooks/useIsNarrow';
import { useModifierHeld } from './hooks/useModifierHeld';
import gsap, { prefersReducedMotion } from './lib/anim';
import { loadCosmosPref } from './lib/cosmosPrefs';
import { buildShot, nextAmbientDelayMs, detectTurnCompletions, type Shot } from './lib/shootingStars';
import { loadPerfDiagnosticsEnabled, recordPerfEvent, savePerfDiagnosticsEnabled } from './lib/perfDiagnostics';


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
// Optimistic sends are persisted (key: PENDING_SENDS_LS_KEY, imported from
// lib/pendingSend so removePendingSend's own persistence stays in sync) so a
// page reload doesn't drop an un-echoed message — on load they rehydrate and
// the transcript reconcile resolves them.

type PendingSend = {
  key: number;
  reqId: string;
  sessionId: string;
  text: string;
  label: string;
  // Attachment count at original send time (see onNew) — reused by Retry so a
  // re-sent image-laden message still gets the server's paste→Enter settle
  // scaling. Optional so pre-existing localStorage entries (persisted before
  // this field existed) still pass loadPendingSends's type guard.
  attachments?: number;
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

// Identity converter for useExternalStoreRuntime: we feed the runtime
// already-converted ThreadMessageLike[] (see fullConverted), so conversion is a
// no-op. MUST be a stable module-level reference — assistant-ui resets its
// per-message ThreadMessageConverter cache whenever `convertMessage`'s identity
// changes (external-store-thread-runtime-core.js), so an inline arrow here would
// wipe that cache on EVERY render (every WS frame, incl. resources ticks and
// other-session frames) and re-normalize the whole transcript. A stable ref lets
// the runtime take its fast-path bail when `messages` is referentially unchanged.
const identityConvertMessage = (msg: ThreadMessageLike): ThreadMessageLike => msg;

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
        // This device's localStorage override wins; the server value is only
        // the fallback (see lib/fontSizePrefs.ts) — that's what makes the
        // size per-device rather than shared across every browser hitting
        // this server.
        basePx = loadFontSize('transcript') ?? c.transcriptFontSize ?? 0;
        extPx = loadFontSize('external') ?? c.externalFontSize ?? 0;
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

  // Cosmos backdrop toggles (Settings → General): device-local, no server
  // round-trip (see lib/cosmosPrefs.ts). `cosmosBackground` drives the JSX
  // mount below (needs a re-render); parallax/shooting-stars are read inside
  // non-React loops (rAF scroll handler, ambient timer, GSAP tween) so they
  // live in refs instead — same live-apply CustomEvent as font size, just
  // updating a ref for those two instead of triggering a re-render.
  const [cosmosBackground, setCosmosBackground] = useState(() => loadCosmosPref('background'));
  const parallaxEnabledRef = useRef(loadCosmosPref('parallax'));
  const shootingStarsEnabledRef = useRef(loadCosmosPref('shootingStars'));
  useEffect(() => {
    const onPrefs = (e: Event) => {
      const d = (e as CustomEvent<{
        cosmosBackground?: boolean;
        cosmosParallax?: boolean;
        cosmosShootingStars?: boolean;
      }>).detail;
      if (!d) return;
      if (typeof d.cosmosBackground === 'boolean') setCosmosBackground(d.cosmosBackground);
      if (typeof d.cosmosParallax === 'boolean') parallaxEnabledRef.current = d.cosmosParallax;
      if (typeof d.cosmosShootingStars === 'boolean') shootingStarsEnabledRef.current = d.cosmosShootingStars;
    };
    window.addEventListener('cockpit:cosmosprefs', onPrefs);
    return () => window.removeEventListener('cockpit:cosmosprefs', onPrefs);
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
  const sendSeq = useRef(initialSendSeq(pendingSends));
  // Tracks whether the Composer's >_ terminal mode is active — updated by the
  // Composer via onTerminalModeChange. Used to gate the sub-agent prefix.
  const composerTerminalRef = useRef(false);
  // State mirror of the ref above, purely for the terminal-mode red→yellow
  // theming (data-terminal-mode on .app) — a re-render IS wanted here, unlike
  // the ref's hot-path Esc-key-handler read.
  const [terminalMode, setTerminalMode] = useState(false);
  const onTerminalModeChange = useCallback((active: boolean) => {
    composerTerminalRef.current = active;
    setTerminalMode(active);
  }, []);
  // Imperative handle onto the Composer's own `>_` terminal mode (forwarded
  // through Thread — see ComposerHandle) — the single surviving terminal
  // surface. ⌘J, the command palette, and the header's raw-terminal button
  // all trigger it through this ref instead of the retired ttyd overlay.
  const composerRef = useRef<ComposerHandle>(null);
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
            attachments: paths.length,
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
    const echoes = cockpit.messages
      .filter((m) => m.role === 'user')
      .map((m) => ({ t: msgText(m), ts: toMs(m.ts), hasImage: msgHasImage(m) }))
      // Keep image-only echoes (empty text, e.g. an attachment sent with no
      // caption) — echoMatches' own attachment fallback decides whether one
      // of those reconciles a queued entry; dropping them here would make
      // that fallback unreachable and leave image-only sends "Queued" forever.
      .filter((e) => e.t.trim() || e.hasImage);
    setPendingSends((q) => {
      const claimed = new Set<number>();
      const next = q.filter((e) => {
        if (e.sessionId !== sid) return true; // leave other sessions untouched
        const idx = echoes.findIndex(
          (ec, i) => !claimed.has(i) && echoMatches(e, ec.t, ec.ts, ec.hasImage),
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

  // Retry / Discard actions on a stale "Not delivered" bubble, AND the plain
  // dismiss (×) control on any still-queued/sent bubble that hasn't reconciled
  // (e.g. the TUI's focus wasn't on the composer so the keystrokes never
  // landed — no echo will EVER arrive, and the bubble would otherwise sit
  // until the 30-min TTL backstop). Both dispatch the SAME event (dispatched
  // by UserMessage in Messages.tsx, keyed by the PendingSend's `key`, parsed
  // from the optimistic bubble's `queued-<key>` message id) — Messages.tsx
  // only ever signals intent, App.tsx owns the queue.
  //
  // Discard/dismiss: removePendingSend (lib/pendingSend.ts) drops the entry
  // AND persists the pruned list to localStorage — this useEffect's own
  // persistence (which mirrors pendingSends on every change) then no-ops on
  // the same already-pruned value.
  //
  // Retry is reconcile-first: it's possible the send actually landed (a stale/
  // false-negative ack, or the echo arrived AFTER the ack was marked failed) —
  // re-using the SAME echoMatches rule as the batch reconcile effect above means
  // we never double-send a message that's already in the transcript. If no echo
  // exists, re-dispatch the ORIGINAL text through the same cockpit.sendReply used
  // by onNew, with a fresh reqId; the existing ack/reconcile effects then take
  // the re-queued entry over normally. If the socket can't even dispatch (no
  // reqId), leave the entry 'failed' and surface the same "Not connected" toast
  // onNew uses for that case.
  useEffect(() => {
    const keyFromEvent = (ev: Event): number | null => {
      const k = (ev as CustomEvent).detail?.key;
      return typeof k === 'number' ? k : null;
    };
    const onDiscard = (ev: Event) => {
      const key = keyFromEvent(ev);
      if (key == null) return;
      setPendingSends((q) => removePendingSend(q, key));
    };
    const onRetry = (ev: Event) => {
      const key = keyFromEvent(ev);
      if (key == null) return;
      setPendingSends((q) => {
        const entry = q.find((e) => e.key === key);
        // No-op guard: already discarded/resolved, or a stale event from a
        // fast double-click on an entry that isn't (or is no longer) failed.
        if (!entry || entry.status !== 'failed') return q;
        // A retry can only safely target the currently selected session —
        // cockpit.sendReply always sends to it, not to entry.sessionId.
        if (entry.sessionId !== cockpit.selectedId) {
          showToast('Switch to that session to retry', 'error');
          return q;
        }
        if (hasDeliveredEcho(entry, cockpit.messages)) {
          return removePendingSend(q, key); // promote: the real bubble already exists
        }
        const reqId = cockpit.sendReply(entry.text, entry.attachments ?? 0, false, false);
        if (!reqId) {
          showToast('Not connected — reconnecting…', 'error');
          return q; // nothing was dispatched — stay failed
        }
        return q.map((e) =>
          e.key === key ? { ...e, reqId, at: Date.now(), status: 'queued' as const } : e,
        );
      });
    };
    window.addEventListener('cockpit:pending-retry', onRetry);
    window.addEventListener('cockpit:pending-discard', onDiscard);
    return () => {
      window.removeEventListener('cockpit:pending-retry', onRetry);
      window.removeEventListener('cockpit:pending-discard', onDiscard);
    };
  }, [cockpit, showToast]);

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

  // Whether the SELECTED session is actively working. cockpit.sessions gets a
  // fresh array identity on every liveness/pending frame; feeding that array
  // straight into convertedMessages' deps rebuilt the whole thread (and
  // remounted embedded iframes) on updates with no new messages. This boolean
  // rarely flips, so the thread memo keys on it instead of the array.
  const selectedWorking = useMemo(() => {
    const sess = cockpit.sessions.find((s) => s.id === cockpit.selectedId);
    return (
      (!!sess && claudeWorking(sess)) ||
      (answering !== null && answering.sessionId === cockpit.selectedId)
    );
  }, [cockpit.sessions, cockpit.selectedId, answering]);

  const convertedMessages = useMemo<ThreadMessageLike[]>(
    () =>
      buildThreadMessages(
        fullConverted,
        hiddenCount,
        selectedPending,
        selectedWorking,
      ),
    [fullConverted, hiddenCount, selectedPending, selectedWorking],
  );

  const loadEarlier = useCallback(() => {
    setVisibleCount((c) => c + LOAD_EARLIER_STEP);
  }, []);

  // Stable adapters object so the runtime doesn't see a fresh attachments
  // adapter identity every render (attachmentAdapter is already memoized).
  const runtimeAdapters = useMemo(
    () => ({ attachments: attachmentAdapter }),
    [attachmentAdapter],
  );
  const runtime = useExternalStoreRuntime({
    messages: convertedMessages,
    isDisabled: !cockpit.selectedId,
    convertMessage: identityConvertMessage,
    onNew,
    adapters: runtimeAdapters,
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
  const [perfDiagnosticsOpen, setPerfDiagnosticsOpen] = useState(() => loadPerfDiagnosticsEnabled());
  const setPerfDiagnostics = useCallback(
    (open: boolean) => {
      setPerfDiagnosticsOpen(open);
      savePerfDiagnosticsEnabled(open);
      showToast(open ? 'Device diagnostics enabled' : 'Device diagnostics disabled', open ? 'ok' : '');
    },
    [showToast],
  );

  useEffect(() => {
    recordPerfEvent('app-render', cockpit.messages.length);
  });

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

  // Raw-terminal escape hatch: opens/toggles the Composer's own `>_` terminal
  // mode via the imperative composerRef (the ttyd overlay this used to drive
  // is retired — see ComposerHandle). Requires a session to be selected, same
  // guard the old ttyd path had.
  const openTerminal = useCallback(() => {
    if (!cockpit.selectedId) return;
    composerRef.current?.openTerminal();
  }, [cockpit.selectedId]);
  const toggleTerminal = useCallback(() => {
    if (!cockpit.selectedId) return;
    composerRef.current?.toggleTerminal();
  }, [cockpit.selectedId]);

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
  // Session artifact gallery (Phase D): the disclosure toggle lives in the
  // header beside Rename; ArtifactGallery itself is now a controlled lens
  // (open/onCountChange props) rather than owning its own head button.
  // Persisted the same way as actionsOpen above — best-effort localStorage
  // round-trip via lib/sessionArtifacts.ts's loadGalleryOpen/saveGalleryOpen.
  const [galleryOpen, setGalleryOpen] = useState(() => loadGalleryOpen());
  const [artifactCount, setArtifactCount] = useState(0);
  useEffect(() => {
    saveGalleryOpen(galleryOpen);
  }, [galleryOpen]);
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
    setViewingWorkflowAgent(null);
    setRawOpen(false);
  }, [cockpit.selectedId]);
  // Pill click → show inline transcript; does NOT open the side panel.
  const openAgent = useCallback((agentId: string) => {
    cockpit.requestSubagent(agentId);
    setViewingAgentId((prev) => (prev === agentId ? null : agentId));
  }, [cockpit.requestSubagent]);
  const closeAgent = useCallback(() => setViewingAgentId(null), []);

  // B3 Agent View: which workflow agent's full-transcript overlay is open.
  const [viewingWorkflowAgent, setViewingWorkflowAgent] = useState<
    { runId: string; agentId: string; label: string } | null
  >(null);
  const openWorkflowAgent = useCallback(
    (runId: string, agentId: string, label: string) => {
      cockpit.requestWorkflowAgent(runId, agentId);
      setViewingWorkflowAgent({ runId, agentId, label });
    },
    [cockpit.requestWorkflowAgent],
  );
  const closeWorkflowAgent = useCallback(() => setViewingWorkflowAgent(null), []);

  // Live workflow slice for the selected session, keyed by runId — consumed by
  // the inline WorkflowCard (MessageParts' WorkflowPart) to bind to the polled
  // run, not the frozen tool_result. `openAgent` opens the transcript overlay.
  const workflowCtx = useMemo<WorkflowContextValue>(() => {
    const runs = cockpit.selectedId ? cockpit.workflowsById[cockpit.selectedId] ?? [] : [];
    const byRunId = new Map(runs.map((w) => [w.runId, w]));
    return { byRunId, openAgent: openWorkflowAgent };
  }, [cockpit.selectedId, cockpit.workflowsById, openWorkflowAgent]);

  // The same slice for the live dock (Phase C), but IDENTITY-STABLE: a fresh
  // sessions array lands every poll, so handing `workflowsById[...]` straight
  // to the memoized Thread would re-render it (and the whole transcript
  // subtree) once a second forever after any workflow ran. Reuse the previous
  // array while the serialized content is unchanged. undefined when no runs.
  const wfSliceRef = useRef<{ json: string; runs: Workflow[] } | null>(null);
  const selectedWorkflows = useMemo<Workflow[] | undefined>(() => {
    const runs = cockpit.selectedId ? cockpit.workflowsById[cockpit.selectedId] : undefined;
    if (!runs || runs.length === 0) {
      wfSliceRef.current = null;
      return undefined;
    }
    const json = JSON.stringify(runs);
    if (wfSliceRef.current?.json === json) return wfSliceRef.current.runs;
    wfSliceRef.current = { json, runs };
    return runs;
  }, [cockpit.selectedId, cockpit.workflowsById]);

  // Dock tap → bring the inline card into view. The card mounts ungrouped at
  // its tool block (see Messages.tsx INTERACTIVE_TOOLS), carrying this DOM id.
  const openWorkflowCard = useCallback((runId: string) => {
    document
      .getElementById(`wf-card-${runId}`)
      ?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }, []);

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

  // ── Mobile back-gesture (SPA nav): the iOS edge-swipe-back / browser Back
  // should move detail → rail IN-APP, not reload/leave the page. Push a history
  // entry when the detail pane opens on mobile; intercept popstate to return to
  // the rail. The Back button routes through backToRail() → history.back() so it
  // takes the same path (keeping history in sync). Mobile only — desktop shows
  // both panes, so there is nothing to go "back" from.
  const detailOpen = (cockpit.selectedId != null || draftOpen) && !railOpenMobile;
  const pushedDetailEntry = useRef(false);
  useEffect(() => {
    if (narrow && detailOpen && !pushedDetailEntry.current) {
      window.history.pushState({ ccDetail: true }, '');
      pushedDetailEntry.current = true;
    }
  }, [narrow, detailOpen]);
  useEffect(() => {
    const onPop = () => {
      pushedDetailEntry.current = false;
      if ((cockpit.selectedId != null || draftOpen) && !railOpenMobile) {
        setRailOpenMobile(true);
        setDraftOpen(false);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [cockpit.selectedId, draftOpen, railOpenMobile]);
  const backToRail = useCallback(() => {
    if (pushedDetailEntry.current) window.history.back();
    else {
      setRailOpenMobile(true);
      setDraftOpen(false);
    }
  }, []);

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
      // Default is 'agents' (Claude + Codex) — a persisted choice (including an
      // explicit 'all') always wins over that default on reload.
      return v === 'all' || v === 'agents' || v === 'claude' || v === 'codex' || v === 'terminal'
        ? v
        : 'agents';
    } catch {
      return 'agents';
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

  // Subtle cosmic parallax: the transcript scroll nudges each starfield
  // plane's background-position via --cosmos-shift(-near/-far). Shifting a
  // repeating tile never reveals an edge and leaves each plane's own drift
  // transform free to animate independently. Three different multipliers
  // (near moves most, far almost not at all) is what actually sells the
  // depth between planes — still the SAME single rAF handler, just three
  // property writes instead of one; no new per-frame JS loop. One
  // capture-phase listener catches whichever .thread-viewport is mounted, so
  // it survives session switches. Reduced-motion → no listener at all.
  const cosmosRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let raf = 0;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t?.classList?.contains('thread-viewport') || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = cosmosRef.current;
        if (!el || !parallaxEnabledRef.current) return;
        el.style.setProperty('--cosmos-shift', `${-t.scrollTop * 0.06}px`);
        el.style.setProperty('--cosmos-shift-near', `${-t.scrollTop * 0.13}px`);
        el.style.setProperty('--cosmos-shift-far', `${-t.scrollTop * 0.02}px`);
      });
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Shooting stars — a small pool of real, ref-able elements (CSS
  // pseudo-elements can't be targeted by GSAP/DOM APIs, which is why this
  // used to be three infinite-loop ::before/::after streaks instead — see
  // styles.css's .cosmos-shoot-slot comment). One-shot fired from JS: rare
  // ambient timer (at most once a minute) + once per agent turn completing.
  // A round-robin index picks the next slot so overlapping shots (ambient +
  // turn-done landing close together) never fight over the same element.
  const shootSlotRefs = useRef<(HTMLElement | null)[]>([]);
  const shootSlotCursor = useRef(0);
  const fireShootingStar = useCallback((depth?: Shot['depth']) => {
    if (prefersReducedMotion() || !shootingStarsEnabledRef.current) return;
    const slots = shootSlotRefs.current;
    if (!slots.length) return;
    const el = slots[shootSlotCursor.current % slots.length];
    shootSlotCursor.current += 1;
    if (!el) return;
    const shot = buildShot(depth);
    el.dataset.depth = shot.depth;
    el.style.top = `${shot.topPercent}%`;
    gsap.killTweensOf(el);
    gsap.set(el, { opacity: 0, x: 0, y: 0, rotate: shot.angleDeg });
    // durationMs is the whole one-shot flight (already 2.1x-speedup'd in
    // shootingStars.ts's PRESETS) — position travels the full distance at a
    // constant rate across it, while opacity ramps in over the first ~12%
    // and fades out over the last ~30%, so the streak flashes in, crosses,
    // and dims out rather than popping abruptly at either end.
    const totalS = shot.durationMs / 1000;
    const tl = gsap.timeline();
    tl.to(el, { x: `${shot.travelXvw}vw`, y: `${shot.travelYvw}vw`, duration: totalS, ease: 'none' }, 0)
      .to(el, { opacity: shot.peakAlpha, duration: totalS * 0.12, ease: 'power1.in' }, 0)
      .to(el, { opacity: 0, duration: totalS * 0.3, ease: 'power1.out' }, totalS * 0.7);
  }, []);

  // Ambient cadence: self-rescheduling timeout (not setInterval) so each gap
  // is freshly randomized — see lib/shootingStars.ts's nextAmbientDelayMs
  // (never less than a minute). Skips entirely under reduced-motion/toggle-
  // off, but keeps rescheduling so a later re-enable picks back up without
  // remounting.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = () => {
      if (!alive) return;
      if (!prefersReducedMotion() && shootingStarsEnabledRef.current) fireShootingStar();
      timer = window.setTimeout(tick, nextAmbientDelayMs());
    };
    timer = window.setTimeout(tick, nextAmbientDelayMs());
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [fireShootingStar]);

  // Turn-completion trigger: fire one shooting star whenever any session's
  // active→idle edge fires — the same signal lib/push-trigger.js's
  // evaluateEdges uses server-side to send the "✅ finished" push
  // (wasActive && !nowActive && !pending), mirrored client-side via
  // claudeWorking() over cockpit.sessions. See lib/shootingStars.ts's
  // detectTurnCompletions for the pure edge-detection logic.
  const turnActiveRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    const { completed, nextActive } = detectTurnCompletions(
      turnActiveRef.current,
      cockpit.sessions,
      claudeWorking,
    );
    turnActiveRef.current = nextActive;
    if (completed.length) fireShootingStar();
  }, [cockpit.sessions, fireShootingStar]);

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
  }, [cockpit.sendPromptKey, showToast]);

  // Free-text reply from the inline prompt: same path as a normal composer send.
  const onInlineReply = useCallback((text: string) => {
    if (!text.trim()) return;
    // viaAnswer=true: this is the trailing free-text of a deliberate answer routed
    // through the inline component (which already navigated the picker), so the
    // server's open-question reply guard must allow it through.
    cockpit.sendReply(text, 0, true);
    markAnswered();
  }, [cockpit.sendReply, markAnswered]);

  // Thread handler + derived-prop stabilization. Thread is wrapped in React.memo,
  // so it re-renders only when a prop changes identity. These depend on STABLE
  // cockpit action refs / primitives (never the whole `cockpit` store object,
  // which is a fresh identity every render) so a WS frame for ANOTHER session — or
  // the 5s resources tick — no longer re-renders the transcript + composer subtree.
  const onThreadRetry = useCallback(() => {
    const ok = cockpit.sendReply('Continue');
    showToast(ok ? 'Retry → Continue' : 'Not connected', ok ? 'ok' : 'error');
  }, [cockpit.sendReply, showToast]);
  const onThreadAnswer = useCallback(
    (toolUseId: string, selections: AnswerSelection[]) => {
      cockpit.sendAnswer(toolUseId, selections);
      cockpit.clearCapture();
      markAnswered();
      if (cockpit.selectedId) {
        setAnswering({
          sessionId: cockpit.selectedId,
          baseCount: cockpit.messages.length,
        });
      }
    },
    [cockpit.sendAnswer, cockpit.clearCapture, markAnswered, cockpit.selectedId, cockpit.messages.length],
  );
  const onThreadKey = useCallback(
    (key: string) => {
      cockpit.sendPromptKey(key);
      markAnswered();
    },
    [cockpit.sendPromptKey, markAnswered],
  );
  const onThreadSelect = useCallback(
    (labels: string[]) => {
      markAnswered();
      return cockpit.selectedId
        ? cockpit.sendPromptSelect(cockpit.selectedId, labels)
        : false;
    },
    [markAnswered, cockpit.selectedId, cockpit.sendPromptSelect],
  );
  // Stable identities for the two remaining inline-object Thread props.
  const threadEmptyState = useMemo(
    () =>
      selectedSession?.kind === 'remote'
        ? { heading: 'No transcript yet — waiting for the agent' }
        : null,
    [selectedSession?.kind],
  );
  const viewingAgent = useMemo(
    () =>
      viewingAgentId
        ? (cockpit.subagents.find((a) => a.agentId === viewingAgentId) ?? null)
        : null,
    [viewingAgentId, cockpit.subagents],
  );

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

  // ⌘/Ctrl+, opens Settings — same action as clicking the header's Settings
  // button. Mirrors the ⌘K / ⌘. guards (modifier + no shift/alt, bail if a
  // dialog already owns the keys — the palette itself sets aria-modal="true").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ',' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return; // let dialogs handle keys
      e.preventDefault();
      setConfigOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ⌘/Ctrl+Shift+A toggles the Artifacts pane for the selected session — same
  // action as the header's Artifacts button. Guard mirrors the other detail-head
  // shortcuts (⌘J/⌘U/⌘B below): only meaningful with a session selected.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'a') return;
      if (!selectedSession) return;
      if (document.querySelector('[aria-modal="true"]')) return; // let dialogs handle keys
      e.preventDefault();
      setGalleryOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedSession]);

  // ⌘/Ctrl+N opens the New Session draft — same action as clicking the rail's
  // "+ New session" button — instead of letting the browser open a new
  // window/tab. Registered on the CAPTURE phase (like the other global
  // shortcuts below) so it fires before a focused pane's keydown handler can
  // stopPropagation() it (e.g. TerminalPanel.tsx swallows keydown on the
  // bubble phase, which previously made ⌘N a no-op while a terminal pane had
  // focus). Note: a raw (non-PWA) browser tab still reserves Cmd+N at the OS
  // level and JS can't preventDefault it there, but this works in the
  // installed/standalone PWA and any in-app focus context (terminal, textarea,
  // etc.) that lets the keydown reach the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'n') return;
      if (document.querySelector('[aria-modal="true"]')) return; // a dialog owns the keys
      e.preventDefault();
      openDraft();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openDraft]);

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

  // Claude panes ⌘1-9 can address: VISIBLE, LOCAL RUNNING sessions only — filter
  // must allow Claude (not 'terminal'), exclude remote/olam cloud sessions (they
  // aren't local panes to jump into), and the session group must be expanded —
  // in rail order. The rail's badges read from the same list, so badge ⌘N always
  // selects row N.
  const addressableClaude = useMemo(() => {
    if (sessionFilter === 'terminal') return [];
    return cockpit.sessions
      .filter(
        (s) =>
          s.kind !== 'terminal' && s.kind !== 'remote' && !collapsedSessions.has(s.sessionName ?? '?'),
      )
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

  // ArtifactGallery (Phase C): flatten every text block across the selected
  // session's transcript into one string so it can be scanned for
  // <embedded-app> tags. Text-only — thinking/tool_use/tool_result blocks
  // never carry embed tags, so they're excluded on purpose.
  const transcriptText = useMemo(
    () =>
      cockpit.messages
        .flatMap((m) => (m.blocks ?? []).filter((b) => b.kind === 'text').map((b) => b.text ?? ''))
        .join('\n'),
    [cockpit.messages],
  );

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
        // Composer's own sessionId-keyed effect already leaves `>_` terminal
        // mode on session switch, so there's no stuck terminal focus to
        // release here (the old ttyd iframe needed a manual blur; the
        // composer-terminal doesn't).
        select(target.id);
        // Land focus in the composer so you can type immediately (the default on
        // every switch). For terminal sessions there's no .composer-input, so the
        // visible terminal pane keeps its own focus.
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
  }, [addressableClaude, paletteOpen, select]);

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
    // LOCAL sessions (claude/codex/terminal) FIRST, OLAM cloud sessions LAST —
    // same `kind === 'remote'` predicate SessionRail uses to split its own
    // local vs. per-org olam sections (see groupRemoteByOrg / rail filters).
    // Within the local tier, Sessions before Terminals; within each tier,
    // mirror the rail's natural tmux order (session name → window → pane) so
    // positions feel stable.
    const ordered = [...cockpit.sessions].sort((a, b) => {
      const tierOf = (k: string | undefined) => (k === 'remote' ? 2 : k === 'terminal' ? 1 : 0);
      const at = tierOf(a.kind);
      const bt = tierOf(b.kind);
      if (at !== bt) return at - bt;
      return (
        (a.sessionName ?? '').localeCompare(b.sessionName ?? '', undefined, { numeric: true }) ||
        (a.windowIndex ?? 0) - (b.windowIndex ?? 0) ||
        (a.paneIndex ?? 0) - (b.paneIndex ?? 0)
      );
    });
    for (const s of ordered) {
      const term = s.kind === 'terminal';
      const remote = s.kind === 'remote';
      cmds.push({
        id: `switch:${s.id}`,
        label: s.name || s.title || s.tmuxName || s.id,
        hint: [term ? 'terminal' : base(s.cwd), s.pending ? 'ASK' : ''].filter(Boolean).join(' · '),
        keywords: `${s.sessionName ?? ''} ${s.cwd ?? ''} ${s.id}`,
        group: remote ? 'Olam' : term ? 'Terminals' : 'Sessions',
        run: () => select(s.id),
      });
    }
    cmds.push(
      {
        id: 'act:tmux-window',
        label: 'View raw tmux window',
        hint: selectedSession ? selectedSession.name || selectedSession.id : 'select a session first',
        group: 'Actions',
        keywords: 'terminal pane window shell',
        run: () => openTerminal(),
      },
      {
        id: 'act:new-session',
        label: 'New session',
        group: 'Actions',
        keywords: 'create start draft claude',
        hotkey: '⌘N',
        // Same action as ⌘N and the rail's "+ New session" button
        // (NewSessionForm onOpenDraft={openDraft}) — opens the draft page for
        // review rather than instant-creating with empty defaults, so the
        // palette entry matches what its own hotkey badge promises.
        run: () => openDraft(),
      },
      {
        id: 'act:perf-diagnostics',
        label: perfDiagnosticsOpen ? 'Hide device performance diagnostics' : 'Show device performance diagnostics',
        group: 'Actions',
        keywords: 'mobile heat hot fps jank longtask memory heap gpu webgl diagnostics performance',
        run: () => setPerfDiagnostics(!perfDiagnosticsOpen),
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
        hotkey: '⌘,',
        run: () => setConfigOpen(true),
      },
      {
        id: 'act:terminal-mode',
        label: terminalMode ? 'Exit terminal mode' : 'Terminal mode',
        hint: selectedSession ? undefined : 'select a session first',
        group: 'Actions',
        keywords: 'terminal shell toggle raw tmux',
        hotkey: '⌘J',
        run: () => toggleTerminal(),
      },
      {
        id: 'act:artifacts',
        label: galleryOpen ? 'Close artifacts pane' : 'Open artifacts pane',
        hint: selectedSession ? undefined : 'select a session first',
        group: 'Actions',
        keywords: 'gallery embed embedded-app artifact panel',
        hotkey: '⌘⇧A',
        run: () => setGalleryOpen((v) => !v),
      },
      {
        id: 'act:subagents',
        label: 'Sub-agents panel',
        group: 'Actions',
        keywords: 'agents sidebar list',
        hotkey: '⌘U',
        run: () => {
          setPanelAgentId(null);
          setPanelOpen((v) => !v);
        },
      },
      {
        id: 'act:toggle-sidebar',
        label: railCollapsed ? 'Show sidebar' : 'Hide sidebar (focus mode)',
        group: 'Actions',
        keywords: 'rail collapse focus',
        hotkey: '⌘B',
        run: () => toggleRail(),
      },
      {
        id: 'act:search-transcript',
        label: searchOpen ? 'Close transcript search' : 'Search transcript',
        group: 'Actions',
        keywords: 'find quick-find',
        hotkey: '⌘/',
        run: () => setSearchOpen((v) => !v),
      },
      {
        id: 'act:jump-latest',
        label: 'Jump to latest',
        hint: selectedSession ? undefined : 'select a session first',
        group: 'Actions',
        keywords: 'scroll bottom tail',
        hotkey: '⌘.',
        run: () => {
          const vp = document.querySelector<HTMLElement>('.thread-viewport');
          vp?.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
        },
      },
      {
        id: 'act:focus-composer',
        label: 'Focus composer',
        hint: selectedSession ? undefined : 'select a session first',
        group: 'Actions',
        keywords: 'type message input',
        hotkey: '⌘⏎',
        run: () => {
          document.querySelector<HTMLTextAreaElement>('.composer .composer-input')?.focus();
        },
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
  }, [
    cockpit.sessions,
    cockpit.selectedId,
    selectedSession,
    railCollapsed,
    select,
    toggleRail,
    showToast,
    openTerminal,
    openDraft,
    terminalMode,
    toggleTerminal,
    galleryOpen,
    searchOpen,
    perfDiagnosticsOpen,
    setPerfDiagnostics,
  ]);

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

  // Mobile soft-keyboard flush: pin .app to the visible area above the iOS
  // keyboard so the composer ends FLUSH on the keyboard every time. iOS gives
  // us no keyboard API (no interactive-widget meta, no navigator.virtualKeyboard,
  // no env(keyboard-inset-*) — all unshipped on WebKit as of 2026), so this is
  // pure visualViewport math. Three hard-won invariants, each fixing a real
  // non-deterministic gap observed on-device:
  //
  //  1. DETECT keyboard-up off a STABLE height reference. window.innerHeight is
  //     NOT stable on iOS — when the keyboard opens and iOS scrolls the focused
  //     input into view, innerHeight collapses to visualViewport.height (measured
  //     358 vs a true 695). documentElement.clientHeight holds the real layout
  //     height through that, so we detect on `clientHeight - vv.height`. We do
  //     NOT subtract vv.offsetTop: iOS drives offsetTop large during that scroll,
  //     and the old `innerHeight - vv.height - offsetTop > 120` then went
  //     NEGATIVE, silently never setting kbd-up — the pin never engaged and the
  //     composer floated with a gap. This was the "sometimes flush, sometimes a
  //     massive gap on identical input" bug.
  //
  //  2. KILL the document scroll iOS induces. On focus iOS scrolls the whole
  //     document up (scrollTop/offsetTop → keyboard height) to reveal the input,
  //     even with body{overflow:hidden}. That shifts the position:fixed pin out
  //     of alignment. Since .app pins itself into the visible area, the document
  //     never NEEDS to scroll — so we force scrollTop back to 0, which realigns
  //     the visual viewport to the layout origin (offsetTop → 0) and lands the
  //     pin flush. Also clears iOS 26's offsetTop-doesn't-revert-on-dismiss drift.
  //
  //  3. SETTLE past the animation. iOS can finish the keyboard slide / scroll
  //     WITHOUT firing a final visualViewport event at the settled geometry, so
  //     a purely event-driven read can stick on a mid-animation value. A trailing
  //     re-read a beat after events go quiet guarantees the last committed
  //     geometry is the settled one.
  //
  // .app pinning + --vv-top/--vv-h are consumed by styles.css
  // (`body.kbd-up .app`, `.app-top-fade`). --vv-top also re-anchors the
  // status-bar scrim to the true visible top edge.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let rafId: number | null = null;
    let settleTimer: number | null = null;
    let lastUp = false;
    const commit = () => {
      rafId = null;
      // The app never intends a document-level scroll (inner containers scroll
      // instead). Any nonzero scrollTop here is iOS's focus scroll-into-view —
      // undo it so the visual viewport realigns to the layout origin.
      const se = document.scrollingElement;
      if (se && se.scrollTop !== 0) se.scrollTop = 0;
      // Stable layout-viewport height (see invariant 1); offsetTop deliberately
      // NOT subtracted (see keyboardIsUp).
      const up = keyboardIsUp(document.documentElement.clientHeight, vv.height);
      document.documentElement.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      document.documentElement.style.setProperty('--vv-h', `${vv.height}px`);
      if (up !== lastUp) {
        lastUp = up;
        document.body.classList.toggle('kbd-up', up);
      }
    };
    const scheduleCommit = () => {
      if (rafId == null) rafId = requestAnimationFrame(commit);
    };
    const onViewportChange = () => {
      // Coalesce the burst of resize/scroll events during the slide into one
      // write per frame (continuous tracking, never a single stale read)...
      scheduleCommit();
      // ...then a trailing settle read past the animation (invariant 3).
      if (settleTimer != null) clearTimeout(settleTimer);
      settleTimer = window.setTimeout(scheduleCommit, 350);
    };
    commit();
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
    return () => {
      vv.removeEventListener('resize', onViewportChange);
      vv.removeEventListener('scroll', onViewportChange);
      if (rafId != null) cancelAnimationFrame(rafId);
      if (settleTimer != null) clearTimeout(settleTimer);
      document.body.classList.remove('kbd-up');
      document.documentElement.style.removeProperty('--vv-top');
      document.documentElement.style.removeProperty('--vv-h');
    };
  }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
    <UrlActionProvider>
    <ArtifactPanelProvider sessionId={cockpit.selectedId}>
      <div
        ref={appRef}
        className="app"
        data-detail={(cockpit.selectedId || draftOpen) && !railOpenMobile ? 'open' : 'closed'}
        data-rail-collapsed={!narrow && railCollapsed ? 'true' : undefined}
        data-cmd-held={cmdHeld ? 'true' : undefined}
        data-terminal-mode={terminalMode ? 'true' : undefined}
      >
        {cosmosBackground && (
          <div className="cosmos-backdrop" aria-hidden="true" ref={cosmosRef}>
            <i className="cosmos-stars-far" />
            <i className="cosmos-stars-mid" />
            <i className="cosmos-stars-near" />
            <i className="cosmos-twinkle" />
            <div className="cosmos-shoot-stars">
              {[0, 1, 2].map((i) => (
                <i
                  key={i}
                  className="cosmos-shoot-slot"
                  ref={(el) => {
                    shootSlotRefs.current[i] = el;
                  }}
                />
              ))}
            </div>
            <i className="cosmos-active-tint" />
            <i className="cosmos-aurora" />
          </div>
        )}
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
          onReload={() => window.location.reload()}
          onOpenSettings={() => setConfigOpen(true)}
          onOpenProcesses={() => setProcessOpen(true)}
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
            {/* The sidebar-minimise toggle (⌘B) used to live here as the rail's own
                top strip; it now lives permanently in .detail-head (see below) so
                there's one control, reachable whether the rail is open or
                collapsed, instead of two twinned buttons. That frees this whole
                top row — "+ New session" + the filter funnel live in the bottom
                bar (see .rail-foot / NewSessionForm) for right-thumb reachability. */}
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
                onToast={showToast}
                cmdHeld={cmdHeld}
              />
            </div>
            {/* Bottom bar, pinned below .rail-scroll (never scrolls with the list):
                filter on the left, "+ New session" (primary action) on the right. */}
            <NewSessionForm onOpenDraft={openDraft} filter={sessionFilter} onCycleFilter={cycleFilter} />
          </aside>

          <main className="detail">
            {draftOpen ? (
              <NewSessionDraft
                filter={sessionFilter}
                onToast={showToast}
                onCancel={closeDraft}
                onBack={backToRail}
                onCreated={onDraftCreated}
              />
            ) : (
              <>
            <header className="detail-head">
              <button
                type="button"
                className="back-btn"
                aria-label="Back to sessions"
                onClick={backToRail}
              >
                ‹
              </button>
              {/* Sidebar-collapse toggle (⌘B) — desktop-only focus mode (mobile swaps
                  the whole rail for the detail pane instead, so there's nothing to
                  collapse there). Parked here permanently (not just when collapsed)
                  so there's exactly one control, always reachable, whether the rail
                  is open or collapsed; the icon/label flip with railCollapsed. */}
              {!narrow ? (
                <button
                  type="button"
                  className="rail-collapse-toggle"
                  aria-pressed={railCollapsed}
                  data-on={railCollapsed ? 'true' : undefined}
                  aria-label={railCollapsed ? 'Show sidebar' : 'Focus mode (hide sidebar)'}
                  title={railCollapsed ? 'Show sidebar (⌘B)' : 'Focus mode (hide sidebar) (⌘B)'}
                  data-hotkey="⌘B"
                  data-hotkey-dir="down"
                  onClick={toggleRail}
                >
                  <PanelLeftIcon />
                </button>
              ) : null}
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
                    {/* Artifacts toggle sits between Rename and Reset. Inside
                        .detail-actions (visible by default; on mobile it shows
                        with the rest of the bar, ⋯ collapses it). */}
                    <button
                      type="button"
                      className="detail-action detail-action--artifacts"
                      aria-pressed={galleryOpen}
                      data-on={galleryOpen ? 'true' : undefined}
                      aria-label="Toggle artifacts"
                      title="Artifacts"
                      onClick={() => setGalleryOpen((v) => !v)}
                    >
                      <GalleryIcon />
                      {artifactCount > 0 ? (
                        <span className="detail-action-count">{Math.min(artifactCount, 99)}</span>
                      ) : null}
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
              </div>
            </header>

            <div className="detail-body" ref={detailBodyRef}>
            <ShellContext.Provider value={shellApi}>
            {selectedSession && selectedSession.kind === 'terminal' ? (
              // Plain (non-Claude) pane: a fully interactive live terminal —
              // ANSI view + key bar + keystroke relay. No transcript, by design.
              <TerminalPane
                sessionId={selectedSession.id}
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
                <WorkflowContext.Provider value={workflowCtx}>
                  {/* Catch a render crash in the transcript so one bad message
                      can't white-screen the whole app; resets on session switch. */}
                  <ErrorBoundary
                    resetKey={cockpit.selectedId ?? undefined}
                    label="This conversation failed to render"
                  >
                  <Thread
                    ref={composerRef}
                    hasSelection={!!cockpit.selectedId}
                    agentName={selectedSession?.kind === 'codex' ? 'Codex' : 'Claude'}
                    loading={!cockpit.messagesLoaded}
                    emptyState={threadEmptyState}
                    sessionId={cockpit.selectedId}
                    hiddenCount={hiddenCount}
                    onLoadEarlier={loadEarlier}
                    subAgentMode={activeSubAgentMode}
                    onSubAgentModeChange={onActiveSubAgentModeChange}
                    onTerminalModeChange={onTerminalModeChange}
                    subagents={cockpit.subagents}
                    workflows={selectedWorkflows}
                    onOpenWorkflowCard={openWorkflowCard}
                    onOpenAgent={openAgent}
                    viewingAgent={viewingAgent}
                    onCloseAgent={closeAgent}
                    working={agentWorking}
                    compacting={!!selectedSession?.compacting}
                    resuming={resuming?.sessionId === cockpit.selectedId}
                    errored={!!selectedSession?.errored}
                    onRetry={onThreadRetry}
                    onStop={handleStop}
                    askActive={askActive}
                    activePrompt={activePrompt}
                    incomingAsk={incomingAsk}
                    onAnswer={onThreadAnswer}
                    onKey={onThreadKey}
                    onSelect={onThreadSelect}
                    onReply={onInlineReply}
                  />
                  </ErrorBoundary>
                </WorkflowContext.Provider>
                </LiveThinkingContext.Provider>
                </AgentKindContext.Provider>
                <ErrorBoundary label="Artifact panel failed to render">
                  <ArtifactPanel />
                </ErrorBoundary>
                <ArtifactGallery transcriptText={transcriptText} open={galleryOpen} onCountChange={setArtifactCount} />
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

        <ErrorBoundary label="Sub-agent panel failed to render">
          <SubAgentPanel
            subagents={cockpit.subagents}
            open={panelOpen && cockpit.subagents.length > 0}
            onClose={() => setPanelOpen(false)}
            onLoadAgent={cockpit.requestSubagent}
            focusAgentId={panelAgentId}
          />
        </ErrorBoundary>

        {viewingWorkflowAgent ? (
          <ErrorBoundary label="Workflow agent transcript failed to render">
            <WorkflowAgentView
              label={viewingWorkflowAgent.label}
              messages={
                cockpit.workflowAgentById[
                  `${viewingWorkflowAgent.runId}::${viewingWorkflowAgent.agentId}`
                ]?.messages ?? []
              }
              loading={
                !cockpit.workflowAgentById[
                  `${viewingWorkflowAgent.runId}::${viewingWorkflowAgent.agentId}`
                ]?.loaded
              }
              onClose={closeWorkflowAgent}
            />
          </ErrorBoundary>
        ) : null}

        {processOpen ? (
          <ErrorBoundary label="Process monitor failed to render">
            <ProcessPanel
              power={cockpit.resources.snapshot?.power ?? null}
              history={cockpit.resourceHistory}
              onClose={() => setProcessOpen(false)}
              onToast={showToast}
            />
          </ErrorBoundary>
        ) : null}

        {paletteOpen ? (
          <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        ) : null}

        <ErrorBoundary label="Device diagnostics failed to render">
          <PerfDiagnostics enabled={perfDiagnosticsOpen} onClose={() => setPerfDiagnostics(false)} />
        </ErrorBoundary>

        <HotkeyHints />
        {/* AppFrameLayer runs its geometry/hoist loop on every render — isolate a
            crash in its own helpers so embedded-app hosting can't take down the app. */}
        <ErrorBoundary label="Embedded apps failed to render">
          <AppFrameLayer />
        </ErrorBoundary>
        <ToastView toast={toast} />
      </div>
    </ArtifactPanelProvider>
    </UrlActionProvider>
    </AssistantRuntimeProvider>
  );
}

// A3/A4: registers the single capture-phase hotkey-suppression interceptor
// (see lib/hotkeySuppression.ts) as a sibling of TokenGate/AppInner, in
// App's OWN commit — so its useLayoutEffect runs before AppInner (and all
// 20 of its descendants' keydown listeners) even mounts. Also the sole
// provider/mount-point for chrome that must exist independently of
// TokenGate's auth gate: A4's StudioModal is self-mounting (listens for
// `cockpit:studio-open` itself) and lives here so it's always present,
// regardless of auth state or which session is active.
function AppChrome() {
  useHotkeySuppressionInterceptor();
  // Studio is a self-mounting secondary tool — isolate a render crash here so it
  // can never white-screen the whole app / the working session behind it.
  return (
    <ErrorBoundary label="Studio failed to render">
      <StudioModal />
    </ErrorBoundary>
  );
}

// Root: gate the whole app behind the token login. TokenGate probes
// /api/health and only renders AppInner (which opens the WS) once authorized.
// Tokenless servers probe 200 → AppInner renders immediately, no prompt.
export default function App() {
  return (
    <>
      <AppChrome />
      <TokenGate>
        <AppInner />
      </TokenGate>
    </>
  );
}
