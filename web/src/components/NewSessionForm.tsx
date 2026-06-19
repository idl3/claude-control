import { useCallback, useEffect, useRef, useState } from 'react';
import { createSession } from '../lib/api';
import { FunnelIcon } from './icons';
import type { SessionFilter } from './SessionRail';

interface NewSessionFormProps {
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
  /** Rail filter state + cycle (all → claude → terminal). */
  filter: SessionFilter;
  onCycleFilter: () => void;
}

const FILTER_TITLE: Record<SessionFilter, string> = {
  all: 'Showing all panes — tap to show only Claude',
  claude: 'Showing Claude sessions — tap to show only terminals',
  terminal: 'Showing terminals — tap to show all',
};

/** Client-side mirror of the server's `session-<short-ts>` default name. */
function defaultName(now: number = Date.now()): string {
  return `session-${now.toString(36).slice(-6)}`;
}

/**
 * Rail-head "new session" control. Collapsed it's a "+ New session" button;
 * expanded it reveals a NAME field (required-with-default — blank submits the
 * placeholder default) plus Create/Cancel. On submit it POSTs to the server,
 * which names the tmux window and launches Claude with `--name <name>`. The new
 * window appears in the rail on the next registry refresh.
 */
export function NewSessionForm({ onToast, filter, onCycleFilter }: NewSessionFormProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  // A fresh default each time the form opens, so the placeholder is current.
  const [placeholder, setPlaceholder] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setPlaceholder(defaultName());
      inputRef.current?.focus();
    }
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setName('');
  }, []);

  const submit = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    // Required-with-default: blank field falls back to the shown placeholder.
    const resolved = name.trim() || placeholder;
    onToast('Creating session…');
    try {
      const result = await createSession({ name: resolved });
      onToast(`Session created → ${result.name}`, 'ok');
      close();
    } catch (err) {
      onToast(`New session failed: ${(err as Error).message}`, 'error');
    } finally {
      setCreating(false);
    }
  }, [creating, name, placeholder, onToast, close]);

  if (!open) {
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
          {filter !== 'all' ? (
            <span className="rail-filter-tag">{filter === 'claude' ? 'CC' : '>_'}</span>
          ) : null}
        </button>
      </div>
    );
  }

  return (
    <form
      className="rail-new-form"
      aria-label="Create session"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        ref={inputRef}
        className="rail-new-name"
        type="text"
        value={name}
        placeholder={placeholder}
        disabled={creating}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        aria-label="Session name"
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
