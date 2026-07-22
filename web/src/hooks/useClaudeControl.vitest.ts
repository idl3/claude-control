// @vitest-environment jsdom
/**
 * Regression tests for the remote-vs-local `messagesLoaded` gate (olam
 * transcript loading-UX fix).
 *
 * Root cause under test: `messagesLoaded` used to be `selectedId in
 * messagesById` for EVERY session kind. That's correct for local/codex
 * sessions (an empty `[]` first frame IS the whole known tail), but wrong for
 * remote (olam) sessions, where an empty `[]` merely means "no backfill has
 * landed on the wire yet" — the Electric chunks shape drains its snapshot
 * asynchronously and only becomes trustworthy once the server forwards
 * `olam-transcript-ready`.
 *
 * Strategy: mirror ws.vitest.ts's FakeWebSocket double (stubbed on
 * globalThis), mock ../lib/api + ../lib/auth so CockpitSocket runs without a
 * real network, and drive the hook via @testing-library/react's renderHook.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  wsUrl: () => 'ws://test/',
  handleUnauthorized: () => {},
}));
vi.mock('../lib/auth', () => ({
  getToken: () => null,
  WS_PROTOCOL: 'claude-control',
}));

import { useClaudeControl } from './useClaudeControl';
import type { Session } from '../lib/types';

// --- Minimal controllable WebSocket double (mirrors lib/ws.vitest.ts) ------
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

  static last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
}

function remoteSession(id: string): Session {
  return { id, kind: 'remote' };
}
function localSession(id: string): Session {
  return { id, kind: 'claude' };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render the hook, open its socket, and push a `sessions` snapshot. */
async function mountConnected(sessions: Session[]) {
  const result = renderHook(() => useClaudeControl());
  await act(async () => {
    FakeWebSocket.last().open();
    FakeWebSocket.last().message({ type: 'sessions', sessions });
  });
  return { ...result, ws: FakeWebSocket.last() };
}

describe('useClaudeControl — messagesLoaded (remote vs. local gating)', () => {
  it('remote session: stays false on an empty messages:[] frame, flips true only on olam-transcript-ready', async () => {
    const id = 'olam:acme:sess-1';
    const { result, ws } = await mountConnected([remoteSession(id)]);

    act(() => result.current.select(id));
    expect(result.current.messagesLoaded).toBe(false);

    // Empty backfill frame lands on the wire — must NOT be mistaken for "loaded".
    await act(async () => {
      ws.message({ type: 'messages', id, messages: [], pending: null });
    });
    expect(result.current.messagesLoaded).toBe(false);

    // Server forwards the shape's drain-to-live-cursor signal.
    await act(async () => {
      ws.message({ type: 'olam-transcript-ready', id });
    });
    expect(result.current.messagesLoaded).toBe(true);
  });

  it('local session: an empty messages:[] frame is immediately "loaded" (no regression)', async () => {
    const id = 'sess-local-1';
    const { result, ws } = await mountConnected([localSession(id)]);

    act(() => result.current.select(id));
    expect(result.current.messagesLoaded).toBe(false);

    await act(async () => {
      ws.message({ type: 'messages', id, messages: [], pending: null });
    });
    expect(result.current.messagesLoaded).toBe(true);
  });

  it('remote session: re-selecting after a prior ready does not carry the stale ready flag over', async () => {
    const id = 'olam:acme:sess-2';
    const other = 'sess-local-2';
    const { result, ws } = await mountConnected([remoteSession(id), localSession(other)]);

    act(() => result.current.select(id));
    await act(async () => {
      ws.message({ type: 'olam-transcript-ready', id });
    });
    expect(result.current.messagesLoaded).toBe(true);

    // Switch away, then back — the server tears down + recreates the remote
    // OlamTranscriptSource on last-client-unsubscribe, so the fresh subscribe
    // must NOT trust the previous visit's ready flag until a new one arrives.
    act(() => result.current.select(other));
    act(() => result.current.select(id));
    expect(result.current.messagesLoaded).toBe(false);

    await act(async () => {
      ws.message({ type: 'olam-transcript-ready', id });
    });
    expect(result.current.messagesLoaded).toBe(true);
  });
});

// ── dismissPending: stale-question escape hatch ────────────────────────────
//
// Root cause under test: a session that stalls on an API error (429/401/
// overload) keeps re-reporting the SAME `pending` on every snapshot/pending
// WS frame, so a local clear alone doesn't stick — the very next frame
// re-sets pendingById[id] to the identical object. dismissPending records
// (sessionId -> dismissed toolUseId) instead, and the derived `pending`
// memo suppresses a pendingById entry whose toolUseId matches. A genuinely
// NEW question (different toolUseId) must NOT be suppressed.
describe('useClaudeControl — dismissPending (stale-question escape hatch)', () => {
  it('suppresses the dismissed question and survives a repeated snapshot re-send', async () => {
    const id = 'sess-dismiss-1';
    const { result, ws } = await mountConnected([localSession(id)]);
    act(() => result.current.select(id));

    const pending = { toolUseId: 'tu-1', questions: [{ question: 'Proceed?', options: [] }] };
    await act(async () => {
      ws.message({ type: 'pending', id, pending });
    });
    expect(result.current.pending).toEqual(pending);

    act(() => result.current.dismissPending(id, 'tu-1'));
    expect(result.current.pending).toBeNull();

    // The server has no idea it was dismissed — it keeps re-reporting the
    // SAME pending on the next snapshot/pending frame. Must stay suppressed.
    await act(async () => {
      ws.message({ type: 'pending', id, pending });
    });
    expect(result.current.pending).toBeNull();

    await act(async () => {
      ws.message({ type: 'messages', id, messages: [], pending });
    });
    expect(result.current.pending).toBeNull();
  });

  it('does NOT suppress a new question with a different toolUseId', async () => {
    const id = 'sess-dismiss-2';
    const { result, ws } = await mountConnected([localSession(id)]);
    act(() => result.current.select(id));

    const first = { toolUseId: 'tu-1', questions: [{ question: 'Proceed?', options: [] }] };
    await act(async () => {
      ws.message({ type: 'pending', id, pending: first });
    });
    act(() => result.current.dismissPending(id, 'tu-1'));
    expect(result.current.pending).toBeNull();

    const second = { toolUseId: 'tu-2', questions: [{ question: 'Continue?', options: [] }] };
    await act(async () => {
      ws.message({ type: 'pending', id, pending: second });
    });
    expect(result.current.pending).toEqual(second);
  });

  it('clears the session rail pending badge immediately on dismiss', async () => {
    const id = 'sess-dismiss-3';
    const { result, ws } = await mountConnected([localSession(id)]);
    act(() => result.current.select(id));

    const pending = { toolUseId: 'tu-1', questions: [{ question: 'Proceed?', options: [] }] };
    await act(async () => {
      ws.message({ type: 'pending', id, pending });
    });
    expect(result.current.sessions.find((s) => s.id === id)?.pending).toBe(true);

    act(() => result.current.dismissPending(id, 'tu-1'));
    expect(result.current.sessions.find((s) => s.id === id)?.pending).toBe(false);
  });
});
