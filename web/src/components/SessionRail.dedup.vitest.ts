import { describe, it, expect } from 'vitest';
import {
  dedupeSessionsByIdentity,
  groupByTmux,
  isRestoredSessionName,
  sessionIdentityKey,
} from './SessionRail';
import type { Session } from '../lib/types';

function session(partial: Partial<Session>): Session {
  return { id: 'test-id', ...partial };
}

describe('isRestoredSessionName', () => {
  it('matches the literal "restored" tmux session name (any case)', () => {
    expect(isRestoredSessionName('restored')).toBe(true);
    expect(isRestoredSessionName('RESTORED')).toBe(true);
    expect(isRestoredSessionName('Restored')).toBe(true);
  });

  it('matches "restored:"/"restored-"/"restored "-prefixed variants', () => {
    expect(isRestoredSessionName('restored:2026-07-20')).toBe(true);
    expect(isRestoredSessionName('restored-2')).toBe(true);
    expect(isRestoredSessionName('restored backup')).toBe(true);
  });

  it('does not match an ordinary session name, even one containing "restore" mid-word', () => {
    expect(isRestoredSessionName('fix-claude-control-sessions')).toBe(false);
    expect(isRestoredSessionName('ree-cadence-for-olam')).toBe(false);
    expect(isRestoredSessionName('restoredb')).toBe(false); // no separator after "restored"
  });

  it('returns false for undefined/null/empty', () => {
    expect(isRestoredSessionName(undefined)).toBe(false);
    expect(isRestoredSessionName(null)).toBe(false);
    expect(isRestoredSessionName('')).toBe(false);
  });
});

describe('sessionIdentityKey', () => {
  it('prefers transcriptPath when present', () => {
    const s = session({ transcriptPath: '/a/b.jsonl', sessionId: 'sid-1', windowId: '@1' });
    expect(sessionIdentityKey(s)).toBe('tp:/a/b.jsonl');
  });

  it('falls back to sessionId when transcriptPath is absent', () => {
    const s = session({ sessionId: 'sid-1', windowId: '@1' });
    expect(sessionIdentityKey(s)).toBe('sid:sid-1');
  });

  it('falls back to windowId when neither transcriptPath nor sessionId is present', () => {
    const s = session({ windowId: '@1' });
    expect(sessionIdentityKey(s)).toBe('wid:@1');
  });

  it('returns null when the row carries none of the three', () => {
    const s = session({});
    expect(sessionIdentityKey(s)).toBeNull();
  });
});

describe('dedupeSessionsByIdentity', () => {
  it('collapses a live row and a restored-mirror row sharing the same transcriptPath to one — keeps the live row', () => {
    const live = session({
      id: 'live-1',
      sessionName: 'fix-claude-control-sessions',
      transcriptPath: '/logs/abc.jsonl',
    });
    const restored = session({
      id: 'restored-1',
      sessionName: 'restored',
      transcriptPath: '/logs/abc.jsonl',
    });
    const out = dedupeSessionsByIdentity([live, restored]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('live-1');
  });

  it('keeps the live row regardless of which order the rows arrive in', () => {
    const live = session({ id: 'live-1', sessionName: 'ree-cadence-for-olam', transcriptPath: '/logs/x.jsonl' });
    const restored = session({ id: 'restored-1', sessionName: 'restored', transcriptPath: '/logs/x.jsonl' });
    const out = dedupeSessionsByIdentity([restored, live]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('live-1');
  });

  it('collapses several grouped-tmux-session mirrors (same window, different session names) to one row', () => {
    const mirrors = ['Olam', '_mobile', 'claude-control + olam-agent', 'claude-control & olam'].map((sessionName, i) =>
      session({ id: `mirror-${i}`, sessionName, transcriptPath: '/logs/shared.jsonl' }),
    );
    const out = dedupeSessionsByIdentity(mirrors);
    expect(out).toHaveLength(1);
    // None of the mirror names are "restored", so the first-seen row wins deterministically.
    expect(out[0].id).toBe('mirror-0');
  });

  it('falls back to sessionId when transcriptPath is absent on both duplicate rows', () => {
    const live = session({ id: 'live-1', sessionName: 'olam-agent', sessionId: 'claude-sid-9' });
    const restored = session({ id: 'restored-1', sessionName: 'restored', sessionId: 'claude-sid-9' });
    const out = dedupeSessionsByIdentity([live, restored]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('live-1');
  });

  it('falls back to windowId for terminal panes with no transcript or claude sessionId', () => {
    const a = session({ id: 'term-a', sessionName: 'shell', windowId: '@42' });
    const b = session({ id: 'term-b', sessionName: 'restored', windowId: '@42' });
    const out = dedupeSessionsByIdentity([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('term-a');
  });

  it('does not dedupe distinct sessions that share no identity key', () => {
    const a = session({ id: 'a', sessionName: 'one', transcriptPath: '/logs/a.jsonl' });
    const b = session({ id: 'b', sessionName: 'two', transcriptPath: '/logs/b.jsonl' });
    const out = dedupeSessionsByIdentity([a, b]);
    expect(out).toHaveLength(2);
  });

  it('passes through rows with no derivable identity unchanged (no transcript/sessionId/windowId)', () => {
    const a = session({ id: 'a', sessionName: 'bare' });
    const b = session({ id: 'b', sessionName: 'bare-two' });
    const out = dedupeSessionsByIdentity([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('when both colliding rows are restored-named, the first-seen row still wins (no crash, deterministic)', () => {
    const r1 = session({ id: 'r1', sessionName: 'restored', transcriptPath: '/logs/z.jsonl' });
    const r2 = session({ id: 'r2', sessionName: 'restored', transcriptPath: '/logs/z.jsonl' });
    const out = dedupeSessionsByIdentity([r1, r2]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('r1');
  });
});

describe('groupByTmux — end-to-end dedup', () => {
  it('renders a session reachable via a live tmux name AND a restored mirror exactly once, under the live name', () => {
    const live = session({
      id: 'live-1',
      sessionName: 'claude-control-connect-olam',
      windowIndex: 0,
      paneIndex: 0,
      transcriptPath: '/logs/dup.jsonl',
    });
    const restored = session({
      id: 'restored-1',
      sessionName: 'restored',
      windowIndex: 3,
      paneIndex: 0,
      transcriptPath: '/logs/dup.jsonl',
    });
    const other = session({
      id: 'other-1',
      sessionName: 'unrelated',
      windowIndex: 0,
      paneIndex: 0,
      transcriptPath: '/logs/other.jsonl',
    });
    const groups = groupByTmux([live, restored, other]);

    // Exactly one row total for the duplicated session, under its live group.
    const allIds = groups.flatMap((g) => g.windows.flatMap((w) => w.panes.map((p) => p.id)));
    expect(allIds.sort()).toEqual(['live-1', 'other-1']);
    expect(allIds).not.toContain('restored-1');

    const restoredGroup = groups.find((g) => g.sessionName === 'restored');
    expect(restoredGroup).toBeUndefined(); // the whole group disappears once its only row is deduped away

    const liveGroup = groups.find((g) => g.sessionName === 'claude-control-connect-olam');
    expect(liveGroup?.windows[0].panes.map((p) => p.id)).toEqual(['live-1']);
  });

  it('still shows unrelated sessions untouched alongside a deduped pair', () => {
    const live = session({ id: 'a', sessionName: 'alpha', transcriptPath: '/logs/a.jsonl' });
    const restored = session({ id: 'a-restored', sessionName: 'restored', transcriptPath: '/logs/a.jsonl' });
    const standalone = session({ id: 'b', sessionName: 'beta', transcriptPath: '/logs/b.jsonl' });
    const groups = groupByTmux([live, restored, standalone]);
    expect(groups.map((g) => g.sessionName).sort()).toEqual(['alpha', 'beta']);
  });
});
