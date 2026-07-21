import { useEffect, useRef } from 'react';
import gsap, { prefersReducedMotion } from '../lib/anim';
import type { Msg } from '../lib/types';
import { SubAgentThread } from './SubAgentThread';

interface WorkflowAgentViewProps {
  /** Agent label for the overlay header; null while unknown. */
  label: string | null;
  messages: Msg[];
  loading: boolean;
  onClose: () => void;
}

/**
 * B3 Agent View — full transcript overlay for ONE workflow agent. Reuses the
 * exact single sub-agent viewer (SubAgentThread) + the SubAgentPanel drawer
 * chrome (.sa-backdrop / .sa-panel), so a workflow agent's transcript reads
 * identically to a top-level sub-agent's (S4: no new viewer). Messages are
 * loaded on demand by useClaudeControl.requestWorkflowAgent → workflow-agent-load.
 */
export function WorkflowAgentView({ label, messages, loading, onClose }: WorkflowAgentViewProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panelRef.current || prefersReducedMotion()) return;
    gsap.fromTo(
      panelRef.current,
      { x: 28, opacity: 0 },
      {
        x: 0,
        opacity: 1,
        duration: 0.28,
        ease: 'power3.out',
        onComplete: () => gsap.set(panelRef.current, { clearProps: 'transform' }),
      },
    );
  }, []);

  return (
    <>
      <div className="sa-backdrop" aria-hidden="true" onClick={onClose} />
      <div className="sa-panel" ref={panelRef} role="complementary" aria-label="Workflow agent transcript">
        <header className="sa-panel-head">
          <span className="sa-panel-title sa-detail-title">
            <span className="sa-dot" data-status="done" aria-hidden="true" />
            <span className="agent-chip">
              <span className="agent-chip-name">{label || 'agent'}</span>
            </span>
          </span>
          <button type="button" className="sa-panel-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <SubAgentThread messages={messages} loading={loading} />
      </div>
    </>
  );
}
