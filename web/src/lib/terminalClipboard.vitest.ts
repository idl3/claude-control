// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyText, isCopyShortcut, type CopyKeyEvent } from './terminalClipboard';

describe('copyText', () => {
  beforeEach(() => {
    // jsdom doesn't implement execCommand at all — define a stub so
    // vi.spyOn has a real property to wrap in each test below.
    if (!('execCommand' in document)) {
      // @ts-expect-error -- jsdom omits this DOM API entirely
      document.execCommand = () => false;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses navigator.clipboard.writeText in a secure context', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const execSpy = vi.spyOn(document, 'execCommand');

    copyText('https://example.com/foo');

    expect(writeText).toHaveBeenCalledWith('https://example.com/foo');
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when navigator.clipboard is absent (non-secure Tailscale context)', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    vi.stubGlobal('navigator', {}); // no `clipboard` property at all
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true);
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const removeSpy = vi.spyOn(document.body, 'removeChild');

    copyText('fallback text');

    expect(execSpy).toHaveBeenCalledWith('copy');
    expect(appendSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    const textarea = appendSpy.mock.calls[0][0] as HTMLTextAreaElement;
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.value).toBe('fallback text');
  });

  it('falls back to execCommand when the secure-context clipboard write rejects', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true);

    copyText('retry text');
    // the rejection fallback runs in a microtask
    await Promise.resolve();
    await Promise.resolve();

    expect(execSpy).toHaveBeenCalledWith('copy');
  });

  it('removes the offscreen textarea even when execCommand throws', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    vi.stubGlobal('navigator', {});
    vi.spyOn(document, 'execCommand').mockImplementation(() => {
      throw new Error('unsupported');
    });
    const removeSpy = vi.spyOn(document.body, 'removeChild');

    expect(() => copyText('x')).not.toThrow();
    expect(removeSpy).toHaveBeenCalled();
  });
});

describe('isCopyShortcut', () => {
  const keydown = (overrides: Partial<CopyKeyEvent> = {}): CopyKeyEvent => ({
    type: 'keydown',
    metaKey: false,
    ctrlKey: false,
    key: 'c',
    ...overrides,
  });

  it('true for Cmd+C with an active selection', () => {
    expect(isCopyShortcut(keydown({ metaKey: true }), true)).toBe(true);
  });

  it('true for Ctrl+C with an active selection', () => {
    expect(isCopyShortcut(keydown({ ctrlKey: true }), true)).toBe(true);
  });

  it('false for Cmd+C / Ctrl+C with NO selection — lets ^C interrupt the shell', () => {
    expect(isCopyShortcut(keydown({ metaKey: true }), false)).toBe(false);
    expect(isCopyShortcut(keydown({ ctrlKey: true }), false)).toBe(false);
  });

  it('false when neither meta nor ctrl is held, even with a selection', () => {
    expect(isCopyShortcut(keydown(), true)).toBe(false);
  });

  it('false for a different key', () => {
    expect(isCopyShortcut(keydown({ metaKey: true, key: 'v' }), true)).toBe(false);
  });

  it('false for keyup (only keydown is intercepted)', () => {
    expect(isCopyShortcut(keydown({ type: 'keyup', metaKey: true }), true)).toBe(false);
  });

  it('is case-insensitive on the key (some layouts report uppercase)', () => {
    expect(isCopyShortcut(keydown({ metaKey: true, key: 'C' }), true)).toBe(true);
  });
});
