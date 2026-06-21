import { useEffect, useRef, useState } from 'react';
import { getAgents, getTmuxSessions } from '../lib/api';
import {
  agentDisabledReason,
  buildSpawnMessage,
  validateSpawnForm,
} from '../lib/spawn';
import type { AgentInfo, SpawnFormState, TmuxSessionInfo } from '../lib/spawn';
import type { SpawnClientMessage } from '../lib/types';

interface SpawnPickerProps {
  open: boolean;
  onClose: () => void;
  onSpawn: (msg: SpawnClientMessage) => void;
  error?: string | null;
}

const DEFAULT_STATE: SpawnFormState = {
  agentType: 'claude',
  mode: 'new-window',
  session: '',
  name: '',
  cwd: '',
};

export function SpawnPicker({ open, onClose, onSpawn, error }: SpawnPickerProps) {
  const [form, setForm] = useState<SpawnFormState>(DEFAULT_STATE);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fetch agents + tmux sessions whenever the picker opens.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([getAgents(), getTmuxSessions()]).then(([a, t]) => {
      setAgents(a);
      setTmuxSessions(t);
      // Seed the session dropdown with the first available tmux session.
      if (t.length > 0) {
        setForm((prev) => ({
          ...prev,
          session: prev.session || t[0].name,
          cwd: prev.cwd || t[0].cwd || '',
        }));
      }
      setLoading(false);
    });
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus trap: focus the dialog when opened.
  useEffect(() => {
    if (open && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  const validationErrors = validateSpawnForm(form);
  const spawnMsg = buildSpawnMessage(form);
  const canSubmit = spawnMsg !== null;

  function handleTmuxSessionChange(name: string) {
    const found = tmuxSessions.find((s) => s.name === name);
    setForm((prev) => ({
      ...prev,
      session: name,
      // Auto-seed cwd when picking an existing session.
      cwd: found?.cwd ?? prev.cwd,
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSpawn(spawnMsg!);
    onClose();
  }

  const claudeDisabled = agentDisabledReason(agents, 'claude');
  const codexDisabled = agentDisabledReason(agents, 'codex');

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="spawn-picker-title"
        className="modal spawn-picker"
        tabIndex={-1}
      >
        <header className="modal-head">
          <span id="spawn-picker-title" className="modal-title spawn-picker-title">
            New Session
          </span>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <form onSubmit={handleSubmit} className="modal-body spawn-picker-form">
          {/* Agent selector */}
          <fieldset className="spawn-fieldset">
            <legend className="spawn-legend">Agent</legend>
            <div className="spawn-agent-row">
              {(['claude', 'codex'] as const).map((id) => {
                const reason = agentDisabledReason(agents, id);
                const isDisabled = reason !== null;
                return (
                  <label
                    key={id}
                    className="spawn-agent-option"
                    data-disabled={isDisabled ? 'true' : 'false'}
                    data-selected={form.agentType === id ? 'true' : 'false'}
                    title={reason ?? undefined}
                  >
                    <input
                      type="radio"
                      name="agentType"
                      value={id}
                      checked={form.agentType === id}
                      disabled={isDisabled}
                      onChange={() => setForm((prev) => ({ ...prev, agentType: id }))}
                    />
                    <span className="spawn-agent-label">{id}</span>
                    {isDisabled ? (
                      <span className="spawn-agent-unavail">unavailable</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            {/* Suppress lint warnings for destructured-but-unused vars */}
            {claudeDisabled !== null || codexDisabled !== null ? null : null}
          </fieldset>

          {/* Mode toggle */}
          <fieldset className="spawn-fieldset">
            <legend className="spawn-legend">Target</legend>
            <div className="spawn-mode-row">
              {(['new-window', 'new-session'] as const).map((m) => (
                <label
                  key={m}
                  className="spawn-mode-option"
                  data-selected={form.mode === m ? 'true' : 'false'}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={m}
                    checked={form.mode === m}
                    onChange={() => setForm((prev) => ({ ...prev, mode: m }))}
                  />
                  <span className="spawn-mode-label">
                    {m === 'new-window' ? 'Existing session' : 'New session'}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Existing session dropdown (mode=new-window) */}
          {form.mode === 'new-window' ? (
            <div className="spawn-field">
              <label className="spawn-field-label" htmlFor="spawn-session">
                tmux session
              </label>
              {loading ? (
                <div className="spawn-field-loading">Loading…</div>
              ) : tmuxSessions.length > 0 ? (
                <select
                  id="spawn-session"
                  className="spawn-select"
                  value={form.session}
                  onChange={(e) => handleTmuxSessionChange(e.target.value)}
                >
                  {tmuxSessions.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}{s.cwd ? ` (${s.cwd})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="spawn-session"
                  type="text"
                  className="spawn-input"
                  placeholder="session name"
                  value={form.session}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, session: e.target.value }))
                  }
                />
              )}
            </div>
          ) : (
            /* New session name input (mode=new-session) */
            <div className="spawn-field">
              <label className="spawn-field-label" htmlFor="spawn-name">
                Session name
              </label>
              <input
                id="spawn-name"
                type="text"
                className={`spawn-input${validationErrors.name ? ' spawn-input-error' : ''}`}
                placeholder="my-project"
                value={form.name}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, name: e.target.value }))
                }
                autoComplete="off"
              />
              {validationErrors.name ? (
                <span className="spawn-field-error">{validationErrors.name}</span>
              ) : null}
            </div>
          )}

          {/* Working directory */}
          <div className="spawn-field">
            <label className="spawn-field-label" htmlFor="spawn-cwd">
              Working directory
            </label>
            <input
              id="spawn-cwd"
              type="text"
              className={`spawn-input${validationErrors.cwd ? ' spawn-input-error' : ''}`}
              placeholder="/home/user/project"
              value={form.cwd}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, cwd: e.target.value }))
              }
              autoComplete="off"
            />
            {validationErrors.cwd ? (
              <span className="spawn-field-error">{validationErrors.cwd}</span>
            ) : null}
          </div>

          {/* Server-side ack error */}
          {error ? (
            <div className="spawn-error" role="alert">
              {error}
            </div>
          ) : null}

          <footer className="modal-foot">
            <div className="modal-foot-spacer" />
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!canSubmit}
            >
              Spawn
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
