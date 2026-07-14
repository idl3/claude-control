// Structured "delivery" payloads in transcript markdown.
//
// Agents emit a one-line JSON blob describing what a run produced, e.g.:
//   {"type":"delivery","outcome":"pushed_pr","branch":"linear/atl-9661","prUrl":"https://github.com/atlas-kitchen/restaurant-web/pull/2946"}
// Rendered as plain markdown text this reads as raw JSON — worse, remark-gfm's
// autolink-literal extension is a micromark SYNTAX extension (see
// micromark-extension-gfm-autolink-literal), so it tokenizes bare URLs during
// the initial parse, before any remark tree-transform plugin ever runs. That
// means plugin array ORDER cannot stop it from mangling the prUrl (it grabs
// trailing characters like the closing `"}` into the link). remarkDelivery
// works around this by ignoring the (already-mangled) parsed children for a
// candidate paragraph/code block entirely and re-scanning the ORIGINAL raw
// source text (via the node's position offsets into the VFile) for a
// balanced JSON object that matches the delivery shape — ground truth the
// parser's autolinking can't touch. A matched paragraph is rewritten to a
// `deliveryCard` mdast node (data.hName: 'div', mirroring the `hName`
// upgrade-a-leaf-handler trick lib/reservedTokens.ts uses for `mark`); a
// matched fenced code block is rewritten the same way. MarkdownText maps the
// resulting `div[data-delivery]` to DeliveryCard (components/DeliveryCard.tsx).
//
// Detection covers three shapes, per the module's single findDeliveryPayload
// scan: the payload IS the whole paragraph text; the payload sits inside a
// fenced ```json (or unlabeled ```) block; the payload is one JSON object
// embedded inline among other prose in a paragraph (split into leading text +
// card + trailing text, mirroring lib/embeds.ts's tag-splitting behavior for
// the same "text around a matched blob" scenario).

export interface DeliveryPayload {
  type: 'delivery';
  outcome: string;
  branch?: string;
  prUrl?: string;
  [key: string]: unknown;
}

const KNOWN_KEYS = new Set(['type', 'outcome', 'branch', 'prUrl']);

/** Shape guard — true only for an object carrying `type: 'delivery'` and a
 * non-empty string `outcome` (branch/prUrl, if present, must be strings).
 * Any other JSON (wrong `type`, missing/malformed `outcome`, or a
 * non-object) is rejected so it renders as ordinary text/code instead. */
export function isDeliveryPayload(value: unknown): value is DeliveryPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== 'delivery') return false;
  if (typeof v.outcome !== 'string' || v.outcome.length === 0) return false;
  if (v.branch !== undefined && typeof v.branch !== 'string') return false;
  if (v.prUrl !== undefined && typeof v.prUrl !== 'string') return false;
  return true;
}

/** Parse a JSON string, applying isDeliveryPayload as a shape guard. Never
 * throws — malformed JSON or a shape mismatch both yield null. */
export function safeParseDeliveryPayload(json: string): DeliveryPayload | null {
  try {
    const parsed = JSON.parse(json);
    return isDeliveryPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Non-type/outcome/branch/prUrl entries — rendered as extra rows so the card
 * degrades gracefully to future/unknown fields instead of dropping them. */
export function extraDeliveryFields(payload: DeliveryPayload): Array<[string, unknown]> {
  return Object.entries(payload).filter(([key]) => !KNOWN_KEYS.has(key));
}

export interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: string;
}

// Tolerates a trailing slash and any trailing path/query/fragment
// (e.g. "#discussion_r123") after the PR number.
const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** Parse a GitHub PR URL into {owner, repo, number}. Returns null for
 * anything that isn't a github.com/<owner>/<repo>/pull/<number> URL. */
export function parsePrUrl(url: string): ParsedPrUrl | null {
  const m = PR_URL_RE.exec(url.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: m[3] };
}

/** "owner/repo #number", the link text for a parsed PR url. */
export function formatPrLabel(parsed: ParsedPrUrl): string {
  return `${parsed.owner}/${parsed.repo} #${parsed.number}`;
}

export type DeliveryTone = 'success' | 'danger' | 'neutral';

export interface DeliveryBadge {
  label: string;
  tone: DeliveryTone;
}

const OUTCOME_BADGES: Record<string, DeliveryBadge> = {
  pushed_pr: { label: '✓ Pushed PR', tone: 'success' },
  no_changes: { label: 'No changes', tone: 'neutral' },
  failed: { label: '✗ Failed', tone: 'danger' },
  error: { label: '✗ Error', tone: 'danger' },
};

/** Badge copy + color tone for an outcome. Unknown outcomes fall back to a
 * neutral badge showing the raw value verbatim — never crashes, never hides
 * an outcome the card doesn't recognize yet. */
export function outcomeBadge(outcome: string): DeliveryBadge {
  return OUTCOME_BADGES[outcome] ?? { label: outcome, tone: 'neutral' };
}

export interface DeliveryMatch {
  payload: DeliveryPayload;
  /** Offset into the scanned string where the matched `{…}` starts. */
  start: number;
  /** Offset just past the matched `{…}`'s closing brace. */
  end: number;
}

// Scan forward from `start` (which must point at a `{`) for the balanced
// closing `}`, honoring JSON string-escaping so a `{`/`}` inside a quoted
// value never miscounts the depth. Returns null if the braces never balance
// before the string ends (truncated/streaming text, or not JSON at all).
function findBalancedObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return null; // stray closing brace before any open
    }
  }
  return null;
}

/**
 * Scan `text` for the first balanced `{…}` JSON object that parses and
 * matches the delivery shape. Handles all three detection cases with one
 * routine: a match spanning the whole (trimmed) string is "the whole node is
 * the payload"; a match with real content before/after it is "an inline blob
 * mixed with other text"; running it against a fenced code block's raw value
 * covers the fenced-block case. Returns null when no candidate object in the
 * text is valid AND delivery-shaped (a `{...}` that parses to some other JSON
 * shape is skipped, not treated as a match — the shape-guard).
 */
export function findDeliveryPayload(text: string): DeliveryMatch | null {
  let searchFrom = 0;
  for (;;) {
    const braceIdx = text.indexOf('{', searchFrom);
    if (braceIdx === -1) return null;
    const end = findBalancedObjectEnd(text, braceIdx);
    if (end === null) return null; // no further balanced object is possible
    const candidate = text.slice(braceIdx, end);
    try {
      const parsed = JSON.parse(candidate);
      if (isDeliveryPayload(parsed)) {
        return { payload: parsed, start: braceIdx, end };
      }
    } catch {
      // not valid JSON — keep scanning past this brace
    }
    searchFrom = braceIdx + 1;
  }
}

// Minimal mdast shape — enough to walk and rewrite without pulling in
// @types/mdast (matches lib/embeds.ts's / lib/reservedTokens.ts's MdNode).
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  [key: string]: unknown;
}

interface VFileLike {
  value?: unknown;
}

function deliveryNode(payload: DeliveryPayload): MdNode {
  return {
    type: 'deliveryCard',
    data: {
      hName: 'div',
      hProperties: { dataDelivery: 'true', dataPayload: JSON.stringify(payload) },
    },
  };
}

// The raw source span a paragraph/code node covers, read from the VFile via
// its position offsets — unaffected by whatever gfm's autolink tokenizer did
// to the node's own (already-mangled) children. Falls back to concatenating
// child text (best-effort, only reliable when nothing mangled the children —
// e.g. a hand-built tree in a test with no VFile/position) when offsets are
// unavailable.
function rawSpan(node: MdNode, raw: string | null): string | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (raw != null && typeof start === 'number' && typeof end === 'number') {
    return raw.slice(start, end);
  }
  if (node.children) {
    return node.children.map((c) => (typeof c.value === 'string' ? c.value : '')).join('');
  }
  return typeof node.value === 'string' ? node.value : null;
}

function walk(node: MdNode, raw: string | null): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'code' && typeof child.value === 'string') {
      const match = findDeliveryPayload(child.value);
      if (match) {
        next.push(deliveryNode(match.payload));
        continue;
      }
    } else if (child.type === 'paragraph') {
      const text = rawSpan(child, raw);
      const match = text !== null ? findDeliveryPayload(text) : null;
      if (match && text !== null) {
        const before = text.slice(0, match.start);
        const after = text.slice(match.end);
        if (before.trim()) next.push({ type: 'paragraph', children: [{ type: 'text', value: before }] });
        next.push(deliveryNode(match.payload));
        if (after.trim()) next.push({ type: 'paragraph', children: [{ type: 'text', value: after }] });
        continue;
      }
    }
    walk(child, raw);
    next.push(child);
  }
  node.children = next;
}

/** remark plugin — add to MarkdownText's remarkPlugins. Runs after parsing
 * (like every remark tree-transform), but reconstructs from the VFile's raw
 * source rather than trusting the parsed children, so it isn't fooled by
 * remark-gfm's autolink mangling. See the module doc comment above. */
export function remarkDelivery() {
  return (tree: MdNode, file?: VFileLike) => {
    const raw = typeof file?.value === 'string' ? file.value : null;
    walk(tree, raw);
  };
}
