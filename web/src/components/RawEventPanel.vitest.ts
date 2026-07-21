// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { RawEventPanel } from './RawEventPanel';
import type { RawEvent } from '../lib/types';

const EVENTS: RawEvent[] = [
  { ts: 1000, source: 'hook', kind: 'PreToolUse', summary: 'bash guard fired', detail: { cmd: 'ls' } },
  { ts: 2000, source: 'ws', kind: 'message', summary: 'assistant chunk', detail: { text: 'hello world' } },
  { ts: 3000, source: 'hook', kind: 'PostToolUse', summary: 'wrote a file', detail: { path: '/tmp/secret.txt' } },
];

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.raw-row'));
}

afterEach(cleanup);

describe('RawEventPanel — table tier', () => {
  it('renders one lean row per event, newest-first, and a match-count chip', () => {
    render(createElement(RawEventPanel, { events: EVENTS, onClose: vi.fn() }));

    const r = rows();
    expect(r).toHaveLength(3);
    // Newest-first: the last event (ts 3000) leads.
    expect(within(r[0]).getByText('wrote a file')).toBeTruthy();
    expect(within(r[2]).getByText('bash guard fired')).toBeTruthy();
    // The count chip mirrors the visible (filtered) row count.
    expect(document.querySelector('.raw-count')?.textContent).toBe('3');
  });

  it('empty events shows the empty state, no split', () => {
    render(createElement(RawEventPanel, { events: [], onClose: vi.fn() }));
    expect(screen.getByText('No events captured yet.')).toBeTruthy();
    expect(document.querySelector('.raw-split')).toBeNull();
  });
});

describe('RawEventPanel — global search', () => {
  it('filters case-insensitively and updates the count chip', () => {
    render(createElement(RawEventPanel, { events: EVENTS, onClose: vi.fn() }));

    fireEvent.change(screen.getByLabelText('Filter raw events'), { target: { value: 'HOOK' } });
    expect(rows()).toHaveLength(2); // both hook events
    expect(document.querySelector('.raw-count')?.textContent).toBe('2');
  });

  it('matches on the serialized detail even when the summary does not', () => {
    render(createElement(RawEventPanel, { events: EVENTS, onClose: vi.fn() }));

    // "secret" appears only in the third event's detail.path, not its summary.
    fireEvent.change(screen.getByLabelText('Filter raw events'), { target: { value: 'secret' } });
    const r = rows();
    expect(r).toHaveLength(1);
    expect(within(r[0]).getByText('wrote a file')).toBeTruthy();
  });

  it('shows a no-match message when nothing matches', () => {
    render(createElement(RawEventPanel, { events: EVENTS, onClose: vi.fn() }));
    fireEvent.change(screen.getByLabelText('Filter raw events'), { target: { value: 'zzz-nope' } });
    expect(rows()).toHaveLength(0);
    expect(screen.getByText(/No events match/)).toBeTruthy();
    expect(document.querySelector('.raw-count')?.textContent).toBe('0');
  });
});

describe('RawEventPanel — drill-in detail tier', () => {
  it('selecting a row renders that event’s full detail and flags data-detail on the split', () => {
    render(createElement(RawEventPanel, { events: EVENTS, onClose: vi.fn() }));

    // No selection yet: the split carries no data-detail, detail pane is a hint.
    expect(document.querySelector('.raw-split')?.getAttribute('data-detail')).toBeNull();
    expect(screen.getByText('Select an event to see its detail.')).toBeTruthy();

    fireEvent.click(rows()[0]); // the ts-3000 event (secret.txt)

    expect(document.querySelector('.raw-split')?.getAttribute('data-detail')).toBe('true');
    const detail = document.querySelector('.raw-detail') as HTMLElement;
    expect(detail).toBeTruthy();
    expect(detail.textContent).toContain('/tmp/secret.txt');
    // The selected row is marked current.
    expect(rows()[0].getAttribute('aria-current')).toBe('true');
  });

  it('a filter change keeps the open detail rendering from its stable index', () => {
    render(createElement(RawEventPanel, { events: EVENTS, onClose: vi.fn() }));

    fireEvent.click(rows()[0]); // select ts-3000 (wrote a file / secret.txt)
    // Filter so the selected row is hidden from the table.
    fireEvent.change(screen.getByLabelText('Filter raw events'), { target: { value: 'assistant' } });
    expect(rows()).toHaveLength(1);
    // Detail still shows the originally-selected event, not the filtered one.
    const detail = document.querySelector('.raw-detail') as HTMLElement;
    expect(detail.textContent).toContain('/tmp/secret.txt');
  });

  // Regression coverage for the selectedIdx → selectedKey fix: selection must
  // be anchored to a stable identity, not an array position, because the
  // events array both (a) gets front-evicted (useClaudeControl caps at
  // RAW_EVENT_CAP and slices from the front, shifting every later index down)
  // and (b) can be swapped wholesale on a session switch. An index-based
  // selection silently re-points at an unrelated event in both cases; a
  // key-based selection either keeps tracking the SAME event (still present)
  // or fails closed to null (evicted/gone) — never a neighbor.
  it('surviving front-eviction: selection keeps tracking the same event by identity once its index shifts', () => {
    const { rerender } = render(createElement(RawEventPanel, { events: EVENTS, onClose: vi.fn() }));

    // Select the oldest event (ts 1000, index 0) — its newest-first row is last.
    fireEvent.click(rows()[2]);
    const detailBefore = document.querySelector('.raw-detail-body') as HTMLElement;
    expect(detailBefore.textContent).toContain('bash guard fired');

    // Simulate front-eviction: the front (oldest) entries get sliced away as
    // new events arrive, but the selected event (ts 1000) is still present —
    // just at a different array position than before.
    const evicted: RawEvent[] = [
      { ts: 1000, source: 'hook', kind: 'PreToolUse', summary: 'bash guard fired', detail: { cmd: 'ls' } },
      { ts: 4000, source: 'ws', kind: 'message', summary: 'new chunk', detail: { text: 'more' } },
    ];
    rerender(createElement(RawEventPanel, { events: evicted, onClose: vi.fn() }));

    const detailAfter = document.querySelector('.raw-detail-body') as HTMLElement;
    expect(detailAfter.textContent).toContain('bash guard fired');
    // NOT the neighboring event that an index-based selection would have
    // silently drifted to.
    expect(detailAfter.textContent).not.toContain('new chunk');
  });

  it('a session switch (or full eviction of the selected event) fails closed to null — never shows a neighboring event', () => {
    const { rerender } = render(createElement(RawEventPanel, { events: EVENTS, onClose: vi.fn() }));

    fireEvent.click(rows()[0]); // select ts-3000 (wrote a file / secret.txt)
    expect(document.querySelector('.raw-split')?.getAttribute('data-detail')).toBe('true');

    // A different session's events entirely (or the selected event evicted
    // past the cap) — no matching identity key survives.
    const otherSession: RawEvent[] = [
      { ts: 500, source: 'ws', kind: 'message', summary: 'unrelated session event', detail: {} },
    ];
    rerender(createElement(RawEventPanel, { events: otherSession, onClose: vi.fn() }));

    // Fails closed to the empty-detail hint, not a neighboring event's detail.
    expect(document.querySelector('.raw-split')?.getAttribute('data-detail')).toBeNull();
    expect(screen.getByText('Select an event to see its detail.')).toBeTruthy();
    expect(document.querySelector('.raw-detail-body')).toBeNull();
    // The new session's event legitimately appears as a table row — the
    // regression this guards against is the DETAIL pane showing it as if it
    // had been selected, which the above assertions already rule out.
    const detailPane = document.querySelector('.raw-detail-pane') as HTMLElement;
    expect(within(detailPane).queryByText('unrelated session event')).toBeNull();
  });

  it('Escape drills back out of the detail first, then closes the panel', () => {
    const onClose = vi.fn();
    render(createElement(RawEventPanel, { events: EVENTS, onClose }));

    fireEvent.click(rows()[0]);
    expect(document.querySelector('.raw-split')?.getAttribute('data-detail')).toBe('true');

    // First Escape: back out of the detail, panel stays open.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('.raw-split')?.getAttribute('data-detail')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Second Escape: close the panel.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
