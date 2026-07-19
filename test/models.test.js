import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MLX_MODELS,
  CLAUDE_MODELS,
  CLAUDEX_MODELS,
  CLAUDEMI_MODELS,
  recommendMlxModel,
  recommendClaudeModel,
  detectMachine,
} from '../lib/models.js';

test('recommendMlxModel scales with unified memory', () => {
  assert.equal(recommendMlxModel(16), 'mlx-community/Llama-3.2-3B-Instruct-4bit');
  assert.equal(recommendMlxModel(23), 'mlx-community/Llama-3.2-3B-Instruct-4bit');
  assert.equal(recommendMlxModel(24), 'mlx-community/Qwen2.5-7B-Instruct-4bit');
  assert.equal(recommendMlxModel(36), 'mlx-community/Qwen2.5-7B-Instruct-4bit');
  assert.equal(recommendMlxModel(48), 'mlx-community/Qwen2.5-14B-Instruct-4bit');
  assert.equal(recommendMlxModel(64), 'mlx-community/Qwen2.5-14B-Instruct-4bit');
});

test('recommended models exist in their catalogs', () => {
  for (const ram of [16, 24, 48]) {
    assert.ok(MLX_MODELS.some((m) => m.id === recommendMlxModel(ram)), `mlx rec for ${ram}GB`);
  }
  assert.ok(CLAUDE_MODELS.some((m) => m.id === recommendClaudeModel()));
});

test('catalog entries are well-formed', () => {
  for (const m of MLX_MODELS) {
    assert.match(m.id, /^mlx-community\//);
    assert.ok(m.sizeGB > 0 && m.minRamGB >= 16);
    assert.ok(typeof m.label === 'string' && m.label.length > 0);
  }
  for (const m of CLAUDE_MODELS) {
    assert.match(m.id, /^claude-/);
  }
  for (const m of CLAUDEX_MODELS) {
    assert.ok(typeof m.id === 'string' && m.id.length > 0);
    assert.ok(typeof m.label === 'string' && m.label.length > 0);
  }
  for (const m of CLAUDEMI_MODELS) {
    assert.ok(typeof m.id === 'string' && m.id.length > 0);
    assert.ok(typeof m.label === 'string' && m.label.length > 0);
  }
});

test('claudex catalog is a closed single-entry list', () => {
  // Deliberately exactly one entry (design rubric S3: no generic model /
  // base-URL configurability for the claudex agent kind).
  assert.deepEqual(CLAUDEX_MODELS, [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (Codex)' }]);
});

test('claudemi catalog is a closed two-entry list', () => {
  // Deliberately exactly two entries — Kimi K3 (default) + Kimi K2.7 Code
  // (design rubric S3 parity: no generic model / base-URL configurability
  // for the claudemi agent kind, same as claudex).
  assert.deepEqual(CLAUDEMI_MODELS, [
    { id: 'kimi-k3', label: 'Kimi K3' },
    { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  ]);
});

test('detectMachine returns plausible specs', () => {
  const m = detectMachine();
  assert.ok(m.ramGB > 0);
  assert.equal(typeof m.appleSilicon, 'boolean');
});
