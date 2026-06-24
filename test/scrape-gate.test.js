import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldScrapePane, paneHasPermIssue } from '../lib/sessions.js';

const NOW = 1_000_000;
const WIN = 20_000;
const base = { transcriptPath: '/p/s.jsonl', lastActivityMs: 0 };

test('shouldScrapePane: live flags always scrape (keep polling until settled)', () => {
  for (const flag of ['thinking', 'compacting', 'pending', 'errored']) {
    assert.equal(shouldScrapePane({ ...base, [flag]: true }, 0, NOW, WIN), true, flag);
  }
});

test('shouldScrapePane: no transcript → scrape (can not gate)', () => {
  assert.equal(shouldScrapePane({ transcriptPath: null }, 0, NOW, WIN), true);
});

test('shouldScrapePane: fresh fs.watch activeUntil → scrape', () => {
  assert.equal(shouldScrapePane(base, NOW + 5_000, NOW, WIN), true);
});

test('shouldScrapePane: recent lastActivityMs backstop → scrape', () => {
  assert.equal(shouldScrapePane({ ...base, lastActivityMs: NOW - 5_000 }, 0, NOW, WIN), true);
});

test('shouldScrapePane: idle (no flags, stale watch + stale activity) → skip', () => {
  const idle = { transcriptPath: '/p/s.jsonl', lastActivityMs: NOW - 60_000 };
  assert.equal(shouldScrapePane(idle, NOW - 1, NOW, WIN), false);
});

test('paneHasPermIssue: detects macOS Full-Disk-Access denial', () => {
  assert.equal(paneHasPermIssue('ls: .: Operation not permitted'), true);
  assert.equal(paneHasPermIssue('OPERATION NOT PERMITTED'), true);
  assert.equal(paneHasPermIssue('normal shell output, all good'), false);
  assert.equal(paneHasPermIssue(''), false);
  assert.equal(paneHasPermIssue(null), false);
});
