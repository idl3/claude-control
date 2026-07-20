// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import {
  computeRailTabs,
  defaultOrgLabel,
  resolveOrgLabel,
  resolveTabAction,
  RailTabs,
  type RailTab,
} from './RailTabs';
import type { OrgHealth, Session } from '../lib/types';

afterEach(() => cleanup());

function local(partial: Partial<Session> = {}): Session {
  return { id: `local:${Math.random()}`, kind: 'claude', ...partial } as Session;
}
function remote(org: string, partial: Partial<Session> = {}): Session {
  return { id: `olam:${org}:${Math.random()}`, kind: 'remote', org, ...partial } as Session;
}

describe('computeRailTabs — tab partition + counts', () => {
  it('Local tab counts every non-remote session, regardless of kind', () => {
    const sessions = [
      local({ kind: 'claude' }),
      local({ kind: 'terminal' }),
      local({ kind: 'codex' }),
      remote('atlas'),
    ];
    const tabs = computeRailTabs(sessions, ['atlas']);
    const localTab = tabs.find((t) => t.id === 'local')!;
    expect(localTab.count).toBe(3);
    expect(localTab.kind).toBe('local');
  });

  it('each configured org tab counts only that org\'s remote sessions', () => {
    const sessions = [
      local(),
      remote('atlas'),
      remote('atlas'),
      remote('grain'),
    ];
    const tabs = computeRailTabs(sessions, ['atlas', 'grain']);
    expect(tabs.find((t) => t.id === 'atlas')!.count).toBe(2);
    expect(tabs.find((t) => t.id === 'grain')!.count).toBe(1);
  });

  it('orders Local first, then configured orgs alphabetically by slug', () => {
    const tabs = computeRailTabs([], ['pleri', 'atlas', 'grain']);
    expect(tabs.map((t) => t.id)).toEqual(['local', 'atlas', 'grain', 'pleri']);
  });

  it('a remote session for an unconfigured org does not leak into any org tab', () => {
    const sessions = [remote('atlas'), remote('rogue-org')];
    const tabs = computeRailTabs(sessions, ['atlas']);
    expect(tabs.map((t) => t.id)).toEqual(['local', 'atlas']);
    expect(tabs.find((t) => t.id === 'atlas')!.count).toBe(1);
  });

  it('zero configured orgs (and no remote sessions passed in) yields a single unconfigured "Cloud" pseudo-tab', () => {
    const tabs = computeRailTabs([local()], []);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toMatchObject({ id: 'local', kind: 'local' });
    expect(tabs[1]).toMatchObject({ id: 'cloud', kind: 'unconfigured', count: 0 });
  });

  it('with >=1 configured org, no unconfigured pseudo-tab exists', () => {
    const tabs = computeRailTabs([], ['atlas']);
    expect(tabs.some((t) => t.kind === 'unconfigured')).toBe(false);
  });

  it('dedupes a configuredOrgs list with a repeated slug', () => {
    const tabs = computeRailTabs([], ['atlas', 'atlas']);
    expect(tabs.filter((t) => t.id === 'atlas')).toHaveLength(1);
  });

  // Fix 2a: the tab badge must be a TRUE total, not just the "current"
  // (non-earlier, non-archived) subset SessionRail's groupRemoteByOrg splits
  // rows into for display. computeRailTabs counts every matching session
  // unconditionally — earlier/idle and archived rows are never excluded —
  // so this locks in that the two concepts (rail display grouping vs. tab
  // count) stay decoupled rather than the count silently adopting the
  // display split's exclusions.
  it('org + local counts include archived and old-idle ("earlier") rows, not just current ones', () => {
    const sessions = [
      local({ kind: 'terminal' }),
      remote('atlas', { archived: true }),
      remote('atlas', { archived: false, lastActivity: Date.parse('2020-01-01T00:00:00Z') }), // ancient → "earlier" in the rail, still counted here
      remote('atlas', { archived: false, lastActivity: Date.now() }),
    ];
    const tabs = computeRailTabs(sessions, ['atlas']);
    expect(tabs.find((t) => t.id === 'local')!.count).toBe(1);
    expect(tabs.find((t) => t.id === 'atlas')!.count).toBe(3);
  });
});

describe('computeRailTabs — capped badge (Fix 2b)', () => {
  function health(capped: boolean): OrgHealth {
    return { status: 'green', reason: null, capped };
  }

  it('an org tab is capped when orgHealth reports capped for that org', () => {
    const tabs = computeRailTabs([], ['atlas'], {}, { atlas: health(true) });
    expect(tabs.find((t) => t.id === 'atlas')!.capped).toBe(true);
  });

  it('an org tab is NOT capped when orgHealth reports capped:false or is absent', () => {
    const tabs = computeRailTabs([], ['atlas', 'grain'], {}, { atlas: health(false) });
    expect(tabs.find((t) => t.id === 'atlas')!.capped).toBe(false);
    expect(tabs.find((t) => t.id === 'grain')!.capped).toBe(false);
  });

  it('the Local tab is never capped, regardless of orgHealth contents', () => {
    const tabs = computeRailTabs([], ['atlas'], {}, { atlas: health(true) });
    expect(tabs.find((t) => t.id === 'local')!.capped).toBeFalsy();
  });

  it('omitting the orgHealth argument entirely defaults every tab to uncapped (back-compat)', () => {
    const tabs = computeRailTabs([], ['atlas']);
    expect(tabs.find((t) => t.id === 'atlas')!.capped).toBe(false);
  });
});

describe('RailTabs — capped badge renders as "N+" (Fix 2b)', () => {
  it('renders "50+" with a title hint when the tab is capped', () => {
    const tabs: RailTab[] = [
      { id: 'local', label: 'Local', count: 5, kind: 'local' },
      { id: 'atlas', label: 'Atlas', count: 50, kind: 'org', capped: true },
    ];
    render(
      createElement(RailTabs, {
        tabs,
        activeTab: 'local',
        onSelect: () => {},
        onRename: () => {},
        customNames: {},
      }),
    );
    const count = screen.getByText('50+');
    expect(count.getAttribute('title')).toBe('50+ — more may exist past the fetch limit');
  });

  it('renders the plain count with no "+" and no title when the tab is not capped', () => {
    const tabs: RailTab[] = [
      { id: 'local', label: 'Local', count: 5, kind: 'local' },
      { id: 'grain', label: 'Grain', count: 16, kind: 'org', capped: false },
    ];
    render(
      createElement(RailTabs, {
        tabs,
        activeTab: 'local',
        onSelect: () => {},
        onRename: () => {},
        customNames: {},
      }),
    );
    const count = screen.getByText('16');
    expect(count.getAttribute('title')).toBeNull();
  });
});

describe('defaultOrgLabel / resolveOrgLabel — custom-name resolution', () => {
  it('Title-Cases a single-word slug', () => {
    expect(defaultOrgLabel('grain')).toBe('Grain');
    expect(defaultOrgLabel('atlas')).toBe('Atlas');
    expect(defaultOrgLabel('pleri')).toBe('Pleri');
  });

  it('Title-Cases each hyphen segment of a multi-word slug', () => {
    expect(defaultOrgLabel('atlas-two')).toBe('Atlas Two');
  });

  it('falls back to the default label when no custom name is set', () => {
    expect(resolveOrgLabel('grain', {})).toBe('Grain');
  });

  it('a non-blank custom name overrides the default label', () => {
    expect(resolveOrgLabel('grain', { grain: 'My Grain Cluster' })).toBe('My Grain Cluster');
  });

  it('an empty-string custom name resets to the default label', () => {
    expect(resolveOrgLabel('grain', { grain: '' })).toBe('Grain');
  });

  it('a whitespace-only custom name resets to the default label', () => {
    expect(resolveOrgLabel('grain', { grain: '   ' })).toBe('Grain');
  });

  it('a custom name for a DIFFERENT org never leaks onto this one', () => {
    expect(resolveOrgLabel('grain', { atlas: 'Not Grain' })).toBe('Grain');
  });

  it('computeRailTabs applies the custom name but keeps the id as the raw slug', () => {
    const tabs = computeRailTabs([], ['grain'], { grain: 'Prod Cluster' });
    const grainTab = tabs.find((t) => t.id === 'grain')!;
    expect(grainTab.id).toBe('grain'); // routing/filtering key never changes
    expect(grainTab.label).toBe('Prod Cluster'); // only display changes
  });
});

describe('resolveTabAction — unconfigured-cloud routing', () => {
  const unconfigured: RailTab[] = [
    { id: 'local', label: 'Local', count: 0, kind: 'local' },
    { id: 'cloud', label: 'Cloud', count: 0, kind: 'unconfigured' },
  ];
  const configured: RailTab[] = [
    { id: 'local', label: 'Local', count: 0, kind: 'local' },
    { id: 'atlas', label: 'Atlas', count: 0, kind: 'org' },
  ];

  it('selecting the unconfigured "cloud" pseudo-tab opens settings, not a select', () => {
    expect(resolveTabAction('cloud', unconfigured)).toEqual({ type: 'open-settings' });
  });

  it('selecting Local always selects, even in the unconfigured tab set', () => {
    expect(resolveTabAction('local', unconfigured)).toEqual({ type: 'select', id: 'local' });
  });

  it('selecting a configured org tab selects/filters, never opens settings', () => {
    expect(resolveTabAction('atlas', configured)).toEqual({ type: 'select', id: 'atlas' });
  });

  it('with >=1 configured org, there is no "cloud" pseudo-tab id to select at all', () => {
    expect(configured.some((t) => t.id === 'cloud')).toBe(false);
  });

  it('an id that matches no tab at all (stale persisted selection) defensively opens settings', () => {
    expect(resolveTabAction('removed-org', configured)).toEqual({ type: 'open-settings' });
  });
});
