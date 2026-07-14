// Wide presentation-embeds visual/measurement harness — mounts the REAL
// EmbeddedApp + AppFrameLayer (same components src/App.tsx wires together,
// no mocks), wrapped in the real .app/.app-body/.rail/.detail/.detail-split
// shell so the transcript column at each target viewport (1400x900 desktop,
// 834x1194 iPad, 390x844 mobile) has the same width the real app would give
// it (.rail reserves min(46vw, 375px) at >=760px — see styles.css lines
// 242-259 — .thread-root fills the rest). data-detail="open" keeps .detail
// visible below 760px too (styles.css line 238), matching pin-to-panel-
// harness's simplification of using .thread-root.stage directly rather than
// the full .msg-row/.msg-body nesting (that harness's own doc comment: "a
// visual/interaction pass ... doesn't need the full transcript-churn
// machinery" — this harness needs geometry, not churn, either).
//
// One `width="wide"` embed (create-artifact html-lane output) + one default
// embed, side by side, so a single screenshot at each viewport shows the
// contrast directly.
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { ArtifactPanelProvider } from '../../src/components/ArtifactContext';
import { EmbeddedApp } from '../../src/components/EmbeddedApp';
import { AppFrameLayer } from '../../src/components/AppFrameLayer';
import './preview.css';

function App() {
  return (
    <ArtifactPanelProvider>
      <div className="app" data-detail="open">
        <div className="app-body">
          <div className="rail" aria-hidden="true" />
          <div className="detail">
            <div className="detail-split">
              <div className="thread-root stage">
                <div className="proto-label" data-testid="wide-label">
                  wide (width=&quot;wide&quot;) — apps/artifacts-landing.html
                </div>
                <EmbeddedApp url="apps/artifacts-landing.html" height={640} context="transcript" width="wide" />
                <div className="proto-label" data-testid="default-label">
                  default (no width attr) — apps/pipeline-dashboard.html
                </div>
                <EmbeddedApp url="apps/pipeline-dashboard.html" height={640} context="transcript" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <AppFrameLayer />
    </ArtifactPanelProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
