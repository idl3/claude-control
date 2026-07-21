import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mirrors ws.vitest.ts's mocking approach exactly (same two modules stubbed,
// same reasoning): pty-client.ts pulls wsUrl/handleUnauthorized from ./api and
// getToken/WS_PROTOCOL from ./auth, both of which touch window/localStorage.
// Stubbing lets this test run in the plain 'node' vitest environment (no
// jsdom), matching ws.vitest.ts's precedent for the sibling WS client.
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

import { PtyClient, type PtyConnState } from './pty-client';

// --- Minimal controllable WebSocket double, binary-aware -------------------
// Extends ws.vitest.ts's FakeWebSocket shape with ArrayBuffer send capture
// (binaryType='arraybuffer' is what pty-client.ts sets) so binary frames can
// be asserted on directly instead of only JSON control frames.
type Listener = (evt: unknown) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: (string | Uint8Array)[] = [];
  url: string;
  protocols: string | string[] | undefined;
  binaryType = 'blob';
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

  send(data: string | Uint8Array): void {
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
  /** Deliver a framed binary data frame (channel header + payload), as pty-bridge.js sends it. */
  binaryMessage(channel: number, payload: number[]): void {
    const buf = new Uint8Array([channel, ...payload]);
    this.emit('message', { data: buf.buffer });
  }
  drop(code?: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code });
  }

  static last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

function parseSentControlFrames(ws: FakeWebSocket): unknown[] {
  return ws.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
}

function sentBinaryFrames(ws: FakeWebSocket): Uint8Array[] {
  return ws.sent.filter((s): s is Uint8Array => s instanceof Uint8Array);
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

describe('PtyClient — attach handshake', () => {
  it('sends an attach control frame with the session id on open', () => {
    const c = new PtyClient('main:0');
    c.connect();
    FakeWebSocket.last().open();
    expect(parseSentControlFrames(FakeWebSocket.last())).toEqual([
      { type: 'attach', sessionId: 'main:0' },
    ]);
  });

  it('sets binaryType to arraybuffer (not the default blob)', () => {
    const c = new PtyClient('main:0');
    c.connect();
    expect(FakeWebSocket.last().binaryType).toBe('arraybuffer');
  });

  it('emits connecting, then stays connecting until the attached ack (not merely on open)', () => {
    const c = new PtyClient('main:0');
    const states: PtyConnState[] = [];
    c.onState((s) => states.push(s));
    c.connect();
    expect(states).toEqual(['connecting']);
    FakeWebSocket.last().open();
    expect(states).toEqual(['connecting']); // open alone does not mean connected
    FakeWebSocket.last().message({ type: 'attached', sessionId: 'main:0' });
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('offers [WS_PROTOCOL, token] the same way ClaudeControlSocket does', () => {
    fakeToken = 'secret-xyz';
    const c = new PtyClient('main:0');
    c.connect();
    expect(FakeWebSocket.last().protocols).toEqual(['claude-control', 'secret-xyz']);
  });

  it('connects to wsUrl() + "pty"', () => {
    const c = new PtyClient('main:0');
    c.connect();
    expect(FakeWebSocket.last().url).toBe('ws://test/pty');
  });
});

describe('PtyClient — binary data in', () => {
  it('strips the 0x00 channel header and delivers the payload to onData', () => {
    const c = new PtyClient('main:0');
    const chunks: Uint8Array[] = [];
    c.onData((b) => chunks.push(b));
    c.connect();
    FakeWebSocket.last().open();
    FakeWebSocket.last().binaryMessage(0x00, [104, 105]); // "hi"
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0])).toEqual([104, 105]);
  });

  it('ignores a frame with an unrecognised channel header', () => {
    const c = new PtyClient('main:0');
    const chunks: Uint8Array[] = [];
    c.onData((b) => chunks.push(b));
    c.connect();
    FakeWebSocket.last().open();
    FakeWebSocket.last().binaryMessage(0x01, [1, 2, 3]);
    expect(chunks).toHaveLength(0);
  });

  it('ignores non-JSON text frames without throwing', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    expect(() => ws.messageRaw('not json{')).not.toThrow();
  });
});

describe('PtyClient — binary data out (write)', () => {
  it('frames outbound bytes with the 0x00 channel header once attached', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'attached', sessionId: 'main:0' });
    c.write('hi');
    const frames = sentBinaryFrames(ws);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual([0x00, 104, 105]);
  });

  it('accepts raw Uint8Array input directly (xterm onData gives a string, but the API is byte-agnostic)', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'attached', sessionId: 'main:0' });
    c.write(new Uint8Array([3])); // Ctrl-C
    expect(Array.from(sentBinaryFrames(ws)[0])).toEqual([0x00, 3]);
  });

  it('is a no-op for an empty write', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'attached', sessionId: 'main:0' });
    c.write('');
    expect(sentBinaryFrames(ws)).toHaveLength(0);
  });
});

describe('PtyClient — resize frame', () => {
  it('sends a resize control frame once attached', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'attached', sessionId: 'main:0' });
    c.resize(120, 40);
    expect(parseSentControlFrames(ws)).toEqual([
      { type: 'attach', sessionId: 'main:0' },
      { type: 'resize', cols: 120, rows: 40 },
    ]);
  });

  it('coalesces a resize requested before attach into a single frame sent on attach (latest value wins)', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    c.resize(80, 24);
    c.resize(120, 40); // supersedes — only the latest should ever be sent
    expect(sentBinaryFrames(ws)).toHaveLength(0);
    expect(parseSentControlFrames(ws)).toEqual([{ type: 'attach', sessionId: 'main:0' }]);
    ws.message({ type: 'attached', sessionId: 'main:0' });
    expect(parseSentControlFrames(ws)).toEqual([
      { type: 'attach', sessionId: 'main:0' },
      { type: 'resize', cols: 120, rows: 40 },
    ]);
  });
});

describe('PtyClient — close code 4000 (dead-target / session-ended)', () => {
  it('enters session-ended state and never reconnects', () => {
    const c = new PtyClient('main:0');
    const states: PtyConnState[] = [];
    c.onState((s) => states.push(s));
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'attached', sessionId: 'main:0' });
    ws.drop(4000);
    expect(states).toEqual(['connecting', 'connected', 'session-ended']);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // no auto-retry
    expect(unauthorizedCalls.n).toBe(0);
  });
});

describe('PtyClient — close code 1008 (auth-rejected)', () => {
  it('enters auth-expired state, calls handleUnauthorized once, and never reconnects', () => {
    const c = new PtyClient('main:0');
    const states: PtyConnState[] = [];
    c.onState((s) => states.push(s));
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.drop(1008);
    expect(states).toEqual(['connecting', 'auth-expired']);
    expect(unauthorizedCalls.n).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('PtyClient — transient close (anything else)', () => {
  it('enters reconnecting state and schedules a reconnect with doubling backoff', () => {
    const c = new PtyClient('main:0');
    const states: PtyConnState[] = [];
    c.onState((s) => states.push(s));
    c.connect();
    FakeWebSocket.last().open();
    FakeWebSocket.last().message({ type: 'attached', sessionId: 'main:0' });
    FakeWebSocket.last().drop(1006);
    expect(states).toEqual(['connecting', 'connected', 'reconnecting']);

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // Second attempt re-emits reconnecting (not connecting) since it was
    // connected at least once before.
    expect(states[states.length - 1]).toBe('reconnecting');

    FakeWebSocket.last().drop(1006);
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3); // doubled to 2000ms
  });

  it('resets backoff to base after a successful reattach', () => {
    const c = new PtyClient('main:0');
    c.connect();
    FakeWebSocket.last().open();
    FakeWebSocket.last().message({ type: 'attached', sessionId: 'main:0' });
    FakeWebSocket.last().drop(1006);
    vi.advanceTimersByTime(1000); // retry #1
    FakeWebSocket.last().drop(1006);
    vi.advanceTimersByTime(2000); // retry #2 (doubled)
    FakeWebSocket.last().open();
    FakeWebSocket.last().message({ type: 'attached', sessionId: 'main:0' });
    FakeWebSocket.last().drop(1006);
    vi.advanceTimersByTime(1000); // back to base, not 4000ms
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('does NOT reconnect after an explicit close()', () => {
    const c = new PtyClient('main:0');
    c.connect();
    FakeWebSocket.last().open();
    FakeWebSocket.last().message({ type: 'attached', sessionId: 'main:0' });
    c.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close() sends a close control frame with the session id before closing', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'attached', sessionId: 'main:0' });
    c.close();
    expect(parseSentControlFrames(ws)).toEqual([
      { type: 'attach', sessionId: 'main:0' },
      { type: 'close', sessionId: 'main:0' },
    ]);
  });
});

describe('PtyClient — 4096-byte keystroke queue bound + flush-on-reconnect', () => {
  it('queues writes typed while not attached instead of dropping them', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open(); // open, but NOT yet attached
    c.write('abc');
    expect(sentBinaryFrames(ws)).toHaveLength(0); // not sent yet
    expect(c.queuedByteLength()).toBe(3);
  });

  it('flushes the queue in order, as one frame, once attach is confirmed — not on raw open', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    c.write('ab');
    c.write('cd');
    expect(sentBinaryFrames(ws)).toHaveLength(0);
    ws.message({ type: 'attached', sessionId: 'main:0' });
    const frames = sentBinaryFrames(ws);
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0])).toEqual([0x00, 97, 98, 99, 100]); // 0x00 + "abcd"
  });

  it('drops the OLDEST bytes on overflow, keeping the most recent 4096', () => {
    const c = new PtyClient('main:0');
    c.connect();
    const ws = FakeWebSocket.last();
    ws.open(); // not attached — everything queues

    // Write a distinguishable prefix, then pad well past the 4096B bound.
    c.write('HEAD');
    const pad = 'x'.repeat(4200);
    c.write(pad);

    expect(c.queuedByteLength()).toBe(4096);
    ws.message({ type: 'attached', sessionId: 'main:0' });
    const frames = sentBinaryFrames(ws);
    expect(frames).toHaveLength(1);
    const flushed = frames[0].subarray(1); // drop the 0x00 channel header
    expect(flushed.length).toBe(4096);
    // "HEAD" (the oldest 4 bytes) must have been evicted — everything left is 'x'.
    const decoded = new TextDecoder().decode(flushed);
    expect(decoded).not.toContain('HEAD');
    expect(decoded).toBe('x'.repeat(4096));
  });

  it('flushes queued keystrokes typed during a reconnect gap, in order, on the reattach', () => {
    const c = new PtyClient('main:0');
    c.connect();
    let ws = FakeWebSocket.last();
    ws.open();
    ws.message({ type: 'attached', sessionId: 'main:0' });

    ws.drop(1006); // transient blip
    c.write('during-gap'); // typed while reconnecting — must be queued, not dropped
    expect(c.queuedByteLength()).toBe('during-gap'.length);

    vi.advanceTimersByTime(1000); // backoff fires the reconnect
    ws = FakeWebSocket.last();
    expect(FakeWebSocket.instances).toHaveLength(2);
    ws.open();
    expect(sentBinaryFrames(ws)).toHaveLength(0); // still queued — not attached yet
    ws.message({ type: 'attached', sessionId: 'main:0' });
    const frames = sentBinaryFrames(ws);
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0].subarray(1))).toBe('during-gap');
  });
});
