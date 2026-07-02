/**
 * lib/olam-prs.js — normalise the runner status `prs` field for the UI.
 *
 * `GET <runner>/agent-run/status` returns `{ ..., prs, prCount, ... }`
 * (docs/olam-contract.md). The element shape of `prs` has not been
 * live-verified, so this accepts either a bare URL string array or an
 * array of richer objects and always normalises to `[{ url, number }]`.
 */

/** Extract the PR number from a GitHub PR URL's trailing `/pull/<n>`, or null. */
function numberFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return m ? Number(m[1]) : null;
}

/**
 * Normalise the runner's `prs` field to `[{ url, number }]`. Accepts
 * `string[]` (bare URLs) or `{url, number, state}[]` (or any mix); never
 * throws — malformed entries are dropped rather than surfaced as crashes.
 *
 * @param {unknown} prs
 * @returns {Array<{ url: string, number: number|null }>}
 */
export function normalizePrs(prs) {
  if (!Array.isArray(prs)) return [];
  const out = [];
  for (const entry of prs) {
    if (typeof entry === 'string') {
      if (entry.length === 0) continue;
      out.push({ url: entry, number: numberFromUrl(entry) });
    } else if (entry && typeof entry === 'object' && typeof entry.url === 'string') {
      const number = typeof entry.number === 'number' ? entry.number : numberFromUrl(entry.url);
      out.push({ url: entry.url, number });
    }
  }
  return out;
}
