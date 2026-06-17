import { useEffect, useMemo, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';

// ── Detection ────────────────────────────────────────────────────────────────

export function isSkillInvocation(text: string): boolean {
  return text.trimStart().startsWith('Base directory for this skill:');
}

// ── Parsing ──────────────────────────────────────────────────────────────────

interface FrontmatterEntry {
  key: string;
  value: string;
}

interface ParsedSkill {
  name: string;
  description: string | null;
  frontmatter: FrontmatterEntry[];
  body: string;
}

/** Extract last non-empty path segment, stripping a trailing /SKILL.md first. */
function nameFromPath(raw: string): string {
  const path = raw.trim().replace(/\/SKILL\.md$/i, '');
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'skill';
}

/**
 * Parse a YAML-like front-matter block delimited by `---` lines.
 * Returns the key/value pairs and everything after the closing `---`.
 * No external dependency — simple line parser only.
 */
function parseFrontmatter(text: string): { entries: FrontmatterEntry[]; rest: string } {
  const lines = text.split('\n');
  // Must start with a `---` line (possibly preceded by whitespace).
  if (lines[0]?.trim() !== '---') {
    return { entries: [], rest: text };
  }
  const entries: FrontmatterEntry[] = [];
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
    const colon = lines[i].indexOf(':');
    if (colon !== -1) {
      const key = lines[i].slice(0, colon).trim();
      const value = lines[i].slice(colon + 1).trim();
      if (key) entries.push({ key, value });
    }
  }
  if (closeIdx === -1) {
    // No closing ---: treat entire block as no front-matter.
    return { entries: [], rest: text };
  }
  const rest = lines.slice(closeIdx + 1).join('\n');
  return { entries, rest };
}

function parseSkill(text: string): ParsedSkill {
  const lines = text.trimStart().split('\n');
  // First line: "Base directory for this skill: <path>"
  const firstLine = lines[0] ?? '';
  const match = firstLine.match(/Base directory for this skill:\s*(.+)/);
  const rawPath = match?.[1] ?? '';
  const pathName = nameFromPath(rawPath);

  // Body = everything after the first line.
  const bodyRaw = lines.slice(1).join('\n').trimStart();

  // Parse optional front-matter from the body.
  const { entries: fmEntries, rest: bodyAfterFm } = parseFrontmatter(bodyRaw);

  // Prefer `name:` from front-matter if present.
  const fmName = fmEntries.find((e) => e.key === 'name')?.value ?? null;
  const fmDesc = fmEntries.find((e) => e.key === 'description')?.value ?? null;

  return {
    name: fmName ?? pathName,
    description: fmDesc,
    frontmatter: fmEntries,
    body: bodyAfterFm.trimStart(),
  };
}

// ── Markdown renderer (reuses the same pattern as PlanReview in PromptModal) ─

const messageComponents = {
  UserMessage,
  AssistantMessage,
  SystemMessage: AssistantMessage,
} as const;

function SkillBodyRenderer({ markdown }: { markdown: string }) {
  const messages = useMemo<ThreadMessageLike[]>(
    () => [
      {
        role: 'assistant',
        id: 'skill-body',
        content: [{ type: 'text', text: markdown }],
        metadata: { custom: { cockpitRole: 'assistant' } },
      } as ThreadMessageLike,
    ],
    [markdown],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    isDisabled: true,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="skill-body-thread">
        <ThreadPrimitive.Viewport className="skill-body-viewport">
          <ThreadPrimitive.Messages components={messageComponents} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

interface SkillModalProps {
  parsed: ParsedSkill;
  onClose: () => void;
}

function SkillModal({ parsed, onClose }: SkillModalProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-skill"
        role="dialog"
        aria-modal="true"
        aria-label={`Skill: ${parsed.name}`}
      >
        {/* Header */}
        <div className="modal-head">
          <span className="modal-title modal-title-skill">
            🧩 Skill: {parsed.name}
          </span>
          <button
            type="button"
            className="modal-close"
            aria-label="Close skill detail"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="modal-body skill-modal-body">
          {/* Front-matter */}
          {parsed.frontmatter.length > 0 && (
            <dl className="skill-fm">
              {parsed.frontmatter.map(({ key, value }) => (
                <div key={key} className="skill-fm-row">
                  <dt className="skill-fm-key">{key}</dt>
                  <dd className="skill-fm-val">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* Markdown body */}
          {parsed.body.length > 0 && (
            <div className="skill-body-wrap">
              <SkillBodyRenderer markdown={parsed.body} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Chip + export ─────────────────────────────────────────────────────────────

interface SkillInvocationProps {
  text: string;
}

export function SkillInvocation({ text }: SkillInvocationProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseSkill(text), [text]);

  return (
    <>
      <button
        type="button"
        className="skill-chip"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title={parsed.description ?? `Skill: ${parsed.name}`}
      >
        <span className="skill-chip-icon" aria-hidden="true">
          🧩
        </span>
        <span className="skill-chip-name">{parsed.name}</span>
        <span className="skill-chip-tag">skill</span>
      </button>

      {open && <SkillModal parsed={parsed} onClose={() => setOpen(false)} />}
    </>
  );
}
