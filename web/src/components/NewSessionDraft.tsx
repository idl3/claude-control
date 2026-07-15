import { useCallback, useEffect, useRef, useState } from 'react';
import { createSession, fetchSpawnAgents, fetchTmuxSessions, getConfig } from '../lib/api';
import type { CreateSessionResult, SpawnAgentInfo, TmuxSessionSummary } from '../lib/api';
import {
  defaultAgentForFilter,
  defaultName,
  normalizeClaudeTransport,
  normalizeCodexTransport,
  type ClaudeTransport,
  type CodexTransport,
} from './NewSessionForm';
import type { SessionFilter } from './SessionRail';

/** Claude model picker value. 'default' omits --model (agent's own default). */
export type ClaudeModel = 'default' | 'opus' | 'sonnet' | 'haiku';

interface NewSessionDraftProps {
  /** Rail filter at the time the draft was opened — seeds the default agent. */
  filter: SessionFilter;
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
  /** Esc / Cancel — discard the draft and return to the previous view. */
  onCancel: () => void;
  /** Session created successfully — caller selects it (lands in its transcript). */
  onCreated: (result: CreateSessionResult) => void;
}

const MODEL_OPTIONS: { id: ClaudeModel; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

/** Sentinel value for the tmux-session <select>'s "New tmux session…" option. */
const NEW_TMUX_SESSION = '__new__';

/**
 * New-chat draft screen, shown in the main content area in place of the
 * transcript. Carries the same agent/transport/name/cwd pickers the old
 * inline rail form had (logic moved here verbatim), plus a Claude-only model
 * picker and a composer-styled multi-line prompt textarea. Submitting creates
 * the session WITH the prompt atomically — the server either types the
 * prompt into the launch command (tmux transports) or submits it over the
 * print/RPC socket once the agent is ready, rather than the old
 * create-then-type-into-the-pane flow.
 *
 * Does NOT reuse Composer.tsx's send logic — that's coupled to a live
 * session's assistant-ui runtime. This is a plain controlled textarea styled
 * with the same `.composer-card` / `.composer-input` CSS classes.
 */
export function NewSessionDraft({ filter, onToast, onCancel, onCreated }: NewSessionDraftProps) {
  const [agent, setAgent] = useState<'claude' | 'codex'>(() => defaultAgentForFilter(filter));
  const [claudeTransport, setClaudeTransport] = useState<ClaudeTransport>('tmux');
  const [codexTransport, setCodexTransport] = useState<CodexTransport>('rpc');
  const [model, setModel] = useState<ClaudeModel>('default');
  const [name, setName] = useState('');
  const [placeholder] = useState(defaultName);
  // Selected value in the project-dir dropdown: a path string, or '' to use
  // defaultCwd, or the sentinel 'custom' to show the free-text input.
  const [cwdChoice, setCwdChoice] = useState('');
  const [cwdCustom, setCwdCustom] = useState('');
  // Selected value in the tmux-session dropdown: an existing session name, or
  // '' to use today's default (first existing session / bootstrap), or the
  // NEW_TMUX_SESSION sentinel to show the new-session-name input.
  const [tmuxChoice, setTmuxChoice] = useState('');
  const [newTmuxSessionName, setNewTmuxSessionName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [agentInfos, setAgentInfos] = useState<SpawnAgentInfo[]>([]);
  const [defaultCwd, setDefaultCwd] = useState('~');
  const [projectDirs, setProjectDirs] = useState<{ label: string; path: string }[]>([]);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Fetch agent availability + config once on mount, and focus the composer
  // so the user can start typing the prompt immediately.
  useEffect(() => {
    fetchSpawnAgents()
      .then((infos) => {
        setAgentInfos(infos);
        setClaudeTransport(normalizeClaudeTransport(infos.find((info) => info.id === 'claude')?.defaultTransport));
        setCodexTransport(normalizeCodexTransport(infos.find((info) => info.id === 'codex')?.defaultTransport));
      })
      .catch(() => {
        // Non-fatal: form still works, agents just won't show disabled state.
      });
    getConfig()
      .then((cfg) => {
        setDefaultCwd(cfg.defaultCwd || '~');
        setProjectDirs(cfg.projectDirs ?? []);
      })
      .catch(() => {
        // Non-fatal: placeholder falls back to '~'.
      });
    fetchTmuxSessions()
      .then((sessions) => setTmuxSessions(sessions))
      .catch(() => {
        // Non-fatal: the picker still offers "(default)" + "New tmux session…".
      });
    promptRef.current?.focus();
  }, []);

  const submit = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    // Required-with-default: blank name field falls back to the shown placeholder.
    const resolvedName = agent === 'codex' ? undefined : (name.trim() || placeholder);
    // Resolve the effective cwd: '' = use server default; 'custom' = free-text;
    // otherwise the path from the selected dropdown option.
    const resolvedCwd =
      cwdChoice === 'custom'
        ? cwdCustom.trim() || undefined
        : cwdChoice || undefined;
    // tmux target: '' = today's default (send neither field); an existing
    // session name = host in that session; NEW_TMUX_SESSION sentinel = create
    // a fresh session with the typed name.
    const resolvedTmuxSession =
      tmuxChoice && tmuxChoice !== NEW_TMUX_SESSION ? tmuxChoice : undefined;
    const resolvedNewTmuxSession =
      tmuxChoice === NEW_TMUX_SESSION ? newTmuxSessionName.trim() || undefined : undefined;
    onToast('Creating session…');
    try {
      const result = await createSession({
        name: resolvedName,
        cwd: resolvedCwd,
        agent,
        claudeTransport: agent === 'claude' ? claudeTransport : undefined,
        codexTransport: agent === 'codex' ? codexTransport : undefined,
        model: agent === 'claude' && model !== 'default' ? model : undefined,
        prompt: prompt.trim() || undefined,
        tmuxSession: resolvedTmuxSession,
        newTmuxSession: resolvedNewTmuxSession,
      });
      onToast(`Session created → ${result.name}`, 'ok');
      onCreated(result);
    } catch (err) {
      // Keep the draft screen open (with the typed prompt intact) so the
      // user can retry rather than losing their message.
      onToast(`New session failed: ${(err as Error).message}`, 'error');
    } finally {
      setCreating(false);
    }
  }, [
    creating,
    agent,
    claudeTransport,
    codexTransport,
    model,
    prompt,
    name,
    cwdChoice,
    cwdCustom,
    tmuxChoice,
    newTmuxSessionName,
    placeholder,
    onToast,
    onCreated,
  ]);

  // Helper: look up availability for an agent id.
  function agentInfo(id: 'claude' | 'codex'): SpawnAgentInfo | undefined {
    return agentInfos.find((a) => a.id === id);
  }

  const claudeInfo = agentInfo('claude');
  const codexInfo = agentInfo('codex');

  return (
    <div
      ref={rootRef}
      className="new-session-draft"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="new-session-draft-scroll">
        <form
          className="new-session-draft-body"
          aria-label="Create session"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h1 className="new-session-draft-heading">New session</h1>

          {/* Agent-type segmented control */}
          <div className="rail-new-agent-seg" role="group" aria-label="Agent type">
            {(['claude', 'codex'] as const).map((id) => {
              const info = id === 'claude' ? claudeInfo : codexInfo;
              const unavailable = info && !info.available;
              const isActive = agent === id;
              return (
                <button
                  key={id}
                  type="button"
                  className="rail-new-agent-seg-btn"
                  data-active={isActive ? 'true' : 'false'}
                  data-unavailable={unavailable ? 'true' : 'false'}
                  disabled={creating}
                  title={unavailable ? info?.reason : undefined}
                  aria-pressed={isActive}
                  onClick={() => setAgent(id)}
                >
                  <span className="rail-new-agent-seg-label">
                    {id === 'claude' ? 'Claude' : 'Codex'}
                  </span>
                  {unavailable ? (
                    <span className="rail-new-agent-seg-hint" aria-hidden="true">unavailable</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {agent === 'claude' ? (
            <div className="rail-new-mode-seg" role="group" aria-label="Claude mode">
              {([
                ['tmux', 'Interactive'],
                ['print', 'Print mode'],
              ] as const).map(([id, label]) => {
                const isActive = claudeTransport === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className="rail-new-mode-seg-btn"
                    data-active={isActive ? 'true' : 'false'}
                    disabled={creating}
                    aria-pressed={isActive}
                    onClick={() => setClaudeTransport(id)}
                  >
                    <span className="rail-new-agent-seg-label">{label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {agent === 'codex' ? (
            <div className="rail-new-mode-seg" role="group" aria-label="Codex mode">
              {([
                ['rpc', 'RPC'],
                ['tmux', 'TUI'],
              ] as const).map(([id, label]) => {
                const isActive = codexTransport === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className="rail-new-mode-seg-btn"
                    data-active={isActive ? 'true' : 'false'}
                    disabled={creating}
                    aria-pressed={isActive}
                    onClick={() => setCodexTransport(id)}
                  >
                    <span className="rail-new-agent-seg-label">{label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Model picker — Claude only; Codex has no model flag wired here. */}
          {agent === 'claude' ? (
            <div className="rail-new-mode-seg" role="group" aria-label="Model">
              {MODEL_OPTIONS.map(({ id, label }) => {
                const isActive = model === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className="rail-new-mode-seg-btn"
                    data-active={isActive ? 'true' : 'false'}
                    disabled={creating}
                    aria-pressed={isActive}
                    onClick={() => setModel(id)}
                  >
                    <span className="rail-new-agent-seg-label">{label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Name field — Claude only; Codex has no --name flag */}
          {agent === 'claude' ? (
            <input
              className="rail-new-name"
              type="text"
              value={name}
              placeholder={placeholder}
              disabled={creating}
              onChange={(e) => setName(e.target.value)}
              aria-label="Session name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          ) : (
            <div className="rail-new-name-note" aria-live="polite">
              Codex has no session name
            </div>
          )}

          {/* CWD: dropdown of project directories + Custom… option */}
          <select
            className="rail-new-cwd"
            value={cwdChoice}
            disabled={creating}
            onChange={(e) => setCwdChoice(e.target.value)}
            aria-label="Working directory"
          >
            <option value="">(default) {defaultCwd}</option>
            {projectDirs.map((d) => (
              <option key={d.path} value={d.path}>
                {d.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
          {cwdChoice === 'custom' ? (
            <input
              className="rail-new-cwd"
              type="text"
              value={cwdCustom}
              placeholder="~/Projects/my-project"
              disabled={creating}
              onChange={(e) => setCwdCustom(e.target.value)}
              aria-label="Custom working directory"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          ) : null}

          {/* tmux session target: host the new window in an existing tmux
              session, or spin up a brand-new one. '' preserves today's
              default behavior (first existing session, or bootstrap). */}
          <select
            className="rail-new-cwd"
            value={tmuxChoice}
            disabled={creating}
            onChange={(e) => setTmuxChoice(e.target.value)}
            aria-label="Tmux session"
          >
            <option value="">(default) — existing session, or new if none</option>
            {tmuxSessions.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.windows} window{s.windows === 1 ? '' : 's'})
              </option>
            ))}
            <option value={NEW_TMUX_SESSION}>New tmux session…</option>
          </select>
          {tmuxChoice === NEW_TMUX_SESSION ? (
            <input
              className="rail-new-cwd"
              type="text"
              value={newTmuxSessionName}
              placeholder="my-new-session"
              disabled={creating}
              onChange={(e) => setNewTmuxSessionName(e.target.value)}
              aria-label="New tmux session name"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          ) : null}

          {/* Composer-styled initial prompt. Plain controlled textarea — NOT
              ComposerPrimitive.Input, which is wired to a live assistant-ui
              runtime this draft doesn't have. Styled with the same CSS classes
              as the real composer so it reads as the same surface. */}
          <div className="composer-card new-session-draft-composer">
            <div className="composer-input-wrap">
              <textarea
                ref={promptRef}
                className="composer-input"
                value={prompt}
                disabled={creating}
                placeholder="Message to start the session with (optional)…"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘/Ctrl+Enter submits, same convention as the real composer's
                  // send shortcut. Plain Enter inserts a newline (textarea default).
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void submit();
                  }
                }}
                aria-label="Initial prompt"
              />
            </div>
          </div>

          <div className="rail-new-actions new-session-draft-actions">
            <button
              type="button"
              className="rail-new-cancel"
              onClick={onCancel}
              disabled={creating}
            >
              Cancel
            </button>
            <button type="submit" className="rail-new-create" disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
