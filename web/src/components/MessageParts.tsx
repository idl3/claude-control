import { useState } from 'react';
import type {
  TextMessagePartComponent,
  ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import { toolInput, toolResult, toolSummary } from '../lib/convert';
import { MarkdownText } from './MarkdownText';
import { InlineAttachmentPreviews } from './AttachmentPreview';
import { isSkillInvocation, SkillInvocation } from './SkillInvocation';
import { useArtifactPanel } from './ArtifactContext';
import { ClaudeRobotIcon } from './ClaudeRobotIcon';
import { CodexIcon } from './CodexIcon';
import { useAgentKind } from './AgentContext';

// The optimistic "Working…" placeholder (App.tsx, while Claude's real reply is
// pending) renders as an animated spinner; everything else is GitHub-flavored
// markdown (see MarkdownText).
const WORKING_RE = /^\s*working…?\s*$/i;
export const TextPart: TextMessagePartComponent = (props) => {
  const agentKind = useAgentKind();
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

export const AskAnsweredPart: ToolCallMessagePartComponent = (props) => {
  const { args, result } = props;
  const input = toolInput(args) as { questions?: AskInputQuestion[] } | null;
  const questions = input?.questions ?? [];
  const res = toolResult(result);
  const answered = res != null && !res.isError;
  const pairs = answered ? parseAskAnswers(res.text) : [];

  // No structured questions to show → fall back to the generic tool row.
  if (questions.length === 0) return <ToolPart {...props} />;

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
            {answered && opt?.description ? (
              <div className="ask-answered-desc">{opt.description}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
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
