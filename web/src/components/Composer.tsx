import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useComposerRuntime,
  type Attachment,
} from '@assistant-ui/react';
import { Kbd } from './Kbd';
import {
  optimizePrompt as optimizePromptApi,
  listSkills,
  listAgents,
  type OptimizeResult,
  type SkillEntry,
  type AgentEntry,
} from '../lib/api';
import { OptimizeReview } from './OptimizeReview';
import { Lightbox } from './AttachmentPreview';
import { SkillBrowser } from './SkillBrowser';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { TerminalView } from './TerminalView';
import { useShell } from './ShellContext';
import { relayDiff, controlToken, interceptToken, navToken, isLetter, type Mods } from '../lib/terminalKeys';
import { triggerTokenAt, type TriggerToken } from '../lib/slashToken';
import type { SubAgentMode } from '../lib/subAgent';
import type { AnswerSelection } from '../lib/types';
import gsap, { ANIM, prefersReducedMotion } from '../lib/anim';
import { StopIcon, BotIcon, ArrowUpIcon, MicIcon } from './icons';
import { ComposerAttachButton, ComposerMicButton, ComposerRawSendButton, ComposerSendButton } from './ComposerActionBar';
import { AskInline, type ActivePrompt } from './AskInline';
import { composerHighlightSegments } from '../lib/composerHighlight';

// Module-level per-session cache so the skill list (live, session-discovered
// via GET /api/skills?id=<sessionId> → lib/skills.js) is fetched once per
// session and shared across Composer mounts. Project skills are scoped to the
// session's cwd; different sessions can have different project-skill sets.
const _skillsCache = new Map<string, SkillEntry[]>();
const _skillsPromise = new Map<string, Promise<SkillEntry[]>>();

function defaultLoadSkills(id?: string | null): Promise<SkillEntry[]> {
  const key = id ?? '';
  const hit = _skillsCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = _skillsPromise.get(key);
  if (inflight) return inflight;
  const p = listSkills(id)
    .then((s) => {
      _skillsCache.set(key, s);
      _skillsPromise.delete(key);
      return s;
    })
    .catch(() => {
      _skillsPromise.delete(key); // allow retry on next open
      return [] as SkillEntry[];
    });
  _skillsPromise.set(key, p);
  return p;
}

// Module-level per-session cache for the agent list (mirrors the skills cache).
// Fetched via GET /api/agents?id=<sessionId> → lib/subagents.js listAgents.
const _agentsCache = new Map<string, AgentEntry[]>();
const _agentsPromise = new Map<string, Promise<AgentEntry[]>>();

function defaultLoadAgents(id?: string | null): Promise<AgentEntry[]> {
  const key = id ?? '';
  const hit = _agentsCache.get(key);
  if (hit) return Promise.resolve(hit);
  const inflight = _agentsPromise.get(key);
  if (inflight) return inflight;
  const p = listAgents(id)
    .then((a) => {
      _agentsCache.set(key, a);
      _agentsPromise.delete(key);
      return a;
    })
    .catch(() => {
      _agentsPromise.delete(key); // allow retry on next open
      return [] as AgentEntry[];
    });
  _agentsPromise.set(key, p);
  return p;
}

// A completed leading slash-command (name followed by a space) — used to derive
// the active-skill chip. Requires trailing whitespace so a name that is a prefix
// of another (e.g. `100x:plan` vs `100x:plan-hard`) does NOT fire early while
// the user is still typing.
const SLASH_DONE_RE = /^\/([A-Za-z0-9:_-]+)\s/;
const AC_MAX = 4;

interface ComposerProps {
  disabled: boolean;
  /** True while the selected session's transcript is still loading from the
   *  server (see Thread's `loading` prop / useCockpit's `messagesLoaded`).
   *  Purely a copy hint — `disabled` already carries the send-blocking gate;
   *  this only swaps the placeholder to something more specific than "Select
   *  a session…" while a session IS selected but not yet ready. */
  loading?: boolean;
  /** Active session id — used to scope the enhance/review state so an
   *  improvement from one session can't leak into another on switch. */
  sessionId?: string | null;
  /** Per-session sub-agent mode. Defaults to true when not provided. */
  subAgentMode?: SubAgentMode;
  /** Called when the sub-agent checkbox changes. */
  onSubAgentModeChange?: (mode: SubAgentMode) => void;
  /** Called when the Composer's >_ terminal mode changes, so callers can gate
   *  the sub-agent prefix (which must not corrupt shell commands). */
  onTerminalModeChange?: (active: boolean) => void;
  /** True while the selected Claude session is actively generating/thinking.
   *  Flips the primary send button into a STOP button. Ignored in terminal mode. */
  working?: boolean;
  /** True while the selected Claude session is compacting its conversation. The
   *  composer blocks sends and shows a "Compacting…" progress strip so it never
   *  looks hung. */
  compacting?: boolean;
  /** True while a dormant remote session's "Resume & send" call is in flight
   *  (Phase C, C5). Mirrors `compacting`'s gating: blocks further sends and
   *  shows a progress strip so a ~2min resume round trip never looks hung. */
  resuming?: boolean;
  /** True when the selected session hit an API error and stalled — shows a Retry strip. */
  errored?: boolean;
  /** Called when the user clicks Retry on the error strip (sends "Continue"). */
  onRetry?: () => void;
  /** Called when the user clicks the STOP button (or presses Esc from App).
   *  Should send Escape to the session's Claude pane. */
  onStop?: () => void;
  /** Active inline prompt (AskUserQuestion or PanePrompt). When non-null the
   *  composer morphs to show the inline prompt body instead of the input. */
  askActive?: boolean;
  activePrompt?: ActivePrompt | null;
  onAnswer?: (toolUseId: string, selections: AnswerSelection[]) => void;
  onKey?: (key: string) => void;
  onSelect?: (labels: string[]) => void;
  onReply?: (text: string) => void;
  services?: Partial<ComposerServices>;
}

export interface ComposerServices {
  optimizePrompt: (text: string) => Promise<OptimizeResult>;
  loadSkills: (id?: string | null) => Promise<SkillEntry[]>;
  loadAgents: (id?: string | null) => Promise<AgentEntry[]>;
}

const DEFAULT_SERVICES: ComposerServices = {
  optimizePrompt: optimizePromptApi,
  loadSkills: defaultLoadSkills,
  loadAgents: defaultLoadAgents,
};

// Image preview for an image attachment that still carries its File (pending),
// otherwise a placeholder. Object URLs are revoked on unmount.
function AttachmentThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) return <div className="chip-thumb chip-thumb-empty" />;
  // Tap the thumbnail to open the full image in an in-app lightbox modal (NOT a
  // new tab — that loses app focus/context). Same Lightbox the transcript uses.
  return (
    <>
      <img
        className="chip-thumb"
        src={url}
        alt=""
        role="button"
        tabIndex={0}
        title="Open preview"
        onClick={() => setLightboxOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setLightboxOpen(true);
          }
        }}
      />
      {lightboxOpen ? (
        <Lightbox src={url} alt={file.name} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </>
  );
}

// Composer attachment chip: image thumbnail for images, filename otherwise,
// with a remove button. Rendered inside ComposerPrimitive.Attachments, which
// provides each attachment's runtime context (so AttachmentPrimitive.Remove
// works).
function AttachmentChip({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.type === 'image';
  // The adapter uploads eagerly in add(), so by the time a chip renders the
  // upload is already done — show the spinner ONLY while genuinely running.
  // (Composer attachments are never `complete`; that status is post-send.)
  const uploading = attachment.status.type === 'running';
  return (
    <AttachmentPrimitive.Root className="attach-chip" data-pending={uploading}>
      {isImage && attachment.file ? (
        <AttachmentThumb file={attachment.file} />
      ) : (
        <span className="chip-icon" aria-hidden="true">
          {attachment.type === 'document' ? '📄' : '📎'}
        </span>
      )}
      <span className="chip-name" title={attachment.name}>
        {attachment.name}
      </span>
      {uploading ? <span className="chip-spinner" aria-hidden="true" /> : null}
      <AttachmentPrimitive.Remove
        className="chip-remove"
        aria-label={`Remove ${attachment.name}`}
      >
        ×
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

/**
 * assistant-ui composer wired to the cockpit:
 * - Plain Enter inserts a newline; ⌘/Ctrl+Enter optimises (default send),
 *   ⌘/Ctrl+Shift+Enter bypasses the optimiser and sends the raw text.
 * - The reply send + "sent →" toast happen in App's onNew adapter (where the
 *   WS reply is dispatched); this just renders the UI.
 * - Attachments use assistant-ui's native attachment system: the 📎 button is
 *   ComposerPrimitive.AddAttachment (driven by the attachment adapter on the
 *   runtime), pending/uploaded files render as chips above the input, and on
 *   send onNew appends each attachment's uploaded absolute path to the reply
 *   text. Paths are NEVER injected into the textarea.
 */
/** Per-session enhance state: an in-progress flag + a ready review. */
type EnhanceState = {
  optimizing: boolean;
  review: (OptimizeResult & { original: string }) | null;
};
const EMPTY_ENHANCE: EnhanceState = { optimizing: false, review: null };

export function Composer({
  disabled,
  loading = false,
  sessionId,
  subAgentMode = true,
  onSubAgentModeChange,
  onTerminalModeChange,
  working = false,
  compacting = false,
  resuming = false,
  errored = false,
  onRetry,
  onStop,
  askActive = false,
  activePrompt = null,
  onAnswer,
  onKey,
  onSelect,
  onReply,
  services,
}: ComposerProps) {
  const composer = useComposerRuntime();
  const shell = useShell();
  const composerServices = useMemo<ComposerServices>(
    () => ({ ...DEFAULT_SERVICES, ...(services ?? {}) }),
    [services],
  );
  const customServices = services != null;
  const [empty, setEmpty] = useState(true);
  // NOTE: SkillBrowser now unreachable via UI (inline / typing replaced the
  // toolbar slash button). State + component kept to avoid risky dead-code removal.
  const [skillBrowserOpen, setSkillBrowserOpen] = useState(false);
  // Terminal (>_) mode: the composer runs shell command lines in a dedicated
  // server-side pane instead of replying to Claude. `terminal` = currently SHOWN;
  // `termWarm` = TerminalView is mounted+polling (kept warm so re-opens don't
  // flash a loader). Opening the first time warms it; closing only hides it; the
  // real unload happens on session change (the effect below resets both).
  const [terminal, setTerminal] = useState(false);
  const [termWarm, setTermWarm] = useState(false);
  const termWrapRef = useRef<HTMLDivElement>(null);
  const openTerminal = useCallback(() => {
    setTermWarm(true);
    setTerminal(true);
    onTerminalModeChange?.(true);
  }, [onTerminalModeChange]);

  // Real unload on session change: drop the warm terminal and hide it.
  useEffect(() => {
    setTerminal(false);
    setTermWarm(false);
    onTerminalModeChange?.(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Cosmetic show/hide of the kept-warm terminal (fade + zoom). The element stays
  // mounted + polling while hidden, so re-opening is instant (no loader flash).
  useEffect(() => {
    const el = termWrapRef.current;
    if (!el) return;
    if (terminal) {
      el.style.display = '';
      if (prefersReducedMotion()) {
        gsap.set(el, { opacity: 1, scale: 1, y: 0 });
        return;
      }
      gsap.fromTo(
        el,
        { opacity: 0, scale: 0.95, y: 8 },
        { opacity: 1, scale: 1, y: 0, duration: 0.26, ease: 'power3.out', transformOrigin: 'bottom center' },
      );
    } else if (prefersReducedMotion()) {
      el.style.display = 'none';
    } else {
      gsap.to(el, {
        opacity: 0,
        scale: 0.95,
        y: 8,
        duration: 0.18,
        ease: 'power2.in',
        transformOrigin: 'bottom center',
        onComplete: () => {
          el.style.display = 'none';
        },
      });
    }
  }, [terminal, termWarm]);
  // Enhance state BOUND PER SESSION (keyed by session id), like the per-session
  // AskUserQuestion pending state. The Composer stays mounted across session
  // switches, so this map persists: switching away preserves an in-progress or
  // ready improvement, switching back restores it, and an improvement can never
  // leak into (or be accepted onto) a different session.
  const [enhanceBySession, setEnhanceBySession] = useState<Record<string, EnhanceState>>({});
  const key = sessionId ?? '';
  const { optimizing, review } = enhanceBySession[key] ?? EMPTY_ENHANCE;

  const patchEnhance = useCallback((sid: string, patch: Partial<EnhanceState>) => {
    setEnhanceBySession((m) => ({ ...m, [sid]: { ...(m[sid] ?? EMPTY_ENHANCE), ...patch } }));
  }, []);

  // Keep the cursor in the composer after a send (incl. after the optimise modal
  // closes) so the user can immediately type the next message and follow the
  // streaming response without re-clicking.
  const refocusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
    });
  }, []);

  // Pulse the primary send button while a prompt is being optimised (in flight).
  const sendBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = sendBtnRef.current;
    if (!el) return;
    if (optimizing && !prefersReducedMotion()) {
      const tween = gsap.to(el, {
        scale: 1.08,
        duration: 0.5,
        ease: 'sine.inOut',
        repeat: -1,
        yoyo: true,
      });
      return () => {
        tween.kill();
        gsap.set(el, { scale: 1 });
      };
    }
    gsap.set(el, { scale: 1 });
  }, [optimizing]);

  // ── Inline skill + agent autocomplete ────────────────────────────────────
  const [skills, setSkills] = useState<SkillEntry[]>(
    () => (customServices ? [] : _skillsCache.get(sessionId ?? '') ?? []),
  );
  const [agents, setAgents] = useState<AgentEntry[]>(
    () => (customServices ? [] : _agentsCache.get(sessionId ?? '') ?? []),
  );
  const [text, setTextMirror] = useState('');     // mirror of composer text
  const [caret, setCaret] = useState(0);           // textarea selectionStart
  const [acIndex, setAcIndex] = useState(0);       // highlighted suggestion
  const [acDismissed, setAcDismissed] = useState(false); // Esc / just-selected

  // Re-fetch skills whenever the session changes (different sessions may have
  // different project skills). The cache prevents redundant network calls.
  useEffect(() => {
    let alive = true;
    const cached = customServices ? null : _skillsCache.get(sessionId ?? '');
    if (cached) {
      setSkills(cached);
    } else {
      composerServices.loadSkills(sessionId)
        .then((s) => {
          if (alive) setSkills(s);
        })
        // Don't let a transient skills-API error silently leave the inline
        // autocomplete + skill browser empty forever.
        .catch(() => {
          if (alive) setSkills([]);
        });
    }
    return () => { alive = false; };
  }, [composerServices, customServices, sessionId]);

  // Re-fetch agents whenever the session changes (mirrors skills fetch above).
  useEffect(() => {
    let alive = true;
    const cached = customServices ? null : _agentsCache.get(sessionId ?? '');
    if (cached) {
      setAgents(cached);
    } else {
      composerServices.loadAgents(sessionId)
        .then((a) => {
          if (alive) setAgents(a);
        })
        .catch(() => {
          if (alive) setAgents([]);
        });
    }
    return () => { alive = false; };
  }, [composerServices, customServices, sessionId]);

  // Track composer text → drives both the empty flag and the slash detection.
  // ALSO refresh the caret here: this subscribe fires on every committed text
  // change — crucially including iOS soft-keyboard input, which often does NOT
  // emit keyup/keydown (so the onKeyUp caret handler never runs on iPad). It runs
  // AFTER the controlled value commits, so it can't reset typing. Without this,
  // the slash-autocomplete never opens on a touch keyboard.
  useEffect(() => {
    const sync = () => {
      const t = composer.getState().text ?? '';
      setTextMirror(t);
      setEmpty(!t.trim());
      const ta = document.querySelector<HTMLTextAreaElement>('.composer-input');
      if (ta) setCaret(ta.selectionStart ?? t.length);
    };
    sync();
    return composer.subscribe(sync);
  }, [composer]);

  // Track caret position for caret-aware slash autocomplete (Fix 2). MUST use
  // React SYNTHETIC handlers on the Input (onKeyUp/onClick/onSelect below), NOT
  // native 'input'/'selectionchange' listeners: those fire DURING the input
  // event, before assistant-ui's controlled onChange commits the new text, so the
  // setCaret re-render would render the Input with the stale (empty) runtime text
  // and wipe every keystroke (see repro). Synthetic handlers fire after onChange.
  const updateCaret = useCallback((el: HTMLTextAreaElement | null) => {
    if (el) setCaret(el.selectionStart ?? 0);
  }, []);

  // Active trigger token at the current caret — drives autocomplete suggestions.
  // Detects both `/skill` (trigger='/') and `@agent` (trigger='@') tokens.
  const activeToken = useMemo<TriggerToken | null>(
    () => triggerTokenAt(text, caret),
    [text, caret],
  );
  const acQuery = activeToken ? activeToken.query : null;

  // Reset highlight + un-dismiss whenever the query changes (new keystroke).
  useEffect(() => {
    setAcIndex(0);
    setAcDismissed(false);
  }, [acQuery]);

  const acItems = useMemo(() => {
    if (acQuery == null || acDismissed) return [];
    const q = acQuery.toLowerCase();
    // '@' trigger → search agents; '/' trigger → search skills.
    const source: (SkillEntry | AgentEntry)[] = activeToken?.trigger === '@' ? agents : skills;
    return source
      .filter((s) => s.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prefix matches first, then alphabetical.
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return ap !== bp ? ap - bp : a.name.localeCompare(b.name);
      })
      .slice(0, AC_MAX);
  }, [acQuery, acDismissed, activeToken?.trigger, skills, agents]);
  const acOpen = !terminal && acItems.length > 0;

  // Active-skill chip: the leading `/<skill>` once it's a known, completed name.
  const activeSkill = useMemo(() => {
    const m = SLASH_DONE_RE.exec(text);
    return m && skills.some((s) => s.name === m[1]) ? m[1] : null;
  }, [text, skills]);

  const selectSkill = useCallback(
    (name: string) => {
      const token = activeToken;
      // Use the trigger char that opened this autocomplete ('@' for agents, '/' for skills).
      const replacement = (token?.trigger === '@' ? '@' : '/') + name + ' ';
      if (token) {
        // Splice: replace only the trigger-token at the caret, preserve surrounding text.
        const current = composer.getState().text ?? '';
        const spliced = current.slice(0, token.start) + replacement + current.slice(token.end);
        composer.setText(spliced);
        // Restore caret to right after the inserted replacement.
        const newCaret = token.start + replacement.length;
        requestAnimationFrame(() => {
          const ta = document.querySelector<HTMLTextAreaElement>('.composer-input');
          if (ta) {
            ta.focus();
            ta.setSelectionRange(newCaret, newCaret);
            setCaret(newCaret);
          }
        });
      } else {
        composer.setText(replacement);
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('.composer-input')?.focus();
        });
      }
      setAcDismissed(true);
    },
    [composer, activeToken],
  );

  // ── Voice dictation (inline mode) ────────────────────────────────────────
  // Voice mode flips the composer body into a waveform + status label, and the
  // toolbar into Cancel / Pause-Resume / Stop & Transcribe. No modal — the
  // transcript stays readable behind the composer. Mirrors the terminal mode
  // pattern (data-voice on .composer-card, toolbar swaps, body swaps).
  //
  // Pre-render strategy: VoiceInline is ALWAYS mounted (the shell is in the DOM
  // while idle). When idle the .voice-inline-body is display:none so it adds
  // zero height to the composer. `voice` = logical/desired state (mic gated).
  // The VoiceInline receives `active={voice && voiceMicOn}` — mic is acquired
  // ONLY once the ENTER morph has finished (see voiceMicOn below).
  const [voice, setVoice] = useState(false);
  // TRIGGER-LAG FIX: gate mic acquisition on morph completion. getUserMedia +
  // AudioContext init do real synchronous main-thread work; when they run in
  // parallel with the ENTER morph (as `active={voice}` did) they starve the
  // rAF ticker — the GSAP timeline visibly freezes mid-tween, then time-jumps
  // to its end state when the thread unblocks (measured ~0.8s on a cold mic).
  // Flipped true by ENTER Phase 2's onComplete (or immediately on the
  // reduced-motion path); reset by the effect below whenever voice drops.
  const [voiceMicOn, setVoiceMicOn] = useState(false);
  // Ref for the .composer-card so we can reach into it for animation targets.
  const composerCardRef = useRef<HTMLDivElement>(null);
  // Guard: only one in-flight timeline at a time (avoids enter/exit overlap).
  const voiceAnimRef = useRef<gsap.core.Timeline | null>(null);
  // Ref to the always-mounted voice-inline-body so we can toggle display:none
  // without React re-renders (layout read happens in useLayoutEffect).
  const voiceBodyRef = useRef<HTMLDivElement>(null);
  // Tracks whether the ENTER Phase 2 reveal has completed. VoiceInline's
  // Pause button uses this to decide whether to run its own entrance
  // (late-mount path) or stay pre-hidden (Phase 2 will reveal it in order).
  const phase2DoneRef = useRef<boolean>(false);
  // FIX B: Skip the morph useLayoutEffect on initial mount (and on any run
  // where voice is false and we haven't yet had a true→false transition).
  // Without this guard the initial-mount run hits the EXIT branch which tries
  // to animate the card from voice→composer on first render — causing the
  // "composer starts big then snaps in" symptom on session load/switch.
  // The ref starts false; it's set to true on the first real voice=true run.
  const voiceMorphHasRunRef = useRef<boolean>(false);

  // ── Ask-inline morph refs (mirrors voice morph) ────────────────────────────
  const askAnimRef = useRef<gsap.core.Timeline | null>(null);
  const askBodyRef = useRef<HTMLDivElement>(null);
  const askMorphHasRunRef = useRef<boolean>(false);
  // True while the main composer↔ask morph is running, so the height-follow
  // ResizeObserver below doesn't fight it.
  const askMorphingRef = useRef<boolean>(false);

  const openVoice = useCallback(() => {
    if (disabled) return;
    if (askActive) return; // inline prompt has priority
    setVoice(true);
  }, [disabled, askActive]);

  // Mic gate follows voice down: any exit (Cancel, Esc, session switch resetting
  // voice) immediately de-activates the mic so VoiceInline tears the stream down.
  useEffect(() => {
    if (!voice) setVoiceMicOn(false);
  }, [voice]);

  const exitVoice = useCallback(() => {
    // FIX A: Pin the card to its current rendered height BEFORE flipping voice
    // state. Without this pin, the React re-render triggered by setVoice(false)
    // unmounts the Pause button row (showPauseBtn = false when status resets to
    // 'starting'), which reflows the height:auto card shorter INSTANTLY — before
    // the EXIT useLayoutEffect reads heightFrom. The tween then starts from the
    // already-shrunken value, producing a visible one-bar upward jump.
    // Pinning here captures the true pre-cancel height; the EXIT effect reads the
    // pinned value and clears the pin (card.style.height='') on completion.
    const card = composerCardRef.current;
    if (card) card.style.height = card.offsetHeight + 'px';
    setVoice(false);
  }, []);

  // Drive the two-phase ENTER / EXIT GSAP timelines whenever `voice` changes.
  //
  // ENTER (composer → voice) — strictly sequenced:
  //   Phase 1: stagger composer toolbar buttons out ONE-BY-ONE + fade input/body
  //            out + tween .composer-card height FROM→TO (voice height).
  //   Gap:     explicit T.gap delay after Phase 1; overflow cleared + height
  //            settled to auto BEFORE Phase 2 starts so nothing is clipped.
  //   Phase 2: reveal transcriber top group (status + wave + hint), THEN
  //            reveal each voice action button ONE-BY-ONE (targets individual
  //            child buttons inside .voice-toolbar, NOT the container).
  //
  // EXIT (voice → composer) — symmetric reverse:
  //   Phase 1: hide each voice toolbar button ONE-BY-ONE + fade top group out
  //            + tween .composer-card height back.
  //   Gap:     same T.gap settle delay.
  //   Phase 2: fade in composer body + reveal each composer toolbar button
  //            ONE-BY-ONE in succession.
  //
  // Pre-render model: VoiceInline is always mounted. When idle the
  // .voice-inline-body has display:none (set by this effect on exit, or on
  // the initial render path). On ENTER we un-hide it (display:'') THEN
  // immediately pre-hide child targets with gsap.set BEFORE paint so Phase 2
  // reveals existing nodes instead of newly-mounted ones — eliminating the
  // flash-of-full-opacity-before-effect frame that useEffect had.
  //
  // Height tween without a plugin (manual FLIP):
  //   We measure FROM = card.offsetHeight, then temporarily float the
  //   to-be-hidden elements out of flow (position:absolute) so their layout
  //   contribution is removed, read card.offsetHeight as TO, restore them,
  //   pin the card at FROM explicitly, force a reflow, then tween FROM → TO.
  //   After Phase 1 completes (+ gap) we clear the inline height (back to auto)
  //   BEFORE Phase 2 so buttons are never clipped by overflow:hidden.
  //
  // ── Minimum composer height floor ───────────────────────────────────────────
  // Matches the single-row composer resting height:
  //   card border (2) + card padding top+bottom (20) + textarea single-row (28)
  //   + flex gap (8) + toolbar button height (34) ≈ 92px.
  // Used as the lower clamp for the voice-morph height tween so the card never
  // collapses to near-zero even if the voice-body measurement returns low.
  // The CSS .composer-card min-height mirrors this constant.
  const COMPOSER_MIN_HEIGHT = 96;

  // ── Timing constants — production tempo. ────────────────────────────────────
  // All durations in seconds; all stagger values are per-element delays.
  // Ratios are preserved from the original slow values so phasing reads the same.
  // Values are ×0.85 of the previous set (15% faster; cumulatively ~0.47 of the
  // original slow tempo).
  const T = {
    fade:       0.094,  // per-element fade duration (in or out)
    height:     0.102,  // card height tween duration (ENTER)
    btnStagger: 0.017,  // delay between successive button reveals/hides
    topStagger: 0.014,  // delay between status / wave / hint reveals
    gap:        0.038,  // pause between Phase 1 completion and Phase 2 start
    enterEase:  ANIM.enterEase,
    exitEase:   ANIM.exitEase,
  } as const;

  useLayoutEffect(() => {
    const card = composerCardRef.current;
    if (!card) return;

    // FIX B: Skip the morph entirely when voice is false and no ENTER has run
    // yet. This covers: (a) initial mount, (b) session-switch where the effect
    // re-runs because `voice` was reset to false by the session-change effect.
    // In both cases voice was never true, so there is no voice→composer
    // transition to animate — the composer should just render statically.
    if (!voice && !voiceMorphHasRunRef.current) return;

    // Mark that we've had at least one ENTER — future false runs are real exits.
    if (voice) voiceMorphHasRunRef.current = true;

    // Kill any in-flight timeline before starting a new one.
    voiceAnimRef.current?.kill();
    voiceAnimRef.current = null;

    if (voice) {
      // ── ENTER: composer → voice morph ────────────────────────────────────────
      //
      // Phase 1a: stagger composer toolbar buttons out ONE-BY-ONE + fade input out.
      //           NO height tween yet, NO overflow:hidden — buttons exit VISIBLY.
      // Phase 1b: after 1a completes, pin height + apply overflow:hidden, THEN
      //           tween the card height FROM → TO (composer → voice height).
      // Gap:      explicit T.gap delay after Phase 1b; overflow cleared + height
      //           settled to auto BEFORE Phase 2 starts so nothing is clipped.
      // Phase 2:  reveal transcriber top group (status + wave + hint), THEN
      //           reveal each voice action button ONE-BY-ONE.
      //
      // HEIGHT-JUMP FIX:
      //   heightFrom is captured BEFORE voiceBody is shown (while it is still
      //   display:none). The card's intrinsic height at that moment equals the
      //   composer-only height. We pin the card at heightFrom immediately after,
      //   THEN show the voiceBody and measure heightTo (voice-only). Because the
      //   card is pinned before voiceBody enters flow there is no frame where the
      //   card's layout height = compositor + voice stacked — no jump.
      //
      // BUTTON CLIP FIX:
      //   overflow:hidden is NOT applied during Phase 1a so the staggered button
      //   exit is fully visible. It is applied only just before the height tween
      //   (Phase 1b), at which point there is no longer any visible content to clip.

      const voiceBody   = voiceBodyRef.current;
      const toolbar     = card.querySelector<HTMLElement>('.composer-toolbar:not(.voice-toolbar)');
      const inputWrap   = card.querySelector<HTMLElement>('.composer-input-wrap');

      // Reduced-motion: instant swap — no tweens. Mic can start right away
      // (there is no timeline to starve).
      if (prefersReducedMotion()) {
        if (voiceBody) voiceBody.style.display = 'flex';
        if (inputWrap) gsap.set(inputWrap, { display: 'none' });
        setVoiceMicOn(true);
        return;
      }

      // ── Measure heights (no-jump order). ────────────────────────────────────
      // FROM = current card height while voiceBody is still display:none —
      //        this is the composer-only height and is the correct start value.
      const heightFrom = card.offsetHeight;

      // Pin the card at FROM *before* voiceBody enters flow so the card never
      // renders taller than heightFrom for even a single frame.
      card.style.height = `${heightFrom}px`;
      // NOTE: overflow is NOT locked yet — we need the buttons to be visible
      // during Phase 1a. It will be applied in Phase 1b right before the tween.

      // Now it is safe to un-hide the voice body; the card is pinned in height.
      if (voiceBody) voiceBody.style.display = 'flex';

      // Defensively clear any position/visibility overrides left on voice children
      // from a prior animation cycle (e.g. a prior exit phase that floated something
      // out of flow). While opacity and transform do NOT affect offsetHeight,
      // position:absolute and visibility:hidden DO affect flow layout. This ensures
      // the voiceBody's children are genuinely in normal flow when we measure below.
      if (voiceBody) {
        voiceBody.querySelectorAll<HTMLElement>('*').forEach((el) => {
          if (el.style.position)   el.style.position   = '';
          if (el.style.visibility) el.style.visibility = '';
        });
      }

      // TO = voice-only height: temporarily float composer elements out of flow
      // so the card's intrinsic height collapses to the voice body alone.
      // Clear the pinned height temporarily so card.offsetHeight reads intrinsic.
      if (inputWrap) {
        inputWrap.style.position   = 'absolute';
        inputWrap.style.visibility = 'hidden';
      }
      if (toolbar) {
        toolbar.style.position   = 'absolute';
        toolbar.style.visibility = 'hidden';
      }
      card.style.height = '';  // clear pin so we read intrinsic voice-only height
      const rawHeightTo = card.offsetHeight;
      // Clamp: never let the tween target fall below COMPOSER_MIN_HEIGHT.
      // This prevents any near-zero measurement (e.g. when voiceBody hasn't fully
      // laid out yet) from collapsing the card to near-zero during Phase 1b.
      const heightTo = Math.max(rawHeightTo, COMPOSER_MIN_HEIGHT);
      card.style.height = `${heightFrom}px`;  // restore pin
      // Restore.
      if (inputWrap) { inputWrap.style.position = ''; inputWrap.style.visibility = ''; }
      if (toolbar)   { toolbar.style.position   = ''; toolbar.style.visibility   = ''; }

      void card.offsetHeight; // force reflow so GSAP starts from the pinned value

      const voiceStatus  = card.querySelector<HTMLElement>('.voice-status');
      const voiceWave    = card.querySelector<HTMLElement>('.voice-wave-inline');
      const voiceHintEl  = card.querySelector<HTMLElement>('.voice-hint, .voice-error');
      const voiceToolbar = card.querySelector<HTMLElement>('.voice-toolbar');

      // Individual voice toolbar buttons (revealed one-by-one in Phase 2 —
      // targeting children NOT the container avoids clipping from overflow:hidden).
      const voiceBtns = voiceToolbar
        ? Array.from(voiceToolbar.querySelectorAll<HTMLElement>('button, [role="button"]'))
        : [];

      // Ensure inputWrap is visible at the start of the enter animation
      // (it may have display:none from a prior reduced-motion session).
      if (inputWrap) gsap.set(inputWrap, { clearProps: 'display,position,visibility', opacity: 1, y: 0 });

      // Pre-hide voice targets BEFORE paint (useLayoutEffect guarantee) so they
      // start invisible and Phase 2 slides them in — no flash of final state.
      // Target individual buttons (NOT the toolbar container) so Phase 2 can
      // reveal them while the container itself remains at full opacity/position.
      const topTargets = [voiceStatus, voiceWave, voiceHintEl].filter(Boolean) as HTMLElement[];
      if (topTargets.length) gsap.set(topTargets, { opacity: 0, y: -16 });
      // Ensure toolbar container is fully visible — only its children are hidden.
      if (voiceToolbar) gsap.set(voiceToolbar, { clearProps: 'opacity,y' });
      if (voiceBtns.length) gsap.set(voiceBtns, { opacity: 0, y: 12 });

      // Toolbar action buttons (children of .composer-toolbar) for per-item stagger.
      const toolbarBtns = toolbar
        ? Array.from(toolbar.querySelectorAll<HTMLElement>('button, label, [role="button"]'))
        : [];

      // ── Phase 2 builder: reveal voice action buttons ─────────────────────────
      // Called from Phase 1b's onComplete after the T.gap settle delay so that
      // overflow:hidden is fully cleared and height is auto before any button
      // tries to render outside the previous clipped bounds. The top group
      // (status/wave/hint) is NOT revealed here — it comes in DURING the Phase
      // 1b height tween (see runPhase1b) so the transcriber appears the moment
      // the card starts morphing instead of after the full settle chain.
      //
      // PAUSE-ORDER FIX: re-query voice buttons fresh at Phase 2 run-time (not
      // at closure-capture time) so that a Pause button that mounted late
      // (status flip to 'recording' after Phase 2 started) is included. Buttons
      // are ordered explicitly Cancel → Stop → Pause so the stagger always
      // reveals them in that order regardless of DOM order or mount timing.
      const runPhase2Enter = () => {
        // Re-query fresh at execution time to catch any buttons that mounted
        // between Phase 1b start and Phase 2 start (e.g. Pause mounting late).
        const lateCancelBtn = card.querySelector<HTMLElement>('.voice-btn-cancel');
        const lateStopBtn   = card.querySelector<HTMLElement>('.voice-btn-stop');
        const latePauseBtn  = card.querySelector<HTMLElement>('.voice-btn-pause');
        // Explicit order: Cancel → Stop → Pause. Pause is always last.
        const orderedVoiceBtns = [lateCancelBtn, lateStopBtn, latePauseBtn]
          .filter((b): b is HTMLElement => b !== null);
        // Pre-hide any button not already hidden (e.g. Pause mounted after the
        // initial gsap.set(voiceBtns, ...) above ran on the old capture).
        orderedVoiceBtns.forEach((btn) => {
          const opacity = parseFloat(btn.style.opacity);
          if (btn.style.opacity === '' || isNaN(opacity) || opacity > 0) {
            gsap.set(btn, { opacity: 0, y: 12 });
          }
        });

        const phase2 = gsap.timeline({
          onComplete: () => {
            // Signal that Phase 2 has fully completed — VoiceInline's Pause
            // mount guard reads this to decide whether to self-animate.
            phase2DoneRef.current = true;
            // Morph is fully settled — NOW start the mic. getUserMedia /
            // AudioContext init block the main thread; running them here (not
            // at tap time) keeps the enter timeline stall-free.
            setVoiceMicOn(true);
          },
        });

        // Reveal each voice button in explicit order Cancel → Stop → Pause.
        // Targets individual buttons, NOT the container — avoids clip. (The top
        // group is already in from Phase 1b, so buttons start immediately.)
        if (orderedVoiceBtns.length) {
          phase2.to(
            orderedVoiceBtns,
            {
              opacity: 1, y: 0,
              duration: T.fade, ease: T.enterEase,
              stagger: T.btnStagger,
            },
            0,
          );
        } else if (voiceToolbar) {
          phase2.to(
            voiceToolbar,
            { opacity: 1, y: 0, duration: T.fade, ease: T.enterEase },
            0,
          );
        }

        voiceAnimRef.current = phase2;
      };

      // ── Phase 1b: height morph + top-group reveal ────────────────────────────
      // Called when 1a (buttons/input out) is complete. At this point there is no
      // visible content that could be clipped, so it is safe to apply
      // overflow:hidden and tween the card height to the voice-only size.
      //
      // TRIGGER-LAG FIX: the transcriber top group (status / wave / hint) is
      // revealed HERE, in parallel with the height tween — not in Phase 2. It
      // sits at the TOP of the card so the morphing bottom edge can never clip
      // it, and inputWrap is taken out of flow at 1b start (it is already fully
      // invisible after 1a) so the top group renders at its final layout
      // position from the first frame — no post-settle jump. Only the bottom
      // action buttons still wait for the T.gap settle (Phase 2): they are the
      // ones that would clip against the tweening bottom edge.
      const runPhase1b = () => {
        // All composer content is now invisible — take the input out of flow so
        // the in-flow layout matches the measured heightTo, and lock overflow
        // for the height tween. (toolbar keeps its flow slot, as before — only
        // its already-invisible children were animated.)
        if (inputWrap) gsap.set(inputWrap, { display: 'none' });
        if (toolbar)   gsap.set(toolbar,   { clearProps: 'opacity,y' });
        card.style.overflow = 'hidden';
        void card.offsetHeight; // force reflow so the new overflow takes effect

        const phase1b = gsap.timeline({
          onComplete: () => {
            // Frame has settled — restore card to auto height, clear overflow
            // lock (MUST happen before Phase 2 so buttons aren't clipped).
            // After T.gap, fire Phase 2 (action-button reveal).
            card.style.height   = '';
            card.style.overflow = '';
            gsap.delayedCall(T.gap, runPhase2Enter);
          },
        });

        phase1b.to(
          card,
          { height: heightTo, duration: T.height, ease: T.exitEase },
          0,
        );

        // Top group in DURING the morph — this is the moment the transcriber
        // visibly "arrives"; previously it waited for height + gap to settle.
        if (topTargets.length) {
          phase1b.to(
            topTargets,
            {
              opacity: 1, y: 0,
              duration: T.fade, ease: T.enterEase,
              stagger: T.topStagger,
            },
            0,
          );
        }

        voiceAnimRef.current = phase1b;
      };

      // ── Phase 1a timeline: buttons + input out (no height change, no clip) ───
      // Stagger composer toolbar buttons out ONE-BY-ONE + fade inputWrap out.
      // overflow:hidden is NOT applied here — buttons must exit visibly.
      const phase1a = gsap.timeline({
        onComplete: runPhase1b,
      });

      // Stagger composer toolbar buttons out ONE-BY-ONE.
      if (toolbarBtns.length) {
        phase1a.to(
          toolbarBtns,
          { opacity: 0, y: 4, duration: T.fade, ease: T.exitEase, stagger: T.btnStagger },
          0,
        );
      } else if (toolbar) {
        phase1a.to(toolbar, { opacity: 0, y: 4, duration: T.fade, ease: T.exitEase }, 0);
      }

      // Fade + nudge inputWrap out alongside the buttons.
      if (inputWrap) {
        phase1a.to(
          inputWrap,
          { opacity: 0, y: 6, duration: T.fade, ease: T.exitEase },
          0,
        );
      }

      voiceAnimRef.current = phase1a;

    } else {
      // ── EXIT: voice → composer morph ─────────────────────────────────────────
      //
      // Mirror of ENTER (exact reverse):
      //   Phase 1 = transcriber out (card stays at transcriber height so nothing
      //             is clipped and the exit is fully visible).
      //             Reverse of ENTER Phase 2: voice buttons out one-by-one, then
      //             top group (status/wave/hint) out.
      //   Gap     = T.gap settle pause.
      //   Phase 2 = FLIP-measure composer height, tween card height back, then
      //             reveal composer inputWrap + toolbar buttons one-by-one.
      //             Reverse of ENTER Phase 1.
      //
      // HEIGHT-JUMP FIX (EXIT):
      //   heightFrom is captured before inputWrap is restored to flow (it is
      //   display:none from ENTER's phase1 onComplete). heightTo is measured by
      //   temporarily floating voiceBody out while inputWrap re-enters flow.
      //   The card is pinned at heightFrom before activating the tween, so there
      //   is no frame where composer + voice are stacked.

      // Reset phase2 completion signal — next ENTER starts fresh.
      phase2DoneRef.current = false;

      const voiceBody       = voiceBodyRef.current;
      const voiceToolbar    = card.querySelector<HTMLElement>('.voice-toolbar');
      const voiceStatus     = card.querySelector<HTMLElement>('.voice-status');
      const voiceWave       = card.querySelector<HTMLElement>('.voice-wave-inline');
      const voiceHintEl     = card.querySelector<HTMLElement>('.voice-hint, .voice-error');
      const toolbar         = card.querySelector<HTMLElement>('.composer-toolbar:not(.voice-toolbar)');
      const inputWrap       = card.querySelector<HTMLElement>('.composer-input-wrap');

      // Reduced-motion: instant swap — hide voice body immediately + refocus.
      if (prefersReducedMotion()) {
        if (voiceBody) voiceBody.style.display = 'none';
        if (inputWrap) gsap.set(inputWrap, { clearProps: 'all' });
        if (toolbar)   gsap.set(toolbar,   { clearProps: 'all' });
        // FIX 2 (reduced-motion): return focus to the composer textarea.
        requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
        });
        return;
      }

      // ── Measure heights (no-jump order). ────────────────────────────────────
      // FROM = current voice-mode card height.
      // IMPORTANT: exitVoice() pins card.style.height before setVoice(false) so
      // the React re-render doesn't collapse the card prematurely. We read
      // heightFrom from that pin, then we MUST clear the pin before measuring
      // heightTo so card.offsetHeight reads the intrinsic composer-only height
      // (not the still-pinned voice height). Without this clear, heightFrom ===
      // heightTo → the tween is a no-op → the card snaps instantly.
      const heightFrom = card.offsetHeight; // pinned = voice-mode height (correct)

      // TO = composer-only height. First clear the pin so offsetHeight reads
      // intrinsic layout. Then float composer elements back in (opacity:0 so
      // invisible) and voiceBody out, read the intrinsic height, restore.
      card.style.height = ''; // ← FIX 1: clear pin before measuring heightTo

      if (inputWrap) {
        inputWrap.style.display = '';
        inputWrap.style.opacity = '0';   // invisible during measurement
      }
      if (voiceBody) {
        voiceBody.style.position   = 'absolute';
        voiceBody.style.visibility = 'hidden';
      }
      const rawExitHeightTo = card.offsetHeight;
      // Clamp: the exit target (composer height) should also never be below MIN.
      const heightTo = Math.max(rawExitHeightTo, COMPOSER_MIN_HEIGHT);
      // Restore measurement scaffolding.
      if (voiceBody) {
        voiceBody.style.position   = '';
        voiceBody.style.visibility = '';
      }
      if (inputWrap) {
        inputWrap.style.display = 'none'; // will be re-shown via gsap.set below
        inputWrap.style.opacity = '';
      }

      // Pin the card at heightFrom *before* restoring inputWrap to flow so the
      // card never renders at the stacked height for even a single frame.
      card.style.height   = `${heightFrom}px`;
      card.style.overflow = 'hidden';

      // Pre-hide composer elements at opacity 0 so Phase 2 can reveal them.
      if (inputWrap) gsap.set(inputWrap, { display: '', opacity: 0, y: 6 });
      if (toolbar)   gsap.set(toolbar,   { opacity: 0, y: 4 });
      const toolbarBtns = toolbar
        ? Array.from(toolbar.querySelectorAll<HTMLElement>('button, label, [role="button"]'))
        : [];
      if (toolbarBtns.length) gsap.set(toolbarBtns, { opacity: 0, y: 4 });

      void card.offsetHeight; // force reflow so GSAP starts from the pinned value

      // Voice content targets for Phase 1 stagger.
      const voiceTopTargets = [voiceStatus, voiceWave, voiceHintEl].filter(Boolean) as HTMLElement[];
      const voiceBtns = voiceToolbar
        ? Array.from(voiceToolbar.querySelectorAll<HTMLElement>('button, [role="button"]'))
        : [];

      // ── Phase 2 builder: restore frame + reveal composer elements ────────────
      // Called after Phase 1 completes + T.gap settle delay.
      // overflow is cleared BEFORE tween starts so buttons aren't clipped.
      //
      // EXIT DOUBLE-HEIGHT FIX: voiceBody must be display:none before the card
      // height is tweened AND before card.style.height is cleared to 'auto'.
      // If voiceBody is still in normal flow (even at opacity:0) the card's
      // intrinsic height = composer + voice stacked → a double-height spike when
      // height:auto kicks in. Taking it out of flow first ensures the card's
      // intrinsic height = composer-only for the entire Phase 2 tween.
      const runPhase2Exit = () => {
        // Take the transcriber layer COMPLETELY out of flow before any height
        // measurement or tween. This is the critical exit no-double-height guard:
        // once voiceBody is display:none the card's intrinsic height is composer-
        // only, so the height tween and the final height:auto clear are both safe.
        if (voiceBody) voiceBody.style.display = 'none';

        // Clear overflow before the height tween so the composer body (now taller
        // than the pinned transcriber height) is never clipped as it comes in.
        card.style.height   = `${heightFrom}px`; // re-pin at current (transcriber) height
        card.style.overflow = '';                 // ← unlock before tween

        const phase2 = gsap.timeline({
          onComplete: () => {
            // Tween has settled — let the card breathe (auto height).
            // voiceBody is already display:none (set at runPhase2Exit entry), so
            // clearing height:auto here will NOT cause a double-height spike.
            card.style.height = '';
            // Clear GSAP inline styles so they're clean for next time.
            if (inputWrap)          gsap.set(inputWrap,    { clearProps: 'all' });
            if (toolbar)            gsap.set(toolbar,       { clearProps: 'all' });
            if (toolbarBtns.length) gsap.set(toolbarBtns,  { clearProps: 'all' });
            // FIX 2: Return focus to the composer textarea after exit settles.
            // Only on voice→composer exit (not on enter, not on session load).
            document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
          },
        });

        // Tween card height transcriber → composer simultaneously with the reveal.
        // EXIT: use T.fade (not T.height) so the frame-shrink is as quick as
        // the button-out sequence — they feel equally snappy.
        phase2.to(
          card,
          { height: heightTo, duration: T.fade, ease: T.enterEase },
          0,
        );

        // Fade in composer body.
        if (inputWrap) {
          phase2.to(
            inputWrap,
            { opacity: 1, y: 0, duration: T.fade, ease: T.enterEase },
            0,
          );
        }

        // Then reveal each composer toolbar button ONE-BY-ONE in succession.
        if (toolbarBtns.length) {
          const bodyDuration = inputWrap ? T.fade * 0.4 : 0;
          phase2.to(
            toolbarBtns,
            {
              opacity: 1, y: 0,
              duration: T.fade, ease: T.enterEase,
              stagger: T.btnStagger,
            },
            bodyDuration,
          );
        } else if (toolbar) {
          phase2.to(toolbar, { opacity: 1, y: 0, duration: T.fade, ease: T.enterEase }, 0);
        }

        voiceAnimRef.current = phase2;
      };

      // ── Phase 1 timeline: transcriber OUT (no height change) ─────────────────
      // The frame stays pinned at transcriber height so the voice elements are
      // fully visible as they leave. This is the reverse of ENTER Phase 2.
      const phase1 = gsap.timeline({
        onComplete: () => {
          // Phase 1 done — transcriber content is gone. Start gap then Phase 2.
          // height + overflow are still set (frame still pinned at transcriber size).
          gsap.delayedCall(T.gap, runPhase2Exit);
        },
      });

      // Reverse of ENTER Phase 2 button reveal: animate voice buttons OUT one-by-one.
      if (voiceBtns.length) {
        phase1.to(
          voiceBtns,
          { opacity: 0, y: 8, duration: T.fade, ease: T.exitEase, stagger: T.btnStagger },
          0,
        );
      } else if (voiceToolbar) {
        phase1.to(voiceToolbar, { opacity: 0, y: 8, duration: T.fade, ease: T.exitEase }, 0);
      }

      // Reverse of ENTER Phase 2 top-group reveal: fade top group OUT.
      const voiceBtnsDuration = voiceBtns.length
        ? T.fade + T.btnStagger * (voiceBtns.length - 1)
        : 0;
      const topStart = voiceBtns.length ? voiceBtnsDuration * 0.5 : 0;
      if (voiceTopTargets.length) {
        phase1.to(
          voiceTopTargets,
          { opacity: 0, y: -8, duration: T.fade, ease: T.exitEase, stagger: T.topStagger },
          topStart,
        );
      } else if (voiceBody) {
        phase1.to(voiceBody, { opacity: 0, y: -8, duration: T.fade, ease: T.exitEase }, 0);
      }

      voiceAnimRef.current = phase1;
    }
  }, [voice]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ask-inline morph: mirrors the voice morph pattern ──────────────────────
  // ENTER (composer → ask): stagger toolbar + fade input out, tween height, reveal ask body.
  // EXIT (ask → composer): fade ask body out, tween height back, reveal input + toolbar.
  useLayoutEffect(() => {
    const card = composerCardRef.current;
    if (!card) return;

    // Skip on initial mount and any false run before a true ENTER has happened.
    if (!askActive && !askMorphHasRunRef.current) return;
    if (askActive) askMorphHasRunRef.current = true;

    askAnimRef.current?.kill();
    askAnimRef.current = null;
    askMorphingRef.current = true;

    const askBody   = askBodyRef.current;
    const toolbar   = card.querySelector<HTMLElement>('.composer-toolbar:not(.voice-toolbar)');
    const inputWrap = card.querySelector<HTMLElement>('.composer-input-wrap');

    if (askActive) {
      // ── ENTER ──────────────────────────────────────────────────────────────
      if (prefersReducedMotion()) {
        if (askBody) askBody.style.display = 'flex';
        if (inputWrap) gsap.set(inputWrap, { display: 'none' });
        if (toolbar)   gsap.set(toolbar,   { display: 'none' });
        askMorphingRef.current = false;
        return;
      }

      const heightFrom = card.offsetHeight;
      card.style.height = `${heightFrom}px`;
      if (askBody) askBody.style.display = 'flex';

      // Clear any leftover position/visibility from a prior cycle.
      if (askBody) {
        askBody.querySelectorAll<HTMLElement>('*').forEach((el) => {
          if (el.style.position)   el.style.position   = '';
          if (el.style.visibility) el.style.visibility = '';
        });
      }

      // Measure TO by floating composer elements out.
      if (inputWrap) { inputWrap.style.position = 'absolute'; inputWrap.style.visibility = 'hidden'; }
      if (toolbar)   { toolbar.style.position   = 'absolute'; toolbar.style.visibility   = 'hidden'; }
      card.style.height = '';
      const rawHeightTo = card.offsetHeight;
      const heightTo = Math.max(rawHeightTo, COMPOSER_MIN_HEIGHT);
      card.style.height = `${heightFrom}px`;
      if (inputWrap) { inputWrap.style.position = ''; inputWrap.style.visibility = ''; }
      if (toolbar)   { toolbar.style.position   = ''; toolbar.style.visibility   = ''; }

      void card.offsetHeight;

      const toolbarBtns = toolbar
        ? Array.from(toolbar.querySelectorAll<HTMLElement>('button, label, [role="button"]'))
        : [];

      if (inputWrap) gsap.set(inputWrap, { clearProps: 'display,position,visibility', opacity: 1, y: 0 });
      // Pre-hide ask body content so Phase 2 reveals it.
      if (askBody) gsap.set(askBody, { opacity: 0, y: -10 });

      const runPhase2Enter = () => {
        // Re-query the foot at execution time — may have (re)mounted since
        // the effect ran (e.g. new question with askActive still true).
        const foot = askBody
          ? askBody.querySelector<HTMLElement>('.ask-inline-foot')
          : null;

        const phase2 = gsap.timeline({
          onComplete: () => {
            if (askBody) gsap.set(askBody, { clearProps: 'opacity,y' });
            // Belt-and-suspenders: clear any stranded inline opacity/transform on
            // the foot. gsap.from() with clearProps handles the normal-completion
            // path, but if the tween was interrupted the onComplete here fires once
            // the ENTER morph has fully settled — clear it now so the foot is never
            // left invisible.
            if (foot) gsap.set(foot, { clearProps: 'opacity,transform' });
            askMorphingRef.current = false;
          },
        });
        if (askBody) {
          // Reveal the body content (everything except the foot) first.
          phase2.to(askBody, { opacity: 1, y: 0, duration: T.fade, ease: T.enterEase }, 0);
        }
        // Then slide+fade the foot in after a small offset (mirrors voice button
        // stagger). Use gsap.from() so clearProps auto-fires on normal completion.
        if (foot) {
          // Ensure foot starts hidden before the from() tween sets up.
          gsap.set(foot, { opacity: 0, y: 12 });
          const bodyDuration = askBody ? T.fade * 0.5 : 0;
          phase2.from(
            foot,
            {
              opacity: 0,
              y: 12,
              duration: T.fade,
              ease: T.enterEase,
              clearProps: 'opacity,transform',
            },
            bodyDuration,
          );
        }
        askAnimRef.current = phase2;
      };

      const runPhase1b = () => {
        card.style.overflow = 'hidden';
        void card.offsetHeight;

        const phase1b = gsap.timeline({
          onComplete: () => {
            card.style.height   = '';
            card.style.overflow = '';
            // Take the normal composer chrome fully out of flow so it can't sit
            // below the ask body as an empty action bar. The ask body has its own
            // (sticky) action bar.
            if (inputWrap) gsap.set(inputWrap, { display: 'none' });
            if (toolbar)   gsap.set(toolbar,   { display: 'none', clearProps: 'opacity,y' });
            gsap.delayedCall(T.gap, runPhase2Enter);
          },
        });
        phase1b.to(card, { height: heightTo, duration: T.height, ease: T.exitEase }, 0);
        askAnimRef.current = phase1b;
      };

      const phase1a = gsap.timeline({ onComplete: runPhase1b });
      if (toolbarBtns.length) {
        phase1a.to(toolbarBtns, { opacity: 0, y: 4, duration: T.fade, ease: T.exitEase, stagger: T.btnStagger }, 0);
      } else if (toolbar) {
        phase1a.to(toolbar, { opacity: 0, y: 4, duration: T.fade, ease: T.exitEase }, 0);
      }
      if (inputWrap) {
        phase1a.to(inputWrap, { opacity: 0, y: 6, duration: T.fade, ease: T.exitEase }, 0);
      }
      askAnimRef.current = phase1a;

    } else {
      // ── EXIT ───────────────────────────────────────────────────────────────
      if (prefersReducedMotion()) {
        if (askBody) askBody.style.display = 'none';
        if (inputWrap) gsap.set(inputWrap, { clearProps: 'all' });
        if (toolbar)   gsap.set(toolbar,   { clearProps: 'all' });
        askMorphingRef.current = false;
        requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
        });
        return;
      }

      const heightFrom = card.offsetHeight;
      card.style.height = '';

      if (inputWrap) { inputWrap.style.display = ''; inputWrap.style.opacity = '0'; }
      if (askBody)   { askBody.style.position = 'absolute'; askBody.style.visibility = 'hidden'; }
      const rawExitHeightTo = card.offsetHeight;
      const heightTo = Math.max(rawExitHeightTo, COMPOSER_MIN_HEIGHT);
      if (askBody)   { askBody.style.position = ''; askBody.style.visibility = ''; }
      if (inputWrap) { inputWrap.style.display = 'none'; inputWrap.style.opacity = ''; }

      card.style.height   = `${heightFrom}px`;
      card.style.overflow = 'hidden';

      // Restore the normal chrome to flow (it was display:none'd on enter) so the
      // exit can fade it back in.
      if (inputWrap) gsap.set(inputWrap, { display: '', opacity: 0, y: 6 });
      if (toolbar)   gsap.set(toolbar,   { display: '', opacity: 0, y: 4 });
      const toolbarBtns = toolbar
        ? Array.from(toolbar.querySelectorAll<HTMLElement>('button, label, [role="button"]'))
        : [];
      if (toolbarBtns.length) gsap.set(toolbarBtns, { opacity: 0, y: 4 });

      void card.offsetHeight;

      const runPhase2Exit = () => {
        if (askBody) askBody.style.display = 'none';
        card.style.height   = `${heightFrom}px`;
        card.style.overflow = '';

        const phase2 = gsap.timeline({
          onComplete: () => {
            card.style.height = '';
            if (inputWrap)          gsap.set(inputWrap,   { clearProps: 'all' });
            if (toolbar)            gsap.set(toolbar,      { clearProps: 'all' });
            if (toolbarBtns.length) gsap.set(toolbarBtns, { clearProps: 'all' });
            askMorphingRef.current = false;
            document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
          },
        });
        phase2.to(card, { height: heightTo, duration: T.fade, ease: T.enterEase }, 0);
        if (inputWrap) {
          phase2.to(inputWrap, { opacity: 1, y: 0, duration: T.fade, ease: T.enterEase }, 0);
        }
        if (toolbarBtns.length) {
          const bodyDuration = inputWrap ? T.fade * 0.4 : 0;
          phase2.to(toolbarBtns, { opacity: 1, y: 0, duration: T.fade, ease: T.enterEase, stagger: T.btnStagger }, bodyDuration);
        } else if (toolbar) {
          phase2.to(toolbar, { opacity: 1, y: 0, duration: T.fade, ease: T.enterEase }, 0);
        }
        askAnimRef.current = phase2;
      };

      // Phase 1: fade ask foot OUT first (slide down), then fade the body out.
      // Mirrors voice EXIT: buttons out → top group out.
      const phase1 = gsap.timeline({
        onComplete: () => { gsap.delayedCall(T.gap, runPhase2Exit); },
      });
      // Query the foot now (before the body fades). Clear any stranded enter
      // opacity/transform from a prior interrupted enter so the exit starts clean.
      const foot = askBody
        ? askBody.querySelector<HTMLElement>('.ask-inline-foot')
        : null;
      if (foot) {
        // Ensure the foot is fully visible at exit start (guard against a prior
        // interrupted enter that left it with opacity:0).
        gsap.set(foot, { clearProps: 'opacity,transform' });
        phase1.to(
          foot,
          { opacity: 0, y: 8, duration: T.fade, ease: T.exitEase },
          0,
        );
      }
      if (askBody) {
        // Body fades out slightly after the foot starts its exit.
        const footDuration = foot ? T.fade * 0.5 : 0;
        phase1.to(askBody, { opacity: 0, y: -8, duration: T.fade, ease: T.exitEase }, footDuration);
      }
      askAnimRef.current = phase1;
    }
  }, [askActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Kill any in-flight ask timeline on unmount.
  useEffect(() => {
    return () => { askAnimRef.current?.kill(); };
  }, []);

  // (Height changes WITHIN the open ask body — e.g. options ↔ free-text — are
  // animated by AskInline itself via a FLIP on .ask-inline-body, which the
  // auto-height card follows. A ResizeObserver can't drive that: by the time it
  // fires the DOM has already snapped to the new height, so there's no "before"
  // to animate from.)

  // Kill any in-flight voice timeline on unmount to avoid post-unmount callbacks.
  useEffect(() => {
    return () => {
      voiceAnimRef.current?.kill();
    };
  }, []);

  // NOTE: No initial-mount useLayoutEffect to hide the voice shell is needed.
  // The CSS default for .voice-inline-body is display:none, so the shell is
  // hidden from the very first paint without any post-mount JS. The morph
  // driver sets display:'' on ENTER and display:none on EXIT at runtime.

  // ⌘/Ctrl+S opens voice mode from ANYWHERE (not just when the composer textarea
  // is focused) — window-level + capture phase so it beats the browser's Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (disabled) return; // no session selected
      if (document.querySelector('[aria-modal="true"]')) return; // a dialog is open
      e.preventDefault();
      if (voice) {
        // ⌘S while recording = toggle off (cancel gracefully via the hook if mounted)
        // exitVoice is just the state flip; VoiceInline cancel handles teardown.
        exitVoice();
      } else {
        openVoice();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [disabled, voice, openVoice, exitVoice]);
  // ⌘/Ctrl+D toggles the sub-agent checkbox from anywhere — beats the
  // browser's bookmark-page shortcut via capture-phase + preventDefault.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'd' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (disabled) return;
      if (document.querySelector('[aria-modal="true"]')) return; // a dialog is open
      if (terminal) return; // terminal mode has no sub-agent concept
      e.preventDefault();
      onSubAgentModeChange?.(!subAgentMode);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [disabled, terminal, subAgentMode, onSubAgentModeChange]);

  const commitVoice = useCallback(
    (transcribed: string) => {
      exitVoice();
      const t = transcribed.trim();
      if (!t) return;
      const cur = composer.getState().text ?? '';
      const sep = cur && !/\s$/.test(cur) ? ' ' : '';
      composer.setText(cur + sep + t + ' ');
    },
    [composer, exitVoice],
  );

  // Close the (session-agnostic) skill browser + voice mode on a session switch.
  // The voice shell stays mounted (always-mounted) — just flip voice=false so
  // the mic is released and the layout effect hides the shell on next render.
  //
  // ANIMATION CLEANUP (race-proof):
  // Kill any in-flight voice animation and clear ALL GSAP inline styles that
  // the morph may have left on composer elements (inputWrap, toolbar, toolbarBtns,
  // card height). This prevents stale opacity:0/transform/height values from
  // persisting across the session switch when the animation was interrupted
  // mid-flight and its onComplete (which would have run clearProps) never fired.
  //
  // Reset voiceMorphHasRunRef so the guard is correct for the next voice ENTER/EXIT
  // cycle on this session (the compositor will re-initialize from a clean state).
  useEffect(() => {
    setSkillBrowserOpen(false);
    setVoice(false);

    // Kill in-flight animation immediately.
    voiceAnimRef.current?.kill();
    voiceAnimRef.current = null;

    // Reset the morph-has-run guard so the next ENTER is treated as a fresh start.
    voiceMorphHasRunRef.current = false;
    phase2DoneRef.current = false;

    // Reset ask morph guard.
    askAnimRef.current?.kill();
    askAnimRef.current = null;
    askMorphHasRunRef.current = false;

    // Clear any GSAP inline styles left by an interrupted animation so the
    // composer always renders at its correct natural (un-animated) state.
    const card = composerCardRef.current;
    if (card) {
      // Clear the card's pinned height (set by exitVoice or the height tween).
      card.style.height = '';
      card.style.overflow = '';

      // Clear inline styles on compositor children.
      const inputWrap = card.querySelector<HTMLElement>('.composer-input-wrap');
      const toolbar   = card.querySelector<HTMLElement>('.composer-toolbar:not(.voice-toolbar)');
      if (inputWrap) gsap.set(inputWrap, { clearProps: 'all' });
      if (toolbar)   gsap.set(toolbar,   { clearProps: 'all' });
      const toolbarBtns = toolbar
        ? Array.from(toolbar.querySelectorAll<HTMLElement>('button, label, [role="button"]'))
        : [];
      if (toolbarBtns.length) gsap.set(toolbarBtns, { clearProps: 'all' });

      // Hide the voice body (voice is internal state, always reset on switch).
      const voiceBody = voiceBodyRef.current;
      if (voiceBody) voiceBody.style.display = 'none';

      // The ask prompt is SERVER-driven and persists across session switches — so
      // snap the ask body to the NEW session's state instantly (no morph): if that
      // session has an active prompt, show it and take the normal chrome out of
      // flow; otherwise hide it. (Bug: this used to unconditionally hide, so a
      // pending question vanished when you switched away and came back.)
      const askBody = askBodyRef.current;
      if (askBody) {
        if (askActive) {
          askBody.style.display = 'flex';
          gsap.set(askBody, { clearProps: 'opacity,y' });
          // Also clear the foot — our foot animation may have left inline
          // opacity/transform if it was interrupted mid-flight.
          const foot = askBody.querySelector<HTMLElement>('.ask-inline-foot');
          if (foot) gsap.set(foot, { clearProps: 'opacity,transform' });
          if (inputWrap) gsap.set(inputWrap, { display: 'none' });
          if (toolbar)   gsap.set(toolbar,   { display: 'none' });
        } else {
          askBody.style.display = 'none';
        }
      }
      askMorphHasRunRef.current = askActive;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const pickSkill = useCallback(
    (name: string) => {
      composer.setText(`/${name} `);
      setSkillBrowserOpen(false);
      // Return focus to the composer input so the user can add args and send.
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>('.composer-input');
        el?.focus();
      });
    },
    [composer],
  );

  const runEnhance = useCallback(async () => {
    if (disabled || optimizing || compacting || resuming) return;
    const original = composer.getState().text ?? '';
    if (!original.trim()) return;
    const sid = key; // the session this enhancement belongs to
    patchEnhance(sid, { optimizing: true });
    try {
      const result = await composerServices.optimizePrompt(original);
      // Store the review UNDER ITS SESSION — if the user switched away, it waits
      // there until they return; it never appears on the wrong session.
      patchEnhance(sid, { optimizing: false, review: { ...result, original } });
    } catch {
      patchEnhance(sid, { optimizing: false });
    }
  }, [composer, composerServices, disabled, optimizing, compacting, resuming, key, patchEnhance]);

  // ⌘/Ctrl+Enter (optimise) and ⌘/Ctrl+Shift+Enter (send raw) from ANYWHERE —
  // window-level + capture phase so it fires even when focus is outside the
  // textarea. Mirrors the ⌘S pattern. Does nothing in terminal mode (the
  // textarea's onKeyDown already handles the shell-Enter path).
  // When in voice mode, ⌘Enter = Stop & Transcribe (the hook's stop() handles it).
  // The voiceStopRef lets us call the hook's stop from this window handler without
  // adding the hook return as a dep (it changes identity every render).
  const voiceStopRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (disabled || terminal) return;
      if (document.querySelector('[aria-modal="true"]')) return; // a dialog is open
      // In voice mode, ⌘/Ctrl+Enter = Stop & Transcribe.
      if (voice) {
        e.preventDefault();
        voiceStopRef.current?.();
        return;
      }
      e.preventDefault();
      if (e.shiftKey) {
        composer.send();
        refocusComposer();
      } else {
        void runEnhance();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [disabled, terminal, voice, composer, runEnhance, refocusComposer]);

  // ── Terminal input relay ────────────────────────────────────────────────────
  // The textarea is a VISIBLE buffer the user types into normally — so the iOS
  // soft keyboard, autocorrect, and on-screen feedback all work. On every buffer
  // change we diff old→new and relay just the delta to the shell pane (which
  // echoes it back). Live relay keeps Tab-complete working: the partial word is
  // already on the shell line. Sticky Ctrl/Opt are ONE-SHOT modifiers — tap Ctrl,
  // then a letter, for Ctrl-<letter> "in succession" (the soft keyboard can't
  // chord). Refs keep the relay reading the latest sticky/shell values.
  const [sticky, setSticky] = useState<Mods>({ ctrl: false, alt: false });
  const stickyRef = useRef(sticky);
  stickyRef.current = sticky;
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const termPrevRef = useRef(''); // last buffer value we relayed

  const toggleMod = useCallback((m: keyof Mods) => {
    setSticky((s) => ({ ...s, [m]: !s[m] }));
  }, []);

  // Subscribe to composer text changes; relay the diff while in terminal mode.
  useEffect(() => {
    if (!terminal) {
      termPrevRef.current = '';
      return;
    }
    composer.setText(''); // clean slate — don't relay a leftover reply draft
    termPrevRef.current = '';
    setSticky({ ctrl: false, alt: false });

    const relay = () => {
      const next = composer.getState().text ?? '';
      const prev = termPrevRef.current;
      if (next === prev) return;
      const { removed, added } = relayDiff(prev, next);
      const s = stickyRef.current;

      // Sticky modifier + a single inserted letter → control key (Ctrl-A etc.);
      // consume the modifier and DON'T keep the letter in the buffer.
      if ((s.ctrl || s.alt) && removed === 0 && added.length === 1 && isLetter(added)) {
        const tok = controlToken(s, added);
        if (tok) shellRef.current.key(tok);
        setSticky({ ctrl: false, alt: false });
        composer.setText(prev); // revert; termPrevRef stays = prev
        return;
      }
      // A newline in the delta == Enter (a soft-keyboard return that slipped past
      // keydown): run the line and clear the buffer.
      const nl = added.indexOf('\n');
      if (nl !== -1) {
        for (let i = 0; i < removed; i += 1) shellRef.current.key('BSpace');
        if (added.slice(0, nl)) shellRef.current.text(added.slice(0, nl));
        shellRef.current.key('Enter');
        termPrevRef.current = '';
        composer.setText('');
        return;
      }
      for (let i = 0; i < removed; i += 1) shellRef.current.key('BSpace');
      if (added) shellRef.current.text(added);
      termPrevRef.current = next;
    };
    return composer.subscribe(relay);
  }, [terminal, composer]);

  // ── Inline pill overlay (Part 3) ───────────────────────────────────────────
  // The overlay is a read-only <div> layered behind the textarea (position:
  // absolute; pointer-events:none). It mirrors the textarea's text but replaces
  // each committed `/skill` or `@agent` mention with a styled pill span. The
  // textarea text is made transparent only when ≥1 pill exists (data-has-pills),
  // so the common no-mention case has zero visual change and zero risk of
  // misalignment. The overlay NEVER touches the textarea value or events.
  const overlayRef = useRef<HTMLDivElement>(null);

  // Known name sets for fast O(1) lookup during rendering.
  const skillNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills]);
  const agentNames = useMemo(() => new Set(agents.map((a) => a.name)), [agents]);

  /**
   * Render `text` into an array of React nodes, wrapping committed `/skill` and
   * `@agent` mentions (whose names appear in skillNames / agentNames) in a
   * `.composer-pill` span. Also returns `hasPills` so the caller can gate the
   * transparent-textarea style without a second pass.
   *
   * METRIC CONSTRAINT: The pill span MUST NOT alter glyph advance width vs. the
   * textarea (no horizontal padding/margin, no font-weight/size/family changes,
   * no letter-spacing). Only background-color, border-radius, and color may
   * differ — all zero-advance properties. If these change the overlay drifts.
   *
   * Regex matches pattern: (leading-ws)(trigger)(name)(trailing-ws)
   * where trigger is / or @, and the name is in the known set.
   */
  function renderMentions(
    t: string,
    knownSkills: Set<string>,
    knownAgents: Set<string>,
  ): { nodes: React.ReactNode[]; hasPills: boolean } {
    // Match a committed mention: (start-or-whitespace)(trigger)(name)(whitespace).
    // We use a 4-group regex: [1] leading ws, [2] trigger, [3] name, [4] trailing ws.
    const RE = /(^|\s)([/@])([A-Za-z0-9:_-]+)(\s)/g;
    const nodes: React.ReactNode[] = [];
    let last = 0;
    let hasPills = false;
    let key = 0;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(t)) !== null) {
      const trigger = m[2] as '/' | '@';
      const name = m[3];
      const isKnown =
        (trigger === '/' && knownSkills.has(name)) ||
        (trigger === '@' && knownAgents.has(name));
      if (!isKnown) continue;
      hasPills = true;
      const matchStart = m.index; // start of the full match (before leading ws)
      const leadingWs = m[1];    // leading whitespace (or empty at string start)
      const trailingWs = m[4];   // trailing whitespace (confirms commit)
      const mentionStart = matchStart + leadingWs.length; // index of trigger char
      const mentionEnd = mentionStart + 1 + name.length;  // exclusive end of name
      // Push any plain text between the last node and the leading whitespace.
      if (matchStart > last) nodes.push(t.slice(last, matchStart));
      // Push the leading whitespace as plain text (outside the pill).
      if (leadingWs) nodes.push(leadingWs);
      // Push the pill: only the trigger+name, no padding (metric constraint).
      nodes.push(
        <span key={key++} className="composer-pill" aria-hidden="true">
          {t.slice(mentionStart, mentionEnd)}
        </span>
      );
      // Push the trailing whitespace as plain text (outside the pill).
      nodes.push(t.slice(mentionEnd, mentionEnd + trailingWs.length));
      last = mentionEnd + trailingWs.length;
    }
    // Push any remaining plain text after the last match.
    if (last < t.length) nodes.push(t.slice(last));
    return { nodes, hasPills };
  }

  /**
   * Layers live `/goal` + `ultrathink` reserved-token highlighting on top of
   * renderMentions above, reusing the transcript's detectors
   * (lib/composerHighlight.ts → lib/reservedTokens.ts) so the composer shows
   * the same feedback while typing that the sent message renders with.
   *
   * `/goal` (only valid at the true start of the message) and `ultrathink`
   * segments render as their own pill/highlight spans; every plain-text
   * segment in between still goes through renderMentions unchanged, so
   * committed /skill and @agent mentions keep working exactly as before.
   *
   * Disabled in terminal mode: composer text there is a raw shell-keystroke
   * relay, not a prompt — "/goal"/"ultrathink" typed as shell input must
   * never be repainted, so terminal mode falls back to renderMentions alone
   * (identical to today's behavior).
   *
   * METRIC CONSTRAINT (see renderMentions above): .composer-goal-pill /
   * .composer-ultrathink reuse the transcript's gradients (styles.css
   * .goal-pill / .ultrathink-text) but drop the padding/margin/border/
   * font-weight the transcript versions use, which would otherwise change
   * glyph advance width and drift the overlay out of alignment.
   */
  function renderReservedAndMentions(
    t: string,
    knownSkills: Set<string>,
    knownAgents: Set<string>,
  ): { nodes: React.ReactNode[]; hasPills: boolean } {
    const segments = composerHighlightSegments(t);
    const nodes: React.ReactNode[] = [];
    let hasPills = false;
    let key = 0;
    for (const seg of segments) {
      if (seg.kind === 'goal') {
        hasPills = true;
        nodes.push(
          <span key={key++} className="composer-goal-pill" aria-hidden="true">
            {seg.text}
          </span>,
        );
        continue;
      }
      if (seg.kind === 'ultrathink') {
        hasPills = true;
        nodes.push(
          <span key={key++} className="composer-ultrathink" aria-hidden="true">
            {seg.text}
          </span>,
        );
        continue;
      }
      const mentions = renderMentions(seg.text, knownSkills, knownAgents);
      if (mentions.hasPills) hasPills = true;
      nodes.push(<Fragment key={key++}>{mentions.nodes}</Fragment>);
    }
    return { nodes, hasPills };
  }

  const { nodes: overlayNodes, hasPills } = useMemo(
    () =>
      terminal
        ? renderMentions(text, skillNames, agentNames)
        : renderReservedAndMentions(text, skillNames, agentNames),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, skillNames, agentNames, terminal],
  );

  // Sync overlay scroll to the textarea scroll after every text change.
  // This ensures the pill layer stays aligned when the textarea scrolls vertically.
  useLayoutEffect(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.composer-input');
    const overlay = overlayRef.current;
    if (!ta || !overlay) return;
    overlay.scrollTop = ta.scrollTop;
    overlay.scrollLeft = ta.scrollLeft;
  }, [text]);

  return (
    <ComposerPrimitive.Root className="composer" data-ask-active={askActive ? 'true' : undefined}>
      {/* Inline skill autocomplete: floats ABOVE the composer (the mobile
          keyboard is below). Populated from the live session skill list. */}
      {acOpen ? (
        <div className="skill-ac" role="listbox" aria-label="Skill suggestions">
          {acItems.map((s, i) => (
            <button
              type="button"
              key={s.name}
              role="option"
              aria-selected={i === acIndex}
              data-on={i === acIndex ? 'true' : undefined}
              className="skill-ac-item"
              // Use onMouseDown (not onClick) so the textarea doesn't blur first.
              onMouseDown={(e) => {
                e.preventDefault();
                selectSkill(s.name);
              }}
              onMouseEnter={() => setAcIndex(i)}
            >
              <span className="tool-head">
                <span className="tool-arrow" aria-hidden="true">▸</span>
                <span className="tool-name skill-card-name">{s.name}</span>
                {s.description ? (
                  <>
                    <span className="tool-sep">—</span>
                    <span className="tool-input skill-card-desc">{s.description}</span>
                  </>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {/* Terminal mode: kept-warm once opened (still polling while hidden) so
          re-opening just fades+zooms in — no loader flash. Unloads on session
          change (the effect above resets termWarm). */}
      {termWarm && sessionId ? (
        <div ref={termWrapRef} className="term-warm">
          <TerminalView
            ptySessionId={`cc-shell:${sessionId}`}
            sendKey={shell.key}
            mods={sticky}
            onToggleMod={toggleMod}
          />
        </div>
      ) : null}
      {/* Centered card (max-width on desktop): input on top, attachments below,
          then a toolbar with attach on the left and send on the right.
          data-voice flips the body to waveform + toolbar to voice actions. */}
      <div
        ref={composerCardRef}
        className="composer-card"
        data-terminal={terminal ? 'true' : undefined}
        data-voice={voice ? 'true' : undefined}
      >
        {activeSkill ? (
          <div className="composer-skill-chip-row">
            <span className="skill-chip composer-skill-chip" title={`Invoking /${activeSkill}`}>
              <span className="skill-chip-icon" aria-hidden="true">⌁</span>
              <span className="skill-chip-name">/{activeSkill}</span>
            </span>
          </div>
        ) : null}
        {/* Voice inline body: always mounted so the DOM nodes exist before the
            enter animation runs — the layout effect pre-hides targets before
            paint and the animation REVEALS existing nodes (no mount-flash).
            The shell is display:none when idle (zero height, zero layout impact).
            `active={voice && voiceMicOn}` gates mic acquisition — never while
            pre-rendered-idle, and only AFTER the enter morph settles (mic init
            blocks the main thread and would freeze the timeline mid-tween). */}
        <VoiceInline
          active={voice && voiceMicOn}
          bodyRef={voiceBodyRef}
          onCommit={commitVoice}
          onClose={exitVoice}
          stopRef={voiceStopRef}
          phase2DoneRef={phase2DoneRef}
        />
        {/* Ask inline body: always mounted, display:none when idle. The ask morph
            driver sets display:'' on ENTER and display:none on EXIT. */}
        <AskInline
          activePrompt={activePrompt}
          bodyRef={askBodyRef}
          onAnswer={onAnswer ?? (() => {})}
          onKey={onKey ?? (() => {})}
          onSelect={onSelect ?? (() => {})}
          onReply={onReply ?? (() => {})}
        />
        {/* Compaction strip: Claude is compacting context — sends are blocked
            (the TUI ignores input) and this shows it's progressing, not hung. */}
        {compacting && !terminal && !voice && !askActive ? (
          <div className="composer-compacting" role="status" aria-live="polite">
            <span className="working-spinner" aria-hidden="true" />
            <span>Compacting conversation… sending is paused</span>
          </div>
        ) : null}
        {/* Resume strip (Phase C, C5): a dormant session's "Resume & send" is
            in flight — the round trip resumes the session AND delivers the
            message, and can take up to ~2min, so this must read as progress,
            not a hang. */}
        {resuming && !terminal && !voice && !askActive ? (
          <div className="composer-resuming" role="status" aria-live="polite">
            <span className="working-spinner" aria-hidden="true" />
            <span>Resuming session & sending your message… (up to ~2 min)</span>
          </div>
        ) : null}
        {/* Error strip: the agent hit an API error and stalled — offer a Retry
            that sends "Continue" to nudge it back into the turn. */}
        {errored && !terminal && !voice && !askActive ? (
          <div className="composer-errored" role="alert">
            <span className="composer-errored-msg">⚠ API error — the agent stalled</span>
            <button
              type="button"
              className="composer-retry"
              onClick={() => onRetry?.()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {/* Placeholder needs the Kbd component, but a native placeholder is
            text-only — so use a space placeholder (keeps :placeholder-shown
            working + invisible) and overlay a hint shown only while empty. */}
        {/* data-has-pills: when ≥1 pill exists, the textarea text is made
            transparent (CSS) and the overlay renders the visible text with
            pill highlights. When no pills are present, the overlay is empty
            and the textarea renders normally — zero divergence risk. */}
        <div className="composer-input-wrap" data-has-pills={hasPills ? 'true' : undefined}
        >
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder={
              loading && !terminal
                ? 'Loading transcript…'
                : disabled && !terminal
                  ? 'Select a session…'
                  : ' '
            }
            submitOnEnter={false}
            onKeyUp={(e) => updateCaret(e.currentTarget)}
            onClick={(e) => updateCaret(e.currentTarget)}
            onSelect={(e) => updateCaret(e.currentTarget)}
            // Sync overlay scroll on textarea scroll (only new handler; no value/selection changes).
            onScroll={(e) => {
              const o = overlayRef.current;
              if (o) {
                o.scrollTop = e.currentTarget.scrollTop;
                o.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            onKeyDown={(e) => {
              // (⌘/Ctrl+S voice toggle is handled window-level above so it works
              // regardless of focus + beats the browser's Save.)
              // Terminal mode: most keys edit the visible buffer (relayed via the
              // diff). Intercept only the keys that must go straight to the shell.
              if (terminal) {
                if (e.metaKey) return; // ⌘ combos belong to the browser/OS
                // Esc leaves terminal mode → back to composer. (Send a literal
                // Escape to the shell via the on-screen key bar's Esc button.)
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setTerminal(false);
                  onTerminalModeChange?.(false);
                  refocusComposer();
                  return;
                }
                const s = sticky;
                const ctrl = e.ctrlKey || s.ctrl;
                const alt = e.altKey || s.alt;
                // Ctrl/Opt + letter (hardware keyboards fire keydown for letters).
                if ((ctrl || alt) && e.key.length === 1 && isLetter(e.key)) {
                  e.preventDefault();
                  const tok = controlToken({ ctrl, alt }, e.key);
                  if (tok) shell.key(tok);
                  if (s.ctrl || s.alt) setSticky({ ctrl: false, alt: false });
                  return;
                }
                // Arrows / nav with hardware modifiers (Magic Keyboard): Opt/Ctrl/
                // Shift + arrow → word-jump / selection escape sequences.
                const nav = navToken(e.key, { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
                if (nav) {
                  e.preventDefault();
                  shell.key(nav);
                  return;
                }
                // Backspace/Del must reach the shell EVEN when the buffer is empty
                // (the shell line may hold echoed/completed text the buffer doesn't).
                if (e.key === 'Backspace') {
                  e.preventDefault();
                  shell.key('BSpace');
                  const cur = composer.getState().text ?? '';
                  if (cur) {
                    const next = cur.slice(0, -1);
                    composer.setText(next);
                    termPrevRef.current = next;
                  }
                  return;
                }
                if (e.key === 'Delete') {
                  e.preventDefault();
                  shell.key('DC');
                  return;
                }
                const tok = interceptToken(e.key, e.shiftKey);
                if (tok) {
                  e.preventDefault();
                  shell.key(tok);
                  if (tok === 'Enter') {
                    termPrevRef.current = '';
                    composer.setText('');
                  }
                }
                return; // everything else edits the buffer; the relay handles it
              }
              // Leading "!" on an empty composer drops into terminal mode (shell
              // bang); the "!" is consumed, not typed.
              if (empty && e.key === '!') {
                e.preventDefault();
                openTerminal();
                return;
              }
              // Skill autocomplete nav takes precedence while the dropdown is open.
              if (acOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setAcIndex((i) => (i + 1) % acItems.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
                  return;
                }
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  selectSkill(acItems[acIndex].name);
                  return;
                }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  selectSkill(acItems[acIndex].name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setAcDismissed(true);
                  return;
                }
              }
              // Enter inserts a newline. ⌘/Ctrl+Enter = optimise (default);
              // ⌘/Ctrl+Shift+Enter = bypass and send the raw composer text.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (disabled || optimizing) return;
                if (e.shiftKey) {
                  composer.send();
                  refocusComposer();
                } else {
                  void runEnhance();
                }
              }
              // ⌘/Ctrl+O also triggers the optimiser (legacy alias).
              if (e.key.toLowerCase() === 'o' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void runEnhance();
              }
            }}
            rows={1}
            disabled={disabled && !terminal}
            autoComplete="off"
            // Terminal mode is a raw keystroke relay — kill iOS autocorrect /
            // autocapitalisation / spellcheck so they don't mangle commands.
            autoCorrect={terminal ? 'off' : undefined}
            autoCapitalize={terminal ? 'none' : undefined}
            spellCheck={terminal ? false : undefined}
          />
          {/* READ-ONLY pill overlay. Absolutely positioned over the textarea;
              pointer-events:none so it never interferes with input. Renders the
              same text as the textarea but with pill spans around committed
              mentions — visible only when the textarea is transparent (hasPills).
              See .composer-overlay and .composer-pill in styles.css. */}
          <div
            className="composer-overlay"
            aria-hidden="true"
            ref={overlayRef}
          >
            {overlayNodes}
            {/* A lone trailing "\n" collapses to zero extra height in a
                white-space:pre-wrap block unless something follows it — this
                zero-width space keeps the overlay's height matched to the
                textarea's, which does render the trailing blank line. */}
            {text.endsWith('\n') ? '\u200B' : null}
          </div>
          {terminal ? (
            <div className="composer-hint" aria-hidden="true">
              <span className="composer-hint-lead">Keys go to the shell…</span>
              <span className="composer-hint-keys">
                <Kbd>Tab</Kbd> completes
                <span className="composer-hint-dot">·</span>
                <Kbd>↑</Kbd> history
              </span>
            </div>
          ) : !disabled ? (
            <div className="composer-hint" aria-hidden="true">
              <span className="composer-hint-lead">Reply…</span>
              <span className="composer-hint-keys">
                <Kbd>⌘/Ctrl+↵</Kbd> optimise
                <span className="composer-hint-dot">·</span>
                <Kbd>⌘/Ctrl+⇧+↵</Kbd> send raw
                <span className="composer-hint-dot">·</span>
                <Kbd>↵</Kbd> newline
              </span>
            </div>
          ) : null}
        </div>

        {/* children render form: invoked once per composer attachment. */}
        {!voice ? (
          <div className="composer-attachments">
            <ComposerPrimitive.Attachments>
              {({ attachment }) => <AttachmentChip attachment={attachment} />}
            </ComposerPrimitive.Attachments>
          </div>
        ) : null}

        <div className="composer-toolbar">
          {!terminal && !voice ? (
            <>
              <ComposerPrimitive.AddAttachment
                render={<ComposerAttachButton />}
                aria-label="Attach a file"
                title="Attach a file"
                multiple
                disabled={disabled}
              />
            </>
          ) : null}
          {/* Terminal-mode toggle (>_): hidden while voice mode is active. */}
          {!voice ? (
            <button
              type="button"
              className="composer-skills-btn composer-term-toggle"
              aria-label="Terminal mode"
              title="Terminal mode — run shell commands"
              aria-pressed={terminal}
              data-on={terminal ? 'true' : undefined}
              onClick={() => {
                if (terminal) {
                  setTerminal(false);
                  onTerminalModeChange?.(false);
                } else {
                  openTerminal();
                }
              }}
            >
              <TerminalIcon />
            </button>
          ) : null}
          {/* Sub-agent toggle: when active, outgoing prompts are prefixed
              with "Using a sub-agent." Sits in the LEFT toolbar cluster,
              beside attach/mic/terminal — deliberately far from the Send
              button on the right so toggling it can't misclick-fire a send.
              Only shown in non-terminal, non-voice mode. */}
          {!terminal && !voice ? (
            <label
              className={`composer-subagent-toggle${subAgentMode ? ' composer-subagent-toggle--on' : ''}`}
              aria-label="Dispatch task in sub-agent"
              data-hotkey="⌘D"
              title={subAgentMode ? 'Sub-agent on — click to disable (⌘D)' : 'Sub-agent off — click to enable (⌘D)'}
            >
              <input
                type="checkbox"
                className="composer-subagent-checkbox"
                checked={!!subAgentMode}
                disabled={disabled}
                onChange={(e) => onSubAgentModeChange?.(e.target.checked)}
                aria-label="Dispatch task in sub-agent"
              />
              <span className="composer-subagent-label">Dispatch task in sub-agent</span>
            </label>
          ) : null}
          {/* Mobile alternative to the checkbox+label toggle above: a compact
              icon-only button, breakpoint-gated in CSS (only one of the two
              is visible at a given viewport width — see .composer-subagent-btn
              in styles.css). Same subAgentMode state, same ⌘D hotkey. */}
          {!terminal && !voice ? (
            <button
              type="button"
              className={`composer-subagent-btn${subAgentMode ? ' composer-subagent-btn--on' : ''}`}
              aria-label="Dispatch task in sub-agent"
              aria-pressed={!!subAgentMode}
              data-hotkey="⌘D"
              title={subAgentMode ? 'Sub-agent on — tap to disable (⌘D)' : 'Sub-agent off — tap to enable (⌘D)'}
              disabled={disabled}
              onClick={() => onSubAgentModeChange?.(!subAgentMode)}
            >
              <BotIcon size={16} />
            </button>
          ) : null}
          <span className="composer-toolbar-spacer" />
          {/* Stop sits to the LEFT of both send buttons (bypass ↑ + optimise ✦).
              Rendered only while generating: the send cluster is right-aligned
              (the spacer above is flex-grow), so Stop grows leftward into the
              spacer when it appears — ↑/✦ never shift, and there's no reserved
              empty slot (the "gapping hole") when idle. */}
          {working && !terminal && !voice ? (
            <button
              type="button"
              className="composer-send"
              data-stop="true"
              aria-label="Stop (Esc)"
              title="Stop the agent (Esc)"
              onClick={() => onStop?.()}
            >
              <StopIcon size={14} />
            </button>
          ) : null}
          {/* Voice input mic — sits just LEFT of the Raw Send (bypass) button. */}
          {!terminal && !voice ? (
            <ComposerMicButton
              ariaLabel="Voice input"
              title="Voice input"
              disabled={disabled}
              dataHotkey="⌘S"
              onClick={openVoice}
            />
          ) : null}
          {/* Secondary: bypass — send the raw composer text without optimising. */}
          {!terminal && !voice ? (
            <ComposerRawSendButton
              ariaLabel="Send without optimising"
              title="Send raw — skip the optimiser (⌘/Ctrl+⇧+↵)"
              disabled={disabled || optimizing || empty || compacting || resuming}
              onClick={() => {
                composer.send();
                refocusComposer();
              }}
            />
          ) : null}
          {terminal && !voice ? (
            <button
              type="button"
              className="composer-send"
              data-terminal="true"
              aria-label="Send Enter"
              title="Enter"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => shell.key('Enter')}
            >
              <ArrowUpIcon />
            </button>
          ) : voice ? null : (
            // The optimise / improve-prompt button. Always visible (only
            // disabled when the composer is empty) so the action never
            // disappears; Stop (rendered above, only while generating) sits to
            // its left — no reserved-slot gap.
            <ComposerSendButton
              ref={sendBtnRef}
              ariaLabel="Optimise and send"
              title="Optimise & send (⌘/Ctrl+↵)"
              disabled={disabled || optimizing || empty || compacting || resuming}
              dataHotkey={empty ? undefined : '⌘↵'}
              busy={optimizing}
              onClick={() => void runEnhance()}
            />
          )}
        </div>
      </div>
      {review ? (
        <OptimizeReview
          original={review.original}
          result={review}
          onSend={(text) => {
            // Primary / auto-send: dispatch the rewritten prompt.
            patchEnhance(key, { review: null });
            composer.setText(text);
            requestAnimationFrame(() => {
              if (!disabled) composer.send();
              refocusComposer(); // keep the cursor in the composer to follow up
            });
          }}
          onAccept={(text) => {
            // Secondary: load into the composer, don't dispatch.
            composer.setText(text);
            patchEnhance(key, { review: null });
            refocusComposer();
          }}
          onClose={() => {
            patchEnhance(key, { review: null });
            refocusComposer();
          }}
        />
      ) : null}
      {skillBrowserOpen ? (
        <SkillBrowser
          onPick={pickSkill}
          onClose={() => setSkillBrowserOpen(false)}
          sessionId={sessionId}
        />
      ) : null}
    </ComposerPrimitive.Root>
  );
}

// ── VoiceInline ──────────────────────────────────────────────────────────────
// Always mounted inside .composer-card. When idle (active=false) the wrapper
// div is display:none (managed by the layout effect in Composer) so it
// contributes zero height and zero layout impact. When active=true the
// useVoiceRecorder hook acquires the mic and starts recording.
// The bodyRef lets Composer's layout effect toggle display without re-renders.
// The stopRef callback is forwarded out so the window ⌘Enter handler can
// call stop() without the hook result drifting into its deps array.

interface VoiceInlineProps {
  /** Gates mic acquisition — true only when voice mode is actually active. */
  active: boolean;
  /** Ref placed on the wrapper div so Composer can set display:none/'' directly. */
  bodyRef: React.RefObject<HTMLDivElement>;
  onCommit: (text: string) => void;
  onClose: () => void;
  stopRef: React.MutableRefObject<(() => void) | null>;
  /**
   * Ref that Composer's ENTER Phase 2 sets to `true` when the reveal sequence
   * completes. VoiceInline's Pause button checks this: if false, Phase 2 has
   * not run yet so Pause stays pre-hidden (Phase 2 will reveal it in order);
   * if true, Phase 2 is done so Pause animates itself in (late-mount path —
   * always appears AFTER Cancel/Stop which are already visible).
   */
  phase2DoneRef: React.RefObject<boolean>;
}

function VoiceInline({ active, bodyRef, onCommit, onClose, stopRef, phase2DoneRef }: VoiceInlineProps) {
  const { status, errorMsg, canvasRef, pauseResume, stop, cancel } = useVoiceRecorder({
    active,
    onCommit,
    onClose,
  });

  // Keep the stopRef current so the window keydown handler can call stop().
  useEffect(() => {
    stopRef.current = stop;
    return () => { stopRef.current = null; };
  }, [stop, stopRef]);

  // Ref for the Pause/Resume button so we can animate its entrance.
  const pauseBtnRef = useRef<HTMLButtonElement>(null);

  // Whether the Pause/Resume button should currently be visible.
  const showPauseBtn = status === 'recording' || status === 'paused';

  // Pre-hide Pause on mount so it starts invisible regardless of when Phase 2
  // runs. This prevents the button from flashing at full opacity before either
  // Phase 2 or the late-mount entrance below takes effect.
  useLayoutEffect(() => {
    const btn = pauseBtnRef.current;
    if (btn && !prefersReducedMotion()) {
      gsap.set(btn, { opacity: 0, y: 12 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause-ordering guard: when showPauseBtn transitions false → true (status
  // flips to 'recording' or 'paused'), decide how to reveal Pause:
  //
  //   phase2DoneRef.current === false → Phase 2 has NOT run yet.
  //     Pause stays pre-hidden (opacity:0). Phase 2 will include it in the
  //     ordered stagger (Cancel → Stop → Pause), ensuring it appears last.
  //
  //   phase2DoneRef.current === true → Phase 2 has ALREADY completed.
  //     Cancel + Stop are already visible. Run Pause's own entrance now —
  //     it still appears AFTER Cancel/Stop so ordering is preserved.
  //
  // Either branch guarantees Pause never appears before Cancel/Stop.
  useLayoutEffect(() => {
    if (!showPauseBtn) return;
    const btn = pauseBtnRef.current;
    if (!btn) return;
    // Phase 2 not yet done — stay hidden; Phase 2 will reveal in order.
    if (!phase2DoneRef.current) return;
    // Phase 2 already done — self-animate (late-mount, always after Cancel/Stop).
    if (prefersReducedMotion()) {
      gsap.set(btn, { opacity: 1, y: 0 });
      return;
    }
    gsap.fromTo(
      btn,
      { opacity: 0, y: 8 },
      {
        opacity: 1, y: 0,
        duration: 0.094,   // matches T.fade in the parent morph driver
        ease: ANIM.enterEase,
      },
    );
  }, [showPauseBtn, phase2DoneRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusLabel =
    status === 'error'
      ? 'Microphone unavailable'
      : status === 'transcribing'
        ? 'Transcribing…'
        : status === 'paused'
          ? 'Paused'
          : status === 'starting'
            ? 'Starting…'
            : 'Listening…';

  return (
    <div ref={bodyRef} className="voice-inline-body" aria-live="polite">
      <div className="voice-status">
        <span className="voice-dot" data-on={status === 'recording' ? 'true' : undefined} />
        {statusLabel}
      </div>
      <canvas
        ref={canvasRef}
        className="voice-wave voice-wave-inline"
        height={64}
        data-paused={status !== 'recording' ? 'true' : undefined}
      />
      {status === 'error' ? (
        <div className="voice-error">{errorMsg || 'Could not start recording.'}</div>
      ) : status !== 'transcribing' ? (
        <div className="voice-hint">Speak, then Stop &amp; Transcribe (or ⌘/Ctrl+↵) to insert.</div>
      ) : null}
      <div className="composer-toolbar voice-toolbar">
        <button
          type="button"
          className="btn-secondary voice-btn-cancel"
          onClick={cancel}
          disabled={status === 'transcribing'}
          aria-label="Cancel voice recording"
        >
          Cancel
        </button>
        <span className="composer-toolbar-spacer" />
        {showPauseBtn ? (
          <button
            ref={pauseBtnRef}
            type="button"
            className="btn-secondary voice-btn-pause"
            onClick={pauseResume}
            aria-label={status === 'recording' ? 'Pause recording' : 'Resume recording'}
          >
            {status === 'recording' ? 'Pause' : 'Resume'}
          </button>
        ) : null}
        <button
          type="button"
          className="composer-send voice-btn-stop"
          onClick={stop}
          disabled={status === 'error' || status === 'transcribing' || status === 'starting'}
          aria-label="Stop recording and transcribe"
          title="Stop & Transcribe (⌘/Ctrl+↵)"
        >
          {status === 'transcribing' ? (
            <span className="composer-enhance-spinner" aria-hidden="true" />
          ) : (
            <MicIcon />
          )}
        </button>
      </div>
    </div>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 8l4 4-4 4M12 16h7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


