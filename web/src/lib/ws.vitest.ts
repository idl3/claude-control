import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ws.ts imports wsUrl + handleUnauthorized from ./api (which read
// window.location / localStorage) and getToken + WS_PROTOCOL from ./auth. Stub
// both so the client runs in a plain Node env (no DOM). unauthorizedCalls lets
// the auth-close test assert the unauthorized flow fired.
const unauthorizedCalls = { n: 0 };
vi.mock('./api', () => ({
  wsUrl: () => 'ws://test/',
  handleUnauthorized: () => {
    unauthorizedCalls.n += 1;
  },
}));
let fakeToken: string | null = null;
vi.mock('./auth', () => ({
  getToken: () => fakeToken,
  WS_PROTOCOL: 'claude-control',
}));

import { ClaudeControlSocket } from './ws';
import type { ServerMessage } from './types';

// --- Minimal controllable WebSocket double ---------------------------------
// Mirrors the slice of the WHATWG WebSocket API ws.ts touches: readyState,
// addEventListener('open'|'message'|'close'|'error'), send, close. Each
// constructed instance is recorded so a test can drive its lifecycle.
type Listener = (evt: unknown) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  url: string;
  protocols: string | string[] | undefined;
  private listeners: Record<string, Set<Listener>> = {};

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= new Set()).add(fn);
  }
  private emit(type: string, evt: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(evt);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code });
  }

  // --- test drivers ---
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }
  message(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }
  messageRaw(data: string): void {
    this.emit('message', { data });
  }
  drop(code?: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code });
  }
  error(): void {
    this.emit('error', {});
  }

  static last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  fakeToken = null;
  unauthorizedCalls.n = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function parseSent(ws: FakeWebSocket): unknown[] {
  return ws.sent.map((s) => JSON.parse(s));
}

describe('ClaudeControlSocket — connection', () => {
  it('emits connecting then connected across open', () => {
    const s = new ClaudeControlSocket();
    const states: string[] = [];
    s.onState((st) => states.push(st));
    s.connect();
    expect(states).toContain('connecting');
    FakeWebSocket.last().open();
    expect(states).toEqual(['connecting', 'connected']);
    expect(s.isOpen()).toBe(true);
  });

  it('does not open a second socket while one is connecting/open', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    s.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.last().open();
    s.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('ClaudeControlSocket — token subprotocol auth', () => {
  it('offers no subprotocols when tokenless', () => {
    fakeToken = null;
    const s = new ClaudeControlSocket();
    s.connect();
    expect(FakeWebSocket.last().protocols).toBeUndefined();
  });

  it('offers [WS_PROTOCOL, token] (safe label first, token second)', () => {
    fakeToken = 'secret-123';
    const s = new ClaudeControlSocket();
    s.connect();
    expect(FakeWebSocket.last().protocols).toEqual(['claude-control', 'secret-123']);
  });

  it('connects to a clean URL with no ?token= in it', () => {
    fakeToken = 'secret-123';
    const s = new ClaudeControlSocket();
    s.connect();
    expect(FakeWebSocket.last().url).toBe('ws://test/');
    expect(FakeWebSocket.last().url).not.toContain('token');
  });

  it('fires the unauthorized flow on a 1008 (auth) close and does NOT reconnect', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.drop(1008);
    expect(unauthorizedCalls.n).toBe(1);
    // No reconnect scheduled for an auth close.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('still reconnects on a non-auth close (e.g. 1006)', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    FakeWebSocket.last().drop(1006);
    expect(unauthorizedCalls.n).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('ClaudeControlSocket — message dispatch', () => {
  it('routes parsed frames to all handlers', () => {
    const s = new ClaudeControlSocket();
    const a: ServerMessage[] = [];
    const b: ServerMessage[] = [];
    s.onMessage((m) => a.push(m));
    s.onMessage((m) => b.push(m));
    s.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'sessions', sessions: [] });
    expect(a).toEqual([{ type: 'sessions', sessions: [] }]);
    expect(b).toEqual([{ type: 'sessions', sessions: [] }]);
  });

  it('silently ignores non-JSON frames', () => {
    const s = new ClaudeControlSocket();
    const got: ServerMessage[] = [];
    s.onMessage((m) => got.push(m));
    s.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    expect(() => ws.messageRaw('not json{')).not.toThrow();
    expect(got).toHaveLength(0);
  });

  it('onMessage returns an unsubscribe that stops delivery', () => {
    const s = new ClaudeControlSocket();
    const got: ServerMessage[] = [];
    const off = s.onMessage((m) => got.push(m));
    s.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    off();
    ws.message({ type: 'sessions', sessions: [] });
    expect(got).toHaveLength(0);
  });
});

describe('ClaudeControlSocket — subscriptions', () => {
  it('sends subscribe on select when open', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    s.select('sess-1');
    expect(parseSent(ws)).toEqual([{ type: 'subscribe', id: 'sess-1' }]);
  });

  it('unsubscribes the old id and subscribes the new on switch', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    s.select('a');
    s.select('b');
    expect(parseSent(ws)).toEqual([
      { type: 'subscribe', id: 'a' },
      { type: 'unsubscribe', id: 'a' },
      { type: 'subscribe', id: 'b' },
    ]);
  });

  it('is a no-op when selecting the already-selected id', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    s.select('a');
    ws.sent = [];
    s.select('a');
    expect(ws.sent).toHaveLength(0);
  });

  it('re-subscribes the selected id automatically on reopen', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    let ws = FakeWebSocket.last();
    ws.open();
    s.select('sess-1');
    // Drop the connection; backoff schedules a reconnect.
    ws.drop();
    vi.advanceTimersByTime(1000);
    ws = FakeWebSocket.last();
    expect(FakeWebSocket.instances).toHaveLength(2);
    ws.open();
    // On reopen the client re-sends subscribe for the still-selected session.
    expect(parseSent(ws)).toEqual([{ type: 'subscribe', id: 'sess-1' }]);
  });

  it('select() before connect buffers nothing but applies on next open', () => {
    const s = new ClaudeControlSocket();
    // No socket yet: send returns false, nothing queued, but selectedId is set.
    s.select('sess-1');
    s.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    expect(parseSent(ws)).toEqual([{ type: 'subscribe', id: 'sess-1' }]);
  });
});

describe('ClaudeControlSocket — reconnect / backoff', () => {
  it('schedules a reconnect after a drop and doubles the delay', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    FakeWebSocket.last().drop();
    // First retry at base (1000ms): nothing before, a new socket after.
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Drop again: next delay is doubled to 2000ms.
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('resets backoff to base after a successful reopen', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(1000); // retry #1
    FakeWebSocket.last().drop();
    vi.advanceTimersByTime(2000); // retry #2 (doubled)
    FakeWebSocket.last().open(); // success resets delay
    FakeWebSocket.last().drop();
    // Back to base 1000ms, not 4000ms.
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('emits disconnected on drop', () => {
    const s = new ClaudeControlSocket();
    const states: string[] = [];
    s.onState((st) => states.push(st));
    s.connect();
    FakeWebSocket.last().open();
    FakeWebSocket.last().drop();
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
  });

  it('does NOT reconnect after close()', () => {
    const s = new ClaudeControlSocket();
    s.connect();
    FakeWebSocket.last().open();
    s.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('ClaudeControlSocket — send guarding', () => {
  it('send returns false when the socket is not open', () => {
    const s = new ClaudeControlSocket();
    expect(s.send({ type: 'subscribe', id: 'x' })).toBe(false);
    s.connect();
    // still CONNECTING
    expect(s.send({ type: 'subscribe', id: 'x' })).toBe(false);
    FakeWebSocket.last().open();
    expect(s.send({ type: 'subscribe', id: 'x' })).toBe(true);
  });

  it('isOpen reflects readyState', () => {
    const s = new ClaudeControlSocket();
    expect(s.isOpen()).toBe(false);
    s.connect();
    expect(s.isOpen()).toBe(false);
    FakeWebSocket.last().open();
    expect(s.isOpen()).toBe(true);
  });
});
