// Phase C, C2: a floating per-session tray listing the distinct micro-app
// artifacts embedded anywhere in the current transcript — click a row to
// open it, routed per its artifactKind (prototype -> Studio, presentation
// kinds -> the inline sandboxed panel viewer). Purely a lens over the
// transcript (S1): nothing here persists; it recomputes from `transcriptText`
// on every mount/session-switch.
//
// Phase C3: the gallery is absolutely positioned over the transcript column
// (see styles.css), so on mobile especially it must not sit open covering
// the thread by default. The row list is a disclosure behind a head button:
// collapsed by default, expand state persisted best-effort to localStorage
// (see the FakeLocalStorage note below — the dev Node harness shadows
// `localStorage` with a broken stub, so all access is try/catch-guarded and
// never assumed to round-trip).

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { appNamesFromTranscript, resolveSessionArtifacts, type SessionArtifact } from '../lib/sessionArtifacts';
import { useArtifactPanel, appArtifactId } from './ArtifactContext';
import { APP_HEIGHT_DEFAULT } from '../lib/embeds';
import type { ArtifactKind } from '../lib/appVersion';

const KIND_LABEL: Record<ArtifactKind, string> = {
  prototype: 'Prototype',
  markdown: 'Markdown',
  html: 'HTML',
  react: 'React',
};

const GALLERY_OPEN_KEY = 'cc:artifact-gallery-open';

// Best-effort persistence, mirroring ArtifactContext's loadSessionPanels/
// saveSessionPanels idiom: read/write wrapped in try/catch, never throws,
// defaults to collapsed on any failure (missing key, quota, privacy mode,
// or the broken dev-harness shadow stub).
function loadGalleryOpen(): boolean {
  try {
    return localStorage.getItem(GALLERY_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveGalleryOpen(value: boolean): void {
  try {
    localStorage.setItem(GALLERY_OPEN_KEY, value ? '1' : '0');
  } catch {
    /* localStorage unavailable/full — the toggle just doesn't survive reload. */
  }
}

function KindBadge({ kind }: { kind: ArtifactKind }) {
  return (
    <span className="artifact-gallery-badge" data-kind={kind} aria-label={`${KIND_LABEL[kind]} artifact`}>
      {KIND_LABEL[kind]}
    </span>
  );
}

export function ArtifactGallery({ transcriptText }: { transcriptText: string }) {
  const { open } = useArtifactPanel();
  const names = useMemo(() => appNamesFromTranscript(transcriptText), [transcriptText]);
  const namesKey = names.join('\n');
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);
  // Collapsed by default (the core ask: never cover/push the transcript,
  // especially on mobile) — loadGalleryOpen only returns true when the user
  // previously expanded it and the browser actually persisted that choice.
  const [expanded, setExpanded] = useState<boolean>(() => loadGalleryOpen());
  const listId = useId();

  // Keyed on the derived NAME SET, not raw transcript text — a token
  // streaming into the transcript re-runs appNamesFromTranscript (cheap,
  // sync) on every render, but must not re-fire a versions+manifest fetch
  // per name unless the set of names actually changed (P2 perf).
  const namesKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (namesKeyRef.current === namesKey) return;
    namesKeyRef.current = namesKey;
    if (names.length === 0) {
      setArtifacts([]);
      return;
    }
    let cancelled = false;
    resolveSessionArtifacts(names).then((resolved) => {
      if (cancelled) return;
      setArtifacts(resolved);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey]);

  if (artifacts.length === 0) return null;

  function onOpen(a: SessionArtifact) {
    if (a.artifactKind === 'prototype') {
      window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url: a.url } }));
      return;
    }
    open({
      id: appArtifactId(a.url),
      kind: 'app',
      title: a.name,
      content: '',
      appUrl: a.url,
      appHeight: APP_HEIGHT_DEFAULT,
      pinned: true,
    });
  }

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev;
      saveGalleryOpen(next);
      return next;
    });
  }

  return (
    <div className="artifact-gallery" role="region" aria-label="Session artifacts">
      <button
        type="button"
        className="artifact-gallery-head"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        aria-controls={listId}
      >
        <span className="artifact-gallery-head-label">Artifacts</span>
        <span className="artifact-gallery-head-count">({artifacts.length})</span>
        <svg
          className="artifact-gallery-chevron"
          data-expanded={expanded}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {expanded ? (
        <ul id={listId} className="artifact-gallery-list">
          {artifacts.map((a) => (
            <li key={a.name}>
              <button type="button" className="artifact-gallery-row" onClick={() => onOpen(a)}>
                <span className="artifact-gallery-name">{a.name}</span>
                <span className="artifact-gallery-version">{a.latestVersion}</span>
                <KindBadge kind={a.artifactKind} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
