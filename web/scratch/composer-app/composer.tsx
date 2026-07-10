// Source for the second cockpit-prototype-studio dogfood (C4) — a minimal
// chat-composer mock, proving the manifest + cc-bridge wiring (C1/C2/C3)
// generalizes beyond the counter demo to a different shape of props
// (`disabled`, `sessionId`, per the C4 spec's own wording) and a different
// interaction model (controlled text input, not a click counter). Built the
// same way as counter-app (see that dir's counter.tsx/build.mjs doc
// comments for the shared constraints: single-file esbuild IIFE bundle, no
// external <script src>/<link href> since this loads via a sandboxed
// iframe's srcDoc with no base URL).
//
// `Composer` is the sole docgen-visible export (same "one named props
// interface per file" discipline as counter.tsx) so `--infer-manifest`'s
// single-component parse always resolves to it.
import { Component, StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { withCcBridge } from '../../src/lib/ccBridgeRuntime';

class ComposerBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
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

export interface ComposerProps {
  /** Input placeholder text. */
  placeholder?: string;
  /** Disables the input + send button (e.g. mid-request). */
  disabled?: boolean;
  /** Session id shown in the footer — stands in for a real session-scoped composer. */
  sessionId?: string;
}

export function Composer({
  placeholder = 'Message…',
  disabled = false,
  sessionId = 'demo-session',
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string[]>([]);

  const send = () => {
    if (!draft.trim() || disabled) return;
    setSent((prev) => [...prev, draft]);
    setDraft('');
  };

  return (
    <div className="composer-card" data-testid="composer">
      <div className="composer-log">
        {sent.length === 0 ? (
          <div className="composer-log-empty">no messages yet</div>
        ) : (
          sent.map((m, i) => (
            <div className="composer-log-entry" key={i}>
              {m}
            </div>
          ))
        )}
      </div>
      <div className="composer-row">
        <input
          className="composer-input"
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button type="button" disabled={disabled} onClick={send}>
          Send
        </button>
      </div>
      <div className="composer-session">session: {sessionId}</div>
    </div>
  );
}

const BridgedComposer = withCcBridge(Composer, {
  placeholder: 'Message…',
  disabled: false,
  sessionId: 'demo-session',
});

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <ComposerBoundary>
        <BridgedComposer />
      </ComposerBoundary>
    </StrictMode>,
  );
}
