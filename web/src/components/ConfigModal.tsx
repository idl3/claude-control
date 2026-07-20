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
import type { OrgHealth } from '../lib/types';
import { loadFontSize, saveFontSize } from '../lib/fontSizePrefs';
import { loadCosmosPref, saveCosmosPref } from '../lib/cosmosPrefs';
import {
  loadRailTokens,
  saveRailTokens,
  DEFAULT_RAIL_TOKENS,
  DEFAULT_RAIL_INTERVAL_MS,
  type RailToken,
} from '../lib/railTokenPrefs';
import { TypeIcon, TerminalSquareIcon, CloudIcon } from './icons';
import { RailTokenConfig } from './RailTokenConfig';

interface ConfigModalProps {
  onClose: () => void;
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
  /** Section to land on when the modal opens — e.g. the rail's cloud tabs
   *  route an unconfigured-org tap straight to 'olam'. Defaults to 'general'. */
  initialSection?: SectionId;
}

// Section-nav icons not already in ./icons.tsx. Kept local (rather than added
// to the shared icon file) since this component is the only caller — same
// 24-grid lucide-style stroke as ./icons.tsx's `Svg` wrapper, matching the
// lucide "mic" and "folder" glyphs exactly.
function MicNavIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function FolderNavIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

// Lucide "repeat" glyph — represents the rail's rotating meta tokens.
function RepeatNavIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

export type SectionId = 'general' | 'harness' | 'voice' | 'session' | 'railtokens' | 'olam';

const SECTIONS: { id: SectionId; label: string; Icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'general', label: 'General', Icon: TypeIcon },
  { id: 'harness', label: 'Harness', Icon: TerminalSquareIcon },
  { id: 'voice', label: 'Voice Control', Icon: MicNavIcon },
  { id: 'session', label: 'Session Defaults', Icon: FolderNavIcon },
  { id: 'railtokens', label: 'Rail tokens', Icon: RepeatNavIcon },
  { id: 'olam', label: 'Olam cloud', Icon: CloudIcon },
];

interface GeneralSectionProps {
  transcriptFontSize: number;
  setTranscriptFontSize: (n: number) => void;
  externalFontSize: number;
  setExternalFontSize: (n: number) => void;
  cosmosBackground: boolean;
  setCosmosBackground: (b: boolean) => void;
  cosmosParallax: boolean;
  setCosmosParallax: (b: boolean) => void;
  cosmosShootingStars: boolean;
  setCosmosShootingStars: (b: boolean) => void;
  loading: boolean;
  iconBust: number;
  iconBusy: boolean;
  iconInputRef: React.RefObject<HTMLInputElement | null>;
  onPickIcon: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onResetIcon: () => void;
}

/** Display/appearance: font sizes (with a live preview), app icon, cosmos backdrop toggles. */
function GeneralSection({
  transcriptFontSize,
  setTranscriptFontSize,
  externalFontSize,
  setExternalFontSize,
  cosmosBackground,
  setCosmosBackground,
  cosmosParallax,
  setCosmosParallax,
  cosmosShootingStars,
  setCosmosShootingStars,
  loading,
  iconBust,
  iconBusy,
  iconInputRef,
  onPickIcon,
  onResetIcon,
}: GeneralSectionProps) {
  return (
    <>
      <h2 className="config-section-heading">General</h2>
      <div className="config-body">
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

        {/* Presentational only — no persisted field. Resizes immediately as the
            transcript font size above changes, before Save. */}
        <div className="config-field config-field--wide">
          <span className="config-label">Live preview</span>
          <div className="config-preview" aria-hidden="true">
            <div
              className="config-preview-msg"
              style={{ fontSize: transcriptFontSize ? `${transcriptFontSize}px` : undefined }}
            >
              <div className="config-preview-row config-preview-row--user">
                You: Can you restyle the settings modal?
              </div>
              <div className="config-preview-row">
                Sure — two-pane nav now, matches the cosmic theme.
              </div>
              <div className="config-preview-meta">Claude Code · just now</div>
            </div>
          </div>
          <span className="config-hint">
            Sample transcript at the size above — updates instantly, no need to save first.
          </span>
        </div>

        <label className="config-checkbox-field">
          <input
            type="checkbox"
            checked={cosmosBackground}
            disabled={loading}
            onChange={(e) => setCosmosBackground(e.target.checked)}
          />
          <span className="config-checkbox-text">
            <span className="config-label">Background cosmos</span>
            <span className="config-hint">Starfield/nebula backdrop. Off shows a flat dark background.</span>
          </span>
        </label>
        <label className="config-checkbox-field">
          <input
            type="checkbox"
            checked={cosmosParallax}
            disabled={loading}
            onChange={(e) => setCosmosParallax(e.target.checked)}
          />
          <span className="config-checkbox-text">
            <span className="config-label">Parallax scrolling</span>
            <span className="config-hint">Star planes shift depth while you scroll. Off keeps the backdrop still on scroll.</span>
          </span>
        </label>
        <label className="config-checkbox-field">
          <input
            type="checkbox"
            checked={cosmosShootingStars}
            disabled={loading}
            onChange={(e) => setCosmosShootingStars(e.target.checked)}
          />
          <span className="config-checkbox-text">
            <span className="config-label">Shooting stars</span>
            <span className="config-hint">A rare ambient streak, plus one whenever an agent finishes a turn.</span>
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
    </>
  );
}

interface HarnessSectionProps {
  launchCommand: string;
  setLaunchCommand: (s: string) => void;
  claudeBin: string;
  setClaudeBin: (s: string) => void;
  codexLaunchCommand: string;
  setCodexLaunchCommand: (s: string) => void;
  codexBin: string;
  setCodexBin: (s: string) => void;
  skipPermissions: boolean;
  setSkipPermissions: (b: boolean) => void;
  loading: boolean;
}

/** Agent CLIs: Claude Code + Codex launch config, plus an OpenCode placeholder. */
function HarnessSection({
  launchCommand,
  setLaunchCommand,
  claudeBin,
  setClaudeBin,
  codexLaunchCommand,
  setCodexLaunchCommand,
  codexBin,
  setCodexBin,
  skipPermissions,
  setSkipPermissions,
  loading,
}: HarnessSectionProps) {
  return (
    <>
      <h2 className="config-section-heading">Harness</h2>
      <div className="config-body">
        <label className="config-checkbox-field">
          <input
            type="checkbox"
            checked={skipPermissions}
            disabled={loading}
            onChange={(e) => setSkipPermissions(e.target.checked)}
          />
          <span className="config-checkbox-text">
            <span className="config-label">Skip permission prompts (launch with full permissions)</span>
            <span className="config-hint">
              New sessions launch with approval prompting bypassed (Claude:{' '}
              <code>--dangerously-skip-permissions</code>; Codex:{' '}
              <code>--dangerously-bypass-approvals-and-sandbox</code>). Turn off to get prompted
              per action.
            </span>
          </span>
        </label>
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

        {/* Presentational placeholder — no state, not wired, leaves room for a
            future third harness. */}
        <div className="config-agent-group" data-disabled="true">
          <div className="config-agent-group-head">
            <span className="config-agent-group-title">OpenCode</span>
            <span className="config-agent-group-badge">Coming soon</span>
          </div>
          <label className="config-field">
            <span className="config-label">Command to run</span>
            <input
              className="config-input"
              type="text"
              placeholder="opencode"
              disabled
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="config-field config-field--wide">
            <span className="config-label">CLI path (optional)</span>
            <input
              className="config-input"
              type="text"
              placeholder="auto-detected"
              disabled
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <span className="config-hint config-field--wide">OpenCode support is planned.</span>
        </div>
      </div>
    </>
  );
}

interface VoiceSectionProps {
  optimizeBackend: OptimizeBackend;
  setOptimizeBackend: (b: OptimizeBackend) => void;
  optimizeModel: string;
  setOptimizeModel: (s: string) => void;
  mlxModel: string;
  setMlxModel: (s: string) => void;
  loading: boolean;
  models: ModelsInfo | null;
}

/** Prompt-enhancer (✨) backend + models. */
function VoiceSection({
  optimizeBackend,
  setOptimizeBackend,
  optimizeModel,
  setOptimizeModel,
  mlxModel,
  setMlxModel,
  loading,
  models,
}: VoiceSectionProps) {
  return (
    <>
      <h2 className="config-section-heading">Voice Control</h2>
      <div className="config-body">
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
      </div>
    </>
  );
}

interface SessionSectionProps {
  defaultCwd: string;
  setDefaultCwd: (s: string) => void;
  projectDirs: { label: string; path: string }[];
  setProjectDirs: (d: { label: string; path: string }[]) => void;
  loading: boolean;
}

/** Default cwd + preconfigured project directories for New Session. */
function SessionSection({
  defaultCwd,
  setDefaultCwd,
  projectDirs,
  setProjectDirs,
  loading,
}: SessionSectionProps) {
  return (
    <>
      <h2 className="config-section-heading">Session Defaults</h2>
      <div className="config-body">
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
      </div>
    </>
  );
}

/**
 * Guidance + status for the rail's cloud tabs (docs/plans/cloud-local-tabs).
 * This is deliberately NOT a disk editor — olam.json (per-org runner URL,
 * SPA base, and secret-lookup config) is operator-edited on disk, since it
 * declares where org bearer tokens live. This panel only explains the
 * shape, shows what's currently configured, and surfaces LIVE health per
 * org (green/red + reason + the exact re-auth command) — read-only, no
 * secret values are ever rendered here, from the same GET /api/config
 * payload the rail tabs use (server.js's olamOrgs + olamHealth fields).
 */
function OlamSection({
  olamOrgs,
  olamHealth,
}: {
  olamOrgs: { org: string; spaBase: string | null }[];
  olamHealth: Record<string, OrgHealth>;
}) {
  return (
    <>
      <h2 className="config-section-heading">Olam cloud</h2>
      <div className="config-body">
        <div className="config-field config-field--wide">
          <span className="config-label">Configured clusters</span>
          {olamOrgs.length === 0 ? (
            <span className="config-hint config-field--wide">
              No Olam cloud clusters configured yet. Add an <code>orgs</code> entry to{' '}
              <code>olam.json</code> in the cockpit's data dir (
              <code>~/.claude-control/olam.json</code> by default, or the{' '}
              <code>CLAUDE_CONTROL_DATA</code>/<code>COCKPIT_DATA</code> dir when set) — each
              entry needs an <code>org</code> slug, an https <code>runnerUrl</code>, and an
              https <code>spaBase</code>; <code>brainUrl</code> is optional. Restart the
              cockpit after editing. Once configured, that cluster's Olam SPA sessions get
              their own tab in the rail above the "+ New session" bar.
            </span>
          ) : (
            <ul className="config-olam-orgs">
              {olamOrgs.map((o) => {
                const health = olamHealth[o.org] ?? { status: 'unknown' as const, reason: null };
                return (
                  <li key={o.org} className="config-olam-org-row">
                    <div className="config-olam-org-row-head">
                      <span
                        className={`remote-health remote-health-${health.status}`}
                        title={health.reason ?? health.status}
                        aria-label={`org ${o.org} health ${health.status}`}
                      />
                      <CloudIcon size={14} />
                      <span className="config-olam-org-name">{o.org}</span>
                      {o.spaBase ? (
                        <a
                          href={o.spaBase}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="config-olam-org-spa"
                        >
                          {o.spaBase}
                        </a>
                      ) : null}
                    </div>
                    {/* health.reason already spells out the exact fix (e.g. "Access
                        session expired — run: cloudflared access login <spaBase>")
                        when unhealthy — read-only, never a credential value. */}
                    {health.reason ? (
                      <div className="config-hint config-olam-org-reason" role="note">
                        {health.reason}
                      </div>
                    ) : null}
                    {health.capped ? (
                      <div className="config-hint config-olam-org-capped">
                        Session count may be a lower bound — this org hit the fetch page limit.
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <span className="config-hint">
            Cloud tabs are personalizable — double-click the active tab's label in the rail
            to rename it (device-local; doesn't change the org slug used for filtering).
          </span>
        </div>
      </div>
    </>
  );
}

/**
 * Settings modal: edit the launch command (run in each new session's pane) and
 * the default cwd. Loads current config on open; Save validates server-side and
 * toasts the result. Small, keyboard-dismissable, matches the app's dark tokens.
 *
 * Two-pane layout (left nav + right content, mirroring the Claude.ai settings
 * modal): fields are grouped into General / Harness / Voice Control / Session
 * Defaults sections purely for navigation — ALL fields still live in one shared
 * form state and Save always sends the complete payload, across every section,
 * in a single request (see `save()` below).
 */
export function ConfigModal({ onClose: rawClose, onToast, initialSection }: ConfigModalProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? 'general');
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
  // Device-local only (no server counterpart) — loaded straight from
  // localStorage below, not from getConfig(). See lib/cosmosPrefs.ts.
  const [cosmosBackground, setCosmosBackground] = useState(true);
  const [cosmosParallax, setCosmosParallax] = useState(true);
  const [cosmosShootingStars, setCosmosShootingStars] = useState(true);
  // Session-rail meta-slot token order — same device-local, no-server-
  // counterpart shape as the cosmos toggles above. See lib/railTokenPrefs.ts.
  const [railTokens, setRailTokens] = useState<RailToken[]>(DEFAULT_RAIL_TOKENS);
  const [railIntervalMs, setRailIntervalMs] = useState<number>(DEFAULT_RAIL_INTERVAL_MS);
  const [projectDirs, setProjectDirs] = useState<{ label: string; path: string }[]>([]);
  const [skipPermissions, setSkipPermissions] = useState(true);
  const [restartSupported, setRestartSupported] = useState(false);
  // Configured Olam cloud clusters, for the 'olam' section's status list —
  // same payload the rail's cloud tabs are built from (App.tsx).
  const [olamOrgs, setOlamOrgs] = useState<{ org: string; spaBase: string | null }[]>([]);
  // Live per-org health (server.js olamOrgHealth() — row-independent, works
  // even before any session has ever been fetched for that org). Keyed by
  // org slug; absent entries render as 'unknown'.
  const [olamHealth, setOlamHealth] = useState<Record<string, OrgHealth>>({});
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

  // Cosmos toggles have no server counterpart — load once from this
  // device's localStorage (see lib/cosmosPrefs.ts).
  useEffect(() => {
    setCosmosBackground(loadCosmosPref('background'));
    setCosmosParallax(loadCosmosPref('parallax'));
    setCosmosShootingStars(loadCosmosPref('shootingStars'));
    const railPrefs = loadRailTokens();
    setRailTokens(railPrefs.tokens);
    setRailIntervalMs(railPrefs.intervalMs);
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
        // This device's localStorage override wins over the shared server
        // value, so Settings shows (and Save round-trips) what's actually
        // applied here — see lib/fontSizePrefs.ts.
        setTranscriptFontSize(loadFontSize('transcript') ?? c.transcriptFontSize ?? 0);
        setExternalFontSize(loadFontSize('external') ?? c.externalFontSize ?? 0);
        setProjectDirs(c.projectDirs ?? []);
        setSkipPermissions(c.skipPermissions ?? true);
        setRestartSupported(c.restartSupported ?? false);
        setOlamOrgs(c.olamOrgs ?? []);
        setOlamHealth(c.olamHealth ?? {});
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

  // Single save for every section: the form state is shared across all four
  // panes, so this always sends the complete payload — there is no per-section
  // save. Switching `activeSection` only changes what's visible, never what's
  // included here.
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
        skipPermissions,
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
      setSkipPermissions(saved.skipPermissions ?? true);
      // Server write above is the cross-device fallback default; this device's
      // own preference lives in localStorage so it survives independent of
      // what other devices later save (see lib/fontSizePrefs.ts).
      saveFontSize('transcript', saved.transcriptFontSize ?? 0);
      saveFontSize('external', saved.externalFontSize ?? 0);
      // Apply the new font size LIVE (no reload): App's font effect listens.
      window.dispatchEvent(
        new CustomEvent('cockpit:fontsize', {
          detail: {
            transcriptFontSize: saved.transcriptFontSize ?? 0,
            externalFontSize: saved.externalFontSize ?? 0,
          },
        }),
      );
      // Cosmos toggles are device-local only — persist directly (no server
      // round-trip) and apply LIVE the same way as font size.
      saveCosmosPref('background', cosmosBackground);
      saveCosmosPref('parallax', cosmosParallax);
      saveCosmosPref('shootingStars', cosmosShootingStars);
      window.dispatchEvent(
        new CustomEvent('cockpit:cosmosprefs', {
          detail: { cosmosBackground, cosmosParallax, cosmosShootingStars },
        }),
      );
      // Rail-token order is device-local only too — persist + apply LIVE the
      // same way. SessionRail owns the load + listener (see its mount effect).
      saveRailTokens({ tokens: railTokens, intervalMs: railIntervalMs });
      window.dispatchEvent(
        new CustomEvent('cockpit:railtokenprefs', { detail: { railTokens, intervalMs: railIntervalMs } }),
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

        <div className="config-panes">
          <nav className="config-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className="config-nav-item"
                aria-current={activeSection === s.id ? 'page' : undefined}
                onClick={() => setActiveSection(s.id)}
              >
                <s.Icon size={16} />
                <span>{s.label}</span>
              </button>
            ))}
          </nav>

          <div className="config-content">
            {activeSection === 'general' ? (
              <GeneralSection
                transcriptFontSize={transcriptFontSize}
                setTranscriptFontSize={setTranscriptFontSize}
                externalFontSize={externalFontSize}
                setExternalFontSize={setExternalFontSize}
                cosmosBackground={cosmosBackground}
                setCosmosBackground={setCosmosBackground}
                cosmosParallax={cosmosParallax}
                setCosmosParallax={setCosmosParallax}
                cosmosShootingStars={cosmosShootingStars}
                setCosmosShootingStars={setCosmosShootingStars}
                loading={loading}
                iconBust={iconBust}
                iconBusy={iconBusy}
                iconInputRef={iconInputRef}
                onPickIcon={onPickIcon}
                onResetIcon={onResetIcon}
              />
            ) : null}
            {activeSection === 'harness' ? (
              <HarnessSection
                launchCommand={launchCommand}
                setLaunchCommand={setLaunchCommand}
                claudeBin={claudeBin}
                setClaudeBin={setClaudeBin}
                codexLaunchCommand={codexLaunchCommand}
                setCodexLaunchCommand={setCodexLaunchCommand}
                codexBin={codexBin}
                setCodexBin={setCodexBin}
                skipPermissions={skipPermissions}
                setSkipPermissions={setSkipPermissions}
                loading={loading}
              />
            ) : null}
            {activeSection === 'voice' ? (
              <VoiceSection
                optimizeBackend={optimizeBackend}
                setOptimizeBackend={setOptimizeBackend}
                optimizeModel={optimizeModel}
                setOptimizeModel={setOptimizeModel}
                mlxModel={mlxModel}
                setMlxModel={setMlxModel}
                loading={loading}
                models={models}
              />
            ) : null}
            {activeSection === 'session' ? (
              <SessionSection
                defaultCwd={defaultCwd}
                setDefaultCwd={setDefaultCwd}
                projectDirs={projectDirs}
                setProjectDirs={setProjectDirs}
                loading={loading}
              />
            ) : null}
            {activeSection === 'railtokens' ? (
              <RailTokenConfig
                railTokens={railTokens}
                setRailTokens={setRailTokens}
                intervalMs={railIntervalMs}
                setIntervalMs={setRailIntervalMs}
              />
            ) : null}
            {activeSection === 'olam' ? (
              <OlamSection olamOrgs={olamOrgs} olamHealth={olamHealth} />
            ) : null}
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
