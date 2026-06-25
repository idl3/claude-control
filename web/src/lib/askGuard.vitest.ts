import { describe, it, expect } from 'vitest';
import { hasOpenQuestion } from './askGuard';

describe('hasOpenQuestion', () => {
  it('blocks when structured pending is present and session flag is false', () => {
    // Structured Pending object from the tailer — the "normal" blocking path.
    expect(hasOpenQuestion({ toolUseId: 'abc', questions: [] }, false)).toBe(true);
  });

  it('blocks when structured pending is null but session flag is true (regression: flag-only path)', () => {
    // This is the reported bug: tailer-less session only has the boolean flag.
    // A normal reply MUST still be blocked in this case.
    expect(hasOpenQuestion(null, true)).toBe(true);
  });

  it('allows send when both signals are absent', () => {
    expect(hasOpenQuestion(null, false)).toBe(false);
  });

  it('allows send when structured pending is null and session flag is undefined', () => {
    // Session object may not carry pendingQuestion at all (older server).
    expect(hasOpenQuestion(null, undefined)).toBe(false);
  });

  it('blocks when only paneScrapePickerOpen is true (screen-truth signal)', () => {
    // The pane-scrape picker signal is the fastest/most authoritative source;
    // it must block even when the structured and session signals have not arrived yet.
    expect(hasOpenQuestion(null, false, true)).toBe(true);
  });

  it('allows send when paneScrapePickerOpen is omitted with other signals falsy (backward-compat)', () => {
    // Third param is optional — callers that have not yet been updated must not break.
    expect(hasOpenQuestion(null, false)).toBe(false);
    expect(hasOpenQuestion(null, undefined, undefined)).toBe(false);
  });
});
