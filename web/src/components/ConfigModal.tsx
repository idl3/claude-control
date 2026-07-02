import { useEffect, useRef, useState } from 'react';
import { useModalTransition } from '../lib/anim';
import {
  getConfig,
  saveConfig,
  getVersion,
  getModels,
  uploadIcon,
  resetIcon,
  restartService,
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
  const [claudeBin, setClaudeBin] = useState('');
  const [codexLaunchCommand, setCodexLaunchCommand] = useState('');
  const [codexBin, setCodexBin] = useState('');
  const [defaultCwd, setDefaultCwd] = useState('');
  const [optimizeModel, setOptimizeModel] = useState('');
  const [optimizeBackend, setOptimizeBackend] = useState<OptimizeBackend>('mlx');
  const [mlxModel, setMlxModel] = useState('');
  // 0 = CSS default (auto); non-zero = user-chosen px value.
  const [transcriptFontSize, setTranscriptFontSize] = useState(0);
  const [externalFontSize, setExternalFontSize] = useState(0);
  const [projectDirs, setProjectDirs] = useState<{ label: string; path: string }[]>([]);
  const [restartSupported, setRestartSupported] = useState(false);
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restartConfirming, setRestartConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [version, setVersion] = useState<{
    current: string;
    root?: string;
    branch?: string | null;
    commit?: string | null;
    dirty?: boolean | null;
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
        setClaudeBin(c.claudeBin ?? '');
        setCodexLaunchCommand(c.codexLaunchCommand ?? 'codex');
        setCodexBin(c.codexBin ?? '');
        setDefaultCwd(c.defaultCwd);
        setOptimizeModel(c.optimizeModel ?? '');
        setOptimizeBackend(c.optimizeBackend ?? 'mlx');
        setMlxModel(c.mlxModel ?? '');
        setTranscriptFontSize(c.transcriptFontSize ?? 0);
        setExternalFontSize(c.externalFontSize ?? 0);
        setProjectDirs(c.projectDirs ?? []);
        setRestartSupported(c.restartSupported ?? false);
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
        claudeBin,
        codexLaunchCommand,
        codexBin,
        defaultCwd,
        optimizeModel,
        optimizeBackend,
        mlxModel,
        transcriptFontSize,
        externalFontSize,
        projectDirs,
      });
      setLaunchCommand(saved.launchCommand);
      setClaudeBin(saved.claudeBin ?? '');
      setCodexLaunchCommand(saved.codexLaunchCommand ?? 'codex');
      setCodexBin(saved.codexBin ?? '');
      setDefaultCwd(saved.defaultCwd);
      setOptimizeModel(saved.optimizeModel ?? '');
      setOptimizeBackend(saved.optimizeBackend ?? 'mlx');
      setMlxModel(saved.mlxModel ?? '');
      setTranscriptFontSize(saved.transcriptFontSize ?? 0);
      setExternalFontSize(saved.externalFontSize ?? 0);
      setProjectDirs(saved.projectDirs ?? []);
      // Apply the new font size LIVE (no reload): App's font effect listens.
      window.dispatchEvent(
        new CustomEvent('cockpit:fontsize', {
          detail: {
            transcriptFontSize: saved.transcriptFontSize ?? 0,
            externalFontSize: saved.externalFontSize ?? 0,
          },
        }),
      );
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

  const onRestartClick = () => {
    if (!restartConfirming) {
      setRestartConfirming(true);
      return;
    }
    setRestartConfirming(false);
    setRestarting(true);
    onToast('Restarting… the app will reconnect automatically', 'ok');
    restartService()
      .then((result) => {
        if (!result.ok) {
          setRestarting(false);
          onToast(`Restart failed: ${result.message ?? 'unknown error'}`, 'error');
        }
        // On success the process exits and the WS client's own reconnect-with-
        // backoff (see lib/ws.ts) recovers the UI — no polling needed here.
      })
      .catch((err) => {
        setRestarting(false);
        onToast(`Restart failed: ${(err as Error).message}`, 'error');
      });
  };

  const versionMeta = version
    ? [
        version.branch && version.commit
          ? `${version.branch}@${version.commit}`
          : version.commit || null,
        version.dirty === true ? 'dirty' : version.dirty === false ? 'clean' : null,
        version.root || null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

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
          {/* ── CLI section ─────────────────────────────────────────── */}
          <div className="config-section-label">CLI</div>

          {/* Claude Code group */}
          <div className="config-agent-group">
            <span className="config-agent-group-title">Claude Code</span>
            <label className="config-field">
              <span className="config-label">Command to run</span>
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
                What gets typed to launch the agent — may be a shell alias (e.g.{' '}
                <code>yolo</code>).
              </span>
            </label>
            <label className="config-field config-field--wide">
              <span className="config-label">CLI path (optional)</span>
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
                Optional absolute path to the binary for availability checks; blank = resolve from PATH.
              </span>
            </label>
          </div>

          {/* Codex group */}
          <div className="config-agent-group">
            <span className="config-agent-group-title">Codex</span>
            <label className="config-field">
              <span className="config-label">Command to run</span>
              <input
                className="config-input"
                type="text"
                placeholder="codex"
                value={codexLaunchCommand}
                disabled={loading}
                onChange={(e) => setCodexLaunchCommand(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <span className="config-hint">
                What gets typed to launch Codex — may be a shell alias (e.g.{' '}
                <code>yodex</code>). RPC mode appends <code>app-server --listen</code>.
              </span>
            </label>
            <label className="config-field config-field--wide">
              <span className="config-label">CLI path (optional)</span>
              <input
                className="config-input"
                type="text"
                placeholder="auto-detected"
                value={codexBin}
                disabled={loading}
                onChange={(e) => setCodexBin(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <span className="config-hint">
                Optional absolute path to the binary for availability checks; blank = resolve from PATH.
              </span>
            </label>
          </div>

          {/* ── Session section ──────────────────────────────────────── */}
          <div className="config-section-label">Session</div>

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

          <div className="config-field config-field--wide">
            <span className="config-label">Project directories</span>
            <div className="config-proj-dirs">
              {projectDirs.map((entry, i) => (
                <div key={i} className="config-proj-dir-row">
                  <input
                    className="config-input config-proj-dir-label"
                    type="text"
                    value={entry.label}
                    placeholder="Label"
                    disabled={loading}
                    onChange={(e) => {
                      const next = projectDirs.map((d, j) =>
                        j === i ? { ...d, label: e.target.value } : d,
                      );
                      setProjectDirs(next);
                    }}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label={`Project directory ${i + 1} label`}
                  />
                  <input
                    className="config-input config-proj-dir-path"
                    type="text"
                    value={entry.path}
                    placeholder="~/Projects/my-project"
                    disabled={loading}
                    onChange={(e) => {
                      const next = projectDirs.map((d, j) =>
                        j === i ? { ...d, path: e.target.value } : d,
                      );
                      setProjectDirs(next);
                    }}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label={`Project directory ${i + 1} path`}
                  />
                  <button
                    type="button"
                    className="config-proj-dir-remove"
                    disabled={loading}
                    aria-label={`Remove ${entry.label || 'project directory'}`}
                    onClick={() => setProjectDirs(projectDirs.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="config-cancel config-proj-dir-add"
                disabled={loading}
                onClick={() => setProjectDirs([...projectDirs, { label: '', path: '' }])}
              >
                + Add directory
              </button>
            </div>
            <span className="config-hint">
              Shown as a dropdown in New Session. Label = short name; path supports{' '}
              <code>~</code>. Custom… option always available for free-text entry.
            </span>
          </div>

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
              Base UI text size — scales the whole interface (transcript, meta, composer).
              Default uses the built-in CSS token.
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
              Applies only on a large external display (≥2K / ≥2000px wide), never on the
              iPad's own screen. Overrides the base size there.
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
              {versionMeta ? (
                <span className="config-version-copy" title={version.root || undefined}>
                  {versionMeta}
                </span>
              ) : null}
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
            className="config-restart"
            title={
              restartSupported
                ? undefined
                : 'Run cockpit as a service (launchd/pm2) to enable restart'
            }
            onClick={onRestartClick}
            onBlur={() => setRestartConfirming(false)}
            disabled={!restartSupported || loading || saving || restarting}
          >
            {restarting ? 'Restarting…' : restartConfirming ? 'Confirm restart?' : 'Restart service'}
          </button>
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
