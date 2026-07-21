// web/src/lib/appVersion.ts — D3: client-side types/helpers for the
// filesystem version convention. Mirrors lib/media-apps.js on the server,
// which is the canonical source of the apps/<name>/<stamp>[-label].html +
// `latest` pointer layout and the GET /api/media-apps/<name>/versions
// response shape this file's types describe.

import { mediaAppFramePath, resolveMediaUrl } from './mediaUrl';
import { authFetch } from './api';

export interface AppVersionEntry {
  filename: string;
  /** ISO-stamp segment of the filename (the version's identity). */
  version: string;
  label: string | null;
  /** media-root-relative url, ready to pass straight into EmbeddedApp's `url` prop. */
  url: string;
  /** true when this is the file the `latest` pointer currently names. */
  latest: boolean;
  /** Whether a sibling `<stamp>.manifest.json` exists for this version (server-provided by listVersions). */
  manifest?: boolean;
  /** media-root-relative url of the sibling manifest, or null when absent. */
  manifestUrl?: string | null;
}

export interface AppVersionListing {
  name: string;
  /** Newest-first (server already sorts this way — see sortVersionsDesc). */
  versions: AppVersionEntry[];
  /** The `latest` pointer's raw filename, or null if unset. */
  latest: string | null;
}

const APP_URL_RE = /^apps\/([a-z0-9-]+)(?:\.html|\/)/;

/**
 * D4: derive the versionable app `name` from an embed's url — matches both
 * the flat legacy form ("apps/counter.html") and a versioned file
 * ("apps/counter/2026-07-08T23-32-05Z.html"). Returns null for anything else
 * (not a media-apps url at all, e.g. an http(s) url or an unrelated media path).
 *
 * M3 (Codex review): normalizes through mediaAppFramePath first, so an
 * already `/api/media/`-prefixed url (e.g. one round-tripped out of a
 * previous transcript render, or an EmbeddedApp `url` prop given the
 * prefixed form directly) resolves to the same name as its bare-relative
 * equivalent. Before this fix, only the bare form ("apps/counter.html")
 * matched APP_URL_RE — a prefixed url ("/api/media/apps/counter.html")
 * always returned null, which silently broke H3's name-aware frame matching
 * (AppFrameLayer.tsx's shouldReloadOnFrame) for any slot whose url happened
 * to carry the prefix. mediaAppFramePath returns null for anything that
 * isn't a local media-root fetch (http(s), rejected) — fall back to the raw
 * url in that case so the null ultimately still flows through APP_URL_RE
 * and fails the same way it always did for non-media urls.
 */
export function appNameFromUrl(url: string): string | null {
  const normalized = mediaAppFramePath(url) ?? url;
  const m = APP_URL_RE.exec(normalized);
  return m ? m[1] : null;
}

/** D4: the flat legacy url for an app name — the track-latest embed used
 * before/without the versioning convention. */
export function flatAppUrl(name: string): string {
  return `apps/${name}.html`;
}

/** D4: the concrete pinned-version url for one listing entry. */
export function versionedAppUrl(name: string, filename: string): string {
  return `apps/${name}/${filename}`;
}

/**
 * Pure re-sort, newest-first by filename (the ISO-stamp prefix sorts
 * lexicographically == chronologically). The server already returns this
 * order; keeping an explicit, tested client-side sort means D4's UI doesn't
 * silently depend on that ordering surviving some future server change.
 */
export function sortVersionsDesc(versions: AppVersionEntry[]): AppVersionEntry[] {
  return [...versions].sort((a, b) => (a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0));
}

// --- Phase C, C3: prop manifest fetch --------------------------------------
// Schema v1, as emitted by ~/.claude/skills/prototype-component/scripts/
// manifest.mjs (C1) and versioned as a sibling file alongside the app's HTML
// by that skill's --write-app --manifest passthrough: <stamp>.manifest.json
// next to <stamp>.html (+ a flat apps/<name>.manifest.json compat alias next
// to the flat apps/<name>.html, mirroring the existing HTML alias pattern).

export interface AppManifestProp {
  name: string;
  tsType: string;
  required: boolean;
  default?: unknown;
  enumOptions?: string[];
  example?: unknown;
}

// B1: Phase A's `/create-artifact` producer writes `artifactKind` into every
// new manifest — 'prototype' for the original component+props form, and
// 'markdown'|'html'|'react' for the presentation kinds (no component/props
// at all). Pre-Phase-A manifests carry no `artifactKind` field; those, and
// any unrecognized value, normalize to 'prototype' (normalizeArtifactKind
// below) so every pre-existing prototype keeps behaving exactly as before.
export type ArtifactKind = 'prototype' | 'markdown' | 'html' | 'react';
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['prototype', 'markdown', 'html', 'react'];

export function normalizeArtifactKind(v: unknown): ArtifactKind {
  return typeof v === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(v) ? (v as ArtifactKind) : 'prototype';
}

export interface AppManifest {
  'schema-version': 1;
  /** Always set post-normalization by fetchAppManifest — absent-in-JSON defaults to 'prototype'. */
  artifactKind: ArtifactKind;
  /** prototype-only. Presentation-kind manifests (markdown|html|react) carry neither this nor `props`. */
  component?: string;
  /** prototype-only. */
  props?: AppManifestProp[];
}

/** Raw shape isValidAppManifestShape actually guarantees — `artifactKind` is
 * injected afterward by normalization (fetchAppManifest), not asserted here. */
type RawAppManifest = Omit<AppManifest, 'artifactKind'>;

/**
 * Shape check on fetched JSON — deliberately loose (only the fields the
 * Props panel actually branches on), matching manifest.mjs's own "never
 * block on anything unexpected" philosophy: an oddly-shaped `props` entry
 * degrades to raw-JSON-only editing in the UI rather than being rejected
 * outright by this check.
 *
 * B1: `component`/`props` are no longer required — a presentation-kind
 * manifest (markdown|html|react) is valid with neither. When `props` IS
 * present it must still be an array of `{name: string, ...}` entries.
 */
export function isValidAppManifestShape(data: unknown): data is RawAppManifest {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  if (rec['schema-version'] !== 1) return false;
  if (rec.props !== undefined) {
    if (!Array.isArray(rec.props)) return false;
    if (!rec.props.every((p) => typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string')) {
      return false;
    }
  }
  return true;
}

/**
 * Derives the manifest's sibling url for an app embed's html url — same
 * versioned/flat pairing convention C1's producer-side writeVersionedApp
 * uses ("apps/<name>/<stamp>.html" -> "apps/<name>/<stamp>.manifest.json",
 * flat "apps/<name>.html" -> "apps/<name>.manifest.json"). Returns null for
 * anything that isn't a local media-apps html url (mirrors appNameFromUrl).
 */
export function manifestUrlForAppUrl(url: string): string | null {
  const normalized = mediaAppFramePath(url) ?? url;
  if (!normalized.endsWith('.html')) return null;
  return normalized.slice(0, -'.html'.length) + '.manifest.json';
}

/**
 * Fetches (and validates) the prop manifest for an app embed's url. Returns
 * null for every failure mode — no manifest written yet (old, pre-C4-rebuild
 * artifact: a 404), a malformed/unreadable response, or a network error —
 * so the Props panel's degrade path (StudioModal.tsx) is the ONE place that
 * decides what "no manifest" looks like; this helper never throws.
 */
export async function fetchAppManifest(url: string): Promise<AppManifest | null> {
  const manifestUrl = manifestUrlForAppUrl(url);
  if (!manifestUrl) return null;
  const resolution = resolveMediaUrl(manifestUrl);
  if (resolution.kind !== 'fetch') return null;
  try {
    const res = await authFetch(resolution.fetchUrl, { cache: 'reload' });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!isValidAppManifestShape(data)) return null;
    // B1: inject the normalized artifactKind — absent/unknown → 'prototype',
    // matching every pre-Phase-A manifest's implicit kind.
    return { ...data, artifactKind: normalizeArtifactKind((data as Record<string, unknown>).artifactKind) };
  } catch {
    return null;
  }
}
