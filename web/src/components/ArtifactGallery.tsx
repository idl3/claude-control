// Phase C, C2: a floating per-session tray listing the distinct micro-app
// artifacts embedded anywhere in the current transcript — click a row to
// open it, routed per its artifactKind (prototype -> Studio, presentation
// kinds -> the inline sandboxed panel viewer). Purely a lens over the
// transcript (S1): nothing here persists; it recomputes from `transcriptText`
// on every mount/session-switch.
//
// Phase D: fully controlled from App.tsx. The disclosure toggle used to live
// here as an internal head button floating over the transcript; it now lives
// in the header action bar beside Rename (a .detail-action with a count
// badge, mirroring the Raw-events button), so this component only resolves
// artifacts + reports the count upward (`onCountChange`) and renders the row
// list when `open` is true. Open/closed persistence lives in App.tsx via
// loadGalleryOpen/saveGalleryOpen (lib/sessionArtifacts.ts).
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

export function ArtifactGallery({
  transcriptText,
  open,
  onCountChange,
}: {
  transcriptText: string;
  open: boolean;
  onCountChange: (count: number) => void;
}) {
  const { open: openArtifact } = useArtifactPanel();
  const names = useMemo(() => appNamesFromTranscript(transcriptText), [transcriptText]);
  const namesKey = names.join('\n');
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([]);

  // Ref-wrap the callback so the resolve effect below only re-runs when the
  // derived NAME SET changes (not on every parent re-render that hands us a
  // fresh onCountChange closure).
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

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
      onCountChangeRef.current(0);
      return;
    }
    let cancelled = false;
    resolveSessionArtifacts(names).then((resolved) => {
      if (cancelled) return;
      setArtifacts(resolved);
      onCountChangeRef.current(resolved.length);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey]);

  // Task 3: an open gallery with zero artifacts now renders a friendly
  // onboarding explainer instead of returning null (the header's own
  // always-visible toggle button — App.tsx — is what let the user get here
  // in the first place; an empty "nothing rendered" result reads as broken,
  // not "nothing to show yet"). A *closed* gallery still returns null
  // exactly as before — this only changes the open+empty case.
  if (!open) return null;

  function onOpen(a: SessionArtifact) {
    if (a.artifactKind === 'prototype') {
      window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url: a.url } }));
      return;
    }
    openArtifact({
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
      {artifacts.length === 0 ? (
        <div className="artifact-gallery-empty">
          <p className="artifact-gallery-empty-title">No artifacts yet</p>
          <p className="artifact-gallery-empty-body">
            Ask for a prototype, webpage, or dashboard — it'll show up here once the agent builds it.
          </p>
        </div>
      ) : (
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
      )}
    </div>
  );
}
