// lib/media-apps.js — D3: filesystem version convention for media micro-app
// artifacts under CONFIG.mediaDir/apps/.
//
// Layout:
//   apps/<name>.html                      — flat, non-versioned app (legacy/
//                                            simple case; stays valid forever)
//   apps/<name>/<ISO-stamp>[-label].html  — one version, stamp = isoStamp()
//   apps/<name>/latest                    — text pointer file: the filename
//                                            (not path) of the current version
//
// <name> is trusted only after isValidAppName passes — the same strict
// [a-z0-9-]+ rule the producer (D5, prototype-component skill) writes under.
// This is the FIRST line of defense for a route (D3's GET .../versions) that
// takes `name` straight from a URL path segment: no traversal characters are
// even representable, so there is nothing for the join below to escape with.

import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[a-z0-9-]+$/;
const STAMP_RE_SRC = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z';
const VERSION_RE = new RegExp(`^(${STAMP_RE_SRC})(?:-([a-z0-9-]+))?\\.html$`);

export function isValidAppName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/**
 * Filesystem-safe, URL-safe version stamp: an ISO-8601 UTC timestamp with
 * colons/dot-milliseconds stripped (`2026-07-08T23:32:05.123Z` ->
 * `2026-07-08T23-32-05Z`). Second precision is deliberate — this tool
 * produces at most a handful of builds a minute by hand, so a same-second
 * collision is not worth the extra filename noise.
 *
 * D5 (the producer skill) lives outside this repo and cannot import this
 * function directly — it duplicates this exact algorithm. Keep the two in
 * sync if this format ever changes.
 */
export function isoStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/**
 * List every version under apps/<name>/, sorted newest-first by the
 * ISO-stamp segment of the filename (a version's stamp is its identity — a
 * plain string compare on the fixed-width, zero-padded stamp sorts exactly
 * chronologically, no Date() round-trip / timezone ambiguity needed), and
 * mark which one the `latest` pointer file currently names.
 *
 * Returns null when `name` fails isValidAppName (traversal/invalid-char
 * defense — same uniform-null-on-reject convention as lib/media.js's
 * resolveMediaPath) or when apps/<name>/ doesn't exist at all (flat-only or
 * unknown app). Returns `{ name, versions: [], latest: null }` when the dir
 * exists but is empty or has no recognizably-named version files — that's a
 * legitimate empty answer, not a rejection.
 */
export function listVersions(mediaRoot, name) {
  if (!isValidAppName(name)) return null;
  const dir = path.join(mediaRoot, 'apps', name);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  let latestPointer = null;
  try {
    latestPointer = fs.readFileSync(path.join(dir, 'latest'), 'utf8').trim() || null;
  } catch {
    // no latest pointer yet — fine, nothing gets marked latest below.
  }

  const versions = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = VERSION_RE.exec(ent.name);
    if (!m) continue;
    // Phase C, C4: a manifest is a sibling file next to the version's .html —
    // same pairing convention web/src/lib/appVersion.ts's manifestUrlForAppUrl
    // uses on the client. A plain existsSync is enough: this is a presence
    // flag for the studio's degrade path, not a parse/shape check (the client
    // already re-validates the JSON itself via fetchAppManifest).
    const manifestFilename = ent.name.replace(/\.html$/, '.manifest.json');
    const hasManifest = fs.existsSync(path.join(dir, manifestFilename));

    versions.push({
      filename: ent.name,
      version: m[1],
      label: m[2] || null,
      url: `apps/${name}/${ent.name}`,
      latest: ent.name === latestPointer,
      manifest: hasManifest,
      manifestUrl: hasManifest ? `apps/${name}/${manifestFilename}` : null,
    });
  }
  versions.sort((a, b) => (a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0));

  // The pointer is raw file bytes — the ONE field here not derived from a
  // VERSION_RE-filtered readdir. Never surface unvalidated content (a poisoned
  // pointer must read as "no latest", not leak through the API).
  const latest = latestPointer && VERSION_RE.test(latestPointer) ? latestPointer : null;
  return { name, versions, latest };
}
