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
import { WelcomeHero } from './WelcomeHero';
import { Dropdown, type DropdownOption } from './Dropdown';

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

/** Fallback label for the model dropdown's default row before /api/models
 *  resolves (see modelDropdownOptions below) — real usage always prefers
 *  modelOptions[0]?.label once the fetch lands. */
const DEFAULT_MODEL_OPTION: ClaudeModelInfo = { id: 'default', label: 'Default' };

/** Sentinel value for the tmux-session dropdown's "New tmux session…" option. */
const NEW_TMUX_SESSION = '__new__';

/** Matches SessionRail.tsx's own default-directory heuristic for this workspace. */
const DEFAULT_DIR_HINT = /pleri-org/i;

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
  // remembering a separate choice per agent, matching the toolbar's single
  // Model Dropdown.
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
  // Option row (agent/model/advanced/tmux/dir) — fades out (opacity only) as
  // the card slides to the bottom slot, so it reads as the plain live
  // composer on arrival.
  const fadeRef = useRef<HTMLDivElement | null>(null);
  // `.new-session-draft-hero` wrapper (WelcomeHero + its own bottom gap baked
  // in via padding) — gets the SAME translateY lift as composerWrapRef so
  // [hero, composer] read as one centered group (see the centering effect),
  // and fades opacity-only on submit (see submit() below).
  const heroRef = useRef<HTMLDivElement | null>(null);
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

  // If agentInfos arrives showing the currently-selected agent is genuinely
  // unavailable while the OTHER agent is available, switch to the available
  // one rather than leaving the user staring at a disabled harness they can't
  // submit. If both (or neither) report unavailable, leave the selection
  // alone — nothing safe to switch to.
  useEffect(() => {
    if (agentInfos.length === 0) return;
    const claude = agentInfos.find((a) => a.id === 'claude');
    const codex = agentInfos.find((a) => a.id === 'codex');
    setAgent((prev) => {
      const prevInfo = prev === 'claude' ? claude : codex;
      const otherInfo = prev === 'claude' ? codex : claude;
      if (prevInfo?.available === false && otherInfo?.available !== false) {
        return prev === 'claude' ? 'codex' : 'claude';
      }
      return prev;
    });
  }, [agentInfos]);

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

  // Keep [hero, composer] visually centered as a GROUP while idle: measure
  // the available height above the pair and lift BOTH by half the empty
  // space, so the hero + composer card read as one vertically centered block
  // rather than the composer alone being bottom-anchored. The hero's own
  // bottom padding (`.new-session-draft-hero`, in styles.css) is the visual
  // gap between it and the composer card — it's included in heroH below
  // since it's part of the wrapper's offsetHeight, so the gap survives the
  // shared transform intact. Recomputes on window resize and whenever a
  // structural row (agent/advanced/custom-cwd/new-tmux-name) is added or
  // removed. Skipped entirely while submitting — submit()'s own GSAP
  // timeline owns the transform during that window.
  useLayoutEffect(() => {
    if (creating) return;
    const root = rootRef.current;
    const wrap = composerWrapRef.current;
    const hero = heroRef.current;
    if (!root || !wrap) return;
    const recompute = () => {
      const heroH = hero?.offsetHeight ?? 0;
      const lift = -Math.max(root.offsetHeight - heroH - wrap.offsetHeight, 0) / 2;
      liftRef.current = lift;
      gsap.set(wrap, { y: lift });
      if (hero) gsap.set(hero, { y: lift });
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
    // position (transform only) while fading out the option row and the hero
    // (opacity only) — both compositor-friendly. Gated by
    // prefers-reduced-motion, in which case it jumps straight to the end
    // state. onCreated() is called only once BOTH this animation and the
    // createSession() call below have settled, so the live <Thread> mounts
    // into an already-bottom-anchored composer with no visible pop.
    const wrap = composerWrapRef.current;
    const fade = fadeRef.current;
    const hero = heroRef.current;
    const reduced = prefersReducedMotion();

    function slideToBottom(): Promise<void> {
      if (!wrap || reduced) {
        if (wrap) gsap.set(wrap, { y: 0 });
        if (fade) gsap.set(fade, { opacity: 0 });
        if (hero) gsap.set(hero, { opacity: 0 });
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const tl = gsap.timeline({ onComplete: resolve });
        tl.to(wrap, { y: 0, duration: ANIM.base, ease: ANIM.enterEase }, 0);
        if (fade) tl.to(fade, { opacity: 0, duration: ANIM.fast, ease: 'none' }, 0);
        if (hero) tl.to(hero, { opacity: 0, duration: ANIM.fast, ease: 'none' }, 0);
      });
    }

    function slideBackToCenter(): void {
      if (!wrap || reduced) {
        if (wrap) gsap.set(wrap, { y: liftRef.current });
        if (fade) gsap.set(fade, { opacity: 1 });
        if (hero) gsap.set(hero, { opacity: 1 });
        return;
      }
      const tl = gsap.timeline();
      tl.to(wrap, { y: liftRef.current, duration: ANIM.base, ease: ANIM.exitEase }, 0);
      if (fade) tl.to(fade, { opacity: 1, duration: ANIM.fast, ease: 'none' }, 0);
      if (hero) tl.to(hero, { opacity: 1, duration: ANIM.fast, ease: 'none' }, 0);
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

  // ASSUMPTION: modelOptions[0] is the harness default (flagship-first
  // ordering in lib/models.js — CLAUDE_MODELS[0]/CODEX_MODELS[0] are the ids
  // the CLI itself falls back to when --model is omitted; see the file-level
  // comment there). The 'default' sentinel row is labeled with that real
  // model name (not the literal word "Default") plus a muted "Default" tag,
  // and modelOptions[0] is sliced off the rest of the list below so it never
  // appears twice.
  const defaultModelLabel = modelOptions[0]?.label ?? DEFAULT_MODEL_OPTION.label;
  const modelDropdownOptions: DropdownOption[] = [
    { value: 'default', label: defaultModelLabel, badge: 'Default' },
    ...modelOptions.slice(1).map((m) => ({ value: m.id, label: m.label })),
  ];

  const cwdDropdownOptions: DropdownOption[] = [
    { value: '', label: `(default) ${defaultCwd}`, caption: defaultCwd },
    ...projectDirs.map((d) => ({ value: d.path, label: d.label, caption: d.path })),
    { value: 'custom', label: 'Custom…' },
  ];

  const tmuxDropdownOptions: DropdownOption[] = [
    { value: '', label: '(default) — existing session, or new if none' },
    ...tmuxSessions.map((s) => ({
      value: s.name,
      label: `${s.name} (${s.windows} window${s.windows === 1 ? '' : 's'})${s.grouped ? ` · shared (${s.groupSize} linked)` : ''}`,
    })),
    { value: NEW_TMUX_SESSION, label: 'New tmux session…' },
  ];

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
      {/* Stands in for .thread-viewport: bottom-aligned so the hero sits
          directly above the composer, exactly like the live transcript's
          welcome state sits above its own composer. Same flex shape as the
          live session (an empty stand-in used to, just now with the hero
          bottom-anchored inside it), so the lift below is measured from the
          same overall root height. */}
      <div className="new-session-draft-placeholder">
        <div className="new-session-draft-hero" ref={heroRef}>
          <WelcomeHero
            agentName={agent === 'codex' ? 'Codex' : 'Claude'}
            onInsert={(t) => {
              setPrompt(t);
              promptRef.current?.focus();
            }}
          />
        </div>
      </div>

      <div className="composer" ref={composerWrapRef}>
        <form
          className="composer-card"
          aria-label="Create session"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
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

          {/* Bottom toolbar — reuses the live Composer.tsx's own
              `.composer-toolbar`/`.composer-toolbar-spacer`/`.composer-send`
              classes so the new-session options read as an INTEGRATED
              composer toolbar, not form fields stacked above the input. The
              lead wrapper (harness/model/dir/tmux/Advanced/name) fades out
              on submit (see submit()'s slideToBottom) so the card reads as
              the plain live composer once it lands in the bottom slot; Cancel
              + Send stay outside the fade — they're the two controls that
              still make sense once the card is in its live position. */}
          <div className="composer-toolbar">
            <div className="new-session-draft-toolbar-lead" ref={fadeRef}>
              {/* Harness — segmented pill (reuses the same
                  .rail-new-mode-seg/-btn classes as the Advanced mode pills
                  below), matching the reference's primary "Chat | Cowork"
                  pill language. Availability + auto-switch logic unchanged
                  from the old <select>: a genuinely unavailable agent stays
                  visible but disabled, with the reason as its title. */}
              <div className="rail-new-mode-seg new-session-draft-agent-seg" role="group" aria-label="Harness">
                {([
                  ['claude', 'Claude', claudeInfo],
                  ['codex', 'Codex', codexInfo],
                ] as const).map(([id, label, info]) => {
                  const isActive = agent === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="rail-new-mode-seg-btn"
                      data-active={isActive ? 'true' : 'false'}
                      disabled={creating || info?.available === false}
                      title={info?.available === false ? info.reason : undefined}
                      aria-pressed={isActive}
                      onClick={() => setAgent(id)}
                    >
                      <span className="rail-new-agent-seg-label">
                        {label}{info?.available === false ? ' (unavailable)' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Model picker — sourced from /api/models (via getModels())
                  so lib/models.js stays the single source of truth for the
                  exact model ids the CLI accepts. Options + default reset
                  whenever the harness above changes (see the agent-change
                  effect). */}
              <Dropdown
                value={model}
                onChange={setModel}
                options={modelDropdownOptions}
                disabled={creating}
                ariaLabel="Model"
              />

              {/* Directory: dropdown of project directories + Custom…
                  option. Defaults to the first entry that looks like this
                  workspace once projectDirs arrive (see the effect above). */}
              <Dropdown
                value={cwdChoice}
                onChange={setCwdChoice}
                options={cwdDropdownOptions}
                disabled={creating}
                ariaLabel="Working directory"
              />
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

              {/* tmux session target: host the new window in an existing
                  tmux session, or spin up a brand-new one. Defaults to the
                  first fetched session once the list arrives (see the
                  tmuxSessions effect); '' still means "no session sent". */}
              <Dropdown
                value={tmuxChoice}
                onChange={setTmuxChoice}
                options={tmuxDropdownOptions}
                disabled={creating}
                ariaLabel="Tmux session"
              />
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

              <button
                type="button"
                className="new-session-draft-advanced-toggle"
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? 'Advanced ▴' : 'Advanced ▾'}
              </button>

              {/* Name field — Claude only; Codex has no --name flag. Compact
                  auto-width (not a stretched full-width field) via
                  new-session-draft-name-compact. */}
              {agent === 'claude' ? (
                <input
                  className="rail-new-name new-session-draft-name-compact"
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

              {/* Harness-mode pills — hidden by default (most sessions want
                  the default transport); the "Advanced" toggle above reveals
                  them. Forced onto their own line (see
                  .new-session-draft-toolbar-lead .rail-new-mode-seg in
                  styles.css) since they're a second, secondary segmented
                  choice rather than part of the primary control row. */}
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
            </div>

            <span className="composer-toolbar-spacer" />
            <button
              type="button"
              className="rail-new-cancel"
              onClick={onCancel}
              disabled={creating}
            >
              Cancel
            </button>
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
