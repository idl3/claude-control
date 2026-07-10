// Source for the deployed micro-app at ~/.claude-control/media/apps/counter.html
// (see build.mjs in this dir). This file itself is never shipped — it is
// bundled + minified by esbuild into one inline <script>, because the
// deployed artifact renders inside a sandboxed iframe's `srcDoc`, which has
// no base URL and therefore cannot load an external <script src="…">.
//
// Demonstrates: a React app with its own root and its own error boundary,
// running fully isolated inside a sandbox="allow-scripts" iframe (no
// allow-same-origin — see EmbeddedApp in web/src/components/EmbeddedApp.tsx).
// "crash it" throws during render on purpose to prove the boundary contains
// it — the surrounding cockpit transcript is never affected.
//
// B2/B3: on catch, also posts an OPTIONAL {type:'cc-app-error'} beacon up to
// window.parent so the host (AppFrameLayer.tsx) can show a "crashed —
// reload?" strip instead of leaving a dead, silently-broken frame in place.
// See docs/design/cockpit-pinned-artifacts.md for the artifact contract this
// beacon is part of. componentDidCatch (not getDerivedStateFromError) is the
// right lifecycle for this: it runs post-render and is documented as safe
// for side effects, and fires exactly once per catch.
//
// Phase C, C4: `Counter` takes props (label/initialCount/theme) and is
// wrapped with withCcBridge (ccBridgeRuntime.tsx) so the studio's Props tab
// (C3) can drive it live — see build.mjs, which runs docgen against THIS
// file's `CounterProps` interface to emit the sibling manifest. Only ONE
// component in this file carries a named props interface docgen can latch
// onto (CounterBoundary's props are an inline `{ children }` literal, not a
// named interface) — deliberate, so `--infer-manifest`'s single-component
// parse always resolves to `Counter`, never the boundary.
import { Component, StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { withCcBridge } from '../../src/lib/ccBridgeRuntime';

class CounterBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    window.parent.postMessage({ type: 'cc-app-error', message: String(error) }, '*');
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-fallback" data-testid="crash-fallback">
          <div className="crash-title">crashed — contained in this frame</div>
          <code>{String(this.state.error)}</code>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface CounterProps {
  /** Text shown above the counter value. */
  label?: string;
  /** Starting/reset value for the counter. */
  initialCount?: number;
}

export function Counter({ label = 'react counter — own root, own boundary', initialCount = 0 }: CounterProps) {
  const [count, setCount] = useState(initialCount);
  const [doomed, setDoomed] = useState(false);

  // Deliberate render-time throw — the boundary above catches it. Nothing
  // outside this iframe ever sees the error. Also reachable via the studio's
  // raw-JSON override (e.g. injecting a non-numeric `initialCount`) once the
  // bridge is wired — see withCcBridge below.
  if (doomed) {
    throw new Error('deliberate render crash (demo)');
  }

  return (
    <div className="counter-card" data-testid="counter">
      <div className="counter-label">{label}</div>
      <div className="count">{count}</div>
      <div className="counter-actions">
        <button type="button" onClick={() => setCount((c) => c - 1)}>
          −1
        </button>
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          +1
        </button>
        <button type="button" className="danger" onClick={() => setDoomed(true)}>
          crash it
        </button>
      </div>
    </div>
  );
}

const BridgedCounter = withCcBridge(Counter, {
  label: 'react counter — own root, own boundary',
  initialCount: 0,
});

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <CounterBoundary>
        <BridgedCounter />
      </CounterBoundary>
    </StrictMode>,
  );
}
