// @vitest-environment jsdom
//
// C4's "live studio probe" equivalent — no Playwright (or any other
// browser-automation tool) is installed anywhere in this repo (checked:
// no `playwright` in package.json/web/package.json, no
// web/node_modules/.bin/playwright), and adding one would violate this
// phase's single-pre-approved-dependency constraint
// (react-docgen-typescript only). Instead this mounts the REAL `Counter`
// component (imported directly from counter.tsx, not a stand-in fixture)
// through the REAL `withCcBridge`, and drives it with real
// cc-props-set/cc-props-reset MessageEvents — the exact technique
// web/src/lib/ccBridgeRuntime.vitest.ts already uses (and this repo already
// trusts) to prove the bridge mechanism generically, now pointed at the
// actual C4 dogfood instead of a generic Fixture. jsdom + React Testing
// Library are already installed and already the established tier for this
// class of claim.
//
// Also documents a real, non-obvious finding: `label` re-renders live on
// every cc-props-set (it's read directly in JSX every render), but
// `initialCount` only seeds Counter's internal `count` state via
// `useState(initialCount)` on first mount — a later cc-props-set to
// `initialCount` alone is silently ignored by React until a
// cc-props-reset forces a remount. This is why withCcBridge treats "set"
// and "reset" differently; see that file's doc comment.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { CC_PROPS_RESET_TYPE, CC_PROPS_SET_TYPE, withCcBridge } from '../../src/lib/ccBridgeRuntime';
import { Counter } from './counter';

afterEach(cleanup);

const EXAMPLE_PROPS = { label: 'react counter — own root, own boundary', initialCount: 0 };

function postToBridge(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: window }));
  });
}

function countText() {
  return screen.getByTestId('counter').querySelector('.count')?.textContent;
}

describe('Counter dogfood wired through the real withCcBridge (C4 live probe)', () => {
  it('a cc-props-set edit to `label` re-renders live, with no remount (click state survives)', () => {
    render(createElement(withCcBridge(Counter, EXAMPLE_PROPS, 1)));
    expect(screen.getByText(EXAMPLE_PROPS.label)).toBeTruthy();

    fireEvent.click(screen.getByText('+1'));
    expect(countText()).toBe('1');

    postToBridge({ type: CC_PROPS_SET_TYPE, props: { label: 'edited label!' } });

    expect(screen.getByText('edited label!')).toBeTruthy();
    // No remount happened: the click above survived the live edit.
    expect(countText()).toBe('1');
  });

  it('a cc-props-set edit to `initialCount` alone does not change the rendered count (useState reads its initial arg once, on mount)', () => {
    render(createElement(withCcBridge(Counter, EXAMPLE_PROPS, 1)));
    expect(countText()).toBe('0');

    postToBridge({ type: CC_PROPS_SET_TYPE, props: { initialCount: 99 } });

    expect(countText()).toBe('0');
  });

  it('cc-props-reset remounts and re-seeds from the ORIGINAL exampleProps, discarding any prior override', () => {
    render(createElement(withCcBridge(Counter, EXAMPLE_PROPS, 1)));

    fireEvent.click(screen.getByText('+1'));
    postToBridge({ type: CC_PROPS_SET_TYPE, props: { initialCount: 99, label: 'edited label!' } });

    postToBridge({ type: CC_PROPS_RESET_TYPE });

    expect(screen.getByText(EXAMPLE_PROPS.label)).toBeTruthy();
    expect(countText()).toBe('0');
  });
});

// ponytail: the "invalid-value injection -> app error path, never cockpit
// crash" checklist item is already proven generically in
// StudioModal.vitest.ts (C3) — re-covering it here against this specific
// dogfood would just duplicate that proof, not extend it.
