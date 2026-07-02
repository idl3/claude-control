import { describe, it, expect } from 'vitest';
import { groupRemoteByOrg } from './SessionRail';
import type { Session } from '../lib/types';

function remote(partial: Partial<Session>): Session {
  return { id: 'olam:atlas:x', kind: 'remote', org: 'atlas', ...partial } as Session;
}

describe('groupRemoteByOrg — active vs archived split', () => {
  it('puts non-archived rows in rows and archived rows in archivedRows', () => {
    const active = remote({ id: 'a', archived: false, lastActivity: Date.parse('2026-07-02T10:00:00Z') });
    const archived = remote({ id: 'b', archived: true, lastActivity: Date.parse('2026-07-01T10:00:00Z') });
    const [group] = groupRemoteByOrg([active, archived]);
    expect(group.rows.map((s) => s.id)).toEqual(['a']);
    expect(group.archivedRows.map((s) => s.id)).toEqual(['b']);
  });

  it('treats an absent archived field as active (not archived)', () => {
    const s = remote({ id: 'c' });
    const [group] = groupRemoteByOrg([s]);
    expect(group.rows.map((r) => r.id)).toEqual(['c']);
    expect(group.archivedRows).toEqual([]);
  });

  it('never drops archived rows from the group — they land in archivedRows, not omitted', () => {
    const archived = remote({ id: 'd', archived: true });
    const [group] = groupRemoteByOrg([archived]);
    expect(group.rows).toEqual([]);
    expect(group.archivedRows).toHaveLength(1);
    expect(group.archivedRows[0].id).toBe('d');
  });

  it('sorts both rows and archivedRows by lastActivity descending within the org', () => {
    const older = remote({ id: 'old', archived: true, lastActivity: Date.parse('2026-06-01T00:00:00Z') });
    const newer = remote({ id: 'new', archived: true, lastActivity: Date.parse('2026-07-01T00:00:00Z') });
    const [group] = groupRemoteByOrg([older, newer]);
    expect(group.archivedRows.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('splits independently per org', () => {
    const atlasActive = remote({ id: 'atlas-active', org: 'atlas', archived: false });
    const grainArchived = remote({ id: 'grain-archived', org: 'grain', archived: true });
    const groups = groupRemoteByOrg([atlasActive, grainArchived]);
    const atlas = groups.find((g) => g.org === 'atlas')!;
    const grain = groups.find((g) => g.org === 'grain')!;
    expect(atlas.rows.map((s) => s.id)).toEqual(['atlas-active']);
    expect(atlas.archivedRows).toEqual([]);
    expect(grain.rows).toEqual([]);
    expect(grain.archivedRows.map((s) => s.id)).toEqual(['grain-archived']);
  });
});
