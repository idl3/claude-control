import { useState } from 'react';
import { useMessage, TextMessagePartProvider } from '@assistant-ui/react';
import type {
  TextMessagePartComponent,
  ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import { toolInput, toolResult, toolSummary } from '../lib/convert';
import { MarkdownText, MD_COMPONENTS, BASE_PLUGINS } from './MarkdownText';
import { InlineAttachmentPreviews } from './AttachmentPreview';
import { isSkillInvocation, SkillInvocation } from './SkillInvocation';
import { GoalPill, TextWithUltrathink } from './ReservedTokens';
import { parseGoalInvocation } from '../lib/reservedTokens';
import { useArtifactPanel } from './ArtifactContext';
import { ClaudeRobotIcon } from './ClaudeRobotIcon';
import { CodexIcon } from './CodexIcon';
import { useAgentKind } from './AgentContext';
import { WorkflowCard } from './WorkflowCard';
import { useWorkflows } from './WorkflowContext';

// The optimistic "Working…" placeholder (App.tsx, while Claude's real reply is
// pending) renders as an animated spinner; everything else is GitHub-flavored
// markdown (see MarkdownText).
const WORKING_RE = /^\s*working…?\s*$/i;
export const TextPart: TextMessagePartComponent = (props) => {
  const agentKind = useAgentKind();
  const role = useMessage((m) => m.role);
  if (typeof props.text === 'string' && WORKING_RE.test(props.text)) {
    return (
      <span className="working-indicator" role="status" aria-live="polite">
        <span className="working-claude" aria-hidden="true">
          {agentKind === 'codex' ? (
            <CodexIcon size={14} />
          ) : (
            <ClaudeRobotIcon size={14} />
          )}
        </span>
        <span className="shimmer-text">Working…</span>
      </span>
    );
  }
  // /goal is a reserved token — only in user messages, so an assistant reply
  // that happens to start with the literal text "/goal" is never repainted.
  const goal = role === 'user' && typeof props.text === 'string'
    ? parseGoalInvocation(props.text)
    : null;
  if (goal) {
    return (
      <>
        <GoalPill token={goal.token} />
        {goal.rest ? <TextWithUltrathink text={goal.rest} /> : null}
      </>
    );
  }
  if (typeof props.text === 'string' && isSkillInvocation(props.text)) {
    return <SkillInvocation text={props.text} />;
  }
  // Render the markdown text + any inline attachment previews detected in the
  // raw text. Previews appear below the text block (thumbnails / file chips).
  return (
    <>
      <MarkdownText {...props} />
      {typeof props.text === 'string' ? (
        <InlineAttachmentPreviews text={props.text} />
      ) : null}
    </>
  );
};

// The last non-empty line of the reasoning, trimmed for the chain-of-thought
// summary (rolled via slot-text while live — see Messages.tsx ChainOfThought).
const MAX_LAST = 90;
export function lastUpdateLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return l.length > MAX_LAST ? l.slice(0, MAX_LAST - 1) + '…' : l;
  }
  return '';
}

// Pretty-print structured tool input. Falls back to the summary string for
// primitives / empty objects.
function formatInput(args: unknown): string {
  const input = toolInput(args);
  if (input == null) return '';
  if (typeof input === 'object' && Object.keys(input).length === 0) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// AskUserQuestion → a clean Q&A card (question + chosen answer) instead of the
// raw tool-call row. The chosen answers live in the tool_result string:
//   Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now …
// We parse those pairs and pair them with the structured questions/options from
// the tool_use input.
interface AskInputQuestion {
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
}

export function parseAskAnswers(text: string): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  const re = /"([^"]+)"="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ question: m[1], answer: m[2] });
  return out;
}

// Shared renderer for the Q&A card in both states: answered (✓ + chosen label)
// and awaiting (question + "awaiting your answer…"). `pairs` is empty when not
// yet answered. Used by AskAnsweredPart (transcript record) AND PendingAskCard
// (the live incoming question, shown the moment it's asked).
function AskCard({
  questions,
  pairs,
  answered,
}: {
  questions: AskInputQuestion[];
  pairs: { question: string; answer: string }[];
  answered: boolean;
}) {
  return (
    <div className="ask-answered" data-answered={answered ? 'true' : 'false'}>
      {questions.map((q, i) => {
        const chosen = (pairs.find((p) => p.question === q.question) ?? pairs[i])?.answer ?? null;
        const opt = q.options?.find((o) => o.label === chosen);
        return (
          <div className="ask-answered-row" key={i}>
            {q.header ? <div className="ask-answered-header">{q.header}</div> : null}
            <div className="ask-answered-q">{q.question}</div>
            {answered ? (
              <div className="ask-answered-a">
                <span className="ask-answered-check" aria-hidden="true">✓</span>
                <span className="ask-answered-label">{chosen ?? '—'}</span>
              </div>
            ) : (
              <div className="ask-answered-waiting">awaiting your answer…</div>
            )}
            {/* When still awaiting, surface each option's description so the user
                has the full incoming context to choose by — not just labels. */}
            {answered
              ? opt?.description
                ? <div className="ask-answered-desc">{opt.description}</div>
                : null
              : q.options
                  ?.filter((o) => o.description)
                  .map((o) => (
                    <div className="ask-answered-opt" key={o.label}>
                      <span className="ask-answered-opt-label">{o.label}</span>
                      <span className="ask-answered-opt-desc">{o.description}</span>
                    </div>
                  ))}
          </div>
        );
      })}
    </div>
  );
}

export const AskAnsweredPart: ToolCallMessagePartComponent = (props) => {
  const { args, result } = props;
  const input = toolInput(args) as { questions?: AskInputQuestion[] } | null;
  const questions = input?.questions ?? [];
  const res = toolResult(result);
  const answered = res != null && !res.isError;
  const pairs = answered ? parseAskAnswers(res.text) : [];

  // No structured questions to show → fall back to the generic tool row.
  if (questions.length === 0) return <ToolPart {...props} />;

  return <AskCard questions={questions} pairs={pairs} answered={answered} />;
};

// ExitPlanMode → a titled, collapsible "Plan" card showing the `plan` argument
// (Claude's plan markdown) rendered as GitHub-flavored markdown, instead of the
// raw JSON args blob the generic ToolPart would otherwise dump into a <pre>.
// Reuses the SAME markdown pipeline as assistant message text (MarkdownText.tsx's
// MD_COMPONENTS + BASE_PLUGINS, fed through MarkdownTextPrimitive) via
// TextMessagePartProvider, which stands up a synthetic "text" message-part
// context for arbitrary strings outside the normal transcript stream — no
// second markdown library, no hand-rolled remark config.
export const ExitPlanPart: ToolCallMessagePartComponent = (props) => {
  const input = toolInput(props.args) as { plan?: unknown; planFilePath?: unknown } | null;
  const plan = input && typeof input.plan === 'string' ? input.plan : '';

  // No plan text to show (unexpected shape) → fall back to the generic tool row.
  if (!plan.trim()) return <ToolPart {...props} />;

  const planFilePath =
    input && typeof input.planFilePath === 'string' && input.planFilePath.trim()
      ? input.planFilePath
      : null;

  return (
    <details className="block-tool block-plan" open>
      <summary className="block-tool-use">
        <span className="tool-head">
          <span className="tool-arrow" data-peek="true" aria-hidden="true">
            ▸
          </span>
          <span className="tool-name">Plan</span>
        </span>
      </summary>
      <div className="block-tool-body block-plan-body">
        <TextMessagePartProvider text={plan}>
          <MarkdownTextPrimitive
            className="aui-md"
            remarkPlugins={BASE_PLUGINS}
            components={MD_COMPONENTS}
          />
        </TextMessagePartProvider>
        {planFilePath ? <div className="block-plan-path">{planFilePath}</div> : null}
      </div>
    </details>
  );
};

// The live, unanswered question — rendered in the transcript timeline the moment
// it's asked (Claude Code records the AskUserQuestion turn to the JSONL only when
// answered, and sub-agent questions never reach the main transcript, so without
// this the chat shows nothing until the answer lands). Same card as the answered
// state, in its "awaiting" form, so the incoming context sits beside the choices.
export function PendingAskCard({ questions }: { questions: AskInputQuestion[] }) {
  if (!questions || questions.length === 0) return null;
  return (
    <div className="thread-incoming-ask">
      <AskCard questions={questions} pairs={[]} answered={false} />
    </div>
  );
}

// Workflow → the inline WorkflowCard, bound to the LIVE polled run (not the
// frozen tool_result). The `Workflow` tool_use INPUT carries only `{script}` —
// the runId is not there. It IS in the tool_RESULT, which reads:
//   Workflow launched in background. Task ID: <taskId>
//   Summary: <…>
//   Transcript dir: <…>/subagents/workflows/wf_<runId>
// We pull the runId from that "Transcript dir" path (primary) or any bare `wf_`
// token (fallback), then look up the live slice by runId. Extraction failure →
// the generic ToolPart (fixed-slot fallback, per B2 acceptance).
const WF_RUNID_PATH_RE = /workflows\/(wf_[A-Za-z0-9._-]+)/;
const WF_RUNID_BARE_RE = /\b(wf_[A-Za-z0-9._-]+)/;

export function extractWorkflowRunId(resultText: string | null | undefined): string | null {
  if (!resultText) return null;
  const m = WF_RUNID_PATH_RE.exec(resultText) ?? WF_RUNID_BARE_RE.exec(resultText);
  return m ? m[1] : null;
}

export const WorkflowPart: ToolCallMessagePartComponent = (props) => {
  const { byRunId, openAgent } = useWorkflows();
  const res = toolResult(props.result);
  const runId = extractWorkflowRunId(res?.text);
  const workflow = runId ? byRunId.get(runId) ?? null : null;

  // No runId, or no live run for it yet (poll hasn't surfaced the slice) → the
  // generic tool row, so the transcript never shows a blank where the card goes.
  if (!workflow || !runId) return <ToolPart {...props} />;

  const onOpenAgentTranscript = openAgent
    ? (agentId: string, label: string) => openAgent(runId, agentId, label)
    : undefined;

  return <WorkflowCard workflow={workflow} onOpenAgentTranscript={onOpenAgentTranscript} />;
};

// tool_use → controlled expandable row with a panel-open trigger on the name.
//   ▸ <ToolName> — <one-line input summary>
// A caret button toggles inline peek; clicking the name opens the artifact panel
// with the full tool result (or input as fallback). The caret only appears when
// there is a body to show. The name is only a button when there is content to send
// to the panel.
export const ToolPart: ToolCallMessagePartComponent = ({
  toolCallId,
  toolName,
  args,
  result,
}) => {
  const { open } = useArtifactPanel();
  const [peek, setPeek] = useState(false);

  const summary = toolSummary(args);
  const inputText = formatInput(args);
  const res = toolResult(result);
  const hasDetails = inputText.length > 0 || res != null;

  // Derive file path and language from tool input for panel metadata.
  const input = toolInput(args);
  const filePath =
    input && typeof input === 'object' && 'file_path' in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).file_path)
      : undefined;
  const language = filePath
    ? filePath.includes('.') ? filePath.split('.').pop() : undefined
    : undefined;

  // Panel content: prefer result text (the rich payload), else input.
  const panelContent = res?.text ?? inputText;
  const canOpenPanel = panelContent.length > 0;

  const openInPanel = () => {
    if (!canOpenPanel) return;
    open({
      id: toolCallId,
      kind: 'tool',
      title: toolName + (summary ? ` — ${summary}` : ''),
      language,
      content: panelContent,
      filePath,
    });
  };

  const nameEl = canOpenPanel ? (
    <button
      type="button"
      className="tool-name tool-name-btn"
      onClick={openInPanel}
      title="Open in side panel"
    >
      {toolName}
    </button>
  ) : (
    <span className="tool-name">{toolName}</span>
  );

  const header = (
    <span className="tool-head">
      {hasDetails ? (
        <button
          type="button"
          className="tool-arrow-btn"
          aria-expanded={peek}
          aria-label={peek ? 'Collapse' : 'Expand'}
          onClick={() => setPeek((v) => !v)}
        >
          <span className="tool-arrow" data-peek={peek ? 'true' : 'false'} aria-hidden="true">
            ▸
          </span>
        </button>
      ) : (
        <span className="tool-arrow" aria-hidden="true">
          ▸
        </span>
      )}
      {nameEl}
      {summary ? (
        <>
          <span className="tool-sep">—</span>
          <span className="tool-input">{summary}</span>
        </>
      ) : null}
    </span>
  );

  return (
    <div className="block-tool">
      <div className="block-tool-use">{header}</div>
      {hasDetails && peek ? (
        <div className="block-tool-body">
          {inputText ? (
            <pre className="block-tool-args">{inputText}</pre>
          ) : null}
          {res != null ? (
            <div
              className="block-tool-result"
              data-error={res.isError ? 'true' : 'false'}
            >
              {res.text}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
