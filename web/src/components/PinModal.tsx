import { useEffect, useMemo, useState } from 'react';
import { listTranscripts, setPin, type TranscriptInfo } from '../lib/api';
import type { Session } from '../lib/types';

interface PinModalProps {
  session: Session;
  onClose: () => void;
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
  onPinned: () => void;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Manually bind this session to a transcript file (escape hatch for sessions the
 * auto-matcher can't resolve: path drift, window-name ≠ session-title, etc).
 */
export function PinModal({ session, onClose, onToast, onPinned }: PinModalProps) {
  const [items, setItems] = useState<TranscriptInfo[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    listTranscripts()
      .then((list) => alive && setItems(list))
      .catch((err) => {
        if (alive) {
          setItems([]);
          onToast(`Couldn't load transcripts: ${(err as Error).message}`, 'error');
        }
      });
    return () => {
      alive = false;
    };
  }, [onToast]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((t) =>
      [t.title, t.cwd, t.sessionId].some((s) => s?.toLowerCase().includes(needle)),
    );
  }, [items, q]);

  const apply = async (transcriptPath: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await setPin(session.id, transcriptPath);
      onToast(transcriptPath ? 'Pinned →' : 'Unpinned', 'ok');
      onPinned();
      onClose();
    } catch (err) {
      onToast(`Pin failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal pin-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <span className="modal-title">Pin transcript — {session.name || session.id}</span>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {session.pinned ? (
          <button
            type="button"
            className="pin-unpin"
            disabled={busy}
            onClick={() => apply(null)}
          >
            Unpin (return to auto-match)
          </button>
        ) : null}

        <input
          className="pin-search"
          type="text"
          placeholder="filter by title, cwd, or session id…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />

        <div className="pin-list">
          {items === null ? (
            <div className="pin-empty">loading…</div>
          ) : filtered.length === 0 ? (
            <div className="pin-empty">no transcripts match</div>
          ) : (
            filtered.map((t) => {
              const isCurrent = t.transcriptPath === session.transcriptPath;
              return (
                <button
                  type="button"
                  key={t.transcriptPath}
                  className="pin-row"
                  data-current={isCurrent ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => apply(t.transcriptPath)}
                >
                  <span className="pin-row-title">
                    {t.title || t.sessionId || t.transcriptPath}
                    {isCurrent ? <span className="pin-row-cur"> · current</span> : null}
                  </span>
                  <span className="pin-row-meta">
                    {t.cwd ? <span className="pin-row-cwd">{t.cwd}</span> : null}
                    <span className="pin-row-when">{fmtWhen(t.lastActivity)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
