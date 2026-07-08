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

/**
 * A2 churn-survival spike (Phase A, OQ3): does identity-stabilization alone
 * stop <embedded-app> iframes from remounting under transcript churn, or does
 * assistant-ui move/rewrap row DOM regardless (forcing the hoisted-portal
 * fallback)? See docs/plans/cockpit-pinned-artifacts/phase-a-tasks.md (A2).
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
 * A host-level capture-phase 'load' listener (load events on <iframe> don't
 * bubble, but DO fire during capture) counts every load fired by the
 * `.embed-app` iframe in each column, split by variant via the closest
 * `[data-panel]` ancestor.
 */

type Variant = 'stable' | 'unstable';

const EMBED_URL = '/api/media/proof/app.html';
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
function embedMessage(): ThreadMessageLike {
  return {
    role: 'assistant',
    id: 'm-embed',
    createdAt: new Date('2026-07-08T06:02:00Z'),
    content: [
      {
        type: 'text',
        text:
          'Stateful counter app under churn:\n\n' +
          `<embedded-app url="${EMBED_URL}" height="320" />`,
      },
    ],
    metadata: { custom: { cockpitRole: 'assistant' } },
  } as ThreadMessageLike;
}

function makeBaseCore(): ThreadMessageLike[] {
  const arr: ThreadMessageLike[] = [];
  for (let i = 0; i < PLAIN_BEFORE; i++) arr.push(plainMessage(i));
  arr.push(embedMessage());
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
  const [core, setCore] = useState<ThreadMessageLike[]>(() => makeBaseCore());
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

function App() {
  const [counts, setCounts] = useState<Record<Variant, number>>({ stable: 0, unstable: 0 });

  useEffect(() => {
    // 'load' does not bubble, but capture-phase listeners on an ancestor DO
    // see it on the way down to the target — the standard way to observe
    // load/error on elements you don't own directly.
    const onLoad = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLIFrameElement)) return;
      if (!target.classList.contains('embed-app')) return;
      const panelEl = target.closest('[data-panel]') as HTMLElement | null;
      const variant = panelEl?.dataset.panel as Variant | undefined;
      if (variant !== 'stable' && variant !== 'unstable') return;
      setCounts((c) => ({ ...c, [variant]: c[variant] + 1 }));
    };
    document.addEventListener('load', onLoad, true);
    return () => document.removeEventListener('load', onLoad, true);
  }, []);

  return (
    <div className="churn-stage" data-testid="stage">
      <div className="proto-label">cockpit churn-survival spike — Phase A / A2 (OQ3)</div>
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
      </div>
      <div className="churn-columns">
        <Panel variant="stable" />
        <Panel variant="unstable" />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
