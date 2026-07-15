import type { ConnState } from '../lib/ws';
import type { ResourceState } from '../hooks/useCockpit';
import type { PushController } from '../hooks/usePushNotifications';
import { NotifyBell } from './NotifyBell';
import { FullscreenButton } from './FullscreenButton';
import { ClaudeRobotIcon } from './ClaudeRobotIcon';
import { BatteryIcon, SettingsIcon, ActivityIcon } from './icons';

interface ResourceHudProps {
  resources: ResourceState;
  conn: ConnState;
  push: PushController;
  /** Reload/Settings/Processes — compressed here from the old rail-foot bar,
      rendered as a compact icon cluster beside the fullscreen toggle. */
  onReload: () => void;
  onOpenSettings: () => void;
  onOpenProcesses: () => void;
}

function fmt(n: number | undefined, suffix = ''): string {
  return n != null ? `${Math.round(n)}${suffix}` : '—';
}

// Slim top bar: self cpu/rss + system load/mem, warning-tinted when over limit.
export function ResourceHud({
  resources,
  conn,
  push,
  onReload,
  onOpenSettings,
  onOpenProcesses,
}: ResourceHudProps) {
  const snap = resources.snapshot;
  const self = snap?.self ?? {};
  const sys = snap?.system ?? {};
  const over = !!snap?.overLimit || !!resources.warning;
  const load0 = sys.loadavg?.[0];
  const power = snap?.power;

  return (
    <div className="hud" data-warn={over ? 'true' : 'false'} role="status">
      <span className="hud-brand">
        <ClaudeRobotIcon size={18} />
        claude control
      </span>
      <span className={`conn-dot conn-${conn}`} title={conn} aria-label={conn} />
      <span className="hud-group">
        <span className="hud-k">cpu</span>
        <span className="hud-v">
          {self.cpuPct != null ? `${self.cpuPct.toFixed(0)}%` : '—'}
        </span>
      </span>
      <span className="hud-group">
        <span className="hud-k">rss</span>
        <span className="hud-v">{fmt(self.rssMB, 'm')}</span>
      </span>
      <span className="hud-group">
        <span className="hud-k">load</span>
        <span className="hud-v">{load0 != null ? load0.toFixed(2) : '—'}</span>
      </span>
      <span className="hud-group">
        <span className="hud-k">mem</span>
        <span className="hud-v">{fmt(sys.memUsedPct, '%')}</span>
      </span>
      {power && power.hasBattery ? (
        <span
          className="hud-group hud-battery"
          data-low={power.low ? 'true' : undefined}
          data-charging={power.charging ? 'true' : undefined}
          title={`battery ${power.percent ?? '—'}%${power.charging ? ' · charging' : ''}${power.low ? ' · low' : ''}`}
        >
          <BatteryIcon size={20} level={(power.percent ?? 0) / 100} charging={!!power.charging} />
          <span className="hud-v">{power.percent != null ? `${power.percent}%` : '—'}</span>
        </span>
      ) : null}
      {over ? (
        <span className="hud-warn-text">{resources.warning || 'over limit'}</span>
      ) : null}
      <span className="hud-spacer" />
      {/* Reload/Settings/Processes — compressed from the old rail-foot bar into a
          compact icon cluster beside fullscreen. Settings is icon-only here (the
          rail-foot text label is gone). */}
      <button
        type="button"
        className="notify-bell hud-reload"
        aria-label="Reload app"
        title="Reload app"
        onClick={onReload}
      >
        <span className="hud-reload-glyph" aria-hidden="true">↻</span>
      </button>
      <button
        type="button"
        className="notify-bell hud-settings"
        aria-label="Settings"
        title="Settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon size={16} />
      </button>
      <button
        type="button"
        className="notify-bell hud-processes"
        aria-label="Processes & system"
        title="Processes & system"
        onClick={onOpenProcesses}
      >
        <ActivityIcon size={16} />
      </button>
      <FullscreenButton />
      <NotifyBell push={push} />
    </div>
  );
}
