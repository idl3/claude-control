// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

// Hermetic: openExternal failure paths ship reports via reportError — keep
// tests off the network.
vi.mock('./reportError', () => ({ reportClientError: vi.fn() }));

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

  it('openExternal outside the shell: plain window.open new tab, no invoke', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke },
    };
    const mod = await import('./nativeShell');
    mod.openExternal('https://example.com/pr/1');
    expect(open).toHaveBeenCalledWith('https://example.com/pr/1', '_blank', 'noopener,noreferrer');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('openExternal in-shell: system browser first, no window.open', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh) ClaudeControlShell/0.1.0',
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke },
    };
    const mod = await import('./nativeShell');
    mod.openExternal('https://github.com/idl3/claude-control');
    expect(invoke).toHaveBeenCalledWith('open_system_browser', {
      url: 'https://github.com/idl3/claude-control',
    });
    // Give the (resolved) invoke promise a tick — no fallback must fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('openExternal in-shell: falls back system browser → app window → window.open', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'ClaudeControlShell/0.1.0',
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    // Older shell build: neither command exists.
    const invoke = vi.fn().mockRejectedValue(new Error('unknown command'));
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke },
    };
    const mod = await import('./nativeShell');
    mod.openExternal('https://example.com');
    await new Promise((r) => setTimeout(r, 10));
    expect(invoke).toHaveBeenNthCalledWith(1, 'open_system_browser', { url: 'https://example.com' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'open_url_window', { url: 'https://example.com' });
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });

  it('openInAppWindow in-shell: open_url_window direct; browser: openExternal path', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const mod = await import('./nativeShell');
    // Outside the shell → openExternal chain → plain window.open.
    mod.openInAppWindow('https://example.com/doc');
    expect(open).toHaveBeenCalledWith('https://example.com/doc', '_blank', 'noopener,noreferrer');
    vi.resetModules();
    vi.stubGlobal('navigator', { userAgent: 'ClaudeControlShell/0.1.0' });
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke },
    };
    const mod2 = await import('./nativeShell');
    mod2.openInAppWindow('https://example.com/doc');
    expect(invoke).toHaveBeenCalledWith('open_url_window', { url: 'https://example.com/doc' });
  });

  it('openExternal in-shell without the Tauri global: window.open fallback, no throw', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'ClaudeControlShell/0.1.0',
    });
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const mod = await import('./nativeShell');
    expect(() => mod.openExternal('https://example.com')).not.toThrow();
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
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

describe('native file-drop bridge', () => {
  it('onNativeDrag outside the shell: inert unsubscriber, no listener', async () => {
    const mod = await import('./nativeShell');
    const handler = vi.fn();
    const off = mod.onNativeDrag(handler);
    window.dispatchEvent(
      new CustomEvent('cc:native-drag', {
        detail: { kind: 'enter', x: 1, y: 1, paths: [] },
      }),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });

  it('onNativeDrag in-shell: routes event detail; unsubscribe stops delivery', async () => {
    vi.stubGlobal('navigator', { userAgent: 'ClaudeControlShell/0.1.1' });
    const mod = await import('./nativeShell');
    const handler = vi.fn();
    const off = mod.onNativeDrag(handler);
    const detail = { kind: 'drop', x: 10, y: 20, paths: ['/tmp/a.png'] };
    window.dispatchEvent(new CustomEvent('cc:native-drag', { detail }));
    expect(handler).toHaveBeenCalledWith(detail);
    off();
    window.dispatchEvent(new CustomEvent('cc:native-drag', { detail }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('readDroppedFile: decodes the b64 payload into a typed File', async () => {
    vi.stubGlobal('navigator', { userAgent: 'ClaudeControlShell/0.1.1' });
    const invoke = vi
      .fn()
      .mockResolvedValue({ name: 'shot.png', b64: btoa('abc') });
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke },
    };
    const mod = await import('./nativeShell');
    const file = await mod.readDroppedFile('/tmp/shot.png');
    expect(invoke).toHaveBeenCalledWith('read_dropped_file', {
      path: '/tmp/shot.png',
    });
    expect(file?.name).toBe('shot.png');
    expect(file?.type).toBe('image/png');
    expect(file?.size).toBe(3);
  });

  it('readDroppedFile: null without the Tauri global and on invoke rejection', async () => {
    vi.stubGlobal('navigator', { userAgent: 'ClaudeControlShell/0.1.1' });
    const mod = await import('./nativeShell');
    expect(await mod.readDroppedFile('/tmp/x')).toBeNull();
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: vi.fn().mockRejectedValue(new Error('not a dropped path')) },
    };
    vi.resetModules();
    const mod2 = await import('./nativeShell');
    expect(await mod2.readDroppedFile('/tmp/x')).toBeNull();
  });
});
