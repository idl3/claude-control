// web/src/lib/appVersion.ts — D3: client-side types/helpers for the
// filesystem version convention. Mirrors lib/media-apps.js on the server,
// which is the canonical source of the apps/<name>/<stamp>[-label].html +
// `latest` pointer layout and the GET /api/media-apps/<name>/versions
// response shape this file's types describe.

export interface AppVersionEntry {
  filename: string;
  /** ISO-stamp segment of the filename (the version's identity). */
  version: string;
  label: string | null;
  /** media-root-relative url, ready to pass straight into EmbeddedApp's `url` prop. */
  url: string;
  /** true when this is the file the `latest` pointer currently names. */
  latest: boolean;
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
 */
export function appNameFromUrl(url: string): string | null {
  const m = APP_URL_RE.exec(url);
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
