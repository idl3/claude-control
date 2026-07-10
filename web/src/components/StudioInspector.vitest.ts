// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { StudioInspector } from './StudioInspector';
import { CC_BRIDGE_READY_TYPE, CC_DOM_OUTLINE_RESULT_TYPE, CC_DOM_OUTLINE_REQUEST_TYPE } from '../lib/appBridge';

const URL = 'apps/counter.html';

// findAppIframeWindow (StudioModal.tsx) looks up a live <iframe title={url}>
// anywhere in the document — same lookup key StudioModal.vitest.ts's own
// props-panel tests rely on, but here mounted directly (no AppFrameLayer)
// since StudioInspector only needs a real contentWindow to source/target
// postMessage traffic, not a fully rendered artifact.
function mountIframe(url: string): Window {
  const iframe = document.createElement('iframe');
  iframe.title = url;
  document.body.appendChild(iframe);
  return iframe.contentWindow as Window;
}

function removeIframes(): void {
  document.querySelectorAll('iframe').forEach((el) => el.remove());
}

function sendBridgeReady(win: Window): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: CC_BRIDGE_READY_TYPE, manifestVersion: 1 }, source: win }),
    );
  });
}

function sendOutlineResult(win: Window, data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: win }));
  });
}

afterEach(() => {
  cleanup();
  removeIframes();
});

describe('StudioInspector — E1: read-only DOM outline round-trip', () => {
  it('requests an outline once the bridge is ready, and renders the returned tree', () => {
    const win = mountIframe(URL);
    const postSpy = vi.spyOn(win, 'postMessage');
    render(createElement(StudioInspector, { url: URL, active: true }));

    sendBridgeReady(win);
    expect(postSpy).toHaveBeenCalledWith({ type: CC_DOM_OUTLINE_REQUEST_TYPE }, '*');

    sendOutlineResult(win, {
      type: CC_DOM_OUTLINE_RESULT_TYPE,
      truncated: false,
      tree: {
        tag: 'div',
        id: 'root',
        className: null,
        textPreview: null,
        childCount: 1,
        children: [
          { tag: 'span', id: null, className: 'label', textPreview: 'hi', childCount: 0, children: [] },
        ],
      },
    });

    expect(screen.getByText('div#root')).toBeTruthy();
    expect(screen.getByText('span.label')).toBeTruthy();
    expect(screen.getByText('“hi”')).toBeTruthy();
  });

  it('shows the truncated notice when the result reports truncated:true', () => {
    const win = mountIframe(URL);
    render(createElement(StudioInspector, { url: URL, active: true }));
    sendBridgeReady(win);

    sendOutlineResult(win, {
      type: CC_DOM_OUTLINE_RESULT_TYPE,
      truncated: true,
      tree: { tag: 'div', id: null, className: null, textPreview: null, childCount: 0, children: [] },
    });

    expect(screen.getByRole('status').textContent).toMatch(/truncated/i);
  });

  it('shows "No outline available" when the producer degrades to tree:null', () => {
    const win = mountIframe(URL);
    render(createElement(StudioInspector, { url: URL, active: true }));
    sendBridgeReady(win);

    sendOutlineResult(win, { type: CC_DOM_OUTLINE_RESULT_TYPE, truncated: false, tree: null });

    expect(screen.getByText('No outline available.')).toBeTruthy();
  });

  it('ignores a cc-dom-outline-result from a spoofed source — stays in the loading state', () => {
    const win = mountIframe(URL);
    render(createElement(StudioInspector, { url: URL, active: true }));
    sendBridgeReady(win);

    // Sourced from the top window itself, never the tracked iframe's
    // contentWindow — same spoofed-source idiom as appBridge.vitest.ts.
    sendOutlineResult(window, {
      type: CC_DOM_OUTLINE_RESULT_TYPE,
      truncated: false,
      tree: { tag: 'div', id: 'evil', className: null, textPreview: null, childCount: 0, children: [] },
    });

    expect(screen.getByText('Loading outline…')).toBeTruthy();
    expect(screen.queryByText('div#evil')).toBeNull();
  });

  it('the Refresh button re-sends the outline request on demand', () => {
    const win = mountIframe(URL);
    render(createElement(StudioInspector, { url: URL, active: true }));
    sendBridgeReady(win);
    const postSpy = vi.spyOn(win, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(postSpy).toHaveBeenCalledWith({ type: CC_DOM_OUTLINE_REQUEST_TYPE }, '*');
  });

  it('is read-only: expanding/collapsing the tree via <summary> never posts any message to the artifact', () => {
    const win = mountIframe(URL);
    render(createElement(StudioInspector, { url: URL, active: true }));
    sendBridgeReady(win);
    sendOutlineResult(win, {
      type: CC_DOM_OUTLINE_RESULT_TYPE,
      truncated: false,
      tree: {
        tag: 'div',
        id: 'root',
        className: null,
        textPreview: null,
        childCount: 1,
        children: [
          { tag: 'span', id: null, className: null, textPreview: null, childCount: 0, children: [] },
        ],
      },
    });
    const postSpy = vi.spyOn(win, 'postMessage');

    // Native disclosure toggle — a view-only interaction, no mutation handler.
    fireEvent.click(screen.getByText('div#root'));
    expect(postSpy).not.toHaveBeenCalled();
  });
});
