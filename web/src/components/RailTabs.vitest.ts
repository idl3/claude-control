import { describe, it, expect } from 'vitest';
import {
  computeRailTabs,
  defaultOrgLabel,
  resolveOrgLabel,
  resolveTabAction,
  type RailTab,
} from './RailTabs';
import type { Session } from '../lib/types';

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
