import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  fetchSkill,
  type OptimizeResult,
  type SkillEntry,
} from '../lib/api';
import { useArtifactPanel } from './ArtifactContext';
import { OptimizeReview } from './OptimizeReview';
import { SkillBrowser } from './SkillBrowser';
import { VoiceDialog } from './VoiceDialog';
import { TerminalView } from './TerminalView';
import { useShell } from './ShellContext';
import { relayDiff, controlToken, interceptToken, navToken, isLetter, type Mods } from '../lib/terminalKeys';
import gsap, { prefersReducedMotion } from '../lib/anim';

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

// A leading slash-command still being typed (no space yet): `/`, then the
// partial name. The capture group is the query that narrows the suggestions.
const SLASH_TYPING_RE = /^\/([A-Za-z0-9:_-]*)$/;
// A completed leading slash-command (name followed by a space or end) — used to
// derive the active-skill chip.
const SLASH_DONE_RE = /^\/([A-Za-z0-9:_-]+)(?:\s|$)/;
const AC_MAX = 4;

interface ComposerProps {
  disabled: boolean;
  /** Active session id — used to scope the enhance/review state so an
   *  improvement from one session can't leak into another on switch. */
  sessionId?: string | null;
}

// Image preview for an image attachment that still carries its File (pending),
// otherwise a placeholder. Object URLs are revoked on unmount.
function AttachmentThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) return <div className="chip-thumb chip-thumb-empty" />;
  // Tap the thumbnail to open the full image in a new tab (preview).
  return (
    <img
      className="chip-thumb"
      src={url}
      alt=""
      role="button"
      tabIndex={0}
      title="Open preview"
      onClick={() => window.open(url, '_blank', 'noopener')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          window.open(url, '_blank', 'noopener');
        }
      }}
    />
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

export function Composer({ disabled, sessionId }: ComposerProps) {
  const composer = useComposerRuntime();
  const shell = useShell();
  const { open: openArtifact, close: closeArtifact } = useArtifactPanel();
  const [empty, setEmpty] = useState(true);
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
  }, []);

  // Real unload on session change: drop the warm terminal and hide it.
  useEffect(() => {
    setTerminal(false);
    setTermWarm(false);
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

  // ── Inline skill autocomplete ──────────────────────────────────────────────
  const [skills, setSkills] = useState<SkillEntry[]>(
    () => _skillsCache.get(sessionId ?? '') ?? [],
  );
  const [text, setTextMirror] = useState('');     // mirror of composer text
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
      loadSkills(sessionId).then((s) => {
        if (alive) setSkills(s);
      });
    }
    return () => { alive = false; };
  }, [sessionId]);

  // Track composer text → drives both the empty flag and the slash detection.
  useEffect(() => {
    const sync = () => {
      const t = composer.getState().text ?? '';
      setTextMirror(t);
      setEmpty(!t.trim());
    };
    sync();
    return composer.subscribe(sync);
  }, [composer]);

  const acQuery = useMemo(() => {
    const m = SLASH_TYPING_RE.exec(text);
    return m ? m[1] : null;
  }, [text]);

  // Reset highlight + un-dismiss whenever the query changes (new keystroke).
  useEffect(() => {
    setAcIndex(0);
    setAcDismissed(false);
  }, [acQuery]);

  const acItems = useMemo(() => {
    if (acQuery == null || acDismissed) return [];
    const q = acQuery.toLowerCase();
    return skills
      .filter((s) => s.name.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prefix matches first, then alphabetical.
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return ap !== bp ? ap - bp : a.name.localeCompare(b.name);
      })
      .slice(0, AC_MAX);
  }, [acQuery, acDismissed, skills]);
  const acOpen = !terminal && acItems.length > 0;

  // Active-skill chip: the leading `/<skill>` once it's a known, completed name.
  const activeSkill = useMemo(() => {
    const m = SLASH_DONE_RE.exec(text);
    return m && skills.some((s) => s.name === m[1]) ? m[1] : null;
  }, [text, skills]);

  // Stable artifact id for the active skill (so tab dedup works correctly).
  const skillArtifactId = activeSkill ? `skill-${activeSkill}` : null;

  // Track the artifact id we opened so we can close it when the skill clears.
  const openedSkillArtifactIdRef = useRef<string | null>(null);

  // When a skill becomes active: fetch its detail and open the side panel.
  // When the skill clears: close the panel for the previously-opened skill.
  useEffect(() => {
    if (!activeSkill || !skillArtifactId) {
      // Close the skill artifact that was previously opened (if any).
      if (openedSkillArtifactIdRef.current) {
        closeArtifact(openedSkillArtifactIdRef.current);
        openedSkillArtifactIdRef.current = null;
      }
      return;
    }
    let alive = true;
    fetchSkill(activeSkill, sessionId)
      .then((detail) => {
        if (!alive) return;
        openArtifact({
          id: skillArtifactId,
          kind: 'skill',
          title: `/${detail.name}`,
          content: detail.body,
          skillFrontMatter: detail.frontMatter,
          skillSource: detail.source,
        });
        openedSkillArtifactIdRef.current = skillArtifactId;
      })
      .catch(() => { /* skill not found or network error — silent */ });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSkill, sessionId]);

  const selectSkill = useCallback(
    (name: string) => {
      composer.setText(`/${name} `);
      setAcDismissed(true);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.composer-input')?.focus();
      });
    },
    [composer],
  );

  // ── Voice dictation ───────────────────────────────────────────────────────
  // The mic opens a recording dialog (waveform + Cancel/Pause/Stop) so recording
  // can always be stopped/exited. On Stop, the transcript is inserted into the
  // composer (review-then-send, never auto-send).
  const [voiceOpen, setVoiceOpen] = useState(false);
  const commitVoice = useCallback(
    (text: string) => {
      setVoiceOpen(false);
      const t = text.trim();
      if (!t) return;
      const cur = composer.getState().text ?? '';
      const sep = cur && !/\s$/.test(cur) ? ' ' : '';
      composer.setText(cur + sep + t + ' ');
    },
    [composer],
  );

  // Close the (session-agnostic) skill browser + voice dialog on a session switch.
  useEffect(() => {
    setSkillBrowserOpen(false);
    setVoiceOpen(false);
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
          then a toolbar with attach on the left and send on the right. */}
      <div className="composer-card" data-terminal={terminal ? 'true' : undefined}>
        {activeSkill ? (
          <div className="composer-skill-chip-row">
            <span className="skill-chip composer-skill-chip" title={`Invoking /${activeSkill}`}>
              <span className="skill-chip-icon" aria-hidden="true">⌁</span>
              <span className="skill-chip-name">/{activeSkill}</span>
            </span>
          </div>
        ) : null}
        {/* Placeholder needs the Kbd component, but a native placeholder is
            text-only — so use a space placeholder (keeps :placeholder-shown
            working + invisible) and overlay a hint shown only while empty. */}
        <div className="composer-input-wrap">
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder={disabled && !terminal ? 'Select a session…' : ' '}
            submitOnEnter={false}
            onKeyDown={(e) => {
              // ⌘/Ctrl+S → open voice (speaking) mode, in any composer state.
              if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
                e.preventDefault();
                setVoiceOpen(true);
                return;
              }
              // Terminal mode: most keys edit the visible buffer (relayed via the
              // diff). Intercept only the keys that must go straight to the shell.
              if (terminal) {
                if (e.metaKey) return; // ⌘ combos belong to the browser/OS
                // Esc leaves terminal mode → back to composer. (Send a literal
                // Escape to the shell via the on-screen key bar's Esc button.)
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setTerminal(false);
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
        <div className="composer-attachments">
          <ComposerPrimitive.Attachments>
            {({ attachment }) => <AttachmentChip attachment={attachment} />}
          </ComposerPrimitive.Attachments>
        </div>

        <div className="composer-toolbar">
          {!terminal ? (
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
                className="composer-skills-btn"
                aria-label="Browse skills"
                title="Browse skills"
                disabled={disabled}
                onClick={() => setSkillBrowserOpen((v) => !v)}
              >
                <SlashIcon />
              </button>
              <button
                type="button"
                className="composer-mic"
                aria-label="Voice input"
                title="Voice input"
                disabled={disabled}
                data-hotkey="⌘S"
                onClick={() => setVoiceOpen(true)}
              >
                <MicIcon />
              </button>
            </>
          ) : null}
          {/* Terminal-mode toggle (>_): turns the composer into a CLI. Always
              available (the shell pane is independent of the selected session). */}
          <button
            type="button"
            className="composer-skills-btn composer-term-toggle"
            aria-label="Terminal mode"
            title="Terminal mode — run shell commands"
            aria-pressed={terminal}
            data-on={terminal ? 'true' : undefined}
            onClick={() => (terminal ? setTerminal(false) : openTerminal())}
          >
            <TerminalIcon />
          </button>
          <span className="composer-toolbar-spacer" />
          {/* Secondary: bypass — send the raw composer text without optimising. */}
          {!terminal ? (
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
          {terminal ? (
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
          ) : (
            // Primary / default: optimise → review → auto-send.
            <button
              type="button"
              ref={sendBtnRef}
              className="composer-send"
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
      {voiceOpen ? (
        <VoiceDialog onCommit={commitVoice} onClose={() => setVoiceOpen(false)} />
      ) : null}
    </ComposerPrimitive.Root>
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

function SlashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 20L17 4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
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
