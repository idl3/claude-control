// C4 E2E/visual harness — mounts the REAL ArtifactPanelProvider +
// ArtifactPanel + AppFrameLayer trio (same components src/App.tsx wires
// together, no mocks) around a transcript stand-in containing one
// <embedded-app> tag pointed at the deployed counter micro-app (see
// ../counter-app/build.mjs). Drives: pin -> panel tab appears -> "active in
// panel" chip replaces the transcript embed -> increment inside the panel's
// iframe -> tab away and back -> count survived (no reload) -> unpin (close
// tab) -> transcript embed resumes hosting, count still intact.
//
// Deliberately skips churn-spike's full assistant-ui Thread mount: that
// harness exists to prove survival under real transcript message-list
// churn, which C4 (a visual/interaction pass, not a churn regression test)
// doesn't need — EmbeddedApp's placeholder + the real .detail-split/
// .thread-root layout classes (see preview.css) is enough for an accurate
// screenshot/video of the panel chrome.
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { ArtifactPanelProvider } from '../../src/components/ArtifactContext';
import { EmbeddedApp } from '../../src/components/EmbeddedApp';
import { AppFrameLayer } from '../../src/components/AppFrameLayer';
import { ArtifactPanel } from '../../src/components/ArtifactPanel';
import './preview.css';

function App() {
  return (
    <ArtifactPanelProvider>
      <div className="detail-split">
        <div className="thread-root stage">
          <div className="proto-label">C4 — pin-to-panel visual pass</div>
          <p>Here&apos;s a live counter app embedded in the transcript:</p>
          <EmbeddedApp url="apps/counter.html" height={280} context="transcript" />
          <p>And a second, independent one:</p>
          <EmbeddedApp url="apps/counter2.html" height={280} context="transcript" />
        </div>
        <ArtifactPanel />
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
