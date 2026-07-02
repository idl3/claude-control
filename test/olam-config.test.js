import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadOlamConfig,
  assertAuthWithRemoteOrgs,
  runnerTokenCandidates,
  readSecretCandidate,
  validateTokenFilePath,
} from '../lib/olam-config.js';

function tmpConfig(json) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olam-config-'));
  const file = path.join(dir, 'olam.json');
  if (json !== undefined) {
    fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  }
  return file;
}

const ATLAS = {
  org: 'atlas',
  runnerUrl: 'https://runner.example.dev/',
  spaBase: 'https://spa.example.dev',
};

// --- loadOlamConfig ----------------------------------------------------------

test('absent file → disabled, zero orgs, no throw (feature flag off)', () => {
  const file = tmpConfig(undefined);
  const cfg = loadOlamConfig({ file });
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.orgs, []);
});

test('valid config parses with defaults filled + trailing slashes stripped', () => {
  const file = tmpConfig({ orgs: [ATLAS] });
  const cfg = loadOlamConfig({ file });
  assert.equal(cfg.enabled, true);
  const org = cfg.orgs[0];
  assert.equal(org.runnerUrl, 'https://runner.example.dev'); // slash stripped
  assert.equal(org.gsmProject, 'pleri-500205');
  assert.equal(org.gsmAccount, 'ernest.codes@gmail.com');
  assert.equal(org.runnerTokenGsmSecret, 'olam-atlas-sandbox-runner-token');
  assert.deepEqual(org.runnerTokenFiles, []);
});

test('malformed JSON throws loudly, naming the file', () => {
  const file = tmpConfig('{ not json');
  assert.throws(() => loadOlamConfig({ file }), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('missing required field throws naming the field + org index', () => {
  const file = tmpConfig({ orgs: [{ org: 'atlas', spaBase: 'https://x.dev' }] });
  assert.throws(() => loadOlamConfig({ file }), /orgs\[0\]\.runnerUrl/);
});

test('non-https URLs are rejected', () => {
  const file = tmpConfig({ orgs: [{ ...ATLAS, spaBase: 'http://spa.example.dev' }] });
  assert.throws(() => loadOlamConfig({ file }), /spaBase/);
});

test('duplicate org names are rejected', () => {
  const file = tmpConfig({ orgs: [ATLAS, ATLAS] });
  assert.throws(() => loadOlamConfig({ file }), /duplicate org "atlas"/);
});

// --- token file path validation ----------------------------------------------

test('relative token file paths are rejected', () => {
  assert.throws(() => validateTokenFilePath('secrets/token'), /absolute/);
});

test('".." segments in token file paths are rejected', () => {
  assert.throws(() => validateTokenFilePath('/etc/../etc/passwd'), /\.\./);
});

test('"~/" token file paths expand to the home directory', () => {
  assert.equal(validateTokenFilePath('~/.olam/secrets/t'), path.join(os.homedir(), '.olam/secrets/t'));
});

// --- assertAuthWithRemoteOrgs (decision 7) ------------------------------------

test('orgs configured + no cockpit token → fail-loud throw', () => {
  const file = tmpConfig({ orgs: [ATLAS] });
  const cfg = loadOlamConfig({ file });
  assert.throws(() => assertAuthWithRemoteOrgs(cfg, null), /Refusing to start/);
  assert.throws(() => assertAuthWithRemoteOrgs(cfg, ''), /Refusing to start/);
});

test('orgs configured + token set → ok; no orgs + no token → ok (unchanged local mode)', () => {
  const file = tmpConfig({ orgs: [ATLAS] });
  assert.doesNotThrow(() => assertAuthWithRemoteOrgs(loadOlamConfig({ file }), 'tok'));
  assert.doesNotThrow(() => assertAuthWithRemoteOrgs(loadOlamConfig({ file: tmpConfig(undefined) }), null));
});

// --- runnerTokenCandidates ----------------------------------------------------

test('candidates are GSM-first, then files, with non-secret labels', () => {
  const file = tmpConfig({ orgs: [{ ...ATLAS, runnerTokenFiles: ['~/.olam/secrets/t'] }] });
  const [org] = loadOlamConfig({ file }).orgs;
  const cands = runnerTokenCandidates(org);
  assert.equal(cands[0].kind, 'gsm');
  assert.equal(cands[0].label, 'gsm:olam-atlas-sandbox-runner-token');
  assert.equal(cands[1].kind, 'file');
  assert.match(cands[1].label, /^file:\//);
});

// --- readSecretCandidate ------------------------------------------------------

test('file candidate reads + trims; missing file resolves null (walk on)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olam-secret-'));
  const p = path.join(dir, 'tok');
  fs.writeFileSync(p, '  sekret-value\n');
  assert.equal(await readSecretCandidate({ kind: 'file', path: p }), 'sekret-value');
  assert.equal(await readSecretCandidate({ kind: 'file', path: path.join(dir, 'nope') }), null);
});

test('gsm candidate shells out to gcloud with account/project/secret args', async () => {
  const calls = [];
  const execFileImpl = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    cb(null, 'gsm-value\n');
  };
  const v = await readSecretCandidate(
    { kind: 'gsm', secret: 's1', project: 'p1', account: 'a@x' },
    { execFileImpl },
  );
  assert.equal(v, 'gsm-value');
  assert.equal(calls[0].cmd, 'gcloud');
  assert.ok(calls[0].args.includes('--secret=s1'));
  assert.ok(calls[0].args.includes('--project=p1'));
  assert.ok(calls[0].args.includes('--account=a@x'));
});

test('gcloud failure resolves null without leaking the value in any error', async () => {
  const execFileImpl = (cmd, args, opts, cb) => cb(new Error('denied'), '');
  assert.equal(
    await readSecretCandidate({ kind: 'gsm', secret: 's', project: 'p', account: 'a' }, { execFileImpl }),
    null,
  );
});
