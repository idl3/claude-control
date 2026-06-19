import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CockpitSocket, type ConnState } from '../lib/ws';
import { mergeMessages } from '../lib/messages';
import type {
  Msg,
  PanePrompt,
  Pending,
  ResourceSnapshot,
  Session,
  SubAgent,
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

export interface CockpitStore {
  sessions: Session[];
  selectedId: string | null;
  messages: Msg[];
  pending: Pending | null;
  prompt: PanePrompt | null;
  subagents: SubAgent[];
  conn: ConnState;
  resources: ResourceState;
  /** Rolling ~10min CPU%/Mem% history for the process-monitor chart. */
  resourceHistory: ResourcePoint[];
  capture: string | null;
  /** Live capture of the dedicated shell pane (composer terminal mode). */
  shellOutput: string | null;
  /**
   * True once the server has sent the `messages` frame for the selected session.
   * False while the session is selected but the transcript tail is still loading.
   * Used to show a loader instead of the empty-state welcome during the load window.
   */
  messagesLoaded: boolean;
  select: (id: string) => void;
  resubscribe: () => void;
  sendReply: (text: string) => boolean;
  sendPromptKey: (key: string) => boolean;
  sendPromptSelect: (id: string, labels: string[]) => boolean;
  sendAnswer: (toolUseId: string, selections: string[][]) => boolean;
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
export function useCockpit(): CockpitStore {
  const socketRef = useRef<CockpitSocket | null>(null);
  if (!socketRef.current) socketRef.current = new CockpitSocket();
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
  const [pendingById, setPendingById] = useState<Record<string, Pending | null>>(
    {},
  );
  // sessionId -> (agentId -> SubAgent). Sub-agents stream independently of the
  // main transcript; keyed by agentId so updates upsert in place.
  const [subagentsById, setSubagentsById] = useState<
    Record<string, Record<string, SubAgent>>
  >({});
  const [promptById, setPromptById] = useState<Record<string, PanePrompt | null>>({});

  // selectedId in a ref so the message handler (registered once) reads fresh.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  // sessions in a ref so shell ops can resolve the selected session's cwd.
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;

  useEffect(() => {
    const offState = socket.onState(setConn);
    const offMsg = socket.onMessage((msg) => {
      switch (msg.type) {
        case 'sessions':
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
          break;
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
            [msg.id]: [...(prev[msg.id] ?? []), ...(msg.messages ?? [])],
          }));
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
        case 'ack':
          // Surfaced to the toast layer via the custom event below so the
          // store stays free of UI concerns.
          window.dispatchEvent(
            new CustomEvent('cockpit:ack', { detail: msg }),
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

  const select = useCallback(
    (id: string) => {
      if (id === selectedRef.current) return;
      setSelectedId(id);
      setCapture(null);
      socket.select(id);
    },
    [socket],
  );

  const sendReply = useCallback(
    (text: string): boolean => {
      const id = selectedRef.current;
      if (!id || !text.trim()) return false;
      return socket.send({ type: 'reply', id, text });
    },
    [socket],
  );

  const sendAnswer = useCallback(
    (toolUseId: string, selections: string[][]): boolean => {
      const id = selectedRef.current;
      if (!id) return false;
      return socket.send({ type: 'answer', id, toolUseId, selections });
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

  // True once the server has delivered the `messages` frame for this session.
  // Uses the `in` operator so an empty transcript ([]) still counts as loaded.
  const messagesLoaded = useMemo(
    () => selectedId != null && selectedId in messagesById,
    [selectedId, messagesById],
  );

  const messages = useMemo(
    () => (selectedId ? messagesById[selectedId] ?? [] : []),
    [selectedId, messagesById],
  );
  const pending = useMemo(
    () => (selectedId ? pendingById[selectedId] ?? null : null),
    [selectedId, pendingById],
  );
  const prompt = useMemo(
    () => (selectedId ? promptById[selectedId] ?? null : null),
    [selectedId, promptById],
  );
  // Sub-agents for the selected session, newest first (by created-at).
  const subagents = useMemo<SubAgent[]>(() => {
    const map = selectedId ? subagentsById[selectedId] : null;
    if (!map) return [];
    return Object.values(map).sort(
      (a, b) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity),
    );
  }, [selectedId, subagentsById]);

  return {
    sessions,
    selectedId,
    messages,
    messagesLoaded,
    pending,
    prompt,
    subagents,
    conn,
    resources,
    resourceHistory,
    capture,
    shellOutput,
    select,
    resubscribe,
    sendReply,
    sendPromptKey,
    sendPromptSelect,
    sendAnswer,
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
