// @vitest-environment jsdom
import { createElement } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { Thread } from './Thread';

const identityConvertMessage = (msg: ThreadMessageLike): ThreadMessageLike => msg;

// jsdom has no ResizeObserver; assistant-ui's ThreadPrimitive.Viewport needs one
// internally. A no-op stub is enough for these DOM-shape assertions (see
// SubAgentPanel.vitest.ts for the established precedent).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

interface HarnessProps {
  loading?: boolean;
  working?: boolean;
  emptyState?: { heading: string; subtitle?: string } | null;
}

function Harness({ loading = false, working = false, emptyState = null }: HarnessProps) {
  const runtime = useExternalStoreRuntime({
    messages: [] as ThreadMessageLike[],
    isDisabled: false,
    convertMessage: identityConvertMessage,
    onNew: async () => {},
  });
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(Thread, {
      hasSelection: true,
      loading,
      working,
      emptyState,
      hiddenCount: 0,
      onLoadEarlier: () => {},
      subAgentMode: 'ask',
      onSubAgentModeChange: () => {},
      onTerminalModeChange: () => {},
      subagents: [],
      onOpenAgent: () => {},
    }),
  );
}

afterEach(cleanup);

describe('Thread transcript loading gate', () => {
  it('shows the skeleton, not the welcome, while the transcript frame is loading', () => {
    render(createElement(Harness, { loading: true }));
    expect(document.querySelector('.thread-skeleton')).toBeTruthy();
    expect(screen.queryByText('What are we shipping today?')).toBeNull();
  });

  it('shows the welcome once loaded, empty, and not working', () => {
    render(createElement(Harness, { loading: false, working: false }));
    expect(screen.queryByText('What are we shipping today?')).toBeTruthy();
    expect(document.querySelector('.thread-skeleton')).toBeNull();
  });

  // Regression: a session just created with an initial prompt can report an
  // empty first transcript frame (messagesLoaded flips true) before Claude's
  // reply lands — see Thread.tsx's `stillLoading`. Without consulting `working`
  // here, this window showed the "What are we shipping today?" compose
  // invitation on a session that's already busy.
  it('holds the skeleton (not the welcome) once loaded-but-empty if the session is working', () => {
    render(createElement(Harness, { loading: false, working: true }));
    expect(document.querySelector('.thread-skeleton')).toBeTruthy();
    expect(screen.queryByText('What are we shipping today?')).toBeNull();
  });

  // Remote (olam) sessions already have their own tailored empty-state copy
  // for "loading over the wire while working" — `working` must not preempt it.
  it('prefers the remote emptyState message over the working-skeleton', () => {
    render(
      createElement(Harness, {
        loading: false,
        working: true,
        emptyState: { heading: 'Resuming session…' },
      }),
    );
    expect(screen.queryByText('Resuming session…')).toBeTruthy();
    expect(document.querySelector('.thread-skeleton')).toBeNull();
  });

  it('renders multi-line skeleton rows (assistant paragraph + user reply), not single short stubs', () => {
    render(createElement(Harness, { loading: true }));
    const rows = document.querySelectorAll('.thread-skeleton-row');
    // 3 turns: a multi-line assistant paragraph, a short user reply, another
    // multi-line assistant paragraph — see SKELETON_ROWS in Thread.tsx.
    expect(rows.length).toBe(3);
    rows.forEach((row) => {
      expect(row.querySelectorAll('.thread-skeleton-bar').length).toBeGreaterThan(1);
    });
    const endRow = document.querySelector('.thread-skeleton-row[data-align="end"]');
    expect(endRow).toBeTruthy();
  });
});
