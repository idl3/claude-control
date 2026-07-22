import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClaudeControlSocket, type ConnState } from '../lib/ws';
import { mergeMessages } from '../lib/messages';
import { mergeById, seedFromHead, canLoadMore, applyPage, EMPTY_PAGING, type OrgPaging } from '../lib/olamPaging';
import { fetchOlamPage } from '../lib/api';
import type {
  AnswerSelection,
  Msg,
  OrgHealth,
  PanePrompt,
  Pending,
  RawEvent,
  ResourceSnapshot,
  Session,
  SubAgent,
  Workflow,
} from '../lib/types';

export interface ResourceState {
  snapshot: ResourceSnapshot | null;
  warning: string | null;
}

/** One sampled point of system load for the process-monitor time chart. */
export interface ResourcePoint {
  t: number;
  cpu: number;
  mem: number;
}
const RESOURCE_WINDOW_MS = 10 * 60_000; // keep the last 10 minutes
const RAW_EVENT_CAP = 200;
const SESSION_CACHE_GRACE_MS = 5 * 60_000;

function pruneRecord<T>(record: Record<string, T>, liveIds: Set<string>): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.every((id) => liveIds.has(id))) return record;
  return Object.fromEntries(keys.filter((id) => liveIds.has(id)).map((id) => [id, record[id]]));
}

export interface ClaudeControlStore {
  sessions: Session[];
  selectedId: string | null;
  messages: Msg[];
  pending: Pending | null;
  prompt: PanePrompt | null;
  /** Remote (olam) selected session in degraded (log-tail) streaming mode. */
  degraded: { degraded: boolean; reason: string | null } | null;
  subagents: SubAgent[];
  /**
   * Number of *running* sub-agents per session id. Only sessions with ≥1 running
   * sub-agent appear as keys. Used by SessionRail to show the "cloning" icon state.
   */
  runningSubagentCountById: Record<string, number>;
  /**
   * Parsed workflow runs per session id (only sessions that have run ≥1 workflow
   * appear as keys). Rides the session poll — a component looks up a run by
   * session id then `runId`. Server-parsed in lib/workflows.js.
   */
  workflowsById: Record<string, Workflow[]>;
  /**
   * Row-independent per-org health, keyed by org slug (server.js
   * olamOrgHealth() — RemoteSessionSource.health()). Lets a cloud tab's
   * empty-state distinguish "genuinely no sessions" from "Access session
   * expired" even when zero rows for that org have ever arrived.
   */
  orgHealth: Record<string, OrgHealth>;
  /**
   * True when a remote (olam) org has a fetchable next page beyond the
   * scrolled tail already merged into `sessions` — drives the rail's
   * IntersectionObserver sentinel for the active cloud tab (SessionRail's
   * `remoteHasMore` prop). Derived from per-org paging state; see
   * lib/olamPaging.ts.
   */
  orgHasMore: Record<string, boolean>;
  /** True while a page fetch for that org is in flight (SessionRail's
   *  `remoteLoadingMore` prop — renders a "loading more…" affordance). */
  orgLoadingMore: Record<string, boolean>;
  /** Fetch the next page of a remote org's session list (rail sentinel
   *  callback). Guarded against duplicate concurrent fetches per org; no-op
   *  when the org has no fetchable cursor or is already loading. */
  loadMoreOlam: (org: string) => void;
  /**
   * On-demand workflow-agent transcripts, keyed `${runId}::${agentId}`. Loaded
   * via requestWorkflowAgent when the Agent View opens "full transcript"; fed to
   * the reused SubAgentThread viewer (B3). `loaded` distinguishes "still
   * fetching" from "genuinely empty".
   */
  workflowAgentById: Record<string, { messages: Msg[]; loaded: boolean }>;
  conn: ConnState;
  resources: ResourceState;
  /** Rolling ~10min CPU%/Mem% history for the process-monitor chart. */
  resourceHistory: ResourcePoint[];
  rawEvents: RawEvent[];
  capture: string | null;
  /** Live capture of the dedicated shell pane (composer terminal mode). */
  shellOutput: string | null;
  /**
   * True when a TUI picker (AskUserQuestion / permission / trust / plan / custom menu)
   * is currently ON SCREEN in the selected session's pane.  This is the fastest
   * send-guard signal — broadcast by the server the moment a picker renders
   * (screen-truth, arrives earlier than the structured `pending` transcript signal).
   */
  pickerOpen: boolean;
  /** Per-session picker state map — exposed for debugging / advanced callers. */
  pickerOpenById: Record<string, boolean>;
  /**
   * True once the selected session's transcript can be trusted as fully loaded.
   *
   * - LOCAL / codex sessions: true as soon as the server's `messages` frame has
   *   arrived (the `in` operator — an empty `[]` counts as loaded, since a local
   *   tailer's first frame IS the whole known tail, sync with the transcript file).
   * - REMOTE (olam) sessions: gated on the `olam-transcript-ready` signal instead
   *   — an empty `[]` `messages` frame merely means "no backfill has landed on
   *   the wire yet", NOT "genuinely empty" (the Electric chunks shape drains its
   *   snapshot asynchronously; see lib/olam-transcript.js's ShapeSubscriber).
   *
   * False while the session is selected but its transcript is still loading.
   * Used to show a loader instead of the empty-state welcome during the load
   * window, and to keep the composer disabled until the transcript settles.
   */
  messagesLoaded: boolean;
  select: (id: string) => void;
  resubscribe: () => void;
  sendReply: (text: string, attachments?: number, viaAnswer?: boolean, hardSteer?: boolean) => string | null;
  /**
   * Move a tmux WINDOW (a client session) to another tmux SESSION by name.
   * Unlike sendReply/sendAnswer, `srcId` is an explicit argument — not read
   * off `selectedRef` — because the rail drag-and-drop path can move a pane
   * that isn't the currently selected session. Returns a reqId (same
   * timestamp+counter idiom as sendReply) the caller correlates against the
   * `ack` op:'move-window' frame — see that frame's `newId` doc comment
   * (lib/types.ts) for why the client must re-select after a successful move.
   */
  sendMoveWindow: (srcId: string, dest: string) => string | null;
  sendPromptKey: (key: string) => boolean;
  sendPromptSelect: (id: string, labels: string[]) => boolean;
  sendAnswer: (toolUseId: string, selections: AnswerSelection[]) => boolean;
  /**
   * Dismiss a stale `pending` question WITHOUT answering it — e.g. the session
   * hit a usage-limit/API error and the question can no longer be answered, so
   * the server keeps reporting the same `pending` forever. Records the
   * dismissed question's `toolUseId` for `id` so the derived `pending` (below)
   * suppresses it; a genuinely NEW question (different `toolUseId`) is not
   * suppressed. Sends nothing over the wire — purely a client-side hide.
   */
  dismissPending: (id: string, toolUseId: string) => void;
  requestSubagent: (agentId: string) => boolean;
  /** Load a workflow agent's full transcript (B3 Agent View overlay). */
  requestWorkflowAgent: (runId: string, agentId: string) => boolean;
  requestCapture: (lines?: number, escapes?: boolean) => boolean;
  clearCapture: () => void;
  /** Interactive terminal panes: relay a literal char / control key to the selected pane. */
  sendPaneText: (text: string) => boolean;
  sendPaneKey: (key: string) => boolean;
  /** Terminal mode: run a command line in the shell pane. */
  sendShellInput: (line: string) => boolean;
  /** Terminal mode: forward literal keystroke text (no Enter) — raw passthrough. */
  sendShellText: (text: string) => boolean;
  /** Terminal mode: send an allow-listed control key (e.g. C-c). */
  sendShellKey: (key: string) => boolean;
  /** Terminal mode: poll the shell pane capture. */
  requestShellCapture: (lines?: number) => boolean;
  clearShellOutput: () => void;
}

/**
 * Single source of truth: owns the WebSocket and exposes derived React state.
 * Per-session message buffers are cached so re-selecting a session is instant.
 */
export function useClaudeControl(): ClaudeControlStore {
  const socketRef = useRef<ClaudeControlSocket | null>(null);
  if (!socketRef.current) socketRef.current = new ClaudeControlSocket();
  const socket = socketRef.current;

  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [resources, setResources] = useState<ResourceState>({
    snapshot: null,
    warning: null,
  });
  const [resourceHistory, setResourceHistory] = useState<ResourcePoint[]>([]);
  const [capture, setCapture] = useState<string | null>(null);
  const [shellOutput, setShellOutput] = useState<string | null>(null);

  // Per-session caches. Mutated via setState replacement (immutable updates).
  const [messagesById, setMessagesById] = useState<Record<string, Msg[]>>({});
  const [degradedById, setDegradedById] = useState<Record<string, { degraded: boolean; reason: string | null }>>({});
  // Remote (olam) sessions only: sessionId -> true once the server has forwarded
  // `olam-transcript-ready` (the Electric shape's initial snapshot drained to its
  // live cursor). See `messagesLoaded` below for how this gates loading per kind.
  const [readyById, setReadyById] = useState<Record<string, boolean>>({});
  const [pendingById, setPendingById] = useState<Record<string, Pending | null>>(
    {},
  );
  // sessionId -> the toolUseId of a `pending` question the user explicitly
  // dismissed (stale-question escape hatch). Survives snapshot/pending WS
  // frames re-setting pendingById[id] — see the `pending` memo below, which
  // suppresses a pendingById entry whose toolUseId matches this map.
  const [dismissedById, setDismissedById] = useState<Record<string, string>>({});
  // sessionId -> (agentId -> SubAgent). Sub-agents stream independently of the
  // main transcript; keyed by agentId so updates upsert in place.
  const [subagentsById, setSubagentsById] = useState<
    Record<string, Record<string, SubAgent>>
  >({});
  const [rawEventsById, setRawEventsById] = useState<Record<string, RawEvent[]>>({});
  // Workflow-agent transcripts loaded on demand (B3), keyed `${runId}::${agentId}`.
  const [workflowAgentById, setWorkflowAgentById] = useState<
    Record<string, { messages: Msg[]; loaded: boolean }>
  >({});
  const [promptById, setPromptById] = useState<Record<string, PanePrompt | null>>({});
  // Pane-scrape picker signal: open:true means a TUI picker is on screen right now.
  const [pickerOpenById, setPickerOpenById] = useState<Record<string, boolean>>({});
  // Per-org health, rides every 'sessions' frame — see the ClaudeControlStore field doc.
  const [orgHealth, setOrgHealth] = useState<Record<string, OrgHealth>>({});
  // Per-org scrolled-tail paging state (pages 2..N) — see lib/olamPaging.ts.
  const [olamPaging, setOlamPaging] = useState<Record<string, OrgPaging>>({});

  // selectedId in a ref so the message handler (registered once) reads fresh.
  const selectedRef = useRef<string | null>(null);
  const replySeq = useRef(0); // monotonic suffix for reply correlation ids
  selectedRef.current = selectedId;
  // sessions in a ref so shell ops can resolve the selected session's cwd.
  const sessionsRef = useRef<Session[]>([]);
  const sessionSeenRef = useRef<Record<string, number>>({});
  sessionsRef.current = sessions;
  // olamPaging in a ref so loadMoreOlam (a stable useCallback) reads fresh
  // state without depending on olamPaging (which would re-create the
  // callback, and thus the sentinel's IntersectionObserver, on every page).
  const olamPagingRef = useRef(olamPaging);
  olamPagingRef.current = olamPaging;
  // Per-org in-flight guard so a fast double-fire of the sentinel (or a
  // slow response overlapping a new one) can't issue two concurrent fetches
  // for the same org.
  const inFlightOrgs = useRef<Set<string>>(new Set());

  useEffect(() => {
    const offState = socket.onState(setConn);
    const offMsg = socket.onMessage((msg) => {
      switch (msg.type) {
        case 'sessions': {
          // Carry forward the last-known model / ctxPct when a refresh omits
          // them: the pane/transcript parse intermittently returns null mid-
          // generation, which would drop the meta row and make the card's height
          // flicker ("wonky"). Sticky values keep the row stable; they update as
          // soon as a refresh carries a real value again.
          setSessions((prev) => {
            const byId = new Map(prev.map((s) => [s.id, s]));
            return (msg.sessions ?? []).map((s) => {
              const old = byId.get(s.id);
              if (!old) return s;
              return {
                ...s,
                model: s.model ?? old.model,
                ctxPct: s.ctxPct ?? old.ctxPct,
              };
            });
          });
          const now = Date.now();
          const liveIds = new Set((msg.sessions ?? []).map((s) => s.id));
          for (const id of liveIds) sessionSeenRef.current[id] = now;
          const retainedIds = new Set(liveIds);
          // An opened deep-tail row (a scrolled-in remote session past the
          // live head — see olamPaging/mergedSessions below) never appears in
          // `liveIds` (the WS head snapshot doesn't know about it), so
          // without this it would fall out of the grace window and have its
          // cached messages/pending/etc. pruned out from under the operator
          // while it's still selected.
          if (selectedRef.current) retainedIds.add(selectedRef.current);
          for (const [id, lastSeen] of Object.entries(sessionSeenRef.current)) {
            if (now - lastSeen <= SESSION_CACHE_GRACE_MS) retainedIds.add(id);
            else delete sessionSeenRef.current[id];
          }
          setMessagesById((prev) => pruneRecord(prev, retainedIds));
          setDegradedById((prev) => pruneRecord(prev, retainedIds));
          setReadyById((prev) => pruneRecord(prev, retainedIds));
          setPendingById((prev) => pruneRecord(prev, retainedIds));
          setDismissedById((prev) => pruneRecord(prev, retainedIds));
          setSubagentsById((prev) => pruneRecord(prev, retainedIds));
          setRawEventsById((prev) => pruneRecord(prev, retainedIds));
          setPromptById((prev) => pruneRecord(prev, retainedIds));
          setPickerOpenById((prev) => pruneRecord(prev, retainedIds));
          if (msg.orgHealth) setOrgHealth(msg.orgHealth);
          break;
        }
        case 'messages':
          // MERGE, don't replace: the server re-sends a snapshot of its bounded
          // (and periodically trimmed) tail on every (re)subscribe. Replacing
          // would drop older messages we already showed — the cause of user
          // chats "disappearing" after a reconnect. See lib/messages.ts.
          setMessagesById((prev) => ({
            ...prev,
            [msg.id]: mergeMessages(prev[msg.id], msg.messages ?? []),
          }));
          setPendingById((prev) => ({ ...prev, [msg.id]: msg.pending ?? null }));
          break;
        case 'append':
          setMessagesById((prev) => ({
            ...prev,
            [msg.id]: mergeMessages(prev[msg.id], msg.messages ?? []),
          }));
          break;
        case 'olam-degraded':
          setDegradedById((prev) => ({
            ...prev,
            [msg.id]: { degraded: !!msg.degraded, reason: msg.reason ?? null },
          }));
          break;
        case 'olam-transcript-ready':
          setReadyById((prev) => (prev[msg.id] ? prev : { ...prev, [msg.id]: true }));
          break;
        case 'pending':
          setPendingById((prev) => ({ ...prev, [msg.id]: msg.pending }));
          // Keep the rail badge in sync without waiting for the next snapshot.
          setSessions((prev) =>
            prev.map((s) =>
              s.id === msg.id ? { ...s, pending: !!msg.pending } : s,
            ),
          );
          break;
        case 'resources': {
          const snap = msg.snapshot ?? null;
          setResources({ snapshot: snap, warning: msg.warning ?? null });
          // Append a sample for the 10-min chart; drop points outside the window.
          if (snap) {
            const now = Date.now();
            const point = {
              t: now,
              cpu: snap.self?.cpuPct ?? 0,
              mem: snap.system?.memUsedPct ?? 0,
            };
            setResourceHistory((h) =>
              [...h, point].filter((p) => now - p.t <= RESOURCE_WINDOW_MS),
            );
          }
          break;
        }
        case 'capture':
          if (msg.id === selectedRef.current) setCapture(msg.text ?? '');
          break;
        case 'shell-output':
          // Per-session sister shell — ignore output for a session we've since
          // switched away from (a stale in-flight poll).
          if (!msg.id || msg.id === selectedRef.current) setShellOutput(msg.text ?? '');
          break;
        case 'prompt':
          setPromptById((prev) => ({ ...prev, [msg.id]: msg.prompt }));
          break;
        case 'picker':
          setPickerOpenById((prev) => ({ ...prev, [msg.id]: msg.open }));
          break;
        case 'subagents':
          // Snapshot: replace this session's sub-agent map.
          setSubagentsById((prev) => ({
            ...prev,
            [msg.id]: Object.fromEntries(
              (msg.subagents ?? []).map((a) => [a.agentId, a]),
            ),
          }));
          break;
        case 'subagent':
          // Incremental upsert by agentId.
          setSubagentsById((prev) => ({
            ...prev,
            [msg.id]: { ...(prev[msg.id] ?? {}), [msg.subagent.agentId]: msg.subagent },
          }));
          break;
        case 'workflow-agent':
          // On-demand workflow-agent transcript (B3). Keyed by run+agent so it
          // survives session polls; the Agent View overlay reads it by that key.
          setWorkflowAgentById((prev) => ({
            ...prev,
            [`${msg.runId}::${msg.agentId}`]: { messages: msg.messages ?? [], loaded: true },
          }));
          break;
        case 'raw-events':
          setRawEventsById((prev) => ({
            ...prev,
            [msg.id]: (msg.events ?? []).slice(-RAW_EVENT_CAP),
          }));
          break;
        case 'raw-event':
          setRawEventsById((prev) => {
            const next = [...(prev[msg.id] ?? []), msg.event].slice(-RAW_EVENT_CAP);
            return { ...prev, [msg.id]: next };
          });
          break;
        case 'ack':
          // Surfaced to the toast layer via the custom event below so the
          // store stays free of UI concerns.
          window.dispatchEvent(
            new CustomEvent('cockpit:ack', { detail: msg }),
          );
          break;
        case 'media-app-changed':
          // D2: same decoupling idiom as 'ack' above — AppFrameLayer owns the
          // actual hot-reload decision (panel-hosted, track-latest slots
          // only; see shouldReloadOnFrame), so the store stays free of it.
          window.dispatchEvent(
            new CustomEvent('cockpit:media-app-changed', { detail: msg }),
          );
          break;
        default:
          break;
      }
    });

    socket.connect();
    return () => {
      offState();
      offMsg();
    };
  }, [socket]);

  // Close the socket only when the whole app unmounts.
  useEffect(() => () => socket.close(), [socket]);

  // Seed/refresh each org's paging cursor from the live head's orgHealth.
  // seedFromHead is a no-op once an org's tail has started accumulating (the
  // client cursor becomes authoritative) — see lib/olamPaging.ts.
  useEffect(() => {
    setOlamPaging((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [org, h] of Object.entries(orgHealth)) {
        const seeded = seedFromHead(prev[org], h);
        if (seeded !== prev[org]) {
          next[org] = seeded;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [orgHealth]);

  // Fetch the next page for a remote org (rail sentinel callback). Guarded by
  // inFlightOrgs so a fast double-fire of the IntersectionObserver (or a slow
  // response overlapping a fresh trigger) can't issue two concurrent fetches
  // for the same org. Deliberately dependency-free (reads olamPagingRef) so
  // the callback identity is stable across renders/pages.
  const loadMoreOlam = useCallback(async (org: string) => {
    if (inFlightOrgs.current.has(org)) return;
    const cur = olamPagingRef.current[org];
    if (!canLoadMore(cur)) return;
    inFlightOrgs.current.add(org);
    setOlamPaging((p) => ({ ...p, [org]: { ...(p[org] ?? EMPTY_PAGING), loading: true } }));
    try {
      const page = await fetchOlamPage(org, cur!.cursor!);
      setOlamPaging((p) => (p[org] ? { ...p, [org]: applyPage(p[org], page) } : p));
    } catch {
      setOlamPaging((p) => (p[org] ? { ...p, [org]: { ...p[org], loading: false } } : p));
    } finally {
      inFlightOrgs.current.delete(org);
    }
  }, []);

  // Merge the live WS-pushed head (`sessions`) with each org's scrolled tail
  // (pages 2..N accumulated in olamPaging) — dedup by id, head wins on overlap.
  const mergedSessions = useMemo(() => {
    const tail = Object.values(olamPaging).flatMap((p) => p.tail);
    return tail.length === 0 ? sessions : mergeById(sessions, tail);
  }, [sessions, olamPaging]);
  const orgHasMore = useMemo(
    () => Object.fromEntries(Object.entries(olamPaging).map(([o, p]) => [o, p.hasMore && p.cursor != null])),
    [olamPaging],
  );
  const orgLoadingMore = useMemo(
    () => Object.fromEntries(Object.entries(olamPaging).map(([o, p]) => [o, p.loading])),
    [olamPaging],
  );

  const select = useCallback(
    (id: string) => {
      if (id === selectedRef.current) return;
      setSelectedId(id);
      setCapture(null);
      // Clear any stale ready flag for the session we're switching TO: the
      // server tears down + recreates a remote session's OlamTranscriptSource
      // once its last subscribed client disconnects (maybeTeardown in
      // server.js), so a prior visit's 'ready' does not describe the fresh
      // subscription's backfill — wait for a new 'olam-transcript-ready' frame.
      setReadyById((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      socket.select(id);
    },
    [socket],
  );

  // Returns a correlation id (reqId) the caller tracks until the server's
  // `ack` for that reqId confirms tmux actually accepted the send — WS-write
  // success alone is NOT delivery. Null means the frame couldn't even be sent
  // (socket closed): nothing was dispatched, show no optimistic bubble.
  const sendReply = useCallback(
    (text: string, attachments = 0, viaAnswer = false, hardSteer = false): string | null => {
      const id = selectedRef.current;
      if (!id || !text.trim()) return null;
      const reqId = `r${Date.now().toString(36)}${(replySeq.current++).toString(36)}`;
      // attachments → server scales the paste→Enter settle so image-laden sends
      // actually submit (the TUI ingests each pasted path asynchronously).
      // viaAnswer marks a reply that the inline question/prompt component sends as
      // the trailing free-text of a DELIBERATE answer (it has already navigated the
      // picker via promptkey/answer first). The server's open-question reply guard
      // refuses raw composer replies into an open picker, but must let these
      // through — they ARE the answer, not an accidental keystroke.
      const ok = socket.send({ type: 'reply', id, text, reqId, attachments, viaAnswer, hardSteer });
      return ok ? reqId : null;
    },
    [socket],
  );

  const sendMoveWindow = useCallback(
    (srcId: string, dest: string): string | null => {
      if (!srcId || !dest) return null;
      const reqId = `r${Date.now().toString(36)}${(replySeq.current++).toString(36)}`;
      const ok = socket.send({ type: 'move-window', id: srcId, dest, reqId });
      return ok ? reqId : null;
    },
    [socket],
  );

  const sendAnswer = useCallback(
    (toolUseId: string, selections: AnswerSelection[]): boolean => {
      const id = selectedRef.current;
      if (!id) return false;
      return socket.send({ type: 'answer', id, toolUseId, selections });
    },
    [socket],
  );

  const dismissPending = useCallback((id: string, toolUseId: string) => {
    setDismissedById((prev) => ({ ...prev, [id]: toolUseId }));
    // Keep the rail badge in sync immediately (same as the 'pending' WS case).
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, pending: false } : s)));
  }, []);

  const requestSubagent = useCallback(
    (agentId: string): boolean => {
      const id = selectedRef.current;
      if (!id || !agentId) return false;
      return socket.send({ type: 'subagent-load', id, agentId });
    },
    [socket],
  );

  const requestWorkflowAgent = useCallback(
    (runId: string, agentId: string): boolean => {
      const id = selectedRef.current;
      if (!id || !runId || !agentId) return false;
      return socket.send({ type: 'workflow-agent-load', id, runId, agentId });
    },
    [socket],
  );

  const requestCapture = useCallback(
    (lines?: number, escapes?: boolean): boolean => {
      const id = selectedRef.current;
      if (!id) return false;
      return socket.send({ type: 'capture', id, lines, escapes });
    },
    [socket],
  );

  const clearCapture = useCallback(() => setCapture(null), []);

  // Interactive terminal panes: relay keystrokes to the SELECTED pane by id.
  const sendPaneText = useCallback(
    (text: string): boolean => {
      const id = selectedRef.current;
      if (!id) return false;
      return socket.send({ type: 'pane-text', id, text });
    },
    [socket],
  );
  const sendPaneKey = useCallback(
    (key: string): boolean => {
      const id = selectedRef.current;
      if (!id) return false;
      return socket.send({ type: 'pane-key', id, key });
    },
    [socket],
  );

  // Composer terminal mode (>_): each Claude session has its OWN sister shell
  // pane in its window. All shell ops carry the selected session id; the server
  // resolves that session's window + cwd and lazily creates/reuses the sister.
  const sendShellInput = useCallback(
    (line: string): boolean => {
      const id = selectedRef.current;
      return id ? socket.send({ type: 'shell-input', id, line }) : false;
    },
    [socket],
  );
  const sendShellText = useCallback(
    (text: string): boolean => {
      const id = selectedRef.current;
      return id ? socket.send({ type: 'shell-text', id, text }) : false;
    },
    [socket],
  );
  const sendShellKey = useCallback(
    (key: string): boolean => {
      const id = selectedRef.current;
      return id ? socket.send({ type: 'shell-key', id, key }) : false;
    },
    [socket],
  );
  const requestShellCapture = useCallback(
    (lines?: number): boolean => {
      const id = selectedRef.current;
      return id ? socket.send({ type: 'shell-capture', id, lines }) : false;
    },
    [socket],
  );
  const clearShellOutput = useCallback(() => setShellOutput(null), []);

  const resubscribe = useCallback(() => socket.resubscribe(), [socket]);
  const sendPromptKey = useCallback(
    (key: string): boolean => {
      const id = selectedRef.current;
      if (!id) return false;
      return socket.send({ type: 'promptkey', id, key });
    },
    [socket],
  );
  const sendPromptSelect = useCallback(
    (id: string, labels: string[]): boolean => {
      return socket.send({ type: 'promptselect', id, labels });
    },
    [socket],
  );

  // See the ClaudeControlStore.messagesLoaded doc comment above for the full
  // local-vs-remote rationale. Remote detection mirrors the rest of the hook
  // (`session.kind === 'remote'`, e.g. olamMode.ts / App.tsx), with the
  // `olam:` id prefix as a defensive fallback for the brief window before the
  // `sessions` snapshot has arrived for a just-selected id.
  const messagesLoaded = useMemo(() => {
    if (selectedId == null) return false;
    const session = sessions.find((s) => s.id === selectedId);
    const isRemote = session ? session.kind === 'remote' : selectedId.startsWith('olam:');
    if (isRemote) return !!readyById[selectedId];
    // Local / codex: the `in` operator so an empty transcript ([]) still
    // counts as loaded — unchanged from prior behavior.
    return selectedId in messagesById;
  }, [selectedId, messagesById, readyById, sessions]);

  const messages = useMemo(
    () => (selectedId ? messagesById[selectedId] ?? [] : []),
    [selectedId, messagesById],
  );
  const pending = useMemo(() => {
    if (!selectedId) return null;
    const p = pendingById[selectedId] ?? null;
    // Suppress a question the user explicitly dismissed as stale (e.g. the
    // session errored and can no longer be answered) — a snapshot/pending WS
    // frame re-sets pendingById[id] to the SAME object every time, so a local
    // clear alone wouldn't stick; comparing toolUseId lets a genuinely new
    // question (different id) through undismissed.
    if (p && dismissedById[selectedId] === p.toolUseId) return null;
    return p;
  }, [selectedId, pendingById, dismissedById]);
  const prompt = useMemo(
    () => (selectedId ? promptById[selectedId] ?? null : null),
    [selectedId, promptById],
  );
  const degraded = useMemo(
    () => (selectedId ? degradedById[selectedId] ?? null : null),
    [selectedId, degradedById],
  );
  // True when a TUI picker is on screen for the selected session right now —
  // the fastest/most-authoritative send-guard signal (screen-truth).
  const pickerOpen = useMemo(
    () => (selectedId ? (pickerOpenById[selectedId] ?? false) : false),
    [selectedId, pickerOpenById],
  );
  const rawEvents = useMemo(
    () => (selectedId ? rawEventsById[selectedId] ?? [] : []),
    [selectedId, rawEventsById],
  );
  // Sub-agents for the selected session, newest first (by created-at).
  const subagents = useMemo<SubAgent[]>(() => {
    const map = selectedId ? subagentsById[selectedId] : null;
    if (!map) return [];
    return Object.values(map).sort(
      (a, b) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity),
    );
  }, [selectedId, subagentsById]);

  // Running sub-agent count per session — drives the "cloning" rail icon state.
  const runningSubagentCountById = useMemo<Record<string, number>>(() => {
    const result: Record<string, number> = {};
    for (const [sid, agentMap] of Object.entries(subagentsById)) {
      const count = Object.values(agentMap).filter((a) => a.status === 'running').length;
      if (count > 0) result[sid] = count;
    }
    return result;
  }, [subagentsById]);

  // Workflow runs per session id — rides the session payload (lib/workflows.js).
  // Keyed for by-session + by-runId lookup; only sessions with runs appear.
  const workflowsById = useMemo<Record<string, Workflow[]>>(() => {
    const result: Record<string, Workflow[]> = {};
    for (const s of sessions) {
      if (s.workflows && s.workflows.length > 0) result[s.id] = s.workflows;
    }
    return result;
  }, [sessions]);

  return {
    sessions: mergedSessions,
    selectedId,
    messages,
    messagesLoaded,
    pending,
    prompt,
    degraded,
    subagents,
    runningSubagentCountById,
    workflowsById,
    workflowAgentById,
    orgHealth,
    orgHasMore,
    orgLoadingMore,
    loadMoreOlam,
    conn,
    resources,
    resourceHistory,
    rawEvents,
    capture,
    shellOutput,
    pickerOpen,
    pickerOpenById,
    select,
    resubscribe,
    sendReply,
    sendMoveWindow,
    sendPromptKey,
    sendPromptSelect,
    sendAnswer,
    dismissPending,
    requestSubagent,
    requestWorkflowAgent,
    requestCapture,
    clearCapture,
    sendPaneText,
    sendPaneKey,
    sendShellInput,
    sendShellText,
    sendShellKey,
    requestShellCapture,
    clearShellOutput,
  };
}
