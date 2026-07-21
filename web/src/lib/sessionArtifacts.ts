// Phase C, C1: derives a session's distinct micro-app artifacts from its
// transcript's `<embedded-app>` tags, then resolves each to its latest
// version + artifactKind — the data source for ArtifactGallery.tsx (C2).
//
// Deliberately transcript-derived only (no persistence, S1): the gallery is
// a lens over what's already embedded in the conversation, not a separate
// store that can drift from it.

import { TAG_RE, parseEmbedAppAttrs } from './embeds';
import { appNameFromUrl, flatAppUrl, fetchAppManifest, type ArtifactKind, type AppVersionListing } from './appVersion';
import { authFetch } from './api';

export interface SessionArtifact {
  name: string;
  url: string;
  artifactKind: ArtifactKind;
  latestVersion: string;
}

// Phase C3→D: the gallery open/closed state used to live inside
// ArtifactGallery.tsx as an internal disclosure; it's now controlled from
// App.tsx (the toggle lives in the header, beside Rename), so the
// persistence helpers move here — the shared home for gallery-derived state.
// Best-effort persistence: read/write wrapped in try/catch, never throws,
// defaults to collapsed on any failure (missing key, quota, privacy mode, or
// the broken dev-harness localStorage shadow stub — see the FakeLocalStorage
// note in ArtifactGallery.vitest.ts).
const GALLERY_OPEN_KEY = 'cc:artifact-gallery-open';

export function loadGalleryOpen(): boolean {
  try {
    return localStorage.getItem(GALLERY_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveGalleryOpen(value: boolean): void {
  try {
    localStorage.setItem(GALLERY_OPEN_KEY, value ? '1' : '0');
  } catch {
    /* localStorage unavailable/full — the toggle just doesn't survive reload. */
  }
}

/**
 * Pure, sync: distinct app names embedded anywhere in `text`, first-seen
 * order. Iterates a PRIVATE copy of embeds.ts's shared TAG_RE (`new RegExp`,
 * never the module-level const) so this never races/mutates the `lastIndex`
 * that embedNodesFromHtml's own walk depends on. Zero `<embedded-app>` tags
 * (or zero tags with a resolvable name) → [].
 */
export function appNamesFromTranscript(text: string): string[] {
  const re = new RegExp(TAG_RE.source, TAG_RE.flags);
  const seen = new Set<string>();
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== 'app') continue;
    const parsed = parseEmbedAppAttrs(m[2]);
    if (!parsed) continue;
    const name = appNameFromUrl(parsed.url);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * One name's fallback shape when its versions-fetch (or anything downstream
 * of it) fails: the flat legacy url, an unversioned "latest" label, and the
 * 'prototype' kind — matching every pre-Phase-A app's implicit kind. A name
 * that appeared in the transcript must still list; it just can't show a real
 * version/kind yet.
 */
function fallbackArtifact(name: string): SessionArtifact {
  return { name, url: flatAppUrl(name), latestVersion: 'latest', artifactKind: 'prototype' };
}

/** Bounded to ONE versions-fetch + ONE manifest-fetch for this one name. Never throws. */
async function resolveOne(name: string): Promise<SessionArtifact> {
  try {
    const res = await authFetch(`/api/media-apps/${encodeURIComponent(name)}/versions`);
    if (!res.ok) return fallbackArtifact(name);
    const listing = (await res.json()) as AppVersionListing;
    const latest = listing.versions?.find((v) => v.latest) ?? listing.versions?.[0];
    const url = latest?.url ?? flatAppUrl(name);
    const latestVersion = latest?.version ?? 'latest';
    // Only fetch the prop-manifest when the listing says one exists. A
    // manifest-less app (e.g. a plain-HTML `--write-app --html` prototype)
    // otherwise fires a doomed request that 404s — or 401s tokenless over a
    // remote/Tailscale origin before the bearer is attached — surfacing as a
    // spurious "manifest failed to load" for a file that never existed.
    const manifest = latest?.manifestUrl ? await fetchAppManifest(url) : null;
    return { name, url, latestVersion, artifactKind: manifest?.artifactKind ?? 'prototype' };
  } catch {
    return fallbackArtifact(name);
  }
}

/**
 * Async: resolve each name to its latest version + kind, in parallel
 * (Promise.all preserves input order in its output regardless of which
 * settles first, so the returned list always matches `names`' order). Any
 * per-name failure degrades to fallbackArtifact rather than dropping the
 * name or rejecting the whole batch — a name that appeared in the transcript
 * always lists.
 */
export async function resolveSessionArtifacts(names: string[]): Promise<SessionArtifact[]> {
  return Promise.all(names.map(resolveOne));
}
