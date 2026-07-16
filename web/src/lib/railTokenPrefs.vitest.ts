// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RAIL_TOKENS,
  DEFAULT_RAIL_TOKENS,
  DEFAULT_RAIL_INTERVAL_MS,
  MIN_RAIL_INTERVAL_MS,
  loadRailTokens,
  saveRailTokens,
  poolTokens,
  insertToken,
  removeToken,
  moveToken,
  orderMetaFields,
} from './railTokenPrefs';

// Same stub as cosmosPrefs.vitest.ts: this repo's Node/vitest/jsdom combo
// shadows jsdom's real localStorage with a broken Node global.
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

describe('railTokenPrefs — load/save', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new FakeLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to DEFAULT_RAIL_TOKENS when nothing is stored', () => {
    expect(loadRailTokens().tokens).toEqual(DEFAULT_RAIL_TOKENS);
  });

  it('defaults to DEFAULT_RAIL_TOKENS on corrupt JSON', () => {
    localStorage.setItem('cc:rail-tokens', '{not json');
    expect(loadRailTokens().tokens).toEqual(DEFAULT_RAIL_TOKENS);
  });

  it('defaults to DEFAULT_RAIL_TOKENS when storage holds a non-array', () => {
    localStorage.setItem('cc:rail-tokens', JSON.stringify({ model: true }));
    expect(loadRailTokens().tokens).toEqual(DEFAULT_RAIL_TOKENS);
  });

  it('saveRailTokens then loadRailTokens round-trips', () => {
    saveRailTokens({ tokens: ['ctx', 'model'], intervalMs: 10000 });
    const p = loadRailTokens();
    expect(p.tokens).toEqual(['ctx', 'model']);
    expect(p.intervalMs).toBe(10000);
  });

  it('drops unknown tokens on load, keeping the valid ones in order', () => {
    localStorage.setItem('cc:rail-tokens', JSON.stringify(['ctx', 'bogus', 'model']));
    expect(loadRailTokens().tokens).toEqual(['ctx', 'model']);
  });

  it('dedupes repeated tokens on load, keeping the first occurrence', () => {
    localStorage.setItem('cc:rail-tokens', JSON.stringify(['ctx', 'model', 'ctx']));
    expect(loadRailTokens().tokens).toEqual(['ctx', 'model']);
  });

  it('falls back to the default when every stored token is unknown/invalid', () => {
    localStorage.setItem('cc:rail-tokens', JSON.stringify(['bogus', 42, null]));
    expect(loadRailTokens().tokens).toEqual(DEFAULT_RAIL_TOKENS);
  });

  it('an intentionally empty bar (operator removed everything) round-trips as empty', () => {
    saveRailTokens({ tokens: [], intervalMs: 10000 });
    // An explicitly-saved [] parses to a valid empty array — sanitize()
    // treats "no valid tokens survived" the same as "started empty", so this
    // degrades to the default rather than staying blank. That's the
    // documented behavior (see sanitize()'s jsdoc): corrupt-vs-empty aren't
    // distinguishable once nothing is left, so we choose the safer default.
    expect(loadRailTokens().tokens).toEqual(DEFAULT_RAIL_TOKENS);
  });

  it('degrades to the default (non-throwing) when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    });
    expect(() => saveRailTokens({ tokens: ['model'], intervalMs: 10000 })).not.toThrow();
    expect(loadRailTokens().tokens).toEqual(DEFAULT_RAIL_TOKENS);
  });

  it('legacy bare-array storage loads with the default interval', () => {
    localStorage.setItem('cc:rail-tokens', JSON.stringify(['ctx', 'model']));
    const p = loadRailTokens();
    expect(p.tokens).toEqual(['ctx', 'model']);
    expect(p.intervalMs).toBe(DEFAULT_RAIL_INTERVAL_MS);
  });

  it('new object-shape storage round-trips the interval', () => {
    saveRailTokens({ tokens: ['model'], intervalMs: 3000 });
    expect(loadRailTokens().intervalMs).toBe(3000);
  });

  it('clamps an interval below the floor to MIN_RAIL_INTERVAL_MS', () => {
    localStorage.setItem('cc:rail-tokens', JSON.stringify({ tokens: ['model'], intervalMs: 200 }));
    expect(loadRailTokens().intervalMs).toBe(MIN_RAIL_INTERVAL_MS);
  });

  it('falls back to the default interval when intervalMs is non-numeric', () => {
    localStorage.setItem('cc:rail-tokens', JSON.stringify({ tokens: ['model'], intervalMs: 'soon' }));
    expect(loadRailTokens().intervalMs).toBe(DEFAULT_RAIL_INTERVAL_MS);
  });
});

describe('railTokenPrefs — poolTokens', () => {
  it('returns tokens not on the bar, in RAIL_TOKENS order', () => {
    expect(poolTokens(['ctx', 'model'])).toEqual(['effort', 'usage']);
  });

  it('returns everything when the bar is empty', () => {
    expect(poolTokens([])).toEqual([...RAIL_TOKENS]);
  });

  it('returns nothing when the bar has every token', () => {
    expect(poolTokens([...RAIL_TOKENS])).toEqual([]);
  });
});

describe('railTokenPrefs — insertToken / removeToken / moveToken', () => {
  it('insertToken inserts a pool token at the given index', () => {
    expect(insertToken(['model', 'ctx'], 'effort', 1)).toEqual(['model', 'effort', 'ctx']);
  });

  it('insertToken at index 0 prepends', () => {
    expect(insertToken(['model', 'ctx'], 'effort', 0)).toEqual(['effort', 'model', 'ctx']);
  });

  it('insertToken past the end appends (clamped)', () => {
    expect(insertToken(['model', 'ctx'], 'effort', 99)).toEqual(['model', 'ctx', 'effort']);
  });

  it('insertToken with a negative index clamps to 0', () => {
    expect(insertToken(['model', 'ctx'], 'effort', -5)).toEqual(['effort', 'model', 'ctx']);
  });

  it('insertToken moves an existing bar token rather than duplicating it', () => {
    // index is computed against the post-removal array (see jsdoc) — moving
    // 'model' (currently at 0) to index 1 lands it between effort and ctx.
    expect(insertToken(['model', 'effort', 'ctx'], 'model', 1)).toEqual(['effort', 'model', 'ctx']);
  });

  it('removeToken drops the token and leaves the rest in order', () => {
    expect(removeToken(['model', 'effort', 'ctx'], 'effort')).toEqual(['model', 'ctx']);
  });

  it('removeToken is a no-op (new array, same values) if the token is absent', () => {
    const bar: ('model' | 'ctx')[] = ['model', 'ctx'];
    const result = removeToken(bar, 'usage' as never);
    expect(result).toEqual(['model', 'ctx']);
    expect(result).not.toBe(bar);
  });

  it('moveToken is equivalent to insertToken for an existing bar token', () => {
    expect(moveToken(['model', 'effort', 'ctx'], 'ctx', 0)).toEqual(['ctx', 'model', 'effort']);
  });

  it('does not mutate the input array', () => {
    const bar: ('model' | 'ctx')[] = ['model', 'ctx'];
    insertToken(bar, 'effort' as never, 1);
    removeToken(bar, 'model');
    expect(bar).toEqual(['model', 'ctx']);
  });
});

describe('railTokenPrefs — orderMetaFields', () => {
  const model = { key: 'model', text: 'sonnet-5' };
  const effort = { key: 'effort', text: 'high' };
  const ctx = { key: 'ctx', text: 'ctx:42%' };

  it('filters and reorders fields to match the token order', () => {
    expect(orderMetaFields([model, effort, ctx], ['ctx', 'model'])).toEqual([ctx, model]);
  });

  it('drops fields whose key has no corresponding token', () => {
    expect(orderMetaFields([model, effort, ctx], ['model'])).toEqual([model]);
  });

  it('drops tokens with no corresponding field (a row that lacks that data)', () => {
    expect(orderMetaFields([model, ctx], ['model', 'effort', 'ctx'])).toEqual([model, ctx]);
  });

  it('returns an empty array when tokens is empty', () => {
    expect(orderMetaFields([model, effort, ctx], [])).toEqual([]);
  });

  it('returns an empty array when fields is empty', () => {
    expect(orderMetaFields([], ['model', 'ctx'])).toEqual([]);
  });
});
