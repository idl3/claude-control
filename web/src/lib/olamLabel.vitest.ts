import { describe, it, expect } from 'vitest';
import { prettifyRemoteId, sessionDisplayLabel } from './olamLabel';
import type { Session } from './types';

describe('prettifyRemoteId', () => {
  it('formats olam:org:uuid as "org · first-8"', () => {
    expect(prettifyRemoteId('olam:atlas:9f3c1a2b-4444-5555-6666-777788889999')).toBe('atlas · 9f3c1a2b');
  });
  it('handles a short uuid tail gracefully (no crash, no padding)', () => {
    expect(prettifyRemoteId('olam:grain:ab12')).toBe('grain · ab12');
  });
  it('falls back to the raw id when it does not match olam:org:uuid', () => {
    expect(prettifyRemoteId('tmux-session-1')).toBe('tmux-session-1');
    expect(prettifyRemoteId('olam:onlyorg')).toBe('olam:onlyorg');
  });
});

describe('sessionDisplayLabel', () => {
  const remote = (over: Partial<Session>): Session =>
    ({ id: 'olam:atlas:9f3c1a2b-4444-5555-6666-777788889999', kind: 'remote', ...over } as Session);

  it('prefers name over everything', () => {
    expect(sessionDisplayLabel(remote({ name: 'My renamed session', title: 'Fix flaky spec' }), null)).toBe(
      'My renamed session',
    );
  });
  it('falls back to title when name is absent', () => {
    expect(sessionDisplayLabel(remote({ title: 'Fix flaky spec' }), null)).toBe('Fix flaky spec');
  });
  it('falls back to a prettified id for remote sessions with no name/title', () => {
    expect(sessionDisplayLabel(remote({}), null)).toBe('atlas · 9f3c1a2b');
  });
  it('never returns the raw olam:org:uuid id', () => {
    const label = sessionDisplayLabel(remote({}), null);
    expect(label).not.toContain('olam:atlas:9f3c1a2b-4444');
  });
  it('falls back to fallbackId for a local (non-remote) session with no name', () => {
    expect(sessionDisplayLabel({ id: 'tmux-1', kind: 'claude' } as Session, 'tmux-1')).toBe('tmux-1');
  });
  it('falls back to "claude control" when nothing is selected', () => {
    expect(sessionDisplayLabel(null, null)).toBe('claude control');
  });
});
