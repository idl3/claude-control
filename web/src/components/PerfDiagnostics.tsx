import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  postClientPerfBatch,
} from '../lib/api';
import {
  buildPerfReport,
  buildPerfSample,
  classifyPerfSample,
  createEmptyCounters,
  createEmptyFrameWindow,
  getPerfDeviceInfo,
  loadPerfClientId,
  recordFrameGap,
  sampleMemory,
  sampleSurfaces,
  setPerfEventRecording,
  type FrameWindow,
  type PerfCounters,
  type PerfDeviceInfo,
  type PerfEventDetail,
  type PerfSample,
} from '../lib/perfDiagnostics';

const SAMPLE_MS = 1000;
const POST_MS = 10_000;
const HISTORY_LIMIT = 120;
const PENDING_POST_LIMIT = 30;

interface PerfDiagnosticsProps {
  enabled: boolean;
  onClose: () => void;
}

interface PerfSnapshot {
  device: PerfDeviceInfo;
  latest: PerfSample | null;
  copied: 'idle' | 'ok' | 'error';
  localLog: 'idle' | 'ok' | 'error';
}

export function PerfDiagnostics({ enabled, onClose }: PerfDiagnosticsProps) {
  const device = useMemo(() => (enabled ? getPerfDeviceInfo() : null), [enabled]);
  const clientId = useMemo(() => loadPerfClientId(), []);
  const pageIdRef = useRef<string>(newPageId());
  const historyRef = useRef<PerfSample[]>([]);
  const pendingPostRef = useRef<PerfSample[]>([]);
  const frameRef = useRef<FrameWindow>(createEmptyFrameWindow());
  const countersRef = useRef<PerfCounters>(createEmptyCounters());
  const [snapshot, setSnapshot] = useState<PerfSnapshot | null>(null);

  useEffect(() => {
    if (!enabled || !device) {
      historyRef.current = [];
      setSnapshot(null);
      return;
    }

    let rafId = 0;
    let lastFrameTs = 0;
    let lastSampleTs = performance.now();
    let expectedTick = lastSampleTs + SAMPLE_MS;
    let lastPostTs = lastSampleTs;
    let maxLoopLagMs = 0;
    let posting = false;
    let alive = true;
    const observers: PerformanceObserver[] = [];

    const handlePerfEvent = (event: Event) => {
      const detail = (event as CustomEvent<PerfEventDetail>).detail;
      if (!detail) return;
      if (detail.kind === 'ws-message') {
        countersRef.current.wsMessages += 1;
        countersRef.current.wsBytes += Math.max(0, detail.value ?? 0);
      } else if (detail.kind === 'app-render') {
        countersRef.current.appRenders += 1;
        countersRef.current.maxRenderMessages = Math.max(
          countersRef.current.maxRenderMessages,
          detail.value ?? 0,
        );
      }
    };

    const observe = (
      type: string,
      onEntry: (entry: PerformanceEntry, counters: PerfCounters) => void,
    ) => {
      if (typeof PerformanceObserver === 'undefined') return;
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) onEntry(entry, countersRef.current);
        });
        observer.observe({ type, buffered: false } as PerformanceObserverInit);
        observers.push(observer);
      } catch {
        /* Unsupported in this browser despite supportedEntryTypes — ignore. */
      }
    };

    observe('longtask', (entry, counters) => {
      counters.longTasks += 1;
      counters.longTaskMs += entry.duration;
    });
    observe('long-animation-frame', (entry, counters) => {
      counters.longAnimationFrames += 1;
      counters.longAnimationFrameMs += entry.duration;
    });
    observe('layout-shift', (entry, counters) => {
      const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (!shift.hadRecentInput && typeof shift.value === 'number') {
        counters.layoutShiftScore += shift.value;
      }
    });

    const onFrame = (ts: number) => {
      if (lastFrameTs > 0) {
        recordFrameGap(frameRef.current, ts - lastFrameTs);
      }
      lastFrameTs = ts;
      rafId = window.requestAnimationFrame(onFrame);
    };

    const sample = () => {
      const now = performance.now();
      const lag = Math.max(0, now - expectedTick);
      maxLoopLagMs = Math.max(maxLoopLagMs, lag);
      const latest = buildPerfSample({
        now: Date.now(),
        elapsedMs: now - lastSampleTs,
        frame: frameRef.current,
        counters: countersRef.current,
        loopLagMs: maxLoopLagMs,
        memory: sampleMemory(),
        surfaces: sampleSurfaces(),
        visibility: document.visibilityState,
      });
      historyRef.current = [...historyRef.current.slice(-(HISTORY_LIMIT - 1)), latest];
      pendingPostRef.current = [...pendingPostRef.current, latest].slice(-PENDING_POST_LIMIT);
      setSnapshot((prev) => ({
        device,
        latest,
        copied: prev?.copied === 'ok' ? 'ok' : 'idle',
        localLog: prev?.localLog ?? 'idle',
      }));
      if (now - lastPostTs >= POST_MS) {
        lastPostTs = now;
        flushLocalLog();
      }
      frameRef.current = createEmptyFrameWindow();
      countersRef.current = createEmptyCounters();
      lastSampleTs = now;
      expectedTick = now + SAMPLE_MS;
      maxLoopLagMs = 0;
    };

    const flushLocalLog = () => {
      if (posting || pendingPostRef.current.length === 0) return;
      const samples = pendingPostRef.current;
      pendingPostRef.current = [];
      posting = true;
      void postClientPerfBatch({
        clientId,
        pageId: pageIdRef.current,
        device,
        samples,
        url: window.location.href,
        userAgent: navigator.userAgent,
      })
        .then((ok) => {
          if (!alive) return;
          setSnapshot((prev) => (prev ? { ...prev, localLog: ok ? 'ok' : 'error' } : prev));
        })
        .catch(() => {
          if (!alive) return;
          setSnapshot((prev) => (prev ? { ...prev, localLog: 'error' } : prev));
        })
        .finally(() => {
          posting = false;
        });
    };

    setPerfEventRecording(true);
    window.addEventListener('cockpit:perf-event', handlePerfEvent);
    rafId = window.requestAnimationFrame(onFrame);
    const intervalId = window.setInterval(sample, SAMPLE_MS);
    setSnapshot({ device, latest: null, copied: 'idle', localLog: 'idle' });

    return () => {
      flushLocalLog();
      alive = false;
      setPerfEventRecording(false);
      window.removeEventListener('cockpit:perf-event', handlePerfEvent);
      window.cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
      for (const observer of observers) observer.disconnect();
      pendingPostRef.current = [];
      frameRef.current = createEmptyFrameWindow();
      countersRef.current = createEmptyCounters();
    };
  }, [enabled, device, clientId]);

  const copyReport = useCallback(async () => {
    if (!snapshot) return;
    const report = JSON.stringify(buildPerfReport(snapshot.device, historyRef.current), null, 2);
    try {
      await navigator.clipboard.writeText(report);
      setSnapshot((prev) => (prev ? { ...prev, copied: 'ok' } : prev));
      window.setTimeout(() => {
        setSnapshot((prev) => (prev?.copied === 'ok' ? { ...prev, copied: 'idle' } : prev));
      }, 1800);
    } catch {
      setSnapshot((prev) => (prev ? { ...prev, copied: 'error' } : prev));
    }
  }, [snapshot]);

  const reset = useCallback(() => {
    historyRef.current = [];
    frameRef.current = createEmptyFrameWindow();
    countersRef.current = createEmptyCounters();
    setSnapshot((prev) => (prev ? { ...prev, latest: null, copied: 'idle' } : prev));
  }, []);

  if (!enabled || !snapshot) return null;

  const latest = snapshot.latest;
  const status = classifyPerfSample(latest);

  return (
    <aside className={`perf-diagnostics perf-diagnostics--${status}`} aria-label="Device performance diagnostics">
      <header className="perf-diagnostics-head">
        <div>
          <span className="perf-diagnostics-dot" aria-hidden />
          <strong>Device perf</strong>
          <span className="perf-diagnostics-status">{status}</span>
        </div>
        <div className="perf-diagnostics-actions">
          <button type="button" onClick={copyReport}>
            {snapshot.copied === 'ok' ? 'Copied' : snapshot.copied === 'error' ? 'Copy failed' : 'Copy'}
          </button>
          <button type="button" onClick={reset}>
            Reset
          </button>
          <button type="button" aria-label="Close device performance diagnostics" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      {latest ? (
        <>
          <div className="perf-diagnostics-grid">
            <Metric label="FPS" value={latest.fps.toFixed(1)} tone={latest.fps < 52 ? 'warn' : 'ok'} />
            <Metric label="Worst frame" value={`${latest.worstFrameMs.toFixed(1)}ms`} tone={latest.worstFrameMs >= 60 ? 'warn' : 'ok'} />
            <Metric label="Long tasks" value={`${latest.longTasks} / ${latest.longTaskMs.toFixed(0)}ms`} tone={latest.longTasks > 0 ? 'warn' : 'ok'} />
            <Metric label="Loop lag" value={`${latest.loopLagMs.toFixed(1)}ms`} tone={latest.loopLagMs >= 60 ? 'warn' : 'ok'} />
            <Metric label="WS" value={`${latest.wsMessagesPerSec.toFixed(1)}/s · ${latest.wsKbPerSec.toFixed(1)}KB/s`} />
            <Metric label="Renders" value={`${latest.appRendersPerSec.toFixed(1)}/s`} tone={latest.appRendersPerSec > 20 ? 'warn' : 'ok'} />
            <Metric label="Heap" value={latest.memory ? `${latest.memory.usedMb.toFixed(1)}MB` : 'n/a'} />
            <Metric label="Media" value={`v${latest.surfaces.playingVideos}/${latest.surfaces.videos} · a${latest.surfaces.playingAudio}/${latest.surfaces.audios} · mic ${latest.surfaces.voiceActive ? 'on' : 'off'}`} tone={latest.surfaces.playingVideos || latest.surfaces.playingAudio || latest.surfaces.voiceActive ? 'warn' : 'neutral'} />
            <Metric label="GPU-ish" value={`ifr ${latest.surfaces.visibleIframes}/${latest.surfaces.iframes} · canv ${latest.surfaces.visibleCanvases}/${latest.surfaces.canvases} · anim ${latest.surfaces.runningAnimations}`} tone={latest.surfaces.visibleIframes || latest.surfaces.visibleCanvases > 1 || latest.surfaces.runningAnimations > 12 ? 'warn' : 'neutral'} />
            <Metric label="Local log" value={snapshot.localLog === 'ok' ? 'ok' : snapshot.localLog === 'error' ? 'failed' : 'pending'} tone={snapshot.localLog === 'error' ? 'warn' : 'neutral'} />
            <Metric label="DPR" value={`${snapshot.device.dpr} · ${snapshot.device.viewport.width}×${snapshot.device.viewport.height}`} />
          </div>
          <p className="perf-diagnostics-note">
            No browser temperature sensor is exposed. Correlate heat with FPS drops, long tasks, heap growth,
            websocket bursts, render bursts, and WebGL/compositor details.
          </p>
          <details className="perf-diagnostics-details">
            <summary>Device details</summary>
            <dl>
              <dt>Visibility</dt>
              <dd>{latest.visibility}</dd>
              <dt>Reduced motion</dt>
              <dd>{snapshot.device.prefersReducedMotion ? 'yes' : 'no'}</dd>
              <dt>WebGL</dt>
              <dd>
                {snapshot.device.webgl.available
                  ? [snapshot.device.webgl.version, snapshot.device.webgl.renderer].filter(Boolean).join(' · ')
                  : 'not available'}
              </dd>
              <dt>Long animation frame API</dt>
              <dd>{snapshot.device.supportedEntryTypes.includes('long-animation-frame') ? 'available' : 'not available'}</dd>
            </dl>
          </details>
        </>
      ) : (
        <p className="perf-diagnostics-note">Warming up one-second sampling window…</p>
      )}
    </aside>
  );
}

function newPageId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn';
}) {
  return (
    <div className={`perf-diagnostics-metric perf-diagnostics-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
