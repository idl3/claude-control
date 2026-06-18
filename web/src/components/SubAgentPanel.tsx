import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { convertMessages } from '../lib/convert';
import { AssistantMessage, UserMessage } from './Messages';
import gsap, { prefersReducedMotion } from '../lib/anim';
import type { SubAgent, AgentDef, NestedSubAgent } from '../lib/types';

interface SubAgentPanelProps {
  subagents: SubAgent[];
  open: boolean;
  onClose: () => void;
}

// Same renderers as the main chat → tool calls, markdown, reasoning all look
// identical in a sub-agent transcript.
const messageComponents = {
  UserMessage,
  AssistantMessage,
  SystemMessage: AssistantMessage,
} as const;

/**
 * Read-only nested chat: renders a sub-agent's transcript with the exact
 * message/tool/markdown components the main thread uses. A throwaway external-
 * store runtime feeds it; autoScroll tails the conversation as the agent runs.
 */
function SubAgentThread({ messages }: { messages: SubAgent['messages'] }) {
  const converted = useMemo<ThreadMessageLike[]>(
    () => convertMessages(messages),
    [messages],
  );
  const runtime = useExternalStoreRuntime({
    messages: converted,
    isDisabled: true,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {}, // read-only: composer is never shown
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="sa-thread-root">
        <ThreadPrimitive.Viewport className="sa-thread-viewport" autoScroll>
          <ThreadPrimitive.Empty>
            <div className="thread-empty">no output yet…</div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={messageComponents} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

type Tab = 'active' | 'completed' | 'all';
const TAB_LABELS: Record<Tab, string> = {
  active: 'Active',
  completed: 'Completed',
  all: 'All',
};

/** Resolve the effective model: transcript wins, then def front-matter. */
function resolveModel(agent: SubAgent): string | null {
  if (agent.model) return agent.model;
  if (agent.def?.model) return agent.def.model;
  return null;
}

/**
 * Inline chip: `agentType · model`. Clicking this component is handled by the
 * parent row button, so the chip itself is purely presentational.
 */
function AgentChip({ agentType, model }: { agentType: string | null; model: string | null }) {
  return (
    <span className="agent-chip">
      <span className="agent-chip-name">{agentType || 'sub-agent'}</span>
      {model ? <span className="agent-chip-model">{model}</span> : null}
    </span>
  );
}

/**
 * Definition block: renders parsed front-matter fields from the agent `.md`
 * file. Shows description, tools, model and any extra keys.
 */
function AgentDefBlock({ def, agentType }: { def: AgentDef | null | undefined; agentType: string | null }) {
  if (!def) {
    // No def found — just show the name as a faint note.
    return (
      <div className="agent-def">
        <span className="agent-def-no-def">{agentType || 'sub-agent'}</span>
      </div>
    );
  }

  // Render description first, then tools chips, then remaining keys (excluding
  // `name` since it's already shown in the chip header).
  const knownKeys = new Set(['name', 'description', 'tools', 'model']);
  const extraKeys = Object.keys(def).filter((k) => !knownKeys.has(k));

  return (
    <div className="agent-def">
      {def.description ? (
        <div className="agent-def-row agent-def-desc">{def.description}</div>
      ) : null}
      {def.tools ? (
        <div className="agent-def-row">
          <span className="agent-def-label">tools</span>
          <span className="agent-def-val agent-def-tools">{def.tools}</span>
        </div>
      ) : null}
      {def.model ? (
        <div className="agent-def-row">
          <span className="agent-def-label">model</span>
          <span className="agent-def-val">{def.model}</span>
        </div>
      ) : null}
      {extraKeys.map((k) => (
        <div key={k} className="agent-def-row">
          <span className="agent-def-label">{k}</span>
          <span className="agent-def-val">{def[k]}</span>
        </div>
      ))}
    </div>
  );
}

/** One-level nested sub-agent list. */
function NestedAgentList({ nested }: { nested: NestedSubAgent[] | undefined }) {
  if (!nested || nested.length === 0) return null;
  return (
    <div className="agent-nested">
      <span className="agent-nested-label">nested ({nested.length})</span>
      <div className="agent-nested-list">
        {nested.map((n) => (
          <AgentChip key={n.agentId} agentType={n.agentType} model={n.model} />
        ))}
      </div>
    </div>
  );
}

function AgentBadge({ agent }: { agent: SubAgent }) {
  const model = resolveModel(agent);
  return (
    <>
      <span className="sa-dot" data-status={agent.status} aria-hidden="true" />
      <AgentChip agentType={agent.agentType} model={model} />
      {agent.description ? <span className="sa-desc">{agent.description}</span> : null}
      <span className="sa-status">
        {agent.status === 'running' ? '· running' : '· done'}
      </span>
    </>
  );
}

/**
 * Sub-agent side panel (desktop: up to half the page; mobile: full-screen nested
 * chat). Tabs filter Active / Completed / All; selecting an agent opens its
 * transcript as a nested chat you can follow live, then back to the list.
 */
export function SubAgentPanel({ subagents, open, onClose }: SubAgentPanelProps) {
  const [tab, setTab] = useState<Tab>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const running = subagents.filter((a) => a.status === 'running').length;
  const counts: Record<Tab, number> = {
    active: running,
    completed: subagents.length - running,
    all: subagents.length,
  };
  const selected = selectedId
    ? subagents.find((a) => a.agentId === selectedId) ?? null
    : null;
  const list = useMemo(
    () =>
      subagents.filter((a) =>
        tab === 'all'
          ? true
          : tab === 'active'
            ? a.status === 'running'
            : a.status === 'done',
      ),
    [subagents, tab],
  );

  // Slide + fade the drawer in on open (and on switching list↔detail).
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !panelRef.current || prefersReducedMotion()) return;
    gsap.fromTo(
      panelRef.current,
      { x: 28, opacity: 0 },
      { x: 0, opacity: 1, duration: 0.28, ease: 'power3.out' },
    );
  }, [open, !!selected]);

  if (!open) return null;

  // Detail: the selected agent's transcript as a nested chat.
  if (selected) {
    const selectedModel = resolveModel(selected);
    return (
      <>
        <div className="sa-backdrop" aria-hidden="true" onClick={onClose} />
        <div className="sa-panel" ref={panelRef} role="complementary" aria-label="Sub-agent transcript">
        <header className="sa-panel-head">
          <button
            type="button"
            className="sa-back"
            aria-label="Back to list"
            onClick={() => setSelectedId(null)}
          >
            ‹
          </button>
          <span className="sa-panel-title sa-detail-title">
            <span className="sa-dot" data-status={selected.status} aria-hidden="true" />
            <AgentChip agentType={selected.agentType} model={selectedModel} />
            <span className="sa-status">
              {selected.status === 'running' ? '· running' : '· done'}
            </span>
          </span>
          <button
            type="button"
            className="sa-panel-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <AgentDefBlock def={selected.def} agentType={selected.agentType} />
        <NestedAgentList nested={selected.nested} />
        <SubAgentThread messages={selected.messages} />
        </div>
      </>
    );
  }

  // List with tabs.
  return (
    <>
      <div className="sa-backdrop" aria-hidden="true" onClick={onClose} />
      <div className="sa-panel" ref={panelRef} role="complementary" aria-label="Sub-agents">
      <header className="sa-panel-head">
        <span className="sa-panel-title">
          Sub-agents <span className="sa-count">{subagents.length}</span>
          {running ? <span className="sa-count-running">{running} running</span> : null}
        </span>
        <button
          type="button"
          className="sa-panel-close"
          aria-label="Close sub-agents panel"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="sa-tabs" role="tablist">
        {(['active', 'completed', 'all'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className="sa-tab"
            data-on={tab === t ? 'true' : undefined}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
            <span className="sa-tab-count">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="sa-panel-body">
        {list.length === 0 ? (
          <div className="sa-empty">
            No {tab === 'all' ? '' : `${tab} `}sub-agents.
          </div>
        ) : (
          list.map((a) => (
            <button
              key={a.agentId}
              type="button"
              className="sa-item-row"
              onClick={() => setSelectedId(a.agentId)}
            >
              <AgentBadge agent={a} />
              <span className="sa-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ))
        )}
      </div>
      </div>
    </>
  );
}
