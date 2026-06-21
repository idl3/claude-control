import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useComposerRuntime,
  type Attachment,
} from '@assistant-ui/react';
import { Kbd } from './Kbd';
import {
  optimizePrompt,
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
import gsap, { ANIM, prefersReducedMotion } from '../lib/anim';
import { StopIcon } from './icons';

// Module-level per-session cache so the skill list (live, session-discovered
// via GET /api/skills?id=<sessionId> → lib/skills.js) is fetched once per
// session and shared across Composer mounts. Project skills are scoped to the
// session's cwd; different sessions can have different project-skill sets.
const _skillsCache = new Map<string, SkillEntry[]>();
const _skillsPromise = new Map<string, Promise<SkillEntry[]>>();

function loadSkills(id?: string | null): Promise<SkillEntry[]> {
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

function loadAgents(id?: string | null): Promise<AgentEntry[]> {
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
  /** Called when the user clicks the STOP button (or presses Esc from App).
   *  Should send Escape to the session's Claude pane. */
  onStop?: () => void;
}

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
  sessionId,
  subAgentMode = true,
  onSubAgentModeChange,
  onTerminalModeChange,
  working = false,
  onStop,
}: ComposerProps) {
  const composer = useComposerRuntime();
  const shell = useShell();
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
    () => _skillsCache.get(sessionId ?? '') ?? [],
  );
  const [agents, setAgents] = useState<AgentEntry[]>(
    () => _agentsCache.get(sessionId ?? '') ?? [],
  );
  const [text, setTextMirror] = useState('');     // mirror of composer text
  const [caret, setCaret] = useState(0);           // textarea selectionStart
  const [acIndex, setAcIndex] = useState(0);       // highlighted suggestion
  const [acDismissed, setAcDismissed] = useState(false); // Esc / just-selected

  // Re-fetch skills whenever the session changes (different sessions may have
  // different project skills). The cache prevents redundant network calls.
  useEffect(() => {
    let alive = true;
    const cached = _skillsCache.get(sessionId ?? '');
    if (cached) {
      setSkills(cached);
    } else {
      loadSkills(sessionId)
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
  }, [sessionId]);

  // Re-fetch agents whenever the session changes (mirrors skills fetch above).
  useEffect(() => {
    let alive = true;
    const cached = _agentsCache.get(sessionId ?? '');
    if (cached) {
      setAgents(cached);
    } else {
      loadAgents(sessionId)
        .then((a) => {
          if (alive) setAgents(a);
        })
        .catch(() => {
          if (alive) setAgents([]);
        });
    }
    return () => { alive = false; };
  }, [sessionId]);

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
  // The VoiceInline receives `active={voice}` — mic is acquired ONLY when true.
  const [voice, setVoice] = useState(false);
  // Ref for the .composer-card so we can reach into it for animation targets.
  const composerCardRef = useRef<HTMLDivElement>(null);
  // Guard: only one in-flight timeline at a time (avoids enter/exit overlap).
  const voiceAnimRef = useRef<gsap.core.Timeline | null>(null);
  // Ref to the always-mounted voice-inline-body so we can toggle display:none
  // without React re-renders (layout read happens in useLayoutEffect).
  const voiceBodyRef = useRef<HTMLDivElement>(null);

  const openVoice = useCallback(() => {
    if (disabled) return;
    setVoice(true);
  }, [disabled]);

  const exitVoice = useCallback(() => {
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
  // ── Timing constants — intentionally SLOW for visual tuning. ────────────────
  // To speed up: edit T below (e.g. fade → 0.22, height → 0.20, gap → 0.08).
  // All durations in seconds; all stagger values are per-element delays.
  const T = {
    fade:       0.40,   // per-element fade duration (in or out)
    height:     0.35,   // card height tween duration
    btnStagger: 0.07,   // delay between successive button reveals/hides
    topStagger: 0.06,   // delay between status / wave / hint reveals
    gap:        0.15,   // pause between Phase 1 completion and Phase 2 start
    enterEase:  ANIM.enterEase,
    exitEase:   ANIM.exitEase,
  } as const;

  useLayoutEffect(() => {
    const card = composerCardRef.current;
    if (!card) return;

    // Kill any in-flight timeline before starting a new one.
    voiceAnimRef.current?.kill();
    voiceAnimRef.current = null;

    if (voice) {
      // ── ENTER: un-hide voice shell, pre-hide targets, composer body out ──────

      const voiceBody   = voiceBodyRef.current;
      const toolbar     = card.querySelector<HTMLElement>('.composer-toolbar:not(.voice-toolbar)');
      const inputWrap   = card.querySelector<HTMLElement>('.composer-input-wrap');

      // Bring the pre-rendered voice shell back into layout (was display:none).
      if (voiceBody) voiceBody.style.display = '';

      // Reduced-motion: instant swap — no tweens.
      if (prefersReducedMotion()) {
        if (inputWrap) gsap.set(inputWrap, { display: 'none' });
        return;
      }

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

      // ── Measure heights for the height tween (manual FLIP). ─────────────────
      // FROM = current card height (composer + voice both in layout).
      const heightFrom = card.offsetHeight;
      // TO   = voice-only height: temporarily float composer elements out of flow.
      if (inputWrap) {
        inputWrap.style.position   = 'absolute';
        inputWrap.style.visibility = 'hidden';
      }
      if (toolbar) {
        toolbar.style.position   = 'absolute';
        toolbar.style.visibility = 'hidden';
      }
      const heightTo = card.offsetHeight;  // reflow reads voice-only height
      // Restore.
      if (inputWrap) { inputWrap.style.position = ''; inputWrap.style.visibility = ''; }
      if (toolbar)   { toolbar.style.position   = ''; toolbar.style.visibility   = ''; }
      // Pin the card at FROM before tweening.
      card.style.height   = `${heightFrom}px`;
      card.style.overflow = 'hidden';
      void card.offsetHeight; // force reflow so GSAP starts from the pinned value

      // Toolbar action buttons (children of .composer-toolbar) for per-item stagger.
      const toolbarBtns = toolbar
        ? Array.from(toolbar.querySelectorAll<HTMLElement>('button, label, [role="button"]'))
        : [];

      // ── Phase 2 builder: reveal voice elements ───────────────────────────────
      // Called from Phase 1's onComplete after the T.gap settle delay so that
      // overflow:hidden is fully cleared and height is auto before any button
      // tries to render outside the previous clipped bounds.
      const runPhase2Enter = () => {
        const phase2 = gsap.timeline();

        // Reveal top group (status → wave → hint) first, with stagger.
        if (topTargets.length) {
          phase2.to(
            topTargets,
            {
              opacity: 1, y: 0,
              duration: T.fade, ease: T.enterEase,
              stagger: T.topStagger,
            },
            0,
          );
        }

        // Then reveal each voice button ONE-BY-ONE with stagger.
        // Targets individual buttons, NOT the container — avoids clip.
        if (voiceBtns.length) {
          const topDuration = topTargets.length
            ? T.fade + T.topStagger * (topTargets.length - 1)
            : 0;
          const btnsStart = topTargets.length ? topDuration * 0.5 : 0;
          phase2.to(
            voiceBtns,
            {
              opacity: 1, y: 0,
              duration: T.fade, ease: T.enterEase,
              stagger: T.btnStagger,
            },
            btnsStart,
          );
        } else if (voiceToolbar) {
          phase2.to(
            voiceToolbar,
            { opacity: 1, y: 0, duration: T.fade, ease: T.enterEase },
            topTargets.length ? T.topStagger * topTargets.length : 0,
          );
        }

        voiceAnimRef.current = phase2;
      };

      // ── Phase 1 timeline: settle the frame ──────────────────────────────────
      const phase1 = gsap.timeline({
        onComplete: () => {
          // Frame has settled — restore card to auto height, clear overflow lock
          // (MUST happen before Phase 2 so buttons aren't clipped), then take
          // inputWrap/toolbar out of flow. After T.gap, fire Phase 2.
          card.style.height   = '';
          card.style.overflow = '';
          if (inputWrap) gsap.set(inputWrap, { display: 'none' });
          if (toolbar)   gsap.set(toolbar,   { clearProps: 'opacity,y' });
          gsap.delayedCall(T.gap, runPhase2Enter);
        },
      });

      // Stagger composer toolbar buttons out ONE-BY-ONE.
      if (toolbarBtns.length) {
        phase1.to(
          toolbarBtns,
          { opacity: 0, y: 4, duration: T.fade, ease: T.exitEase, stagger: T.btnStagger },
          0,
        );
      } else if (toolbar) {
        phase1.to(toolbar, { opacity: 0, y: 4, duration: T.fade, ease: T.exitEase }, 0);
      }

      // Fade + nudge inputWrap out.
      if (inputWrap) {
        phase1.to(
          inputWrap,
          { opacity: 0, y: 6, duration: T.fade, ease: T.exitEase },
          0,
        );
      }

      // Tween card height FROM → TO simultaneously with content exit.
      phase1.to(
        card,
        { height: heightTo, duration: T.height, ease: T.exitEase },
        0,
      );

      voiceAnimRef.current = phase1;

    } else {
      // ── EXIT: voice body out → frame settles → composer body in ─────────────

      const voiceBody       = voiceBodyRef.current;
      const voiceToolbar    = card.querySelector<HTMLElement>('.voice-toolbar');
      const voiceStatus     = card.querySelector<HTMLElement>('.voice-status');
      const voiceWave       = card.querySelector<HTMLElement>('.voice-wave-inline');
      const voiceHintEl     = card.querySelector<HTMLElement>('.voice-hint, .voice-error');
      const toolbar         = card.querySelector<HTMLElement>('.composer-toolbar:not(.voice-toolbar)');
      const inputWrap       = card.querySelector<HTMLElement>('.composer-input-wrap');

      // Reduced-motion: instant swap — hide voice body immediately.
      if (prefersReducedMotion()) {
        if (voiceBody) voiceBody.style.display = 'none';
        if (inputWrap) gsap.set(inputWrap, { clearProps: 'all' });
        if (toolbar)   gsap.set(toolbar,   { clearProps: 'all' });
        return;
      }

      // Restore inputWrap + toolbar into layout at opacity 0 so Phase 2 can fade
      // them in — prevents a React re-render flash of composer buttons appearing.
      if (inputWrap) gsap.set(inputWrap, { display: '', opacity: 0, y: 6 });
      if (toolbar)   gsap.set(toolbar,   { opacity: 0, y: 4 });

      const toolbarBtns = toolbar
        ? Array.from(toolbar.querySelectorAll<HTMLElement>('button, label, [role="button"]'))
        : [];
      if (toolbarBtns.length) gsap.set(toolbarBtns, { opacity: 0, y: 4 });

      // ── Measure heights for the height tween (manual FLIP). ─────────────────
      const heightFrom = card.offsetHeight;
      // TO = composer-only height: float voice body out of flow temporarily.
      if (voiceBody) {
        voiceBody.style.position   = 'absolute';
        voiceBody.style.visibility = 'hidden';
      }
      const heightTo = card.offsetHeight;
      if (voiceBody) {
        voiceBody.style.position   = '';
        voiceBody.style.visibility = '';
      }
      card.style.height   = `${heightFrom}px`;
      card.style.overflow = 'hidden';
      void card.offsetHeight; // force reflow

      // Voice content targets for stagger.
      const voiceTopTargets = [voiceStatus, voiceWave, voiceHintEl].filter(Boolean) as HTMLElement[];

      // ── Phase 2 builder: reveal composer elements ────────────────────────────
      // Called after Phase 1 completes + T.gap settle delay. overflow is already
      // cleared by this point.
      const runPhase2Exit = () => {
        const phase2 = gsap.timeline({
          onComplete: () => {
            // Hide the pre-rendered voice shell (display:none = zero layout contribution).
            if (voiceBody) voiceBody.style.display = 'none';
            // Clear GSAP inline styles so they're clean for next time.
            if (inputWrap)          gsap.set(inputWrap,    { clearProps: 'all' });
            if (toolbar)            gsap.set(toolbar,       { clearProps: 'all' });
            if (toolbarBtns.length) gsap.set(toolbarBtns,  { clearProps: 'all' });
          },
        });

        // Fade in composer body first.
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

      // ── Phase 1 timeline: settle the frame ──────────────────────────────────
      const phase1 = gsap.timeline({
        onComplete: () => {
          card.style.height   = '';
          card.style.overflow = '';
          gsap.delayedCall(T.gap, runPhase2Exit);
        },
      });

      // Stagger voice toolbar buttons out ONE-BY-ONE (bottom → top visual flow).
      if (voiceToolbar) {
        const voiceBtns = Array.from(
          voiceToolbar.querySelectorAll<HTMLElement>('button, [role="button"]'),
        );
        if (voiceBtns.length) {
          phase1.to(
            voiceBtns,
            { opacity: 0, y: 8, duration: T.fade, ease: T.exitEase, stagger: T.btnStagger },
            0,
          );
        } else {
          phase1.to(voiceToolbar, { opacity: 0, y: 8, duration: T.fade, ease: T.exitEase }, 0);
        }
      }

      // Fade voice top targets out ONE-BY-ONE.
      if (voiceTopTargets.length) {
        phase1.to(
          voiceTopTargets,
          { opacity: 0, y: -8, duration: T.fade, ease: T.exitEase, stagger: T.topStagger },
          0,
        );
      } else if (voiceBody) {
        phase1.to(voiceBody, { opacity: 0, y: -8, duration: T.fade, ease: T.exitEase }, 0);
      }

      // Tween card height back.
      phase1.to(
        card,
        { height: heightTo, duration: T.height, ease: T.exitEase },
        0,
      );

      voiceAnimRef.current = phase1;
    }
  }, [voice]); // eslint-disable-line react-hooks/exhaustive-deps

  // Kill any in-flight voice timeline on unmount to avoid post-unmount callbacks.
  useEffect(() => {
    return () => {
      voiceAnimRef.current?.kill();
    };
  }, []);

  // On initial mount, ensure the voice shell is hidden (display:none) so it
  // adds zero height to the idle composer. This runs synchronously before paint.
  useLayoutEffect(() => {
    const voiceBody = voiceBodyRef.current;
    if (voiceBody && !voice) {
      voiceBody.style.display = 'none';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  useEffect(() => {
    setSkillBrowserOpen(false);
    setVoice(false);
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
    if (disabled || optimizing) return;
    const original = composer.getState().text ?? '';
    if (!original.trim()) return;
    const sid = key; // the session this enhancement belongs to
    patchEnhance(sid, { optimizing: true });
    try {
      const result = await optimizePrompt(original);
      // Store the review UNDER ITS SESSION — if the user switched away, it waits
      // there until they return; it never appears on the wrong session.
      patchEnhance(sid, { optimizing: false, review: { ...result, original } });
    } catch {
      patchEnhance(sid, { optimizing: false });
    }
  }, [composer, disabled, optimizing, key, patchEnhance]);

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

  const { nodes: overlayNodes, hasPills } = useMemo(
    () => renderMentions(text, skillNames, agentNames),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, skillNames, agentNames],
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
    <ComposerPrimitive.Root className="composer">
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
      {termWarm ? (
        <div ref={termWrapRef} className="term-warm">
          <TerminalView
            output={shell.output}
            requestCapture={shell.poll}
            clearOutput={shell.clear}
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
            `active={voice}` gates mic acquisition — mic is never grabbed while
            the shell is pre-rendered-idle. */}
        <VoiceInline
          active={voice}
          bodyRef={voiceBodyRef}
          onCommit={commitVoice}
          onClose={exitVoice}
          stopRef={voiceStopRef}
        />
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
            placeholder={disabled && !terminal ? 'Select a session…' : ' '}
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
                className="composer-attach"
                aria-label="Attach a file"
                title="Attach a file"
                multiple
                disabled={disabled}
              >
                <PlusIcon />
              </ComposerPrimitive.AddAttachment>
              <button
                type="button"
                className="composer-mic"
                aria-label="Voice input"
                title="Voice input"
                disabled={disabled}
                data-hotkey="⌘S"
                onClick={openVoice}
              >
                <MicIcon />
              </button>
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
          <span className="composer-toolbar-spacer" />
          {/* Sub-agent toggle: when active, outgoing prompts are prefixed
              with "Using a sub-agent." Sits in the right cluster so it's
              visually adjacent to the send buttons it influences. Only shown
              in non-terminal, non-voice mode. */}
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
          {/* Secondary: bypass — send the raw composer text without optimising. */}
          {!terminal && !voice ? (
            <button
              type="button"
              className="composer-enhance composer-bypass"
              aria-label="Send without optimising"
              title="Send raw — skip the optimiser (⌘/Ctrl+⇧+↵)"
              disabled={disabled || optimizing || empty}
              onClick={() => {
                composer.send();
                refocusComposer();
              }}
            >
              <ArrowUpIcon />
            </button>
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
            // While the agent is generating, show STOP (Esc). The optimise/send
            // button stays available too WHENEVER there's text — so you can stop
            // the current turn AND queue a new message. Empty + working → just
            // Stop. Not working → just optimise/send.
            <>
              {working ? (
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
              {!working || !empty ? (
                <button
                  type="button"
                  ref={sendBtnRef}
                  className="composer-send"
                  data-queue={working ? 'true' : undefined}
                  aria-label="Optimise and send"
                  title="Optimise & send (⌘/Ctrl+↵)"
                  disabled={disabled || optimizing || empty}
                  data-hotkey="⌘↵"
                  onClick={() => void runEnhance()}
                >
                  {optimizing ? (
                    <span className="composer-enhance-spinner" aria-hidden="true" />
                  ) : (
                    <SparkleIcon />
                  )}
                </button>
              ) : null}
            </>
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
}

function VoiceInline({ active, bodyRef, onCommit, onClose, stopRef }: VoiceInlineProps) {
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
        {status === 'recording' || status === 'paused' ? (
          <button
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

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
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


function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* 4-point sparkle: vertical diamond + horizontal diamond */}
      <path
        d="M12 2 L13.5 9.5 L21 11 L13.5 12.5 L12 20 L10.5 12.5 L3 11 L10.5 9.5 Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M19 2 L19.8 4.2 L22 5 L19.8 5.8 L19 8 L18.2 5.8 L16 5 L18.2 4.2 Z"
        fill="currentColor"
        opacity="0.6"
      />
    </svg>
  );
}

