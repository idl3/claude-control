import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing this key resets a previously caught error (e.g. on session switch). */
  resetKey?: string | number;
  /** Optional label shown in the error card for context. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] render error', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary-card" role="alert" aria-live="assertive">
        <span className="error-boundary-title">
          {this.props.label ?? 'This session failed to render'}
        </span>
        <span className="error-boundary-msg">{error.message}</span>
      </div>
    );
  }
}
