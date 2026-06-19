import { useEffect, useRef, useState } from 'react';
import { useModalTransition } from '../lib/anim';
import {
  getConfig,
  saveConfig,
  getVersion,
  getModels,
  uploadIcon,
  resetIcon,
  type OptimizeBackend,
  type ModelsInfo,
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
export function ConfigModal({ onClose: rawClose, onToast }: ConfigModalProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);
  const [launchCommand, setLaunchCommand] = useState('');
  const [defaultCwd, setDefaultCwd] = useState('');
  const [optimizeModel, setOptimizeModel] = useState('');
  const [claudeBin, setClaudeBin] = useState('');
  const [optimizeBackend, setOptimizeBackend] = useState<OptimizeBackend>('mlx');
  const [mlxModel, setMlxModel] = useState('');
  // 0 = CSS default (auto); non-zero = user-chosen px value.
  const [transcriptFontSize, setTranscriptFontSize] = useState(0);
  const [externalFontSize, setExternalFontSize] = useState(0);
  const [models, setModels] = useState<ModelsInfo | null>(null);
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
    getModels()
      .then((m) => alive && setModels(m))
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
        setOptimizeModel(c.optimizeModel ?? '');
        setClaudeBin(c.claudeBin ?? '');
        setOptimizeBackend(c.optimizeBackend ?? 'mlx');
        setMlxModel(c.mlxModel ?? '');
        setTranscriptFontSize(c.transcriptFontSize ?? 0);
        setExternalFontSize(c.externalFontSize ?? 0);
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
      const saved = await saveConfig({
        launchCommand,
        defaultCwd,
        optimizeModel,
        claudeBin,
        optimizeBackend,
        mlxModel,
        transcriptFontSize,
        externalFontSize,
      });
      setLaunchCommand(saved.launchCommand);
      setDefaultCwd(saved.defaultCwd);
      setOptimizeModel(saved.optimizeModel ?? '');
      setClaudeBin(saved.claudeBin ?? '');
      setOptimizeBackend(saved.optimizeBackend ?? 'mlx');
      setMlxModel(saved.mlxModel ?? '');
      setTranscriptFontSize(saved.transcriptFontSize ?? 0);
      setExternalFontSize(saved.externalFontSize ?? 0);
      // If the MLX model isn't downloaded yet, the server fetches it in the
      // background — tell the user the enhancer falls back to claude meanwhile.
      const chosen = models?.mlxModels.find((m) => m.id === saved.mlxModel);
      if (saved.optimizeBackend === 'mlx' && chosen && chosen.installed === false) {
        onToast(`Downloading ${chosen.label} (${chosen.sizeGB} GB)… enhancer uses claude until ready`, 'ok');
      } else {
        onToast('Config saved', 'ok');
      }
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
      ref={rootRef}
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

        <div className="config-body">
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
            <span className="config-hint">Run in each new session's pane.</span>
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
            <span className="config-hint">Existing dir new sessions start in.</span>
          </label>

          <label className="config-field">
            <span className="config-label">Enhancer backend</span>
            <select
              className="config-input"
              value={optimizeBackend}
              disabled={loading}
              onChange={(e) => setOptimizeBackend(e.target.value as OptimizeBackend)}
            >
              <option value="mlx">Local MLX (→ rules)</option>
              <option value="rules">Rules only (offline)</option>
            </select>
            <span className="config-hint">
              Powers ✨. <code>mlx</code> = on-device, no key. (<code>claude -p</code>
              is disabled — it spawned transcripts that corrupted session matching.)
            </span>
          </label>

          <label className="config-field">
            <span className="config-label">Claude model</span>
            <select
              className="config-input"
              value={optimizeModel}
              disabled={loading}
              onChange={(e) => setOptimizeModel(e.target.value)}
            >
              {optimizeModel && !models?.claudeModels.some((m) => m.id === optimizeModel) ? (
                <option value={optimizeModel}>{optimizeModel}{models ? ' (custom)' : ''}</option>
              ) : null}
              {(models?.claudeModels ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.id === models?.recommendedClaudeModel ? ' · recommended' : ''}
                </option>
              ))}
            </select>
            <span className="config-hint">
              For the <code>claude -p</code> backend/fallback.
            </span>
          </label>

          <label className="config-field config-field--wide">
            <span className="config-label">MLX model</span>
            <select
              className="config-input"
              value={mlxModel}
              disabled={loading || optimizeBackend !== 'mlx'}
              onChange={(e) => setMlxModel(e.target.value)}
            >
              {mlxModel && !models?.mlxModels.some((m) => m.id === mlxModel) ? (
                <option value={mlxModel}>{mlxModel}{models ? ' (custom)' : ''}</option>
              ) : null}
              {(models?.mlxModels ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.sizeGB} GB
                  {m.installed ? ' · downloaded' : ' · ⬇ download'}
                  {m.id === models?.recommendedMlxModel ? ' · recommended' : ''}
                  {models && m.minRamGB > models.machine.ramGB ? ` (needs ≥${m.minRamGB} GB)` : ''}
                </option>
              ))}
            </select>
            <span className="config-hint">
              {models
                ? `Your ${models.machine.appleSilicon ? 'Apple Silicon ' : ''}Mac has ${models.machine.ramGB} GB — recommended: ${
                    models.mlxModels.find((m) => m.id === models.recommendedMlxModel)?.label ??
                    models.recommendedMlxModel
                  }. Auto-downloads on first use.`
                : 'On-device model for the ✨ enhancer. Auto-downloads on first use.'}
            </span>
          </label>

          <label className="config-field">
            <span className="config-label">Transcript font size</span>
            <select
              className="config-input"
              value={transcriptFontSize}
              disabled={loading}
              onChange={(e) => setTranscriptFontSize(Number(e.target.value))}
            >
              <option value={0}>Default (auto)</option>
              {[12, 13, 14, 15, 16, 17, 18].map((px) => (
                <option key={px} value={px}>{px}px</option>
              ))}
            </select>
            <span className="config-hint">
              Base transcript size (iPad + desktop). Default uses the built-in CSS token.
            </span>
          </label>

          <label className="config-field">
            <span className="config-label">External display font size</span>
            <select
              className="config-input"
              value={externalFontSize}
              disabled={loading}
              onChange={(e) => setExternalFontSize(Number(e.target.value))}
            >
              <option value={0}>Default (auto)</option>
              {[12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].map((px) => (
                <option key={px} value={px}>{px}px</option>
              ))}
            </select>
            <span className="config-hint">
              Applies only when iPad drives an external monitor. Overrides base size on that display.
            </span>
          </label>

          <label className="config-field config-field--wide">
            <span className="config-label">Claude CLI path (optional)</span>
            <input
              className="config-input"
              type="text"
              placeholder="auto-detected"
              value={claudeBin}
              disabled={loading}
              onChange={(e) => setClaudeBin(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <span className="config-hint">
              Path to the <code>claude</code> binary. Blank = auto-detect.
            </span>
          </label>

          <div className="config-field config-field--wide">
            <span className="config-label">App icon</span>
            <div className="config-icon-row">
              <img
                className="config-icon-preview"
                src={`/api/icon?size=192&t=${iconBust}`}
                alt="Current home-screen icon"
                width={44}
                height={44}
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
              Defaults to the Claude Control logo. Re-add to Home Screen after changing.
            </span>
          </div>
        </div>

        <div className="config-foot">
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
    </div>
  );
}
