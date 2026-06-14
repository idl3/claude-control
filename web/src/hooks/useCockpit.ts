import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CockpitSocket, type ConnState } from '../lib/ws';
import type {
  Msg,
  Pending,
  ResourceSnapshot,
  Session,
} from '../lib/types';

export interface ResourceState {
  snapshot: ResourceSnapshot | null;
  warning: string | null;
}

export interface CockpitStore {
  sessions: Session[];
  selectedId: string | null;
  messages: Msg[];
  pending: Pending | null;
  conn: ConnState;
  resources: ResourceState;
  capture: string | null;
  select: (id: string) => void;
  sendReply: (text: string) => boolean;
  sendAnswer: (toolUseId: string, selections: string[][]) => boolean;
  requestCapture: () => boolean;
  clearCapture: () => void;
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
  const [capture, setCapture] = useState<string | null>(null);

  // Per-session caches. Mutated via setState replacement (immutable updates).
  const [messagesById, setMessagesById] = useState<Record<string, Msg[]>>({});
  const [pendingById, setPendingById] = useState<Record<string, Pending | null>>(
    {},
  );

  // selectedId in a ref so the message handler (registered once) reads fresh.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  useEffect(() => {
    const offState = socket.onState(setConn);
    const offMsg = socket.onMessage((msg) => {
      switch (msg.type) {
        case 'sessions':
          setSessions(msg.sessions ?? []);
          break;
        case 'messages':
          setMessagesById((prev) => ({ ...prev, [msg.id]: msg.messages ?? [] }));
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
        case 'resources':
          setResources({
            snapshot: msg.snapshot ?? null,
            warning: msg.warning ?? null,
          });
          break;
        case 'capture':
          if (msg.id === selectedRef.current) setCapture(msg.text ?? '');
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

  const requestCapture = useCallback((): boolean => {
    const id = selectedRef.current;
    if (!id) return false;
    return socket.send({ type: 'capture', id });
  }, [socket]);

  const clearCapture = useCallback(() => setCapture(null), []);

  const messages = useMemo(
    () => (selectedId ? messagesById[selectedId] ?? [] : []),
    [selectedId, messagesById],
  );
  const pending = useMemo(
    () => (selectedId ? pendingById[selectedId] ?? null : null),
    [selectedId, pendingById],
  );

  return {
    sessions,
    selectedId,
    messages,
    pending,
    conn,
    resources,
    capture,
    select,
    sendReply,
    sendAnswer,
    requestCapture,
    clearCapture,
  };
}
