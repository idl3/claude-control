import { useEffect, useRef, useState } from 'react';
import {
  getConfig,
  saveConfig,
  getVersion,
  uploadIcon,
  resetIcon,
} from '../lib/api';

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
  const [version, setVersion] = useState<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
  } | null>(null);
  // Cache-buster so the icon preview refreshes after an upload/reset (the icon
  // URL is stable; the server sends no-store but the <img> may still hold one).
  const [iconBust, setIconBust] = useState(() => Date.now());
  const [iconBusy, setIconBusy] = useState(false);
  const iconInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    getVersion()
      .then((v) => alive && v && setVersion(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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

  const onPickIcon = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.type !== 'image/png') {
      onToast('Icon must be a PNG image', 'error');
      return;
    }
    setIconBusy(true);
    try {
      await uploadIcon(file);
      setIconBust(Date.now());
      onToast('App icon updated — re-add to Home Screen to see it', 'ok');
    } catch (err) {
      onToast(`Icon upload failed: ${(err as Error).message}`, 'error');
    } finally {
      setIconBusy(false);
    }
  };

  const onResetIcon = async () => {
    setIconBusy(true);
    try {
      await resetIcon();
      setIconBust(Date.now());
      onToast('App icon reset to default', 'ok');
    } catch (err) {
      onToast(`Icon reset failed: ${(err as Error).message}`, 'error');
    } finally {
      setIconBusy(false);
    }
  };

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

        <div className="config-field">
          <span className="config-label">App icon</span>
          <div className="config-icon-row">
            <img
              className="config-icon-preview"
              src={`/api/icon?size=192&t=${iconBust}`}
              alt="Current home-screen icon"
              width={48}
              height={48}
            />
            <div className="config-icon-actions">
              <button
                type="button"
                className="config-cancel"
                disabled={iconBusy}
                onClick={() => iconInputRef.current?.click()}
              >
                {iconBusy ? 'Working…' : 'Upload PNG'}
              </button>
              <button
                type="button"
                className="config-cancel"
                disabled={iconBusy}
                onClick={onResetIcon}
              >
                Reset
              </button>
            </div>
            <input
              ref={iconInputRef}
              type="file"
              accept="image/png"
              hidden
              onChange={onPickIcon}
            />
          </div>
          <span className="config-hint">
            Home-screen icon for this app. Defaults to the Claude Control logo.
            After changing it, re-add the app to your Home Screen to update the
            installed icon.
          </span>
        </div>

        <div className="config-version">
          {version ? (
            <>
              <span>claude-control v{version.current}</span>
              {version.updateAvailable && version.latest ? (
                <span className="config-version-update">
                  · update available: v{version.latest}
                </span>
              ) : null}
            </>
          ) : null}
        </div>

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
