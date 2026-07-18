#!/usr/bin/env node
// gen-protocol-fingerprint — regenerate lib/protocol/fingerprint.snapshot.json
// after an intentional protocol schema change.
//
// Workflow when you change a lib/protocol/*.js schema shape:
//   1. Bump PROTOCOL_VERSION in lib/protocol/version.js.
//   2. node scripts/gen-protocol-fingerprint.mjs
//   3. Commit the updated snapshot alongside the schema change.
//
// test/protocol-fingerprint.test.js is what actually enforces this — this
// script only regenerates the file the test compares against.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as protocol from '../lib/protocol/index.js';
import { fingerprintModule } from '../lib/protocol/fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, '../lib/protocol/fingerprint.snapshot.json');

const snapshot = {
  protocolVersion: protocol.PROTOCOL_VERSION,
  fingerprint: fingerprintModule(protocol),
};

fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), SNAPSHOT_PATH)}:`);
console.log(JSON.stringify(snapshot, null, 2));
