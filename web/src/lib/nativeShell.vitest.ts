// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

// isNativeShell is computed at import time from the UA, so each case resets
// modules and re-imports.
afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

describe('nativeShell', () => {
  it('plain browser UA: not a shell, notify is a silent no-op', async () => {
    const mod = await import('./nativeShell');
    expect(mod.isNativeShell).toBe(false);
    expect(() => mod.notifySessionNative('s1', 't', 'b')).not.toThrow();
  });

  it('shell UA token: invokes notify_session over the Tauri global', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh) ClaudeControlShell/0.0.1',
    });
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke },
    };
    const mod = await import('./nativeShell');
    expect(mod.isNativeShell).toBe(true);
    mod.notifySessionNative('sess-1', 'my session', '✅ Turn finished');
    expect(invoke).toHaveBeenCalledWith('notify_session', {
      sessionId: 'sess-1',
      title: 'my session',
      body: '✅ Turn finished',
    });
  });

  it('shell UA but no Tauri global (init script missing): still no-throw', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'ClaudeControlShell/0.0.1',
    });
    const mod = await import('./nativeShell');
    expect(() => mod.notifySessionNative('s1', 't', 'b')).not.toThrow();
    expect(() =>
      mod.shellDragStart({ target: null, currentTarget: null, buttons: 1 }),
    ).not.toThrow();
  });

  it('shellDragStart: drags only on a primary-button press on the bar itself', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'ClaudeControlShell/0.0.1',
    });
    const startDragging = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      window: { getCurrentWindow: () => ({ startDragging }) },
    };
    const mod = await import('./nativeShell');
    const bar = {};
    mod.shellDragStart({ target: bar, currentTarget: bar, buttons: 1 });
    expect(startDragging).toHaveBeenCalledTimes(1);
    // child element press → no drag (children keep their clicks)
    mod.shellDragStart({ target: {}, currentTarget: bar, buttons: 1 });
    // secondary button → no drag
    mod.shellDragStart({ target: bar, currentTarget: bar, buttons: 2 });
    expect(startDragging).toHaveBeenCalledTimes(1);
  });
});
