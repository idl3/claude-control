import type { Block, SubAgent } from '../lib/types';

interface SubAgentPanelProps {
  subagents: SubAgent[];
  open: boolean;
  onClose: () => void;
}

// Compact, runtime-free render of a sub-agent transcript block. (The main thread
// uses assistant-ui's runtime; sub-agents render straight from raw blocks so the
// panel stays independent of the active thread.)
function SaBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'text':
      return block.text && block.text.trim() ? (
        <div className="sa-text">{block.text}</div>
      ) : null;
    case 'thinking':
      return block.text && block.text.trim() ? (
        <details className="sa-think">
          <summary>thinking</summary>
          <div className="sa-think-body">{block.text}</div>
        </details>
      ) : null;
    case 'tool_use':
      return (
        <div className="sa-tool">
          ▸ {block.name || 'tool'}
          {block.inputSummary ? <span className="sa-tool-arg"> — {block.inputSummary}</span> : null}
        </div>
      );
    case 'tool_result':
      return (
        <div className="sa-result" data-error={block.isError ? 'true' : 'false'}>
          {(block.text || '').slice(0, 2000)}
        </div>
      );
    default:
      return null;
  }
}

function SubAgentItem({ agent }: { agent: SubAgent }) {
  const title = agent.agentType || 'sub-agent';
  return (
    <details className="sa-item" data-status={agent.status}>
      <summary className="sa-summary">
        <span className="sa-dot" data-status={agent.status} aria-hidden="true" />
        <span className="sa-type">{title}</span>
        {agent.description ? <span className="sa-desc">{agent.description}</span> : null}
        <span className="sa-status">{agent.status === 'running' ? '· running' : '· done'}</span>
      </summary>
      <div className="sa-transcript">
        {agent.messages.length === 0 ? (
          <div className="sa-empty">no output yet…</div>
        ) : (
          agent.messages.map((m, i) => (
            <div key={m.uuid || i} className="sa-msg" data-role={m.role}>
              <div className="sa-msg-role">{m.role}</div>
              {(m.blocks ?? []).map((b, j) => (
                <SaBlock key={j} block={b} />
              ))}
            </div>
          ))
        )}
      </div>
    </details>
  );
}

// Right-side drawer listing the selected session's sub-agents (Task/Agent) and
// streaming each one's transcript.
export function SubAgentPanel({ subagents, open, onClose }: SubAgentPanelProps) {
  if (!open) return null;
  const running = subagents.filter((a) => a.status === 'running').length;
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
      <div className="sa-panel-body">
        {subagents.length === 0 ? (
          <div className="sa-empty">No sub-agents for this session.</div>
        ) : (
          subagents.map((a) => <SubAgentItem key={a.agentId} agent={a} />)
        )}
      </div>
    </div>
  );
}
