// @vitest-environment jsdom
//
// Same C4 "live studio probe" tier as counter.vitest.ts (see that file's
// doc comment for the full no-Playwright rationale) — mounts the REAL
// `Composer` through the REAL `withCcBridge` and drives it with real
// cc-props-set MessageEvents, proving the manifest/bridge wiring
// generalizes past the counter demo to the C4 spec's own named props
// (`disabled`, `sessionId`).
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { CC_PROPS_SET_TYPE, withCcBridge } from '../../src/lib/ccBridgeRuntime';
import { Composer } from './composer';

afterEach(cleanup);

const EXAMPLE_PROPS = { placeholder: 'Message…', disabled: false, sessionId: 'demo-session' };

function postToBridge(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: window }));
  });
}

describe('Composer dogfood wired through the real withCcBridge (C4 live probe)', () => {
  it('a cc-props-set edit to `disabled` disables the input/button live, with no remount (draft text survives)', () => {
    render(createElement(withCcBridge(Composer, EXAMPLE_PROPS, 1)));

    const input = screen.getByPlaceholderText('Message…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hi there' } });
    expect(input.value).toBe('hi there');
    expect(input.disabled).toBe(false);

    postToBridge({ type: CC_PROPS_SET_TYPE, props: { disabled: true } });

    expect(input.disabled).toBe(true);
    expect(screen.getByText('Send').closest('button')).toHaveProperty('disabled', true);
    // No remount happened: the draft text survived the live edit.
    expect(input.value).toBe('hi there');
  });

  it('a cc-props-set edit to `sessionId` re-renders the footer live', () => {
    render(createElement(withCcBridge(Composer, EXAMPLE_PROPS, 1)));
    expect(screen.getByText((_, el) => el?.textContent === 'session: demo-session')).toBeTruthy();

    postToBridge({ type: CC_PROPS_SET_TYPE, props: { sessionId: 'live-session-42' } });

    expect(screen.getByText((_, el) => el?.textContent === 'session: live-session-42')).toBeTruthy();
  });
});
