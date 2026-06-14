import { wsUrl } from './api';
import type { ClientMessage, ServerMessage } from './types';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type ConnState = 'connecting' | 'connected' | 'disconnected';

type MsgHandler = (msg: ServerMessage) => void;
type StateHandler = (state: ConnState) => void;

/**
 * Resilient WebSocket client for the cockpit backend.
 *
 * - Reconnects with exponential backoff (capped).
 * - On every (re)open, re-sends `subscribe` for the currently-selected session,
 *   because the server forgets subscriptions when a socket drops.
 */
export class CockpitSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private selectedId: string | null = null;
  private closed = false;

  private msgHandlers = new Set<MsgHandler>();
  private stateHandlers = new Set<StateHandler>();

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.emitState('connecting');
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.emitState('connected');
      // Server pushes sessions + resources on open. Re-subscribe so the
      // transcript stream resumes after a drop.
      if (this.selectedId) {
        this.send({ type: 'subscribe', id: this.selectedId });
      }
    });

    ws.addEventListener('message', (evt) => {
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(evt.data as string) as ServerMessage;
      } catch {
        return;
      }
      for (const h of this.msgHandlers) h(parsed);
    });

    ws.addEventListener('close', () => {
      this.ws = null;
      this.emitState('disconnected');
      if (!this.closed) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' fires next and drives reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  send(msg: ClientMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Switch the active subscription (unsubscribe old, subscribe new). */
  select(id: string | null): void {
    if (this.selectedId === id) return;
    if (this.selectedId) this.send({ type: 'unsubscribe', id: this.selectedId });
    this.selectedId = id;
    if (id) this.send({ type: 'subscribe', id });
  }

  onMessage(h: MsgHandler): () => void {
    this.msgHandlers.add(h);
    return () => this.msgHandlers.delete(h);
  }

  onState(h: StateHandler): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }

  private emitState(state: ConnState): void {
    for (const h of this.stateHandlers) h(state);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
