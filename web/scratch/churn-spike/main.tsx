import './preview.css';

// Stray API calls get a benign empty response — EXCEPT /api/media/*, which the
// vite middleware emulates so EmbeddedApp's real fetch path is exercised.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const u = String(typeof input === 'string' ? input : (input as Request).url ?? input);
  if (u.includes('/api/') && !u.includes('/api/media/')) {
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { UserMessage, AssistantMessage } from '../../src/components/Messages';
import { ArtifactPanelProvider } from '../../src/components/ArtifactContext';
import { AppFrameLayer } from '../../src/components/AppFrameLayer';

/**
 * A2 churn-survival spike (Phase A, OQ3), re-run post-A3-fix: does
 * identity-stabilization alone stop <embedded-app> iframes from remounting
 * under transcript churn, or does assistant-ui move/rewrap row DOM
 * regardless (forcing the hoisted-portal fallback)? See
 * docs/plans/cockpit-pinned-artifacts/phase-a-tasks.md (A2/A3).
 *
 * Two independent thread instances render side-by-side, seeded identically,
 * driven by the SAME churn schedule, differing only in how the underlying
 * ThreadMessageLike[] array is produced each tick:
 *   - stable:   append-only — every previously-created message object keeps
 *               its exact reference; only the array container is new.
 *   - unstable: every tick clones EVERY message object into a fresh
 *               reference (emulates App.tsx's pre-fix convertMessages,
 *               which rebuilds the whole array from scratch whenever
 *               cockpit.messages gets a new reference).
 *
 * A2 verdict was HOIST-LAYER (both variants reloaded ~equally, far above a
 * 1-load steady state) — EmbeddedApp/AppFrameLayer are now the A3 fix, so
 * this re-run exercises the real fixed components unmodified. Each panel
 * embeds a distinct url (?panel=stable / ?panel=unstable) so AppFrameLayer's
 * url-keyed registry — shared across both panels, as it is in production —
 * tracks them as separate slots instead of colliding onto one. A host-level
 * capture-phase 'load' listener (load events on <iframe> don't bubble, but
 * DO fire during capture) counts every load fired by the hoisted `.embed-app`
 * iframe, split by variant via its `title` (AppFrameLayer sets title=url) —
 * `closest('[data-panel]')` no longer works post-fix since the live iframe is
 * portaled to document.body, outside the panel's own DOM subtree.
 */

type Variant = 'stable' | 'unstable';

const EMBED_URL = (variant: Variant) => `/api/media/proof/app.html?panel=${variant}`;
const PLAIN_BEFORE = 128;
const PLAIN_AFTER = 20;
const TOTAL_STEPS = 24;
const STEP_MS = 400;
const START_DELAY_MS = 1500;

function plainMessage(i: number): ThreadMessageLike {
  const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
  return {
    role,
    id: `m-${i}`,
    createdAt: new Date(Date.UTC(2026, 6, 8, 6, 0, i % 3600)),
    content: [{ type: 'text', text: `plain churn message #${i} — ${role} turn` }],
    metadata: { custom: { cockpitRole: role } },
  } as ThreadMessageLike;
}

// The one stateful embed under test — placed ~20 messages from the end of the
// 149-message base transcript so it stays in the (unwindowed) rendered range.
function embedMessage(variant: Variant): ThreadMessageLike {
  return {
    role: 'assistant',
    id: 'm-embed',
    createdAt: new Date('2026-07-08T06:02:00Z'),
    content: [
      {
        type: 'text',
        text:
          'Stateful counter app under churn:\n\n' +
          `<embedded-app url="${EMBED_URL(variant)}" height="320" />`,
      },
    ],
    metadata: { custom: { cockpitRole: 'assistant' } },
  } as ThreadMessageLike;
}

function makeBaseCore(variant: Variant): ThreadMessageLike[] {
  const arr: ThreadMessageLike[] = [];
  for (let i = 0; i < PLAIN_BEFORE; i++) arr.push(plainMessage(i));
  arr.push(embedMessage(variant));
  for (let i = PLAIN_BEFORE; i < PLAIN_BEFORE + PLAIN_AFTER; i++) arr.push(plainMessage(i));
  return arr;
}

// Trailing rows — App.tsx's convertedMessages pins pending-send bubbles then
// the working indicator at the very bottom, below whatever's in fullConverted.
function workingRow(): ThreadMessageLike {
  return {
    role: 'assistant',
    id: 'optimistic-working',
    content: [{ type: 'text', text: 'Working…' }],
    metadata: { custom: { cockpitRole: 'assistant', working: true } },
  } as ThreadMessageLike;
}

function pendingBubble(): ThreadMessageLike {
  return {
    role: 'user',
    id: 'queued-churn',
    createdAt: new Date(),
    content: [{ type: 'text', text: 'queued — churn pending send' }],
    metadata: { custom: { cockpitRole: 'user', optimistic: true, sendStatus: 'queued' } },
  } as ThreadMessageLike;
}

/**
 * Drives one variant's churn schedule via refs (never a functional setState
 * updater — those are double-invoked under StrictMode to check purity, which
 * would double-apply this driver's side effects). Each tick appends one new
 * plain message; every 4th tick also toggles a trailing working row; every
 * 6th tick also toggles a trailing pending-send bubble.
 */
function useChurn(variant: Variant): { rendered: ThreadMessageLike[]; step: number } {
  const [core, setCore] = useState<ThreadMessageLike[]>(() => makeBaseCore(variant));
  const [workingOn, setWorkingOn] = useState(false);
  const [pendingOn, setPendingOn] = useState(false);
  const [step, setStep] = useState(0);
  const coreRef = useRef(core);
  const workingRef = useRef(false);
  const pendingRef = useRef(false);
  const stepRef = useRef(0);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const startId = setTimeout(() => {
      intervalId = setInterval(() => {
        const next = stepRef.current + 1;
        if (next > TOTAL_STEPS) {
          if (intervalId) clearInterval(intervalId);
          return;
        }
        stepRef.current = next;

        const base = variant === 'unstable' ? coreRef.current.map((m) => ({ ...m })) : coreRef.current;
        const nextCore = [...base, plainMessage(1000 + next)];
        coreRef.current = nextCore;
        setCore(nextCore);

        if (next % 4 === 0) {
          workingRef.current = !workingRef.current;
          setWorkingOn(workingRef.current);
        }
        if (next % 6 === 0) {
          pendingRef.current = !pendingRef.current;
          setPendingOn(pendingRef.current);
        }
        setStep(next);
      }, STEP_MS);
    }, START_DELAY_MS);
    return () => {
      clearTimeout(startId);
      if (intervalId) clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  const rendered: ThreadMessageLike[] = [
    ...core,
    ...(pendingOn ? [pendingBubble()] : []),
    ...(workingOn ? [workingRow()] : []),
  ];

  return { rendered, step };
}

function Panel({ variant }: { variant: Variant }) {
  const { rendered, step } = useChurn(variant);
  const runtime = useExternalStoreRuntime({
    messages: rendered,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ArtifactPanelProvider>
        <div className="churn-panel" data-panel={variant} data-testid={`panel-${variant}`}>
          <div className="proto-label">
            variant: {variant} — step {step}/{TOTAL_STEPS}
          </div>
          <ThreadPrimitive.Root className="thread-root">
            <ThreadPrimitive.Viewport className="thread-viewport">
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </div>
      </ArtifactPanelProvider>
    </AssistantRuntimeProvider>
  );
}

// A3 audit follow-up (CP3-A) re-run additions ------------------------------
// FIX 2 evidence: a manual toggle wraps the 'stable' panel (embed included)
// in display:none, matching the real trigger this fix targets — mobile
// back-nav hides the WHOLE detail pane via `.detail { display: none }` while
// every descendant, including the embed placeholder, stays mounted. Toggling
// it off then on past GRACE_MS must evict then re-fetch (one extra load),
// never leak the slot forever. `hoist-count` gives a live, directly
// assertable DOM signal (screenshot-legible number) instead of relying on
// visual absence alone.
function useHoistCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setCount(document.querySelectorAll('.embed-app-hoist').length);
    }, 100);
    return () => clearInterval(id);
  }, []);
  return count;
}

function App() {
  const [counts, setCounts] = useState<Record<Variant, number>>({ stable: 0, unstable: 0 });
  const [hideStable, setHideStable] = useState(false);
  const hoistCount = useHoistCount();

  useEffect(() => {
    // 'load' does not bubble, but capture-phase listeners on an ancestor DO
    // see it on the way down to the target — the standard way to observe
    // load/error on elements you don't own directly.
    const onLoad = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLIFrameElement)) return;
      if (!target.classList.contains('embed-app')) return;
      // Post-fix, the live iframe is hoisted by AppFrameLayer to a portal
      // under document.body — no longer a descendant of [data-panel]. Its
      // title is set to the embed url (see AppFrameLayer.tsx), which now
      // carries ?panel=<variant> (see EMBED_URL above) as the attribution
      // signal instead of DOM ancestry.
      const title = target.title;
      const variant = title.includes('panel=stable')
        ? 'stable'
        : title.includes('panel=unstable')
          ? 'unstable'
          : undefined;
      if (variant !== 'stable' && variant !== 'unstable') return;
      setCounts((c) => ({ ...c, [variant]: c[variant] + 1 }));
    };
    document.addEventListener('load', onLoad, true);
    return () => document.removeEventListener('load', onLoad, true);
  }, []);

  return (
    <div className="churn-stage" data-testid="stage">
      <div className="proto-label">cockpit churn-survival spike — Phase A / A3 re-run (post-fix)</div>
      {/* Stand-ins for real chrome outside .thread-viewport (detail-head sits
          above the scroll pane, composer below) — reused verbatim from
          styles.css so the FIX-1 clip screenshot below proves a hoisted
          iframe scrolled to the pane edge stays clipped underneath them
          (z-index 2 vs the hoist layer's z-index 1), never bleeds over. */}
      <div className="detail-head">
        <strong data-testid="fake-header">fake .detail-head — must stay on top, unobscured</strong>
      </div>
      <div className="churn-counters" data-testid="churn-counters">
        <span>
          <span className="count-label">stable iframe loads:</span>
          <span className="count-value" data-testid="load-count-stable">
            {counts.stable}
          </span>
        </span>
        <span>
          <span className="count-label">unstable iframe loads:</span>
          <span className="count-value" data-testid="load-count-unstable">
            {counts.unstable}
          </span>
        </span>
        <span>
          <span className="count-label">live hoist count:</span>
          <span className="count-value" data-testid="hoist-count">
            {hoistCount}
          </span>
        </span>
        <button type="button" data-testid="toggle-hide-stable" onClick={() => setHideStable((h) => !h)}>
          {hideStable ? 'show' : 'hide'} stable pane (FIX 2 hidden-ancestor probe)
        </button>
      </div>
      <div className="churn-columns">
        {/* display:none here — not unmount — is the whole point: it
            reproduces the mobile `.detail { display: none }` case FIX 2
            targets (placeholder stays mounted, rect collapses to zero). */}
        <div style={{ display: hideStable ? 'none' : undefined }} data-testid="stable-wrap">
          <Panel variant="stable" />
        </div>
        <Panel variant="unstable" />
      </div>
      <div className="composer">
        <span data-testid="fake-composer">fake .composer — must stay on top, unobscured</span>
      </div>
      <AppFrameLayer />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
