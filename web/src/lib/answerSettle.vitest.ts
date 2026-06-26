import { describe, it, expect } from 'vitest';
import { shouldShowPrompt, shouldShowSynthesizedAsk, SETTLE_CAP_MS } from './answerSettle';

// Fixed reference time used across tests.
const T0 = 1_000_000;

describe('shouldShowPrompt', () => {
  // ─── baseline (no settling in play) ───────────────────────────────────────

  it('returns false when hasPrompt is false regardless of settling', () => {
    expect(shouldShowPrompt({
      hasPrompt: false,
      pickerOpen: true,
      answerSettling: true,
      settleDeadline: T0 + SETTLE_CAP_MS,
      now: T0,
    })).toBe(false);
  });

  it('returns true when hasPrompt is true and not settling', () => {
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: true,
      answerSettling: false,
      settleDeadline: 0,
      now: T0,
    })).toBe(true);
  });

  // ─── core bug scenario ─────────────────────────────────────────────────────
  // OLD BEHAVIOUR (broken): a 1800ms timer fires, pickerOpen is still true,
  // activePrompt re-opens → question flashes back.
  // NEW BEHAVIOUR: settling=true + pickerOpen=true → suppress.

  it('suppresses after submit while settling AND pickerOpen still true', () => {
    // This is the exact scenario the old 1800ms timer lost:
    // answer submitted, timer expired, but picker is still on screen.
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: true,    // picker still on screen
      answerSettling: true,
      settleDeadline: T0 + SETTLE_CAP_MS, // cap not yet elapsed
      now: T0,
    })).toBe(false);
  });

  // ─── frame-ordering race cases (the residual flash bug) ──────────────────
  // The picker frame ({type:'picker', open:false}) and the prompt-clear frame
  // ({type:'prompt'}) are separate WebSocket messages with no ordering
  // guarantee. Suppression must hold while hasPrompt=true regardless of
  // pickerOpen, or the stale scrape prompt re-opens the question for one render.

  it('RACE: suppresses when pickerOpen=false but hasPrompt still true (settling, within cap)', () => {
    // Test case (1) from the spec: this FAILED on the old line-84 code which
    // did `if (!pickerOpen) return true`. It must PASS after the fix.
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: false,   // picker frame already cleared…
      answerSettling: true,
      settleDeadline: T0 + SETTLE_CAP_MS, // …but cap not elapsed…
      now: T0,             // …and stale prompt still present → suppress
    })).toBe(false);
  });

  it('RACE: suppresses when pickerOpen=false, hasPrompt=true, one tick before cap', () => {
    const deadline = T0 + SETTLE_CAP_MS;
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: false,
      answerSettling: true,
      settleDeadline: deadline,
      now: deadline - 1,
    })).toBe(false);
  });

  // ─── release conditions ────────────────────────────────────────────────────

  it('releases when safety-cap deadline elapses while pickerOpen still true', () => {
    // Prevents permanent suppression if the picker never clears.
    const deadline = T0 + SETTLE_CAP_MS;
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: true,       // picker would re-open the question...
      answerSettling: true,
      settleDeadline: deadline,
      now: deadline,          // ...but cap just elapsed
    })).toBe(true);
  });

  it('still suppresses one millisecond before the safety-cap elapses', () => {
    const deadline = T0 + SETTLE_CAP_MS;
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: true,
      answerSettling: true,
      settleDeadline: deadline,
      now: deadline - 1,      // one tick before cap
    })).toBe(false);
  });

  it('releases once both pickerOpen false AND cap elapsed (belt-and-suspenders)', () => {
    const deadline = T0 + SETTLE_CAP_MS;
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: false,
      answerSettling: true,
      settleDeadline: deadline,
      now: deadline + 100,
    })).toBe(true);
  });

  // ─── cap-elapsed release, regardless of pickerOpen ───────────────────────

  it('RACE cap: releases when cap elapses even with pickerOpen=false and hasPrompt=true', () => {
    // Spec case (3): settling=true, hasPrompt=true, now>=deadline → release.
    // This is the safety-cap escape hatch for both pickerOpen states.
    const deadline = T0 + SETTLE_CAP_MS;
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: false,
      answerSettling: true,
      settleDeadline: deadline,
      now: deadline,
    })).toBe(true);
  });

  // ─── zero deadline edge case ───────────────────────────────────────────────

  it('suppresses with zero deadline (no cap) while settling and hasPrompt true', () => {
    // settleDeadline=0 means cap check is skipped — suppresses as long as
    // hasPrompt=true and answerSettling=true regardless of pickerOpen.
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: false,  // picker gone, but no cap to release us
      answerSettling: true,
      settleDeadline: 0,  // no cap active
      now: T0,
    })).toBe(false);
  });

  // ─── genuinely new prompt is NOT suppressed ────────────────────────────────
  // The structured `cockpit.pending` path is gated before this function in
  // activePrompt (line 1120: if pending return early). This function only covers
  // the scrape/synthesized paths. So a new scrape prompt AFTER settling has
  // cleared (answerSettling=false) is always shown.

  it('shows a new prompt after settling has been cleared', () => {
    expect(shouldShowPrompt({
      hasPrompt: true,
      pickerOpen: false,
      answerSettling: false,  // cleared by pickerOpen effect
      settleDeadline: 0,
      now: T0 + 5_000,
    })).toBe(true);
  });
});

describe('shouldShowSynthesizedAsk', () => {
  it('suppresses while settling and pickerOpen true', () => {
    expect(shouldShowSynthesizedAsk({
      pickerOpen: true,
      answerSettling: true,
      settleDeadline: T0 + SETTLE_CAP_MS,
      now: T0,
    })).toBe(false);
  });

  it('releases when pickerOpen flips false', () => {
    expect(shouldShowSynthesizedAsk({
      pickerOpen: false,
      answerSettling: true,
      settleDeadline: T0 + SETTLE_CAP_MS,
      now: T0,
    })).toBe(true);
  });

  it('releases when safety cap elapses', () => {
    const deadline = T0 + SETTLE_CAP_MS;
    expect(shouldShowSynthesizedAsk({
      pickerOpen: true,
      answerSettling: true,
      settleDeadline: deadline,
      now: deadline,
    })).toBe(true);
  });

  it('returns true when not settling', () => {
    expect(shouldShowSynthesizedAsk({
      pickerOpen: true,
      answerSettling: false,
      settleDeadline: 0,
      now: T0,
    })).toBe(true);
  });
});
