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
import { renameSession, createSession } from './lib/api';
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
import { PromptModal } from './components/PromptModal';
import { SubAgentPanel } from './components/SubAgentPanel';
import { ProcessPanel } from './components/ProcessPanel';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { HotkeyHints } from './components/HotkeyHints';
import {
  PencilIcon,
  TerminalSquareIcon,
  BotIcon,
  PanelLeftIcon,
  SettingsIcon,
  ActivityIcon,
} from './components/icons';
import type { Msg, ServerMessage } from './lib/types';
import { useIsNarrow } from './hooks/useIsNarrow';
import { useModifierHeld } from './hooks/useModifierHeld';
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
        // Whitespace-insensitive matching. The transcript echo can differ from
        // the exact sent string (collapsed whitespace, attachment paths stored
        // as separate blocks so the typed text is a prefix, an optimiser rewrite,
        // etc.). Try precise/prefix matches first; if none, fall back to clearing
        // the OLDEST pending for the session (FIFO) so a stray-format echo can't
        // strand a duplicate bubble forever.
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
        setPendingSends((q) => {
          const next = [...q];
          for (const raw of echoes) {
            const t = norm(raw);
            const sescit = next
              .map((e, i) => ({ e, i }))
              .filter(({ e }) => e.sessionId === sid);
            if (sescit.length === 0) continue;
            const match =
              sescit.find(({ e }) => {
                const text = norm(e.text);
                const label = norm(e.label);
                return text === t || label === t || t.startsWith(label) || text.startsWith(t);
              }) ?? sescit[0]; // fallback: oldest pending for this session
            next.splice(match.i, 1);
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
    // Each still-unmatched queued send shows as a user bubble, INTERLEAVED by its
    // send time — inserted before the first transcript message that's newer — so
    // a message sent while the agent was mid-reply lands chronologically (even if
    // that splits the agent's turn) rather than all piling at the bottom.
    for (const e of selectedPending) {
      const bubble = {
        role: 'user',
        id: `queued-${e.key}`,
        createdAt: new Date(e.at),
        content: [{ type: 'text', text: e.label }],
        metadata: { custom: { cockpitRole: 'user', optimistic: true } },
      } as ThreadMessageLike;
      let idx = base.length;
      for (let i = 0; i < base.length; i++) {
        const c = base[i].createdAt;
        if (c instanceof Date && c.getTime() > e.at) {
          idx = i;
          break;
        }
      }
      base.splice(idx, 0, bubble);
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

  // Settings modal + Cmd/Ctrl+K command palette.
  const [configOpen, setConfigOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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
  const [processOpen, setProcessOpen] = useState(false);
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);
  useEffect(() => {
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

  // Sticky conversations: tail new/streaming content while pinned to the bottom;
  // scrolling up detaches (and shows the ↓ button); returning to the bottom (or
  // tapping ↓) re-attaches. The KEY safety vs the earlier freeze: tailing is
  // SUPPRESSED while the user is actively touching/scrolling, so a streaming
  // session can never yank the viewport out from under a swipe. tail() is also
  // rAF-coalesced so bursty streams cost one scroll write per frame.
  useEffect(() => {
    if (!cockpit.selectedId) return;
    let vp: HTMLElement | null = null;
    let btn: HTMLElement | null = null;
    let mo: MutationObserver | null = null;
    let ro: ResizeObserver | null = null;
    let raf = 0;
    let tailRaf = 0;
    let settle = 0;
    let tries = 0;
    let pinned = true;
    let interacting = false;

    const atBottom = () => !!vp && vp.scrollHeight - vp.scrollTop - vp.clientHeight < 80;
    const updateBtn = () => {
      if (btn) btn.dataset.show = vp && !atBottom() ? 'true' : '';
    };
    const tail = () => {
      if (tailRaf) return;
      tailRaf = requestAnimationFrame(() => {
        tailRaf = 0;
        if (vp && pinned && !interacting) vp.scrollTop = vp.scrollHeight;
      });
    };
    const onScroll = () => {
      if (!interacting) pinned = atBottom();
      updateBtn();
    };
    const beginInteract = () => {
      interacting = true;
      clearTimeout(settle);
    };
    const endInteract = () => {
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        interacting = false;
        pinned = atBottom();
        updateBtn();
      }, 160);
    };
    const onWheel = () => {
      beginInteract();
      endInteract();
    };

    const attach = () => {
      vp = document.querySelector('.thread-viewport');
      btn = document.querySelector('.scroll-to-bottom');
      if (!vp) {
        if (tries++ < 40) raf = requestAnimationFrame(attach);
        return;
      }
      pinned = true;
      vp.scrollTop = vp.scrollHeight;
      updateBtn();
      vp.addEventListener('scroll', onScroll, { passive: true });
      vp.addEventListener('touchstart', beginInteract, { passive: true });
      vp.addEventListener('touchend', endInteract, { passive: true });
      vp.addEventListener('touchcancel', endInteract, { passive: true });
      vp.addEventListener('wheel', onWheel, { passive: true });
      mo = new MutationObserver(tail);
      mo.observe(vp, { childList: true, subtree: true, characterData: true });

      // Keep the ↓ button above the composer at any composer height.
      const root = vp.closest<HTMLElement>('.thread-root');
      const composer = root?.querySelector<HTMLElement>('.composer') ?? null;
      if (root && composer && 'ResizeObserver' in window) {
        const setH = () => root.style.setProperty('--composer-h', `${composer.offsetHeight}px`);
        setH();
        ro = new ResizeObserver(setH);
        ro.observe(composer);
      }
    };
    raf = requestAnimationFrame(attach);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(tailRaf);
      clearTimeout(settle);
      if (vp) {
        vp.removeEventListener('scroll', onScroll);
        vp.removeEventListener('touchstart', beginInteract);
        vp.removeEventListener('touchend', endInteract);
        vp.removeEventListener('touchcancel', endInteract);
        vp.removeEventListener('wheel', onWheel);
      }
      if (mo) mo.disconnect();
      if (ro) ro.disconnect();
    };
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
  // badges): ⌘E rename · ⌘J raw terminal · ⌘U sub-agents · ⌘B minimise sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        toggleRail();
      } else if (k === 'e' && selectedSession) {
        e.preventDefault();
        setRenaming(selectedSession.name ?? selectedSession.id);
      } else if (k === 'j' && selectedSession) {
        e.preventDefault();
        toggleTerminal();
      } else if (k === 'u' && cockpit.subagents.length > 0) {
        e.preventDefault();
        setPanelOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedSession, cockpit.subagents.length, toggleRail, toggleTerminal]);

  // ⌘/Ctrl+1‑9 jumps to the Nth session/pane in the rail's order (session name →
  // window → pane). Skipped while the command palette is open — it uses ⌘N for
  // its own quick-select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paletteOpen) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const ordered = cockpit.sessions
        .filter((s) => s.kind !== 'terminal') // Claude Code sessions only
        .sort(
          (a, b) =>
            (a.sessionName ?? '').localeCompare(b.sessionName ?? '', undefined, { numeric: true }) ||
            (a.windowIndex ?? 0) - (b.windowIndex ?? 0) ||
            (a.paneIndex ?? 0) - (b.paneIndex ?? 0),
        );
      const target = ordered[Number(e.key) - 1];
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        // If focus is inside a ttyd iframe, the NEXT ⌘N would go to the iframe
        // (and the browser), not our window listener — so chaining ⌘1→⌘2→…
        // breaks. Pull focus back into the top document after switching.
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae.tagName === 'IFRAME') ae.blur();
        const host = document.querySelector<HTMLElement>('.detail-body') ?? document.body;
        host.setAttribute('tabindex', '-1');
        host.focus({ preventScroll: true });
        select(target.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cockpit.sessions, paletteOpen, select]);

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

  // ⌘/Ctrl+. scrolls the transcript to the latest (re-attaches tailing — the
  // controller's scroll listener flips back to pinned once it reaches bottom).
  // (⌘. not ↓: iPad/Safari reserves ⌘↓.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '.' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return; // let dialogs handle keys
      const vp = document.querySelector<HTMLElement>('.thread-viewport');
      if (vp) {
        e.preventDefault();
        vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
    <ArtifactPanelProvider>
      <div
        ref={appRef}
        className="app"
        data-detail={cockpit.selectedId && !railOpenMobile ? 'open' : 'closed'}
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
        {showIosHint ? (
          <div className="ios-push-hint" role="note">
            On iPhone/iPad, add this site to your Home Screen to receive push
            notifications.
          </div>
        ) : null}

        <div className="app-body">
          <aside className="rail" ref={railRef}>
            <NewSessionForm onToast={showToast} />
            <div className="rail-scroll">
              <SessionRail
                sessions={cockpit.sessions}
                selectedId={cockpit.selectedId}
                onSelect={select}
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
                ↻
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
                      {selectedSession?.name || cockpit.selectedId || 'claude control'}
                    </span>
                    {selectedSession?.cwd ? (
                      <span className="detail-cwd" title={selectedSession.cwd}>
                        {selectedSession.cwd.replace(/\/$/, '').split('/').pop() || selectedSession.cwd}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
              {/* All actions live on the RIGHT, as uniform small icon buttons. */}
              <div className="detail-actions">
                {selectedSession && renaming === null ? (
                  <>
                    <button
                      type="button"
                      className="detail-action"
                      aria-label="Rename session"
                      title="Rename session (⌘E)"
                      data-hotkey="⌘E"
                      data-hotkey-dir="down"
                      onClick={() => setRenaming(selectedSession.name ?? selectedSession.id)}
                    >
                      <PencilIcon />
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
                    {cockpit.subagents.length > 0 ? (
                      <button
                        type="button"
                        className="detail-action detail-action--count"
                        aria-pressed={panelOpen}
                        data-on={panelOpen ? 'true' : undefined}
                        aria-label="Sub-agents"
                        title="Sub-agents (⌘U)"
                        data-hotkey="⌘U"
                        data-hotkey-dir="down"
                        onClick={() => setPanelOpen((v) => !v)}
                      >
                        <BotIcon />
                        <span className="detail-action-count">{cockpit.subagents.length}</span>
                      </button>
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
                {/* No transcript thread here, so queued sends would otherwise be
                    invisible (they only echo in the raw pane). Surface them as a
                    compact strip so you can still see what you sent + that it's
                    in flight. They clear via the same reconcile path. */}
                {selectedPending.length > 0 ? (
                  <div className="live-pending" aria-label="Queued sends">
                    {selectedPending.map((e) => (
                      <div key={e.key} className="live-pending-bubble">
                        <span className="live-pending-dot" aria-hidden="true" />
                        {e.label}
                      </div>
                    ))}
                  </div>
                ) : null}
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

        {/* Up to 4 warm ttyd panels stay mounted (LRU); only the current
            session's, when shown, is visible — `visible` fades+zooms it in/out
            so opening never waits on a fresh ttyd load. */}
        {warmTerms.map((id) => (
          <TerminalPanel
            key={id}
            sessionId={id}
            visible={id === cockpit.selectedId && terminalShown}
            label={cockpit.sessions.find((s) => s.id === id)?.name ?? id}
            onClose={() => setTerminalShown(false)}
          />
        ))}

        <SubAgentPanel
          subagents={cockpit.subagents}
          open={panelOpen && cockpit.subagents.length > 0}
          onClose={() => setPanelOpen(false)}
        />

        {processOpen ? (
          <ProcessPanel
            power={cockpit.resources.snapshot?.power ?? null}
            onClose={() => setProcessOpen(false)}
            onToast={showToast}
          />
        ) : null}

        {paletteOpen ? (
          <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
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
