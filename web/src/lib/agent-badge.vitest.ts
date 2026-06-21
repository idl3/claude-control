import { describe, it, expect } from 'vitest';
import { agentBadge, selectionsToPayload } from './agent-badge';

// ---------------------------------------------------------------------------
// agentBadge
// ---------------------------------------------------------------------------

describe('agentBadge', () => {
  it('returns CLA label and claude kind for claude', () => {
    expect(agentBadge('claude')).toEqual({ label: 'CLA', kind: 'claude' });
  });

  it('returns CDX label and codex kind for codex', () => {
    expect(agentBadge('codex')).toEqual({ label: 'CDX', kind: 'codex' });
  });

  it('returns null for undefined (legacy/unknown session)', () => {
    expect(agentBadge(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectionsToPayload — maps per-question Set<string> to string[][]
// ---------------------------------------------------------------------------

describe('selectionsToPayload', () => {
  it('maps a single-question single-select answer to [[label]]', () => {
    const selections = [new Set(['Yes, proceed'])];
    expect(selectionsToPayload(selections)).toEqual([['Yes, proceed']]);
  });

  it('maps a single-question multi-select to [[a, b]]', () => {
    const selections = [new Set(['Option A', 'Option B'])];
    const result = selectionsToPayload(selections);
    expect(result).toHaveLength(1);
    // Order within the inner array may vary (Set iteration); sort for comparison.
    expect(result[0].sort()).toEqual(['Option A', 'Option B']);
  });

  it('maps multiple questions to multiple inner arrays', () => {
    const selections = [new Set(['Yes']), new Set(['Maybe', 'No'])];
    const result = selectionsToPayload(selections);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['Yes']);
    expect(result[1].sort()).toEqual(['Maybe', 'No']);
  });

  it('handles an empty selections array', () => {
    expect(selectionsToPayload([])).toEqual([]);
  });

  it('preserves an empty Set as an empty inner array', () => {
    expect(selectionsToPayload([new Set()])).toEqual([[]]);
  });

  it('Codex-style answer: single question, single choice produces [[choice]]', () => {
    // Simulates the exact payload shape a Codex approval produces.
    const codexSelections = [new Set(['Yes, proceed'])];
    const payload = selectionsToPayload(codexSelections);
    expect(payload).toEqual([['Yes, proceed']]);
  });
});
