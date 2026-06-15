import { useState } from 'react';
import { checkAuth, setToken } from '../lib/api';

interface LoginProps {
  onAuthed: () => void;
}

/**
 * Token entry screen, shown when the cockpit can't authenticate (missing / wrong
 * `?token=`). Entering the correct access token stores it and unlocks the app —
 * no need to hand-edit the URL.
 */
export function Login({ onAuthed }: LoginProps) {
  const [token, setTok] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !token.trim()) return;
    setBusy(true);
    setErr(false);
    setToken(token.trim());
    const ok = await checkAuth();
    setBusy(false);
    if (ok) onAuthed();
    else setErr(true);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">claude control</h1>
        <p className="login-sub">Enter your access token</p>
        <input
          className="login-input"
          type="password"
          value={token}
          onChange={(e) => setTok(e.target.value)}
          placeholder="access token"
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
        />
        <div className="login-err">{err ? 'Invalid token — try again' : ''}</div>
        <button className="login-btn" type="submit" disabled={busy || !token.trim()}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
