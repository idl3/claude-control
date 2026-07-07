// @vitest-environment jsdom
//
// UserMessage renders through assistant-ui primitives (MessagePrimitive,
// ActionBarPrimitive, useMessage) that normally require a full runtime
// (ThreadPrimitive + useExternalStoreRuntime, as wired up in App.tsx/Thread.tsx).
// Rather than standing up that whole runtime, stub the handful of primitives
// UserMessage actually touches so the test can render it directly and assert
// on the Retry/Discard affordance + the events they dispatch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type FakeMessage = {
  id: string;
  metadata?: { custom?: Record<string, unknown> };
};

let currentMessage: FakeMessage = { id: 'queued-1', metadata: { custom: {} } };

function passthrough(tag: string) {
  return ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement(tag, rest, children);
}

vi.mock('@assistant-ui/react', () => ({
  useMessage: (selector: (m: FakeMessage) => unknown) => selector(currentMessage),
  MessagePrimitive: {
    Root: passthrough('div'),
    // Message body content (text/tool parts) isn't under test here — the
    // Retry/Discard affordance lives in the actions row, not the bubble body.
    Parts: () => null,
  },
  ActionBarPrimitive: {
    Root: passthrough('div'),
    Copy: passthrough('button'),
  },
}));

import { UserMessage } from './Messages';

function setMessage(sendStatus: 'queued' | 'sent' | 'failed' | undefined, id = 'queued-7') {
  currentMessage = {
    id,
    metadata: { custom: { optimistic: true, sendStatus } },
  };
}

afterEach(cleanup);
beforeEach(() => {
  currentMessage = { id: 'queued-1', metadata: { custom: {} } };
});

describe('UserMessage — Retry/Discard on a "Not delivered" bubble', () => {
  it('shows Retry + Discard alongside "Not delivered" when sendStatus is failed', () => {
    setMessage('failed');
    render(createElement(UserMessage));
    expect(screen.getByText('Not delivered')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry send' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard message' })).toBeTruthy();
  });

  it('does NOT show Retry/Discard while queued', () => {
    setMessage('queued');
    render(createElement(UserMessage));
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard message' })).toBeNull();
  });

  it('does NOT show Retry/Discard while sent (still collapsed into "Queued" display)', () => {
    setMessage('sent');
    render(createElement(UserMessage));
    expect(screen.queryByRole('button', { name: 'Retry send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard message' })).toBeNull();
  });

  it('clicking Retry dispatches cockpit:pending-retry with the parsed key', () => {
    setMessage('failed', 'queued-42');
    render(createElement(UserMessage));
    const onRetry = vi.fn();
    window.addEventListener('cockpit:pending-retry', onRetry);
    fireEvent.click(screen.getByRole('button', { name: 'Retry send' }));
    window.removeEventListener('cockpit:pending-retry', onRetry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect((onRetry.mock.calls[0][0] as CustomEvent).detail).toEqual({ key: 42 });
  });

  it('clicking Discard dispatches cockpit:pending-discard with the parsed key', () => {
    setMessage('failed', 'queued-99');
    render(createElement(UserMessage));
    const onDiscard = vi.fn();
    window.addEventListener('cockpit:pending-discard', onDiscard);
    fireEvent.click(screen.getByRole('button', { name: 'Discard message' }));
    window.removeEventListener('cockpit:pending-discard', onDiscard);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect((onDiscard.mock.calls[0][0] as CustomEvent).detail).toEqual({ key: 99 });
  });
});
