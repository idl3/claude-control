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
import { Component, StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

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

function Counter() {
  const [count, setCount] = useState(0);
  const [doomed, setDoomed] = useState(false);

  // Deliberate render-time throw — the boundary above catches it. Nothing
  // outside this iframe ever sees the error.
  if (doomed) {
    throw new Error('deliberate render crash (demo)');
  }

  return (
    <div className="counter-card" data-testid="counter">
      <div className="counter-label">react counter — own root, own boundary</div>
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

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <CounterBoundary>
        <Counter />
      </CounterBoundary>
    </StrictMode>,
  );
}
