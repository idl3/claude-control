import { useEffect, useRef, useState } from 'react';
import type { OrgHealth, Session } from '../lib/types';
import { CloudIcon } from './icons';

/**
 * One entry in the rail's tab row (docs/plans/cloud-local-tabs). 'local' is
 * the fixed, non-renamable tab for tmux/terminal sessions; 'org' is one
 * configured Olam cloud cluster; 'unconfigured' is the single pseudo-tab
 * shown when NO cloud cluster is configured yet — selecting it never
 * filters, it opens Settings → Olam cloud instead (see resolveTabAction).
 */
export interface RailTab {
  /** 'local' | the raw org slug | 'cloud' (unconfigured pseudo-tab). Stable
   *  across renames — renaming only ever changes `label`. */
  id: string;
  label: string;
  count: number;
  kind: 'local' | 'org' | 'unconfigured';
  /**
   * True when this org's last fetched page hit the backend's page-size
   * ceiling (lib/olam-client.js LIST_SESSIONS_LIMIT, threaded through
   * RemoteSessionSource.health()) — the org may have MORE sessions than
   * `count` reflects. Renders as an honest "N+" instead of a possibly-wrong
   * exact count. Always false/absent for the 'local' and 'unconfigured' tabs.
   */
  capped?: boolean;
}

/** Title-case an org slug for its default display label: 'grain' → 'Grain',
 *  'atlas-two' → 'Atlas Two'. Overridden by a custom name when one is set. */
export function defaultOrgLabel(org: string): string {
  return org
    .split('-')
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(' ');
}

/** Resolve an org tab's display label: a non-blank custom name wins, else
 *  the Title-Cased slug. Whitespace-only custom names count as unset (the
 *  reset-by-clearing-the-input behavior lives here, not just in the caller
 *  that persists it). */
export function resolveOrgLabel(org: string, customNames: Record<string, string>): string {
  const custom = customNames[org]?.trim();
  return custom ? custom : defaultOrgLabel(org);
}

/**
 * Pure tab-list + count computation — Local first, then configured orgs
 * alphabetically by slug. Zero configured orgs → a single non-filtering
 * "Cloud" setup pseudo-tab instead of an empty org list, so there's always
 * an entry point into Settings → Olam cloud (see resolveTabAction). The
 * tab's `id` is always the raw org slug (never the custom label) so
 * filtering/counting/routing stay stable across a rename.
 */
export function computeRailTabs(
  sessions: Session[],
  configuredOrgs: string[],
  customNames: Record<string, string> = {},
  orgHealth: Record<string, OrgHealth> = {},
): RailTab[] {
  const localCount = sessions.filter((s) => s.kind !== 'remote').length;
  const localTab: RailTab = { id: 'local', label: 'Local', count: localCount, kind: 'local' };

  if (configuredOrgs.length === 0) {
    return [localTab, { id: 'cloud', label: 'Cloud', count: 0, kind: 'unconfigured' }];
  }

  const orgs = [...new Set(configuredOrgs)].sort((a, b) => a.localeCompare(b));
  const orgTabs: RailTab[] = orgs.map((org) => ({
    id: org,
    label: resolveOrgLabel(org, customNames),
    count: sessions.filter((s) => s.kind === 'remote' && s.org === org).length,
    kind: 'org',
    capped: !!orgHealth[org]?.capped,
  }));
  return [localTab, ...orgTabs];
}

export type RailTabAction = { type: 'select'; id: string } | { type: 'open-settings' };

/**
 * What tapping a tab should DO, given the currently rendered tab list.
 * 'local' and any configured 'org' tab select+filter; the unconfigured
 * 'cloud' pseudo-tab (or, defensively, any id not present in `tabs` at
 * all — e.g. a stale persisted selection) routes to Settings instead of
 * silently doing nothing.
 */
export function resolveTabAction(id: string, tabs: RailTab[]): RailTabAction {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab.kind === 'unconfigured') return { type: 'open-settings' };
  return { type: 'select', id };
}

interface RailTabsProps {
  tabs: RailTab[];
  activeTab: string;
  onSelect: (id: string) => void;
  /** label ''/whitespace resets that org back to its default Title-Cased name. */
  onRename: (orgId: string, label: string) => void;
  customNames: Record<string, string>;
}

/**
 * Horizontally-scrollable tab row, pinned above .rail-foot (App.tsx renders
 * it as a flex-shrink:0 sibling between .rail-scroll and NewSessionForm —
 * see styles.css's .rail-tabs block for the layout contract). Presentational
 * only: all state (active tab, custom names) lives in App.
 */
export function RailTabs({ tabs, activeTab, onSelect, onRename, customNames }: RailTabsProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId !== null) inputRef.current?.select();
  }, [renamingId]);

  const startRename = (tab: RailTab) => {
    setRenamingId(tab.id);
    // Seed the draft with the RAW custom value (not the resolved default) so
    // an unmodified submit is a true no-op rather than baking the default in.
    setRenameDraft(customNames[tab.id] ?? '');
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft('');
  };
  const submitRename = () => {
    const org = renamingId;
    cancelRename();
    if (!org) return;
    onRename(org, renameDraft);
  };

  return (
    <nav className="rail-tabs-wrap">
      <div className="rail-tabs" role="tablist" aria-label="Session source">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          const isRenaming = renamingId === tab.id;
          if (isRenaming) {
            return (
              <input
                key={tab.id}
                ref={inputRef}
                type="text"
                className="rail-tab-rename-input"
                value={renameDraft}
                maxLength={40}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={submitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                aria-label={`Rename ${tab.label} tab`}
              />
            );
          }
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="rail-tab"
              data-kind={tab.kind}
              aria-selected={active}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={() => {
                // Only the ACTIVE cloud tab is renamable — keeps the
                // affordance out of the way of ordinary tab switching.
                if (tab.kind === 'org' && active) startRename(tab);
              }}
              title={tab.kind === 'org' && active ? 'Double-click to rename' : undefined}
            >
              {tab.kind === 'unconfigured' ? <CloudIcon size={14} /> : null}
              <span className="rail-tab-label">{tab.label}</span>
              {tab.kind !== 'unconfigured' ? (
                <span className="rail-tab-count" title={tab.capped ? `${tab.count}+ — more may exist past the fetch limit` : undefined}>
                  {tab.count}
                  {tab.capped ? '+' : ''}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
