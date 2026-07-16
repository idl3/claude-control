import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createSession, fetchSpawnAgents, fetchTmuxSessions, getConfig, getModels } from '../lib/api';
import type { ClaudeModelInfo, CreateSessionResult, SpawnAgentInfo, TmuxSessionSummary } from '../lib/api';
import gsap, { ANIM, prefersReducedMotion } from '../lib/anim';
import {
  defaultAgentForFilter,
  defaultName,
  normalizeClaudeTransport,
  normalizeCodexTransport,
  type ClaudeTransport,
  type CodexTransport,
} from './NewSessionForm';
import type { SessionFilter } from './SessionRail';

/** Claude model picker value: 'default' (omit --model) or a full model id
 *  from ClaudeModelInfo.id (e.g. 'claude-opus-4-8'), fetched via getModels(). */
export type ClaudeModel = 'default' | string;

interface NewSessionDraftProps {
  /** Rail filter at the time the draft was opened — seeds the default agent. */
  filter: SessionFilter;
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
  /** Esc / Cancel — discard the draft and return to the previous view. */
  onCancel: () => void;
  /** Session created successfully — caller selects it (lands in its transcript). */
  onCreated: (result: CreateSessionResult) => void;
}

const DEFAULT_MODEL_OPTION: ClaudeModelInfo = { id: 'default', label: 'Default' };

/** Sentinel value for the tmux-session <select>'s "New tmux session…" option. */
const NEW_TMUX_SESSION = '__new__';

/** Matches SessionRail.tsx's own default-directory heuristic for this workspace. */
const DEFAULT_DIR_HINT = /pleri-org/i;

/**
 * Mirrors SessionRail.tsx's module-private `formatModel()` (condenses a model
 * label to the compact lowercase-hyphenated form used throughout the rail's
 * model chips, e.g. "Opus 4.8" → "opus-4.8"). Duplicated rather than imported
 * — pulling in the whole SessionRail component module (icons, SlotText,
 * olamLabel, api.renameTmuxSession) here and into this file's tests just for
 * one pure string helper isn't worth the coupling.
 * ponytail: 8-line duplication over a cross-module import; promote both to a
 * shared lib/format.ts if a third consumer needs this normalization.
 */
function formatModel(model: string): string {
  return model
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^claude-/, '');
}

/**
 * New-chat draft screen, shown in the main content area in place of the
 * transcript. Structured as a mirror of `.thread-root`: an empty flex
 * placeholder (stands in for `.thread-viewport`) above a `.composer`-classed
 * wrapper, so the draft's composer card occupies the EXACT same
 * bottom-anchored slot the live composer does. For the "new chat" state that
 * wrapper is lifted with a measured `translateY` so the card reads as
 * vertically centered; on submit the lift animates back to 0 (compositor-only
 * transform/opacity) while `createSession` runs in parallel, landing the card
 * in the live composer's exact position for an in-place, no-pop handoff.
 *
 * Does NOT reuse Composer.tsx's send logic — that's coupled to a live
 * session's assistant-ui runtime. This is a plain controlled textarea styled
 * with the same `.composer-card` / `.composer-input` CSS classes.
 */
export function NewSessionDraft({ filter, onToast, onCancel, onCreated }: NewSessionDraftProps) {
  const [agent, setAgent] = useState<'claude' | 'codex'>(() => defaultAgentForFilter(filter));
  const [claudeTransport, setClaudeTransport] = useState<ClaudeTransport>('tmux');
  const [codexTransport, setCodexTransport] = useState<CodexTransport>('rpc');
  // Single model slot shared by both agents — switching harness re-defaults
  // it to 'default' (see the agent-change effect below) rather than
  // remembering a separate choice per agent, matching the option-row's
  // single Model <select>.
  const [model, setModel] = useState<ClaudeModel>('default');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [name, setName] = useState('');
  const [placeholder] = useState(defaultName);
  // Selected value in the project-dir dropdown: a path string, or '' to use
  // defaultCwd, or the sentinel 'custom' to show the free-text input.
  const [cwdChoice, setCwdChoice] = useState('');
  const [cwdCustom, setCwdCustom] = useState('');
  // Selected value in the tmux-session dropdown: an existing session name, or
  // '' to use today's default (send neither field), or the NEW_TMUX_SESSION
  // sentinel to show the new-session-name input.
  const [tmuxChoice, setTmuxChoice] = useState('');
  const [newTmuxSessionName, setNewTmuxSessionName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [agentInfos, setAgentInfos] = useState<SpawnAgentInfo[]>([]);
  const [claudeModels, setClaudeModels] = useState<ClaudeModelInfo[]>([]);
  const [codexModels, setCodexModels] = useState<ClaudeModelInfo[]>([]);
  const [defaultCwd, setDefaultCwd] = useState('~');
  const [projectDirs, setProjectDirs] = useState<{ label: string; path: string }[]>([]);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // `.composer`-classed wrapper — the element the center↔bottom lift is
  // applied to (see the centering effect + submit() below).
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  // Heading + option row — fades out (opacity only) as the card slides to
  // the bottom slot, so it reads as the plain live composer on arrival.
  const fadeRef = useRef<HTMLDivElement | null>(null);
  // Last-computed centered translateY, in px (negative = lifted up). Read by
  // submit()'s error-path reverse animation to slide back to the same spot.
  const liftRef = useRef(0);

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
    getModels()
      .then((info) => {
        setClaudeModels(info.claudeModels ?? []);
        setCodexModels(info.codexModels ?? []);
      })
      .catch(() => {
        // Non-fatal: model picker falls back to just "Default".
      });
    promptRef.current?.focus();
  }, []);

  // Switching harness re-defaults the model picker rather than remembering a
  // per-agent choice (also runs once on mount — harmless, model is already
  // 'default'). Also runs on the initial mount value of `agent`.
  useEffect(() => {
    setModel('default');
  }, [agent]);

  // Default-select the project directory whose path/label looks like this
  // workspace, once projectDirs arrive. Only applies while the user hasn't
  // already picked something (guards against clobbering a manual choice made
  // before the fetch resolves).
  useEffect(() => {
    if (projectDirs.length === 0) return;
    setCwdChoice((prev) => {
      if (prev) return prev;
      const match = projectDirs.find((d) => DEFAULT_DIR_HINT.test(d.path) || DEFAULT_DIR_HINT.test(d.label));
      return match ? match.path : prev;
    });
  }, [projectDirs]);

  // Default-select the first tmux session, once the list arrives. Same
  // don't-clobber guard as the cwd effect above.
  useEffect(() => {
    setTmuxChoice((prev) => (prev ? prev : (tmuxSessions[0]?.name ?? '')));
  }, [tmuxSessions]);

  // Keep the composer card visually centered while idle: measure the
  // available height above it and lift it by half the empty space, so it
  // reads as vertically centered rather than bottom-anchored. Recomputes on
  // window resize and whenever a structural row (agent/advanced/custom-cwd/
  // new-tmux-name) is added or removed. Skipped entirely while submitting —
  // submit()'s own GSAP timeline owns the transform during that window.
  useLayoutEffect(() => {
    if (creating) return;
    const root = rootRef.current;
    const wrap = composerWrapRef.current;
    if (!root || !wrap) return;
    const recompute = () => {
      const lift = -Math.max(root.offsetHeight - wrap.offsetHeight, 0) / 2;
      liftRef.current = lift;
      gsap.set(wrap, { y: lift });
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [creating, agent, showAdvanced, cwdChoice, tmuxChoice]);

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

    // Center→bottom handoff: slide the composer card down to its live-slot
    // position (transform only) while fading out the heading/option row
    // (opacity only) — both compositor-friendly. Gated by
    // prefers-reduced-motion, in which case it jumps straight to the end
    // state. onCreated() is called only once BOTH this animation and the
    // createSession() call below have settled, so the live <Thread> mounts
    // into an already-bottom-anchored composer with no visible pop.
    const wrap = composerWrapRef.current;
    const fade = fadeRef.current;
    const reduced = prefersReducedMotion();

    function slideToBottom(): Promise<void> {
      if (!wrap || reduced) {
        if (wrap) gsap.set(wrap, { y: 0 });
        if (fade) gsap.set(fade, { opacity: 0 });
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const tl = gsap.timeline({ onComplete: resolve });
        tl.to(wrap, { y: 0, duration: ANIM.base, ease: ANIM.enterEase }, 0);
        if (fade) tl.to(fade, { opacity: 0, duration: ANIM.fast, ease: 'none' }, 0);
      });
    }

    function slideBackToCenter(): void {
      if (!wrap || reduced) {
        if (wrap) gsap.set(wrap, { y: liftRef.current });
        if (fade) gsap.set(fade, { opacity: 1 });
        return;
      }
      const tl = gsap.timeline();
      tl.to(wrap, { y: liftRef.current, duration: ANIM.base, ease: ANIM.exitEase }, 0);
      if (fade) tl.to(fade, { opacity: 1, duration: ANIM.fast, ease: 'none' }, 0);
    }

    try {
      const [result] = await Promise.all([
        createSession({
          name: resolvedName,
          cwd: resolvedCwd,
          agent,
          claudeTransport: agent === 'claude' ? claudeTransport : undefined,
          codexTransport: agent === 'codex' ? codexTransport : undefined,
          model: agent === 'claude' && model !== 'default' ? model : undefined,
          codexModel: agent === 'codex' && model !== 'default' ? model : undefined,
          prompt: prompt.trim() || undefined,
          tmuxSession: resolvedTmuxSession,
          newTmuxSession: resolvedNewTmuxSession,
        }),
        slideToBottom(),
      ]);
      onToast(`Session created → ${result.name}`, 'ok');
      onCreated(result);
    } catch (err) {
      // Keep the draft screen open (with the typed prompt intact) so the
      // user can retry rather than losing their message, and slide the card
      // back up to where it was.
      slideBackToCenter();
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
  const modelOptions = agent === 'claude' ? claudeModels : codexModels;

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
      {/* Stands in for .thread-viewport: empty, but keeps the composer
          pinned to the bottom of the flex column exactly like the live
          session does, so the lift below is measured from the same shape. */}
      <div className="new-session-draft-placeholder" aria-hidden="true" />

      <div className="composer" ref={composerWrapRef}>
        <form
          className="composer-card"
          aria-label="Create session"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {/* Heading + option row — baked into the card, fades out on submit
              (see submit()'s slideToBottom) so the card reads as the plain
              live composer once it lands in the bottom slot. */}
          <div className="new-session-draft-head" ref={fadeRef}>
            <h1 className="new-session-draft-heading">New session</h1>

            <div className="new-session-draft-options">
              <div className="new-session-draft-options-left">
                <select
                  className="rail-new-cwd new-session-draft-select"
                  value={agent}
                  disabled={creating}
                  onChange={(e) => setAgent(e.target.value as 'claude' | 'codex')}
                  aria-label="Agent"
                >
                  <option value="claude" title={claudeInfo?.available === false ? claudeInfo.reason : undefined}>
                    Claude{claudeInfo?.available === false ? ' (unavailable)' : ''}
                  </option>
                  <option value="codex" title={codexInfo?.available === false ? codexInfo.reason : undefined}>
                    Codex{codexInfo?.available === false ? ' (unavailable)' : ''}
                  </option>
                </select>

                {/* Model picker — sourced from /api/models (via getModels())
                    so lib/models.js stays the single source of truth for the
                    exact model ids the CLI accepts. Options + default reset
                    whenever the harness above changes (see the agent-change
                    effect). */}
                <select
                  className="rail-new-cwd new-session-draft-select"
                  value={model}
                  disabled={creating}
                  onChange={(e) => setModel(e.target.value)}
                  aria-label="Model"
                >
                  <option value={DEFAULT_MODEL_OPTION.id}>{formatModel(DEFAULT_MODEL_OPTION.label)}</option>
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{formatModel(m.label)}</option>
                  ))}
                </select>

                <button
                  type="button"
                  className="new-session-draft-advanced-toggle"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? 'Advanced ▴' : 'Advanced ▾'}
                </button>
              </div>

              <div className="new-session-draft-options-right">
                {/* tmux session target: host the new window in an existing
                    tmux session, or spin up a brand-new one. Defaults to the
                    first fetched session once the list arrives (see the
                    tmuxSessions effect); '' still means "no session sent". */}
                <select
                  className="rail-new-cwd new-session-draft-select"
                  value={tmuxChoice}
                  disabled={creating}
                  onChange={(e) => setTmuxChoice(e.target.value)}
                  aria-label="Tmux session"
                >
                  <option value="">(default) — existing session, or new if none</option>
                  {tmuxSessions.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name} ({s.windows} window{s.windows === 1 ? '' : 's'})
                      {s.grouped ? ` · shared (${s.groupSize} linked)` : ''}
                    </option>
                  ))}
                  <option value={NEW_TMUX_SESSION}>New tmux session…</option>
                </select>
                {tmuxChoice === NEW_TMUX_SESSION ? (
                  <input
                    className="rail-new-cwd new-session-draft-freetext"
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

                {/* Directory: dropdown of project directories + Custom…
                    option. Defaults to the first entry that looks like this
                    workspace once projectDirs arrive (see the effect above). */}
                <select
                  className="rail-new-cwd new-session-draft-select"
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
                    className="rail-new-cwd new-session-draft-freetext"
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
              </div>
            </div>

            {/* Harness-mode pills — hidden by default (most sessions want the
                default transport); the "Advanced" toggle above reveals them. */}
            {showAdvanced && agent === 'claude' ? (
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
            {showAdvanced && agent === 'codex' ? (
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
          </div>

          {/* Composer-styled initial prompt. Plain controlled textarea — NOT
              ComposerPrimitive.Input, which is wired to a live assistant-ui
              runtime this draft doesn't have. Matches the live composer's
              exact input-wrap + toolbar structure so the handoff reads as
              the same surface, not a swap. */}
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
          <div className="composer-toolbar">
            <button
              type="button"
              className="rail-new-cancel"
              onClick={onCancel}
              disabled={creating}
            >
              Cancel
            </button>
            <span className="composer-toolbar-spacer" />
            <button
              type="submit"
              className="composer-send"
              disabled={creating}
              aria-label={creating ? 'Creating session…' : 'Create session'}
              title="Create session (⌘/Ctrl+↵)"
            >
              {creating ? <span className="composer-enhance-spinner" aria-hidden="true" /> : <ArrowUpIcon />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5M6 11l6-6 6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
