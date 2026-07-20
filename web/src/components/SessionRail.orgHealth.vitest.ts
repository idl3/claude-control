// @vitest-environment jsdom
//
// Fix 1 (cloud-local-tabs): a red org (e.g. a lapsed cloudflared Access
// session) must surface its health REASON + login command in the rail's
// empty state, not the generic "No <Org> cloud sessions" message — and it
// must do this even when the org has ZERO known rows, since a row-derived
// `orgHealth` has nothing to read off of in that case. See SessionRail.tsx's
// `orgHealth` prop, `groupRemoteByOrg`'s `orgHealthMap` param, and the
// `remoteGroups` useMemo that synthesizes a placeholder group so
// RemoteOrgSection is always reachable once a cloud tab is active.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { groupRemoteByOrg, SessionRail } from './SessionRail';
import type { OrgHealth, Session } from '../lib/types';

afterEach(() => cleanup());

const NOW = Date.parse('2026-07-03T12:00:00Z');

function remote(partial: Partial<Session>): Session {
  return { id: 'olam:atlas:x', kind: 'remote', org: 'atlas', ...partial } as Session;
}

const RED_HEALTH: OrgHealth = {
  status: 'red',
  reason: 'Access session expired — run: cloudflared access login https://grain.olam.example',
};

describe('groupRemoteByOrg — orgHealthMap override', () => {
  it('prefers the row-independent orgHealthMap over row-derived health when both are present', () => {
    const s = remote({ id: 'a', orgHealth: { status: 'green', reason: null } });
    const [group] = groupRemoteByOrg([s], NOW, { atlas: RED_HEALTH });
    expect(group.health).toEqual(RED_HEALTH);
  });

  it('falls back to row-derived health when the org is absent from orgHealthMap', () => {
    const s = remote({ id: 'a', orgHealth: { status: 'green', reason: null } });
    const [group] = groupRemoteByOrg([s], NOW, { grain: RED_HEALTH });
    expect(group.health).toEqual({ status: 'green', reason: null });
  });

  it('falls back to unknown/null when neither orgHealthMap nor any row carries health', () => {
    const s = remote({ id: 'a' });
    const [group] = groupRemoteByOrg([s], NOW);
    expect(group.health).toEqual({ status: 'unknown', reason: null });
  });
});

function renderRail(overrides: Partial<Parameters<typeof SessionRail>[0]> = {}) {
  render(
    createElement(SessionRail, {
      sessions: [],
      selectedId: null,
      onSelect: () => {},
      filter: 'all',
      collapsed: new Set<string>(),
      onToggleCollapse: () => {},
      hotkeyById: new Map<string, string>(),
      ...overrides,
    }),
  );
}

describe('SessionRail — cloud tab empty state reflects row-independent orgHealth', () => {
  it('a red org with ZERO rows shows the health reason, not the generic empty message', () => {
    renderRail({ cloudOrg: 'grain', orgHealth: { grain: RED_HEALTH } });
    expect(screen.getByRole('note').textContent).toBe(
      'Access session expired — run: cloudflared access login https://grain.olam.example',
    );
    expect(screen.queryByText('No Grain cloud sessions')).toBeNull();
  });

  it('a genuinely-empty but healthy org still shows the generic "No X cloud sessions" message', () => {
    renderRail({ cloudOrg: 'atlas', orgHealth: { atlas: { status: 'green', reason: null } } });
    expect(screen.getByText('No Atlas cloud sessions')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('an org with no orgHealth entry at all (unknown) still renders the tab section with the generic message', () => {
    renderRail({ cloudOrg: 'pleri' });
    expect(screen.getByText('No Pleri cloud sessions')).toBeTruthy();
  });

  it('a red org WITH rows still shows the reason banner alongside the rows', () => {
    const rows: Session[] = [remote({ id: 'a', org: 'grain', lastActivity: NOW - 1000 })];
    renderRail({ sessions: rows, cloudOrg: 'grain', orgHealth: { grain: RED_HEALTH } });
    expect(screen.getByRole('note').textContent).toContain('Access session expired');
    expect(screen.queryByText('No Grain cloud sessions')).toBeNull();
  });
});
