// Phase C, C2: a floating per-session tray listing the distinct micro-app
// artifacts embedded anywhere in the current transcript — click a row to
// open it, routed per its artifactKind (prototype -> Studio, presentation
// kinds -> the inline sandboxed panel viewer). Purely a lens over the
// transcript (S1): nothing here persists; it recomputes from `transcriptText`
// on every mount/session-switch.

import { useEffect, useMemo, useRef, useState } from 'react';
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

  return (
    <div className="artifact-gallery" role="region" aria-label="Session artifacts">
      <div className="artifact-gallery-head">Artifacts</div>
      <ul className="artifact-gallery-list">
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
    </div>
  );
}
