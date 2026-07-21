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
