import { useCallback, useEffect, useState } from 'react';
import { useModalTransition } from '../lib/anim';
import { listProcesses, killProcess } from '../lib/api';
import type { ResourcePoint } from '../hooks/useCockpit';
import type { ProcessInfo, PowerStatus } from '../lib/types';
import { BatteryIcon, XIcon } from './icons';

interface ProcessPanelProps {
  power: PowerStatus | null;
  /** Rolling ~10min CPU%/Mem% samples (from useCockpit). */
  history: ResourcePoint[];
  onClose: () => void;
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
}

const POLL_MS = 3000;
const WINDOW_MS = 10 * 60_000; // x-axis spans the last 10 minutes

/**
 * Time-windowed line chart (SVG): plots `field` over the last 10 minutes with the
 * x-axis as real time (gaps where the modal was closed render as gaps). Cheap —
 * two polylines + a few ticks, no deps/canvas. `now` is passed in so both charts
 * + the axis share one clock.
 */
function TimeChart({
  points,
  field,
  now,
  floor,
  color,
}: {
  points: ResourcePoint[];
  field: 'cpu' | 'mem';
  now: number;
  floor: number;
  color: string;
}) {
  const W = 300;
  const H = 46;
  const start = now - WINDOW_MS;
  const inWin = points.filter((p) => p.t >= start);
  const x = (t: number) => ((t - start) / WINDOW_MS) * W;
  const peak = Math.max(floor, ...inWin.map((p) => p[field]), 1);
  const y = (v: number) => H - (v / peak) * H;
  const line = inWin.map((p) => `${x(p.t).toFixed(1)},${y(p[field]).toFixed(1)}`).join(' ');
  // Vertical gridlines every 2 minutes.
  const ticks = [2, 4, 6, 8].map((m) => x(now - m * 60_000));
  return (
    <svg
      className="proc-chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {ticks.map((tx, i) => (
        <line key={i} x1={tx} y1={0} x2={tx} y2={H} className="proc-chart-grid" />
      ))}
      {inWin.length >= 2 ? (
        <>
          <polyline points={`${x(inWin[0].t).toFixed(1)},${H} ${line} ${x(inWin[inWin.length - 1].t).toFixed(1)},${H}`} fill={color} fillOpacity="0.12" stroke="none" />
          <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </>
      ) : null}
    </svg>
  );
}

/**
 * System monitor: top processes by CPU (polled from /api/ps) with a confirm-gated
 * kill per row, plus a power/battery readout. Read-mostly; the only mutation is
 * SIGTERM (SIGKILL via shift-click), each behind an inline confirm.
 */
export function ProcessPanel({ power, history, onClose: rawClose, onToast }: ProcessPanelProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);
  const [procs, setProcs] = useState<ProcessInfo[] | null>(null);
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [killing, setKilling] = useState<number | null>(null);
  const now = Date.now();
  const last = history.length ? history[history.length - 1] : null;
  const cpu = last?.cpu ?? null;
  const mem = last?.mem ?? null;

  const refresh = useCallback(() => {
    listProcesses()
      .then(setProcs)
      .catch((err) => onToast(`ps failed: ${(err as Error).message}`, 'error'));
  }, [onToast]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doKill = useCallback(
    async (pid: number, hard: boolean) => {
      setKilling(pid);
      try {
        await killProcess(pid, hard ? 'SIGKILL' : 'SIGTERM');
        onToast(`Sent ${hard ? 'SIGKILL' : 'SIGTERM'} → ${pid}`, 'ok');
        setConfirmPid(null);
        refresh();
      } catch (err) {
        onToast(`kill ${pid} failed: ${(err as Error).message}`, 'error');
      } finally {
        setKilling(null);
      }
    },
    [onToast, refresh],
  );

  return (
    <div
      className="modal-backdrop"
      ref={rootRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal modal-process" role="dialog" aria-modal={true} aria-label="Processes & system">
        <div className="modal-head">
          <div className="modal-head-group">
            <span className="modal-title">Processes &amp; system</span>
            {power && power.hasBattery ? (
              <span className="proc-power" data-low={power.low ? 'true' : undefined}>
                <BatteryIcon size={20} level={(power.percent ?? 0) / 100} charging={!!power.charging} />
                {power.percent != null ? `${power.percent}%` : '—'}
                {power.charging ? ' · charging' : ''}
                {power.low ? ' · low' : ''}
              </span>
            ) : null}
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>

        <div className="modal-body proc-body">
          <div className="proc-graphs">
            <div className="proc-graph">
              <div className="proc-graph-head">
                <span className="proc-graph-label">CPU</span>
                <span className="proc-graph-val">{cpu != null ? `${cpu.toFixed(0)}%` : '—'}</span>
              </div>
              <TimeChart points={history} field="cpu" now={now} floor={100} color="var(--accent)" />
            </div>
            <div className="proc-graph">
              <div className="proc-graph-head">
                <span className="proc-graph-label">MEM</span>
                <span className="proc-graph-val">{mem != null ? `${mem.toFixed(0)}%` : '—'}</span>
              </div>
              <TimeChart points={history} field="mem" now={now} floor={100} color="var(--accent-2)" />
            </div>
            {/* Shared x-axis: real time over the last 10 minutes. */}
            <div className="proc-graph-axis">
              <span>10m ago</span>
              <span>5m</span>
              <span>now</span>
            </div>
          </div>
          <div className="proc-row proc-head">
            <span className="proc-pid">PID</span>
            <span className="proc-cpu">CPU%</span>
            <span className="proc-mem">MEM</span>
            <span className="proc-cmd">COMMAND</span>
            <span className="proc-act" />
          </div>
          {procs == null ? (
            <div className="proc-empty">loading…</div>
          ) : procs.length === 0 ? (
            <div className="proc-empty">no processes</div>
          ) : (
            procs.map((p) => (
              <div className="proc-row" key={p.pid}>
                <span className="proc-pid">{p.pid}</span>
                <span className="proc-cpu" data-hot={p.cpu >= 50 ? 'true' : undefined}>
                  {p.cpu.toFixed(0)}
                </span>
                <span className="proc-mem">{p.rssMB}m</span>
                <span className="proc-cmd" title={p.command}>
                  {p.command}
                </span>
                <span className="proc-act">
                  {confirmPid === p.pid ? (
                    <span className="proc-confirm">
                      <button
                        type="button"
                        className="proc-kill-yes"
                        disabled={killing === p.pid}
                        title="SIGTERM (shift-click for SIGKILL)"
                        onClick={(e) => doKill(p.pid, e.shiftKey)}
                      >
                        {killing === p.pid ? '…' : 'Kill'}
                      </button>
                      <button
                        type="button"
                        className="proc-kill-no"
                        onClick={() => setConfirmPid(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="proc-kill"
                      aria-label={`Kill process ${p.pid}`}
                      title="Kill process"
                      onClick={() => setConfirmPid(p.pid)}
                    >
                      <XIcon size={14} />
                    </button>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
