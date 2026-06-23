import { useCallback, useEffect, useRef, useState } from 'react';
import { createSession, fetchSpawnAgents, getConfig } from '../lib/api';
import type { SpawnAgentInfo } from '../lib/api';
import { FunnelIcon } from './icons';
import type { SessionFilter } from './SessionRail';

type CodexTransport = 'rpc' | 'tmux';
type ClaudeTransport = 'tmux' | 'print';

interface NewSessionFormProps {
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
  /** Rail filter state + cycle (all → claude → codex → terminal). */
  filter: SessionFilter;
  onCycleFilter: () => void;
}

const FILTER_TITLE: Record<SessionFilter, string> = {
  all: 'Showing all panes — tap to show only Claude',
  claude: 'Showing Claude sessions — tap to show only Codex',
  codex: 'Showing Codex sessions — tap to show only terminals',
  terminal: 'Showing terminals — tap to show all',
};

/** Client-side mirror of the server's `session-<short-ts>` default name. */
function defaultName(now: number = Date.now()): string {
  return `session-${now.toString(36).slice(-6)}`;
}

function defaultAgentForFilter(filter: SessionFilter): 'claude' | 'codex' {
  return filter === 'codex' ? 'codex' : 'claude';
}

export function normalizeCodexTransport(value: unknown): CodexTransport {
  return value === 'tmux' ? 'tmux' : 'rpc';
}

export function normalizeClaudeTransport(value: unknown): ClaudeTransport {
  return value === 'print' ? 'print' : 'tmux';
}

/** Derive filter badge label for the funnel button. */
export function filterTag(filter: SessionFilter): string | null {
  if (filter === 'claude') return 'CC';
  if (filter === 'codex') return 'CX';
  if (filter === 'terminal') return '>_';
  return null;
}

/**
 * Rail-head "new session" control. Collapsed it's a "+ New session" button;
 * expanded it reveals an agent toggle (Claude | Codex), a NAME field (Claude
 * only — Codex has no --name), a CWD field, and Create/Cancel actions. On
 * submit it POSTs to the server which names the tmux window and launches the
 * selected agent. The new window appears in the rail on the next registry
 * refresh.
 */
export function NewSessionForm({ onToast, filter, onCycleFilter }: NewSessionFormProps) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude');
  const [claudeTransport, setClaudeTransport] = useState<ClaudeTransport>('tmux');
  const [codexTransport, setCodexTransport] = useState<CodexTransport>('rpc');
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [creating, setCreating] = useState(false);
  // A fresh default each time the form opens, so the placeholder is current.
  const [placeholder, setPlaceholder] = useState(defaultName);
  const [agentInfos, setAgentInfos] = useState<SpawnAgentInfo[]>([]);
  const [defaultCwd, setDefaultCwd] = useState('~');
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // On open: refresh default name, reset state, fetch agent availability + config.
  useEffect(() => {
    if (!open) return;
    setPlaceholder(defaultName());
    setName('');
    setCwd('');
    setAgent(defaultAgentForFilter(filter));
    setClaudeTransport('tmux');
    setCodexTransport('rpc');
    setAgentInfos([]);
    fetchSpawnAgents()
      .then((infos) => {
        setAgentInfos(infos);
        setClaudeTransport(normalizeClaudeTransport(infos.find((info) => info.id === 'claude')?.defaultTransport));
        setCodexTransport(normalizeCodexTransport(infos.find((info) => info.id === 'codex')?.defaultTransport));
      })
      .catch(() => {
        // Non-fatal: form still works, agents just won't show disabled state.
      });
    getConfig()
      .then((cfg) => setDefaultCwd(cfg.defaultCwd || '~'))
      .catch(() => {
        // Non-fatal: placeholder falls back to '~'.
      });
    // Focus the name field after a tick (form mount).
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [open, filter]);

  const close = useCallback(() => {
    setOpen(false);
    setName('');
    setCwd('');
  }, []);

  const submit = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    // Required-with-default: blank name field falls back to the shown placeholder.
    const resolvedName = agent === 'codex' ? undefined : (name.trim() || placeholder);
    const resolvedCwd = cwd.trim() || undefined;
    onToast('Creating session…');
    try {
      const result = await createSession({
        name: resolvedName,
        cwd: resolvedCwd,
        agent,
        claudeTransport: agent === 'claude' ? claudeTransport : undefined,
        codexTransport: agent === 'codex' ? codexTransport : undefined,
      });
      onToast(`Session created → ${result.name}`, 'ok');
      close();
    } catch (err) {
      onToast(`New session failed: ${(err as Error).message}`, 'error');
    } finally {
      setCreating(false);
    }
  }, [creating, agent, claudeTransport, codexTransport, name, cwd, placeholder, onToast, close]);

  // Helper: look up availability for an agent id.
  function agentInfo(id: 'claude' | 'codex'): SpawnAgentInfo | undefined {
    return agentInfos.find((a) => a.id === id);
  }

  if (!open) {
    const tag = filterTag(filter);
    return (
      <div className="rail-head">
        <button
          type="button"
          className="rail-new"
          onClick={() => setOpen(true)}
        >
          + New session
        </button>
        <button
          type="button"
          className="rail-filter"
          data-filter={filter}
          aria-label={FILTER_TITLE[filter]}
          title={FILTER_TITLE[filter]}
          onClick={onCycleFilter}
        >
          <FunnelIcon size={15} />
          {tag ? <span className="rail-filter-tag">{tag}</span> : null}
        </button>
      </div>
    );
  }

  const claudeInfo = agentInfo('claude');
  const codexInfo = agentInfo('codex');

  return (
    <form
      className="rail-new-form"
      aria-label="Create session"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {/* Agent-type segmented control */}
      <div className="rail-new-agent-seg" role="group" aria-label="Agent type">
        {(['claude', 'codex'] as const).map((id) => {
          const info = id === 'claude' ? claudeInfo : codexInfo;
          const unavailable = info && !info.available;
          const isActive = agent === id;
          return (
            <button
              key={id}
              type="button"
              className="rail-new-agent-seg-btn"
              data-active={isActive ? 'true' : 'false'}
              data-unavailable={unavailable ? 'true' : 'false'}
              disabled={creating}
              title={unavailable ? info?.reason : undefined}
              aria-pressed={isActive}
              onClick={() => setAgent(id)}
            >
              <span className="rail-new-agent-seg-label">
                {id === 'claude' ? 'Claude' : 'Codex'}
              </span>
              {unavailable ? (
                <span className="rail-new-agent-seg-hint" aria-hidden="true">unavailable</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {agent === 'claude' ? (
        <div className="rail-new-mode-seg" role="group" aria-label="Claude mode">
          {([
            ['tmux', 'Interactive'],
            ['print', 'Print mode'],
          ] as const).map(([id, label]) => {
            const isActive = claudeTransport === id;
            return (
              <button
                key={id}
                type="button"
                className="rail-new-mode-seg-btn"
                data-active={isActive ? 'true' : 'false'}
                disabled={creating}
                aria-pressed={isActive}
                onClick={() => setClaudeTransport(id)}
              >
                <span className="rail-new-agent-seg-label">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {agent === 'codex' ? (
        <div className="rail-new-mode-seg" role="group" aria-label="Codex mode">
          {([
            ['rpc', 'RPC'],
            ['tmux', 'TUI'],
          ] as const).map(([id, label]) => {
            const isActive = codexTransport === id;
            return (
              <button
                key={id}
                type="button"
                className="rail-new-mode-seg-btn"
                data-active={isActive ? 'true' : 'false'}
                disabled={creating}
                aria-pressed={isActive}
                onClick={() => setCodexTransport(id)}
              >
                <span className="rail-new-agent-seg-label">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Name field — Claude only; Codex has no --name flag */}
      {agent === 'claude' ? (
        <input
          ref={nameInputRef}
          className="rail-new-name"
          type="text"
          value={name}
          placeholder={placeholder}
          disabled={creating}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
          }}
          aria-label="Session name"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      ) : (
        <div className="rail-new-name-note" aria-live="polite">
          Codex has no session name
        </div>
      )}

      {/* CWD field — plain text, server defaults when blank */}
      <input
        className="rail-new-cwd"
        type="text"
        value={cwd}
        placeholder={`(default) ${defaultCwd}`}
        disabled={creating}
        onChange={(e) => setCwd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); close(); }
        }}
        aria-label="Working directory"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />

      <div className="rail-new-actions">
        <button
          type="button"
          className="rail-new-cancel"
          onClick={close}
          disabled={creating}
        >
          Cancel
        </button>
        <button type="submit" className="rail-new-create" disabled={creating}>
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}
