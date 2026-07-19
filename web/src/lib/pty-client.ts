// web/src/lib/pty-client.ts — WS client for the A4 binary PTY bridge (`/pty`).
//
// Mirrors `./ws.ts`'s `CockpitSocket` structure deliberately (same bearer-auth
// subprotocol dance, same exponential-backoff reconnect constants, same
// auth-close → handleUnauthorized() convention) — see the A1 design doc
// (docs/design/cockpit-protocol-split-native-heads.md, "Terminal panel design
// (A1)" §4) for the full rationale. Extended with two PTY-specific failure
// modes CockpitSocket never needs: a bounded outbound keystroke queue (so
// typing during a transient reconnect isn't dropped) and a distinct
// `session-ended` terminal state for A4's dead-target close code (4000).
//
// Binary frame shape (lib/protocol/pty.js, lib/pty-bridge.js): a 1-byte
// channel header (PTY_CHANNEL_DATA = 0x00) + opaque terminal bytes, both
// directions. JSON control frames (attach/resize/close/attached/error) are
// validated server-side with zod; the client just constructs literal object
// shapes matching PtyClientMessage (imported as a type only, from
// ./protocol.ts's @protocol re-export — see that file's header comment).
import { handleUnauthorized, wsUrl } from './api';
import { getToken, WS_PROTOCOL } from './auth';
import type { PtyClientMessage, PtyServerMessage } from './protocol';

// Reused verbatim from ws.ts's CockpitSocket (not re-exported from there —
// lib/ws.ts is explicitly "constants reused, not modified" per the A1 design's
// cross-refs; duplicating three primitive constants here is simpler and safer
// than adding a new export surface to the main socket for a single reuse).
const WS_AUTH_CLOSE = 1008;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

// A4's dead-target close code (private-use range per RFC 6455 §7.4.2).
const PTY_DEAD_TARGET_CLOSE = 4000;

// Binary channel header — the only channel Phase A defines (lib/pty-bridge.js).
const PTY_CHANNEL_DATA = 0x00;

// FIFO outbound keystroke queue bound (A1 §4): drops the OLDEST byte on
// overflow so a stuck key-repeat during a long reconnect can't grow it
// unbounded, while still preserving the most recent typing.
const MAX_QUEUE_BYTES = 4096;

export type PtyConnState = 'connecting' | 'connected' | 'reconnecting' | 'auth-expired' | 'session-ended';

type DataHandler = (bytes: Uint8Array) => void;
type StateHandler = (state: PtyConnState) => void;
type PaneSizeHandler = (cols: number, rows: number) => void;

const textEncoder = new TextEncoder();

/**
 * Resilient WebSocket client for one PTY-backed session's binary bridge.
 *
 * - Reconnects with exponential backoff (capped) on a transient drop.
 * - 1008 (bearer rejected on an established socket): no reconnect, routes
 *   through the SAME `handleUnauthorized()` the main socket uses.
 * - 4000 (`dead-target`, A4's PTY bridge attached to a tmux target that no
 *   longer exists): no reconnect, `session-ended` state. Re-opening is an
 *   explicit user action (close + reopen the panel), never automatic.
 * - Outbound bytes typed while not attached are queued (FIFO, bounded 4096B,
 *   drops oldest on overflow) and flushed in order once the server confirms
 *   attach — NOT on the raw transport `open` event: `lib/pty-bridge.js`'s
 *   attach handshake is asynchronous server-side (it awaits `ensurePty`,
 *   including a real process spawn + a dead-target grace wait, before
 *   registering this connection in the target's `clients` map), so a binary
 *   frame sent right after `open` but before the server's `attached` ack can
 *   arrive while `entryRef` is still null and be silently dropped by the
 *   bridge (`if (!sessionId || !entryRef || !entryRef.pty) return;`). Queuing
 *   until `attached` is the literal implementation of the design's intent
 *   ("flush once the connection is usable again") against A4's real handshake
 *   — see this file's PTY_CLIENT.md-equivalent note in the A5 task report.
 */
export class PtyClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private closed = false;
  private attached = false;
  private wasConnected = false;
  private state: PtyConnState = 'connecting';

  private dataHandlers = new Set<DataHandler>();
  private stateHandlers = new Set<StateHandler>();
  private paneSizeHandlers = new Set<PaneSizeHandler>();

  // FIFO byte queue (array of 0-255 values — simplest correct impl at this
  // volume; a typed ring buffer would be premature optimization here).
  private queue: number[] = [];
  private pendingSize: { cols: number; rows: number } | null = null;

  constructor(private readonly sessionId: string) {}

  connect(): void {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.attached = false;
    this.emitState(this.wasConnected ? 'reconnecting' : 'connecting');
    const token = getToken();
    const protocols = token ? [WS_PROTOCOL, token] : undefined;
    const ws = new WebSocket(`${wsUrl()}pty`, protocols);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.sendControl({ type: 'attach', sessionId: this.sessionId });
    });

    ws.addEventListener('message', (evt) => {
      const data = (evt as MessageEvent).data;
      if (typeof data !== 'string') {
        const buf = new Uint8Array(data as ArrayBuffer);
        if (buf.length < 1 || buf[0] !== PTY_CHANNEL_DATA) return;
        const payload = buf.subarray(1);
        for (const h of this.dataHandlers) h(payload);
        return;
      }
      let msg: PtyServerMessage;
      try {
        msg = JSON.parse(data) as PtyServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'attached') {
        this.attached = true;
        this.wasConnected = true;
        this.emitState('connected');
        this.flushQueue();
        this.flushPendingSize();
      }
      if (msg.type === 'pane-size') {
        for (const h of this.paneSizeHandlers) h(msg.paneCols, msg.paneRows);
      }
      // 'error' frames (dead-target/unauthorized) always precede a close with
      // the matching code (lib/pty-bridge.js's killEntryClientsWithError /
      // attach-catch path) — the close handler below drives all state
      // transitions, so no separate handling is needed here.
    });

    ws.addEventListener('close', (evt) => {
      this.ws = null;
      this.attached = false;
      const code = (evt as CloseEvent).code;
      if (code === WS_AUTH_CLOSE) {
        this.emitState('auth-expired');
        handleUnauthorized();
        return;
      }
      if (code === PTY_DEAD_TARGET_CLOSE) {
        this.emitState('session-ended');
        return;
      }
      if (!this.closed) {
        this.emitState('reconnecting');
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      // 'close' fires next and drives reconnect/state — mirrors ws.ts.
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  /** Write raw terminal input (xterm's `onData`). Queued (FIFO, bounded) until attached. */
  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
    if (bytes.length === 0) return;
    if (this.isOpen() && this.attached) {
      this.sendBinary(bytes);
      return;
    }
    this.enqueue(bytes);
  }

  /** Request a resize. Coalesced to the latest value until attached, like `write`. */
  resize(cols: number, rows: number): void {
    if (this.isOpen() && this.attached) {
      this.sendControl({ type: 'resize', cols, rows });
      return;
    }
    this.pendingSize = { cols, rows };
  }

  private enqueue(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i += 1) this.queue.push(bytes[i]);
    while (this.queue.length > MAX_QUEUE_BYTES) this.queue.shift();
  }

  private flushQueue(): void {
    if (this.queue.length === 0) return;
    const bytes = Uint8Array.from(this.queue);
    this.queue = [];
    this.sendBinary(bytes);
  }

  private flushPendingSize(): void {
    if (!this.pendingSize) return;
    const { cols, rows } = this.pendingSize;
    this.pendingSize = null;
    this.sendControl({ type: 'resize', cols, rows });
  }

  private sendBinary(bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.enqueue(bytes);
      return;
    }
    const framed = new Uint8Array(bytes.length + 1);
    framed[0] = PTY_CHANNEL_DATA;
    framed.set(bytes, 1);
    this.ws.send(framed);
  }

  private sendControl(msg: PtyClientMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Current queued-byte count — exposed for tests exercising the 4096B bound. */
  queuedByteLength(): number {
    return this.queue.length;
  }

  onData(h: DataHandler): () => void {
    this.dataHandlers.add(h);
    return () => this.dataHandlers.delete(h);
  }

  onState(h: StateHandler): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }

  /** agent-kind sessions only — fires with the real tmux pane's geometry on attach and on live resize. */
  onPaneSize(h: PaneSizeHandler): () => void {
    this.paneSizeHandlers.add(h);
    return () => this.paneSizeHandlers.delete(h);
  }

  private emitState(state: PtyConnState): void {
    this.state = state;
    for (const h of this.stateHandlers) h(state);
  }

  getState(): PtyConnState {
    return this.state;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isAttached(): boolean {
    return this.attached;
  }

  /** User/app-initiated detach — sends `close`, no reconnect. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendControl({ type: 'close', sessionId: this.sessionId });
      this.ws.close();
    } else {
      this.ws?.close();
    }
    this.ws = null;
  }
}
