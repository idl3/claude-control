import { useCallback, useEffect, useState } from 'react';
import { authFetch, onUnauthorized } from '../lib/api';
import { clearToken, getToken, setToken } from '../lib/auth';

type GateState = 'probing' | 'authed' | 'needs-token' | 'submitting';

interface TokenGateProps {
  children: React.ReactNode;
}

/**
 * Login gate. On mount it probes `GET /api/health` with the currently-stored
 * token (sent as a bearer header):
 *   - 200            → render the app (tokenless server probes return 200 with
 *                      no token, so no prompt shows).
 *   - 401            → show the login form; on submit, store the token and
 *                      re-probe. Wrong token → "invalid token" + clear.
 * Any live request/WS that later 401s routes through onUnauthorized (api.ts),
 * which clears the token and flips this gate back to the login form.
 */
export function TokenGate({ children }: TokenGateProps) {
  const [state, setState] = useState<GateState>('probing');
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');

  // Probe /api/health with the current token. Resolves the gate to 'authed'
  // (200) or 'needs-token' (401/other). Network errors keep the form up with a
  // message rather than locking the user out.
  const probe = useCallback(async (): Promise<boolean> => {
    try {
      const res = await authFetch('/api/health');
      if (res.ok) {
        setState('authed');
        setError(null);
        return true;
      }
      return false;
    } catch {
      setError('Cannot reach the server. Check the connection and retry.');
      return false;
    }
  }, []);

  // Initial probe on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await probe();
      if (cancelled) return;
      if (!ok) setState('needs-token');
    })();
    return () => {
      cancelled = true;
    };
  }, [probe]);

  // A live 401 anywhere (api.ts handleUnauthorized) bounces us back to login.
  useEffect(() => {
    return onUnauthorized(() => {
      setState('needs-token');
      setInput('');
      setError('Session expired — enter your access token again.');
    });
  }, []);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const token = input.trim();
      if (!token) {
        setError('Enter an access token.');
        return;
      }
      setState('submitting');
      setError(null);
      setToken(token);
      const ok = await probe();
      if (!ok) {
        // authFetch already cleared the token on a 401; clear again defensively
        // in case the probe failed for another reason.
        clearToken();
        setState('needs-token');
        setError('Invalid token.');
      }
    },
    [input, probe],
  );

  if (state === 'authed') return <>{children}</>;

  if (state === 'probing') {
    return (
      <div className="gate-root" role="status" aria-live="polite">
        <div className="gate-card gate-card--probing">
          <span className="gate-spinner" aria-hidden="true" />
          <span className="gate-probing-text">Connecting…</span>
        </div>
      </div>
    );
  }

  // Already had a (now-cleared) token before this prompt? Hint the user.
  const hadToken = getToken() !== null;
  void hadToken; // reserved for future copy; keep getToken import meaningful

  return (
    <div className="gate-root">
      <form className="gate-card" onSubmit={onSubmit} aria-label="Sign in">
        <div className="gate-brand">
          <span className="gate-glyph" aria-hidden="true">◧</span>
          <span className="gate-title">claude&nbsp;control</span>
        </div>
        <label className="gate-label" htmlFor="gate-token">
          Access token
        </label>
        <input
          id="gate-token"
          className="gate-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          spellCheck={false}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'gate-error' : undefined}
          placeholder="••••••••••••"
        />
        {error ? (
          <p id="gate-error" className="gate-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="gate-submit"
          disabled={state === 'submitting'}
        >
          {state === 'submitting' ? 'Connecting…' : 'Connect'}
        </button>
        <p className="gate-hint">
          Find your token in <code>~/.claude-control/token</code> on the server,
          or wherever <code>CLAUDE_CONTROL_TOKEN</code> is set. It's also printed
          when the server starts.
        </p>
      </form>
    </div>
  );
}
