import { randomBytes } from 'node:crypto';

/**
 * Random lowercase base36 slug ids (~10 chars). Carried forward from the prior
 * `feat/claude-collab-mcp` attempt's `safeRoomId` primitive: ids that touch
 * queries or the filesystem are validated against a strict charset so nothing
 * resembling path traversal or SQL-adjacent injection ever reaches a query.
 */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 10;

export function generateId(): string {
  const bytes = randomBytes(ID_LENGTH);
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return out;
}

/** Safe id charset: lowercase alnum + hyphen, 1-40 chars. No path traversal. */
const SAFE_ID_RE = /^[a-z0-9-]{1,40}$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID_RE.test(id);
}

export class InvalidIdError extends Error {
  constructor(field: string, value: string) {
    super(`invalid id for ${field}: ${JSON.stringify(value)}`);
    this.name = 'InvalidIdError';
  }
}

/** Validate an id that will be used in a query or filesystem path; throws if unsafe. */
export function assertSafeId(field: string, value: string): string {
  if (!isSafeId(value)) {
    throw new InvalidIdError(field, value);
  }
  return value;
}
