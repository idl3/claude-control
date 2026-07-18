// protocol-fingerprint.test.js — the compat-discipline gate for lib/protocol.
//
// This replaces the buf breaking-change lint we'd get "for free" with
// protobuf: a structural fingerprint of every exported zod schema is
// committed (lib/protocol/fingerprint.snapshot.json) alongside the
// PROTOCOL_VERSION it was generated against. If a schema's shape changes
// (field added/removed/retyped/reoptioned, union/enum member added/removed)
// without a matching PROTOCOL_VERSION bump, the fingerprint no longer
// matches the snapshot and this test goes RED — catching wire drift before
// it reaches a version-handshake between a head and backend built against
// different schema shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import * as protocol from '../lib/protocol/index.js';
import { fingerprintModule, describeModule } from '../lib/protocol/fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, '../lib/protocol/fingerprint.snapshot.json');

function readSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

test('committed fingerprint snapshot matches the live PROTOCOL_VERSION', () => {
  const snapshot = readSnapshot();
  assert.equal(
    protocol.PROTOCOL_VERSION,
    snapshot.protocolVersion,
    `PROTOCOL_VERSION (${protocol.PROTOCOL_VERSION}) does not match the committed snapshot ` +
      `(${snapshot.protocolVersion}). If you bumped PROTOCOL_VERSION, regenerate the snapshot: ` +
      `node scripts/gen-protocol-fingerprint.mjs`,
  );
});

test('recomputed schema fingerprint matches the committed snapshot', () => {
  const snapshot = readSnapshot();
  const fingerprint = fingerprintModule(protocol);
  assert.equal(
    fingerprint,
    snapshot.fingerprint,
    'A lib/protocol schema shape changed (field added/removed/retyped/re-optioned, or a ' +
      'union/enum member added/removed) without a PROTOCOL_VERSION bump. This is the wire-drift ' +
      'gate: bump PROTOCOL_VERSION in lib/protocol/version.js, then regenerate the snapshot ' +
      '(node scripts/gen-protocol-fingerprint.mjs) and commit it alongside the schema change.',
  );
});

test('fingerprintModule is deterministic across repeated calls', () => {
  assert.equal(fingerprintModule(protocol), fingerprintModule(protocol));
});

test('fingerprintModule is insensitive to export order and object key order', () => {
  const a = { Foo: z.object({ a: z.string(), b: z.number() }), Bar: z.object({ c: z.boolean() }) };
  const b = { Bar: z.object({ c: z.boolean() }), Foo: z.object({ b: z.number(), a: z.string() }) };
  assert.equal(fingerprintModule(a), fingerprintModule(b));
});

test('fingerprintModule changes when a field is added to a schema', () => {
  const before = { S: z.object({ a: z.string() }) };
  const after = { S: z.object({ a: z.string(), b: z.number() }) };
  assert.notEqual(fingerprintModule(before), fingerprintModule(after));
});

test('fingerprintModule changes when a field is removed from a schema', () => {
  const before = { S: z.object({ a: z.string(), b: z.number() }) };
  const after = { S: z.object({ a: z.string() }) };
  assert.notEqual(fingerprintModule(before), fingerprintModule(after));
});

test('fingerprintModule changes when a field is renamed', () => {
  const before = { S: z.object({ a: z.string() }) };
  const after = { S: z.object({ renamed: z.string() }) };
  assert.notEqual(fingerprintModule(before), fingerprintModule(after));
});

test('fingerprintModule changes when a field type changes', () => {
  const before = { S: z.object({ a: z.string() }) };
  const after = { S: z.object({ a: z.number() }) };
  assert.notEqual(fingerprintModule(before), fingerprintModule(after));
});

test('fingerprintModule changes when a required field becomes optional', () => {
  const before = { S: z.object({ a: z.string() }) };
  const after = { S: z.object({ a: z.string().optional() }) };
  assert.notEqual(fingerprintModule(before), fingerprintModule(after));
});

test('fingerprintModule changes when a union gains a member', () => {
  const before = {
    U: z.discriminatedUnion('type', [z.object({ type: z.literal('a'), x: z.string() })]),
  };
  const after = {
    U: z.discriminatedUnion('type', [
      z.object({ type: z.literal('a'), x: z.string() }),
      z.object({ type: z.literal('b'), y: z.number() }),
    ]),
  };
  assert.notEqual(fingerprintModule(before), fingerprintModule(after));
});

test('fingerprintModule changes when an enum gains a member', () => {
  const before = { E: z.object({ code: z.enum(['a', 'b']) }) };
  const after = { E: z.object({ code: z.enum(['a', 'b', 'c']) }) };
  assert.notEqual(fingerprintModule(before), fingerprintModule(after));
});

test('fingerprintModule ignores non-schema exports (e.g. PROTOCOL_VERSION)', () => {
  const withExtra = { ...protocol, SOME_CONSTANT: 42, helper: () => {} };
  assert.equal(fingerprintModule(protocol), fingerprintModule(withExtra));
});

test('describeModule only picks up zod-schema exports', () => {
  const described = describeModule({ Schema: z.object({ a: z.string() }), notASchema: 42 });
  assert.deepEqual(Object.keys(described), ['Schema']);
});
