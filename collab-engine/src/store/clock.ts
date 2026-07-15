/**
 * Injectable clock so core logic and tests can control "now" deterministically.
 * Production code defaults to `Date.now`; tests pass a mutable fake clock.
 */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
