import { useMemo, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { convertMessages } from '../lib/convert';
import { AssistantMessage, UserMessage } from './Messages';
import type { SubAgent } from '../lib/types';

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

function AgentBadge({ agent }: { agent: SubAgent }) {
  return (
    <>
      <span className="sa-dot" data-status={agent.status} aria-hidden="true" />
      <span className="sa-type">{agent.agentType || 'sub-agent'}</span>
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

  if (!open) return null;

  // Detail: the selected agent's transcript as a nested chat.
  if (selected) {
    return (
      <div className="sa-panel" role="complementary" aria-label="Sub-agent transcript">
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
            <AgentBadge agent={selected} />
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
        <SubAgentThread messages={selected.messages} />
      </div>
    );
  }

  // List with tabs.
  return (
    <div className="sa-panel" role="complementary" aria-label="Sub-agents">
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
  );
}
