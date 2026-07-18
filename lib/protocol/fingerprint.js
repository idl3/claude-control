/**
 * lib/protocol/fingerprint.js — deterministic structural hashing for zod
 * schema modules.
 *
 * This is the compat-discipline safety net (see version.js): a stable hash
 * of every exported schema's SHAPE (field names, nesting, optionality,
 * literal/enum members) — never runtime values. Two schemas with identical
 * shapes fingerprint identically regardless of export order or object key
 * order, so the only thing that moves the fingerprint is an actual wire-shape
 * change.
 *
 * Deliberately generic: `describeModule`/`fingerprintModule` take any module
 * namespace and pick out zod-schema exports by duck-typing (`.parse` +
 * `._def`), so a new schema added to lib/protocol/index.js is picked up
 * automatically — nobody has to remember to register it here.
 */
import { createHash } from 'node:crypto';

function isZodSchema(value) {
  return !!value && typeof value === 'object' && typeof value.parse === 'function' && !!value._def;
}

/**
 * Canonical (sorted, deterministic) JSON stringification — unlike
 * JSON.stringify, key order in nested objects never affects the output.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Recursively describe one zod schema's structural shape as a plain,
 * JSON-serializable, sorted object. Unknown/unhandled zod node types fall
 * back to `{ kind, of: describe(innerType) }` when an innerType exists (this
 * covers optional/nullable/default/readonly/etc. generically), otherwise
 * `{ kind }` — so an unrecognized wrapper still participates in the hash
 * rather than being silently ignored.
 */
function describe(schema) {
  const def = schema?._def;
  if (!def) return { kind: 'unknown' };

  switch (def.type) {
    case 'object': {
      const shape = schema.shape ?? {};
      const fields = {};
      for (const key of Object.keys(shape).sort()) fields[key] = describe(shape[key]);
      return { kind: 'object', fields };
    }
    case 'array':
      return { kind: 'array', of: describe(def.element) };
    case 'union':
      // Covers both z.union and z.discriminatedUnion (zod v4 represents the
      // latter as a union with `discriminator` set). Options are sorted by
      // their own canonical form so member order in source never matters.
      return {
        kind: 'union',
        discriminator: def.discriminator ?? null,
        of: def.options
          .map((option) => describe(option))
          .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
      };
    case 'literal':
      return { kind: 'literal', values: [...def.values].map(String).sort() };
    case 'enum':
      return { kind: 'enum', values: Object.values(def.entries).map(String).sort() };
    case 'number':
      return {
        kind: 'number',
        int: !!def.checks?.some((c) => c.isInt || c.format === 'safeint' || c.def?.format === 'safeint'),
      };
    case 'string':
    case 'boolean':
      return { kind: def.type };
    default:
      return def.innerType ? { kind: def.type, of: describe(def.innerType) } : { kind: def.type };
  }
}

/**
 * Build a deterministic structural descriptor of every zod schema exported
 * from a module namespace, keyed by export name (sorted).
 * @param {Record<string, unknown>} moduleNamespace
 * @returns {Record<string, unknown>}
 */
export function describeModule(moduleNamespace) {
  const out = {};
  for (const key of Object.keys(moduleNamespace).sort()) {
    const value = moduleNamespace[key];
    if (isZodSchema(value)) out[key] = describe(value);
  }
  return out;
}

/**
 * sha256 hex digest of the canonical structural descriptor of every zod
 * schema exported from a module namespace.
 * @param {Record<string, unknown>} moduleNamespace
 * @returns {string}
 */
export function fingerprintModule(moduleNamespace) {
  const json = stableStringify(describeModule(moduleNamespace));
  return createHash('sha256').update(json).digest('hex');
}
