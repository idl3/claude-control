import { useEffect, useState } from 'react';
import { getConfig, saveConfig } from '../lib/api';

interface ConfigModalProps {
  onClose: () => void;
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
}

/**
 * Settings modal: edit the launch command (run in each new session's pane) and
 * the default cwd. Loads current config on open; Save validates server-side and
 * toasts the result. Small, keyboard-dismissable, matches the app's dark tokens.
 */
export function ConfigModal({ onClose, onToast }: ConfigModalProps) {
  const [launchCommand, setLaunchCommand] = useState('');
  const [defaultCwd, setDefaultCwd] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    getConfig()
      .then((c) => {
        if (!alive) return;
        setLaunchCommand(c.launchCommand);
        setDefaultCwd(c.defaultCwd);
      })
      .catch((err) => onToast(`Load config failed: ${err.message}`, 'error'))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [onToast]);

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveConfig({ launchCommand, defaultCwd });
      setLaunchCommand(saved.launchCommand);
      setDefaultCwd(saved.defaultCwd);
      onToast('Config saved', 'ok');
      onClose();
    } catch (err) {
      onToast(`Save failed: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="config-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="config-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="config-head">
          <span className="config-title">Settings</span>
          <button
            type="button"
            className="config-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <label className="config-field">
          <span className="config-label">Launch command</span>
          <input
            className="config-input"
            type="text"
            placeholder="claude"
            value={launchCommand}
            disabled={loading}
            onChange={(e) => setLaunchCommand(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="config-hint">
            Run in each new session's pane (e.g. <code>yolo</code> or{' '}
            <code>claude --flags</code>).
          </span>
        </label>

        <label className="config-field">
          <span className="config-label">Default cwd</span>
          <input
            className="config-input"
            type="text"
            value={defaultCwd}
            disabled={loading}
            onChange={(e) => setDefaultCwd(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="config-hint">
            Must be an existing directory. New sessions start here.
          </span>
        </label>

        <div className="config-actions">
          <button
            type="button"
            className="config-cancel"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="config-save"
            onClick={save}
            disabled={loading || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
