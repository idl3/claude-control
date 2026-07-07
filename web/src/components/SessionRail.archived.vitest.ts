import { describe, it, expect } from 'vitest';
import { groupRemoteByOrg, isCurrentRemote } from './SessionRail';
import type { Session } from '../lib/types';

const NOW = Date.parse('2026-07-03T12:00:00Z');
const HOUR = 3_600_000;

function remote(partial: Partial<Session>): Session {
  return { id: 'olam:atlas:x', kind: 'remote', org: 'atlas', ...partial } as Session;
}

describe('groupRemoteByOrg — current / earlier / archived split', () => {
  it('puts recent non-archived rows in rows and archived rows in archivedRows', () => {
    const active = remote({ id: 'a', archived: false, lastActivity: NOW - 2 * HOUR });
    const archived = remote({ id: 'b', archived: true, lastActivity: NOW - 24 * HOUR });
    const [group] = groupRemoteByOrg([active, archived], NOW);
    expect(group.rows.map((s) => s.id)).toEqual(['a']);
    expect(group.earlierRows).toEqual([]);
    expect(group.archivedRows.map((s) => s.id)).toEqual(['b']);
  });

  it('collapses an old idle non-archived row under earlierRows (not rows, not archived)', () => {
    // No activity + not live → "active" in the archived sense, but not "current".
    const s = remote({ id: 'c' });
    const [group] = groupRemoteByOrg([s], NOW);
    expect(group.rows).toEqual([]);
    expect(group.earlierRows.map((r) => r.id)).toEqual(['c']);
    expect(group.archivedRows).toEqual([]);
  });

  it('keeps a stale-but-LIVE row in rows regardless of age (in-flight / pending / halted)', () => {
    const ancient = Date.parse('2026-01-01T00:00:00Z');
    const inflight = remote({ id: 'if', lastActivity: ancient, inFlight: true });
    const pending = remote({ id: 'pd', lastActivity: ancient, pending: true });
    const halted = remote({ id: 'ht', lastActivity: ancient, halted: true });
    const [group] = groupRemoteByOrg([inflight, pending, halted], NOW);
    expect(new Set(group.rows.map((s) => s.id))).toEqual(new Set(['if', 'pd', 'ht']));
    expect(group.earlierRows).toEqual([]);
  });

  it('respects the 48h boundary: <48h idle is current, >48h idle is earlier', () => {
    const justInside = remote({ id: 'in', lastActivity: NOW - 47 * HOUR });
    const justOutside = remote({ id: 'out', lastActivity: NOW - 49 * HOUR });
    const [group] = groupRemoteByOrg([justInside, justOutside], NOW);
    expect(group.rows.map((s) => s.id)).toEqual(['in']);
    expect(group.earlierRows.map((s) => s.id)).toEqual(['out']);
  });

  it('never drops archived rows — they land in archivedRows, not omitted', () => {
    const archived = remote({ id: 'd', archived: true });
    const [group] = groupRemoteByOrg([archived], NOW);
    expect(group.rows).toEqual([]);
    expect(group.earlierRows).toEqual([]);
    expect(group.archivedRows).toHaveLength(1);
    expect(group.archivedRows[0].id).toBe('d');
  });

  it('sorts archivedRows by lastActivity descending within the org', () => {
    const older = remote({ id: 'old', archived: true, lastActivity: Date.parse('2026-06-01T00:00:00Z') });
    const newer = remote({ id: 'new', archived: true, lastActivity: Date.parse('2026-07-01T00:00:00Z') });
    const [group] = groupRemoteByOrg([older, newer], NOW);
    expect(group.archivedRows.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('splits independently per org', () => {
    const atlasCurrent = remote({ id: 'atlas-cur', org: 'atlas', lastActivity: NOW - HOUR });
    const grainArchived = remote({ id: 'grain-arch', org: 'grain', archived: true });
    const groups = groupRemoteByOrg([atlasCurrent, grainArchived], NOW);
    const atlas = groups.find((g) => g.org === 'atlas')!;
    const grain = groups.find((g) => g.org === 'grain')!;
    expect(atlas.rows.map((s) => s.id)).toEqual(['atlas-cur']);
    expect(atlas.archivedRows).toEqual([]);
    expect(grain.rows).toEqual([]);
    expect(grain.archivedRows.map((s) => s.id)).toEqual(['grain-arch']);
  });
});

describe('isCurrentRemote', () => {
  it('treats live rows (inFlight / pending / halted) as current regardless of age', () => {
    expect(isCurrentRemote(remote({ inFlight: true, lastActivity: 0 }), NOW)).toBe(true);
    expect(isCurrentRemote(remote({ pending: true, lastActivity: 0 }), NOW)).toBe(true);
    expect(isCurrentRemote(remote({ halted: true, lastActivity: 0 }), NOW)).toBe(true);
  });

  it('treats idle rows as current only within the 48h window', () => {
    expect(isCurrentRemote(remote({ lastActivity: NOW - HOUR }), NOW)).toBe(true);
    expect(isCurrentRemote(remote({ lastActivity: NOW - 72 * HOUR }), NOW)).toBe(false);
  });

  it('is not current when there is no activity signal at all', () => {
    expect(isCurrentRemote(remote({}), NOW)).toBe(false);
  });

  it('parses an ISO-string lastActivity (the server runtime shape)', () => {
    // olam-client sets lastActivity = last_turn_at ?? created_at (an ISO string),
    // even though the field is loosely typed number.
    expect(isCurrentRemote(remote({ lastActivity: '2026-07-03T10:00:00Z' as unknown as number }), NOW)).toBe(true);
    expect(isCurrentRemote(remote({ lastActivity: '2026-06-01T10:00:00Z' as unknown as number }), NOW)).toBe(false);
  });
});
