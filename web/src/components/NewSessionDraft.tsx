import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createSession, fetchSpawnAgents, fetchTmuxSessions, getConfig, getModels, uploadFile } from '../lib/api';
import type { ClaudeModelInfo, CreateSessionResult, SpawnAgentInfo, TmuxSessionSummary } from '../lib/api';
import { ATTACH_ACCEPT } from '../lib/attachments';
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
import { ConfirmCreateFolderModal } from './ConfirmCreateFolderModal';
import { Dropdown, type DropdownOption } from './Dropdown';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { MicIcon } from './icons';
import {
  ComposerAttachButton,
  ComposerMicButton,
  ComposerRawSendButton,
  ComposerSendButton,
} from './ComposerActionBar';

/** Claude model picker value: 'default' (omit --model) or a full model id
 *  from ClaudeModelInfo.id (e.g. 'claude-opus-4-8'), fetched via getModels(). */
export type ClaudeModel = 'default' | string;

/** The exact options object createSession() accepts — resolved once in submit()
 *  and reused verbatim by runCreate() (including the create-folder retry). */
type CreateOpts = NonNullable<Parameters<typeof createSession>[0]>;

/** A file attached to the draft. `path` is null while the eager upload
 *  (see handleFilesPicked below) is still in flight — submit() waits for
 *  every attachment to resolve before it will fire (see `uploadingActive`). */
interface DraftAttachment {
  id: string;
  name: string;
  path: string | null;
}

interface NewSessionDraftProps {
  /** Rail filter at the time the draft was opened — seeds the default agent. */
  filter: SessionFilter;
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
  /** Esc — discard the draft and return to the previous view. */
  onCancel: () => void;
  /** Mobile-only top-left back button (see `.new-session-draft-head` below) —
   *  routes through App.tsx's `backToRail` so cancelling lands on the rail,
   *  not a blank detail pane, matching the live session's back button.
   *  Optional + falls back to onCancel (see the button's onClick below) so
   *  callers that don't care about the rail-vs-blank-pane distinction don't
   *  need to pass it. */
  onBack?: () => void;
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
export function NewSessionDraft({ filter, onToast, onCancel, onBack, onCreated }: NewSessionDraftProps) {
  const [agent, setAgent] = useState<'claude' | 'codex' | 'claudex' | 'claudemi'>(() => defaultAgentForFilter(filter));
  const [claudeTransport, setClaudeTransport] = useState<ClaudeTransport>('tmux');
  const [codexTransport, setCodexTransport] = useState<CodexTransport>('rpc');
  // Single model slot shared by all harnesses — switching harness
  // re-defaults it to 'default' (see the agent-change effect below) rather
  // than remembering a separate choice per agent, matching the toolbar's
  // single Model Dropdown.
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
  // Set when a create attempt came back code:'cwd_missing' — drives the
  // create-folder confirm modal. Holds the resolved createSession options so
  // the retry (with createCwd:true) reuses the EXACT same request.
  const [pendingCwdConfirm, setPendingCwdConfirm] = useState<{ cwd: string; opts: CreateOpts } | null>(null);
  const [agentInfos, setAgentInfos] = useState<SpawnAgentInfo[]>([]);
  const [claudeModels, setClaudeModels] = useState<ClaudeModelInfo[]>([]);
  const [codexModels, setCodexModels] = useState<ClaudeModelInfo[]>([]);
  const [claudexModels, setClaudexModels] = useState<ClaudeModelInfo[]>([]);
  const [claudemiModels, setClaudemiModels] = useState<ClaudeModelInfo[]>([]);
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

  // Voice input: gates useVoiceRecorder's mic acquisition (no getUserMedia
  // call until true). While active, the draft swaps its normal
  // input+attachments+toolbar block for an inline `.voice-inline-body` panel
  // built from the SAME `.voice-*` classes Composer.tsx's VoiceInline uses
  // (status line + waveform canvas + Cancel/Stop toolbar) — see the render
  // below. No GSAP morph/overlay: this is a plain conditional render swap,
  // not the live composer's animated reveal. Errors surface via onToast and
  // auto-reset.
  const [micActive, setMicActive] = useState(false);
  const voice = useVoiceRecorder({
    active: micActive,
    onCommit: (text) => {
      if (text) setPrompt((p) => (p ? p.replace(/\s*$/, '') + ' ' + text : text));
      setMicActive(false);
    },
    onClose: () => setMicActive(false),
  });
  useEffect(() => {
    if (voice.status === 'error' && voice.errorMsg) {
      onToast(voice.errorMsg, 'error');
      setMicActive(false);
    }
  }, [voice.status, voice.errorMsg, onToast]);

  // File attach: mirrors the live composer's attachment adapter
  // (lib/attachments.ts createCockpitAttachmentAdapter) — upload happens
  // EAGERLY on pick (not deferred to submit) via the same uploadFile() call,
  // so the chip reaches an "uploaded" state immediately. Rides along on the
  // initial prompt at submit time (see submit() below), exactly like the
  // live composer's onNew appends each attachment's uploaded absolute path
  // to the outgoing message text.
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // True while at least one attachment's upload hasn't resolved yet — gates
  // submit() so a file mid-upload can't be silently dropped from the prompt.
  const uploadingActive = attachments.some((a) => a.path == null);

  const handleFilesPicked = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      Array.from(files).forEach((file) => {
        const id = `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
        setAttachments((prev) => [...prev, { id, name: file.name, path: null }]);
        onToast(`Uploading ${file.name}…`);
        uploadFile(file)
          .then((res) => {
            setAttachments((prev) =>
              prev.map((a) => (a.id === id ? { ...a, name: res.name, path: res.path } : a)),
            );
            onToast(`Attached ${res.name}`, 'ok');
          })
          .catch((err) => {
            setAttachments((prev) => prev.filter((a) => a.id !== id));
            onToast(`Attach failed: ${(err as Error).message}`, 'error');
          });
      });
    },
    [onToast],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

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
        setClaudexModels(info.claudexModels ?? []);
        setClaudemiModels(info.claudemiModels ?? []);
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
  // unavailable while ANOTHER agent is available, switch to the first
  // available one (claude → claudex → claudemi → codex preference) rather
  // than leaving the user staring at a disabled harness they can't submit.
  // If every agent reports unavailable, leave the selection alone — nothing
  // safe to switch to. Claudex/claudemi both spawn the claude binary, so
  // until the server reports a dedicated entry for each, their availability
  // falls back to claude's (same fallback as agentInfo() below).
  useEffect(() => {
    if (agentInfos.length === 0) return;
    const infoFor = (id: 'claude' | 'codex' | 'claudex' | 'claudemi'): SpawnAgentInfo | undefined =>
      agentInfos.find((a) => a.id === id) ??
      (id === 'claudex' || id === 'claudemi' ? agentInfos.find((a) => a.id === 'claude') : undefined);
    setAgent((prev) => {
      if (infoFor(prev)?.available !== false) return prev;
      const fallback = (['claude', 'claudex', 'claudemi', 'codex'] as const).find(
        (id) => id !== prev && infoFor(id)?.available !== false,
      );
      return fallback ?? prev;
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
  //
  // Mobile soft-keyboard up: drop the centering lift entirely instead of
  // recomputing it against the shrunk container. `.composer` here is the
  // SAME class as the live composer's (Composer.tsx), so it already inherits
  // `body.kbd-up .app`'s position:fixed pin above the keyboard and
  // `body.kbd-up .composer { padding-bottom: 0 }` (styles.css) — but this
  // wrap div also carries an unrelated GSAP `translateY` centering transform
  // that isn't recomputed on keyboard show (window's 'resize' event doesn't
  // reliably fire for the on-screen keyboard — that's exactly why App.tsx
  // uses visualViewport instead), so without this the card kept floating at
  // its pre-keyboard centered position: high above the keyboard with a large
  // dead gap below it, mirroring the live composer's bug. Reusing App.tsx's
  // already-published `body.kbd-up` signal (not re-deriving keyboard state)
  // via a MutationObserver — no second keyboard-detection system — makes
  // `y: 0` land the card flush at the true bottom of its (now
  // keyboard-shrunk) flex container, exactly like the live composer.
  useLayoutEffect(() => {
    if (creating) return;
    const root = rootRef.current;
    const wrap = composerWrapRef.current;
    const hero = heroRef.current;
    if (!root || !wrap) return;
    const recompute = () => {
      if (document.body.classList.contains('kbd-up')) {
        liftRef.current = 0;
        gsap.set(wrap, { y: 0 });
        if (hero) gsap.set(hero, { y: 0 });
        return;
      }
      const heroH = hero?.offsetHeight ?? 0;
      const lift = -Math.max(root.offsetHeight - heroH - wrap.offsetHeight, 0) / 2;
      liftRef.current = lift;
      gsap.set(wrap, { y: lift });
      if (hero) gsap.set(hero, { y: lift });
    };
    recompute();
    window.addEventListener('resize', recompute);
    const kbdObserver = new MutationObserver(recompute);
    kbdObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      window.removeEventListener('resize', recompute);
      kbdObserver.disconnect();
    };
  }, [creating, agent, showAdvanced, cwdChoice, tmuxChoice]);

  // Fire the actual create request with a pre-resolved options object. `extra`
  // is merged over `opts` (used to add `createCwd: true` on the create-folder
  // retry). Owns the center→bottom slide handoff + the error paths, including
  // the cwd_missing branch that raises the create-folder confirm modal.
  const runCreate = useCallback(
    async (opts: CreateOpts, extra?: Partial<CreateOpts>) => {
      setCreating(true);
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
          createSession({ ...opts, ...extra }),
          slideToBottom(),
        ]);
        onToast(`Session created → ${result.name}`, 'ok');
        onCreated(result);
      } catch (err) {
        // Keep the draft screen open (with the typed prompt intact) so the
        // user can retry rather than losing their message, and slide the card
        // back up to where it was.
        slideBackToCenter();
        const e = err as Error & { code?: string; cwd?: string };
        if (e.code === 'cwd_missing') {
          // The picked folder doesn't exist — offer to create it and retry
          // rather than surfacing a dead-end error toast.
          setPendingCwdConfirm({ cwd: e.cwd || opts.cwd || '', opts });
        } else {
          onToast(`New session failed: ${e.message}`, 'error');
        }
      } finally {
        setCreating(false);
      }
    },
    [onToast, onCreated],
  );

  const submit = useCallback(() => {
    if (creating || uploadingActive) return;
    // Same convention as the live composer's onNew (App.tsx): outgoing text
    // = [typedText, ...uploadedAbsolutePaths].filter(Boolean).join(' '). The
    // textarea itself never shows the paths — they're appended only here, at
    // submit time — so a file picked mid-typing rides along on the initial
    // prompt the spawned agent receives.
    const attachmentPaths = attachments.map((a) => a.path).filter((p): p is string => !!p);
    const finalPrompt = [prompt.trim(), ...attachmentPaths].filter(Boolean).join(' ');
    // Required-with-default: blank name field falls back to the shown
    // placeholder. Codex has no --name flag; claudex/claudemi both reuse the
    // claude tmux launch shape, so they name sessions exactly like claude.
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

    const opts: CreateOpts = {
      name: resolvedName,
      cwd: resolvedCwd,
      agent,
      claudeTransport: agent === 'claude' ? claudeTransport : undefined,
      codexTransport: agent === 'codex' ? codexTransport : undefined,
      model: agent === 'claude' && model !== 'default' ? model : undefined,
      codexModel: agent === 'codex' && model !== 'default' ? model : undefined,
      claudexModel: agent === 'claudex' && model !== 'default' ? model : undefined,
      claudemiModel: agent === 'claudemi' && model !== 'default' ? model : undefined,
      prompt: finalPrompt || undefined,
      tmuxSession: resolvedTmuxSession,
      newTmuxSession: resolvedNewTmuxSession,
    };
    void runCreate(opts);
  }, [
    creating,
    uploadingActive,
    agent,
    claudeTransport,
    codexTransport,
    model,
    prompt,
    attachments,
    name,
    cwdChoice,
    cwdCustom,
    tmuxChoice,
    newTmuxSessionName,
    placeholder,
    runCreate,
  ]);

  // Helper: look up availability for an agent id.
  function agentInfo(id: 'claude' | 'codex' | 'claudex' | 'claudemi'): SpawnAgentInfo | undefined {
    return agentInfos.find((a) => a.id === id);
  }

  const claudeInfo = agentInfo('claude');
  const codexInfo = agentInfo('codex');
  // Claudex/claudemi both spawn the claude binary (pointed at the olam
  // auth-worker), so until the server reports a dedicated entry for each,
  // claude's binary availability governs them.
  const claudexInfo = agentInfo('claudex') ?? claudeInfo;
  const claudemiInfo = agentInfo('claudemi') ?? claudeInfo;
  const modelOptions =
    agent === 'claude'
      ? claudeModels
      : agent === 'claudex'
        ? claudexModels
        : agent === 'claudemi'
          ? claudemiModels
          : codexModels;

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

  // Mirrors VoiceInline's statusLabel switch in Composer.tsx, for parity.
  const voiceStatusLabel =
    voice.status === 'error'
      ? 'Microphone unavailable'
      : voice.status === 'transcribing'
        ? 'Transcribing…'
        : voice.status === 'paused'
          ? 'Paused'
          : voice.status === 'starting'
            ? 'Starting…'
            : 'Listening…';

  return (
    <>
    {/* Mobile-only back affordance (hidden ≥760px — see .new-session-draft-head
        and its shared .back-btn class in styles.css, the same rule that hides
        the live session's own back button on desktop/iPad). Rendered as a
        SIBLING of the rootRef div below, not a child of it — the centering
        effect above measures root.offsetHeight and assumes it spans exactly
        [hero, composer], so this header must sit outside that box rather than
        add unaccounted height to the lift math. Reuses the exact `.back-btn`
        markup/classes the session detail header uses (App.tsx's `backToRail`
        button) so the treatment matches; wired to onBack (App.tsx's
        `backToRail`) rather than onCancel so tapping it returns to the mobile
        rail/sidebar instead of leaving a blank detail pane. */}
    <header className="detail-head new-session-draft-head">
      <button
        type="button"
        className="back-btn"
        aria-label="Cancel new session"
        onClick={onBack ?? onCancel}
      >
        ‹
      </button>
    </header>
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
            agentName={
              agent === 'codex'
                ? 'Codex'
                : agent === 'claudex'
                  ? 'Claudex'
                  : agent === 'claudemi'
                    ? 'Claudemi'
                    : 'Claude'
            }
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
          {/* Option row — harness/model/dir/tmux/Advanced/name — sits ABOVE
              the input so it reads as a settings strip anchoring the compose
              box, not part of the send-time action bar below (which now
              matches the live composer's own bar exactly). Single fadeRef
              target: submit()'s slideToBottom fades this whole row out
              (opacity only) so the card reads as the plain live composer
              once it lands in the bottom slot; slideBackToCenter reverses it
              on a failed submit. Cancel no longer lives in this row (moved to
              the mobile-only top-left back button — see .new-session-draft-head
              above); Esc still cancels too (see the root's onKeyDown above). */}
          <div className="new-session-draft-options" ref={fadeRef}>
            {/* Harness — segmented pill (reuses the same
                .rail-new-mode-seg/-btn classes as the Advanced mode pills
                below), matching the reference's primary "Chat | Cowork"
                pill language. Availability + auto-switch logic unchanged
                from the old <select>: a genuinely unavailable agent stays
                visible but disabled, with the reason as its title.
                Claudex (claude CLI → olam auth-worker → OpenAI) is the
                PRIMARY Codex-flavored option (design decision 7, locked);
                the legacy codex CLI/RPC harness stays fully functional but
                visually secondary via the muted "Legacy" tag (aria-hidden so
                the button's accessible name stays exactly "Codex"; the title
                carries the same hint for assistive tech + hover). Claudemi
                (claude CLI → olam auth-worker → Kimi K3) sits as a peer of
                Claudex — picker-reachable, never auto-selected as a
                default. */}
            <div className="rail-new-mode-seg new-session-draft-agent-seg" role="group" aria-label="Harness">
              {([
                ['claude', 'Claude', claudeInfo],
                ['claudex', 'Claudex', claudexInfo],
                ['claudemi', 'Claudemi', claudemiInfo],
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
                    title={
                      info?.available === false
                        ? info.reason
                        : id === 'codex'
                          ? 'Legacy Codex CLI/RPC harness — prefer Claudex'
                          : undefined
                    }
                    aria-pressed={isActive}
                    onClick={() => setAgent(id)}
                  >
                    <span className="rail-new-agent-seg-label">
                      {label}{info?.available === false ? ' (unavailable)' : ''}
                    </span>
                    {id === 'codex' ? (
                      <span className="dropdown-option-badge" aria-hidden="true">Legacy</span>
                    ) : null}
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

            {/* Name field — Claude + Claudex + Claudemi (all three use the
                claude tmux launch shape); Codex has no --name flag. Compact
                auto-width (not a stretched full-width field) via
                new-session-draft-name-compact. */}
            {agent !== 'codex' ? (
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
                .new-session-draft-options .rail-new-mode-seg in styles.css)
                since they're a second, secondary segmented choice rather
                than part of the primary control row. */}
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

          {/* Voice recording panel — swaps in for the input+attachments+
              toolbar block below while micActive, using the SAME
              `.voice-status` / `.voice-wave-inline` / `.voice-toolbar`
              classes as Composer.tsx's VoiceInline, so a dictating draft
              reads as the real voice control (status line + live waveform +
              Cancel/Stop), not a bare toggled button. Plain conditional
              render (no GSAP morph) — see the class doc-comment above. */}
          {micActive ? (
            <div className="voice-inline-body" style={{ display: 'flex' }} aria-live="polite">
              <div className="voice-status">
                <span className="voice-dot" data-on={voice.status === 'recording' ? 'true' : undefined} />
                {voiceStatusLabel}
              </div>
              <canvas
                ref={voice.canvasRef}
                className="voice-wave voice-wave-inline"
                height={64}
                data-paused={voice.status !== 'recording' ? 'true' : undefined}
              />
              {voice.status === 'error' ? (
                <div className="voice-error">{voice.errorMsg || 'Could not start recording.'}</div>
              ) : voice.status !== 'transcribing' ? (
                <div className="voice-hint">Speak, then Stop &amp; Transcribe (or ⌘/Ctrl+↵) to insert.</div>
              ) : null}
              <div className="composer-toolbar voice-toolbar">
                <button
                  type="button"
                  className="btn-secondary voice-btn-cancel"
                  onClick={() => voice.cancel()}
                  disabled={voice.status === 'transcribing'}
                  aria-label="Cancel voice recording"
                >
                  Cancel
                </button>
                <span className="composer-toolbar-spacer" />
                <button
                  type="button"
                  className="composer-send voice-btn-stop"
                  onClick={() => voice.stop()}
                  disabled={voice.status === 'error' || voice.status === 'transcribing' || voice.status === 'starting'}
                  aria-label="Stop recording and transcribe"
                  title="Stop & Transcribe (⌘/Ctrl+↵)"
                >
                  {voice.status === 'transcribing' ? (
                    <span className="composer-enhance-spinner" aria-hidden="true" />
                  ) : (
                    <MicIcon />
                  )}
                </button>
              </div>
            </div>
          ) : (
            <>
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

              {/* Attachment chips — SAME position as the live composer's own
                  `.composer-attachments` row (between the input and the
                  toolbar; see Composer.tsx). A minimal draft-local chip
                  (name + remove), not the live AttachmentChip (that's
                  coupled to assistant-ui's Attachment type) — the shared
                  pipeline being reused is uploadFile() + the
                  [prompt, ...paths].join(' ') convention, not the chip
                  markup itself. */}
              {attachments.length > 0 ? (
                <div className="composer-attachments">
                  {attachments.map((a) => (
                    <span key={a.id} className="attach-chip" data-pending={a.path == null ? 'true' : undefined}>
                      <span className="chip-icon" aria-hidden="true">📎</span>
                      <span className="chip-name" title={a.name}>{a.name}</span>
                      {a.path == null ? <span className="chip-spinner" aria-hidden="true" /> : null}
                      <button
                        type="button"
                        className="chip-remove"
                        aria-label={`Remove ${a.name}`}
                        disabled={creating}
                        onClick={() => removeAttachment(a.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              {/* Bottom action bar — byte-identical to the live composer's own
                  [attach] [mic] [raw] [send] cluster: same .composer-toolbar/
                  -toolbar-spacer classes, same shared leaf buttons
                  (ComposerActionBar.tsx), so the card reads as the SAME composer
                  once it lands in the live slot, not a swap. Unlike the live
                  composer, send/raw-send stay ENABLED on an empty prompt —
                  starting a session doesn't require an initial message; only
                  `creating`/`uploadingActive` disable them. */}
              <div className="composer-toolbar">
                {/* Attach — functional: opens a hidden file input; each pick
                    uploads via the same uploadFile() the live composer's
                    attachment adapter uses (lib/attachments.ts), and rides
                    along on the initial prompt at submit() (see above). */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ATTACH_ACCEPT}
                  multiple
                  hidden
                  aria-hidden="true"
                  tabIndex={-1}
                  onChange={(e) => {
                    handleFilesPicked(e.target.files);
                    e.target.value = '';
                  }}
                />
                <ComposerAttachButton
                  aria-label="Attach a file"
                  title="Attach a file"
                  disabled={creating}
                  onClick={() => fileInputRef.current?.click()}
                />
                <span className="composer-toolbar-spacer" />
                {/* Mic — functional: clicking activates useVoiceRecorder and
                    swaps in the voice panel above (Cancel/Stop live there —
                    this button doesn't double as the stop control anymore). */}
                <ComposerMicButton
                  ariaLabel="Voice input"
                  title="Voice input"
                  disabled={creating}
                  active={micActive}
                  onClick={() => setMicActive(true)}
                />
                {/* Raw send — best-effort: no optimiser exists pre-session, so
                    this converges on the exact same submit() as the primary
                    Send button below (same handler shape as the live composer's
                    bypass button, which also just calls the send path raw). */}
                <ComposerRawSendButton
                  ariaLabel="Create session (raw)"
                  title="Create session — same as Send (⌘/Ctrl+⇧+↵)"
                  disabled={creating || uploadingActive}
                  onClick={() => void submit()}
                />
                {/* Primary send — functional: type="submit" so the form's own
                    onSubmit (preventDefault + submit()) still owns it, keeping
                    Enter-to-submit in the freetext inputs above working exactly
                    as before. */}
                <ComposerSendButton
                  type="submit"
                  ariaLabel={creating ? 'Creating session…' : 'Create session'}
                  title="Create session (⌘/Ctrl+↵)"
                  disabled={creating || uploadingActive}
                  busy={creating}
                />
              </div>
            </>
          )}
        </form>
      </div>
    </div>
    {/* Create-folder confirm — raised when a create attempt returned
        code:'cwd_missing'. Confirming retries the SAME request with
        createCwd:true (server mkdir -p's the folder); dismissing leaves the
        draft open with the typed prompt intact. */}
    {pendingCwdConfirm ? (
      <ConfirmCreateFolderModal
        cwd={pendingCwdConfirm.cwd}
        onConfirm={() => void runCreate(pendingCwdConfirm.opts, { createCwd: true })}
        onClose={() => setPendingCwdConfirm(null)}
      />
    ) : null}
    </>
  );
}
