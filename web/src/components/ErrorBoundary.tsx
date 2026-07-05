import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { reportClientError } from '../lib/reportError';

interface Props {
  children: ReactNode;
  /** Changing this key resets a previously caught error (e.g. on session switch). */
  resetKey?: string | number;
  /** Optional label shown in the error card for context. */
  label?: string;
  /**
   * Optional hard-recovery action (root boundary only): shown as a "Clear cached
   * state & reload" button. Use when a crash may be caused by poisoned persisted
   * state that a plain Retry can't clear.
   */
  onHardReset?: () => void;
  /**
   * Root-level use: center the card in a full-viewport container with safe-area
   * insets, so on mobile it isn't clipped under the notch/status bar. Nested
   * (in-app) boundaries leave this off and render the card inline.
   */
  fullscreen?: boolean;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * Render-error firewall. Catches a throw from its subtree, shows the actual
 * error (message + full stack, copyable) instead of a white screen, and offers
 * a Retry that re-renders the subtree WITHOUT a page reload. `resetKey` also
 * clears the error automatically when it changes (e.g. switching sessions).
 * Nest one around a pane (the transcript) so a crash there stays contained to
 * that pane and the rest of the app keeps working.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[ErrorBoundary] render error', error, info.componentStack);
    // Log it server-side so the crash is traceable + fixable without a live repro.
    reportClientError({
      source: 'react-boundary',
      label: this.props.label,
      message: error.message || String(error),
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
      sessionId: this.props.resetKey != null ? String(this.props.resetKey) : undefined,
    });
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    // The caught error, fully surfaced: message headline + stack, plus the React
    // component stack when present. This exact text is what "Copy error" yields.
    const detail = `${error.stack || String(error)}${
      componentStack ? `\n\nComponent stack:${componentStack}` : ''
    }`;

    const card = (
      <div className="error-boundary-card" role="alert" aria-live="assertive">
        <span className="error-boundary-title">
          {this.props.label ?? 'This view failed to render'}
        </span>
        <span className="error-boundary-msg">{error.message || String(error)}</span>
        <div className="error-boundary-actions">
          <button type="button" className="error-boundary-btn" onClick={this.reset}>
            Retry
          </button>
          <button
            type="button"
            className="error-boundary-btn error-boundary-btn--ghost"
            onClick={() => void navigator.clipboard?.writeText(detail)}
          >
            Copy error
          </button>
          {this.props.onHardReset ? (
            <button
              type="button"
              className="error-boundary-btn error-boundary-btn--ghost"
              onClick={this.props.onHardReset}
            >
              Clear cached state &amp; reload
            </button>
          ) : null}
        </div>
        {error.stack || componentStack ? (
          <details className="error-boundary-details">
            <summary>Stack trace</summary>
            <pre className="error-boundary-stack">{detail}</pre>
          </details>
        ) : null}
      </div>
    );

    if (this.props.fullscreen) {
      return <div className="error-boundary-fullscreen">{card}</div>;
    }
    return card;
  }
}
