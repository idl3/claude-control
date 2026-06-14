import type { ConnState } from '../lib/ws';
import type { ResourceState } from '../hooks/useCockpit';

interface ResourceHudProps {
  resources: ResourceState;
  conn: ConnState;
}

function fmt(n: number | undefined, suffix = ''): string {
  return n != null ? `${Math.round(n)}${suffix}` : '—';
}

// Slim top bar: self cpu/rss + system load/mem, warning-tinted when over limit.
export function ResourceHud({ resources, conn }: ResourceHudProps) {
  const snap = resources.snapshot;
  const self = snap?.self ?? {};
  const sys = snap?.system ?? {};
  const over = !!snap?.overLimit || !!resources.warning;
  const load0 = sys.loadavg?.[0];

  return (
    <div className="hud" data-warn={over ? 'true' : 'false'} role="status">
      <span className="hud-brand">control</span>
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
      {over ? (
        <span className="hud-warn-text">{resources.warning || 'over limit'}</span>
      ) : null}
    </div>
  );
}
