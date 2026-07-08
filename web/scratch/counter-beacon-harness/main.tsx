// B3 E2E harness — proves the counter artifact's cc-app-error beacon end to
// end through the REAL EmbeddedApp + AppFrameLayer components (no mocks):
// crash it (inside the sandboxed iframe) -> AppFrameLayer's message listener
// validates the beacon -> crashed strip replaces the iframe -> reload button
// -> AppFrameLayer.reload() re-fetches -> a live, recovered counter.
//
// Deliberately skips the full assistant-ui transcript stack churn-spike uses
// (that harness exists to prove churn survival; this one only needs a single
// stable embed) — EmbeddedApp + AppFrameLayer mount directly, same shape as
// the mounted tests in src/lib/embeds.vitest.ts.
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { EmbeddedApp } from '../../src/components/EmbeddedApp';
import { AppFrameLayer } from '../../src/components/AppFrameLayer';
import './preview.css';

function App() {
  return (
    <div className="stage">
      <div className="proto-label">B3 — counter crash-beacon harness</div>
      <EmbeddedApp url="proof/app.html" height={320} />
      <AppFrameLayer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
