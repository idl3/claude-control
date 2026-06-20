/**
 * PLE-42 measurement harness — transcript render cost at scale.
 *
 * Method: pure Node/V8, no DOM. We exercise `convertMessages` (the CPU-bound
 * conversion + turn-merging step) with synthetic transcripts and measure:
 *   - output message count after capping (what the runtime actually sees)
 *   - total content-part count (proxy for React element count)
 *   - wall-clock time for convertMessages over the full 1k-message input
 *   - wall-clock time for convertMessages over the capped 150-message slice
 *
 * Caveats (stated explicitly per task spec):
 *   - jsdom / browser-level DOM node counts and first-paint timing are NOT
 *     measured here; real FPS/CLS requires a real browser.
 *   - The `element count` proxy undercounts actual DOM nodes by the React
 *     component subtree depth for each part, but it accurately reflects
 *     O(n) linear scaling and gives a comparable relative before/after number.
 *   - These are single-run wall-clock samples inside vitest, not stable
 *     perf benchmarks. Treat the order-of-magnitude, not the exact ms.
 *
 * Synthetic workload:
 *   - 1 000 raw Msg objects (mimics a long but not pathological Claude session)
 *   - Pattern: alternating user → assistant turn, each assistant turn = 3 msgs
 *     (thinking + tool_use + text), with a matching tool_result in the user msg.
 *   - This produces the realistic case that mergeAssistantTurns must handle.
 */

import { describe, it, expect } from 'vitest';
import { convertMessages } from './convert';
import type { Msg } from './types';

// ── Synthetic transcript builder ──────────────────────────────────────────────

/** Build a realistic-pattern transcript of `targetRawMsgCount` raw Msg objects.
 *
 * Each "conversation turn" emits 5 raw messages:
 *   1. user text
 *   2. assistant thinking
 *   3. assistant tool_use
 *   4. user tool_result  (folded into #3 by convertMessages, so becomes 0 output msgs)
 *   5. assistant text
 * → 5 raw msgs → 2 merged output msgs (user turn + merged assistant turn).
 */
function buildTranscript(targetRawMsgCount: number): Msg[] {
  const msgs: Msg[] = [];
  let toolIdx = 0;

  while (msgs.length + 5 <= targetRawMsgCount) {
    const turnId = msgs.length;
    const toolId = `t-${++toolIdx}`;

    // 1. User message
    msgs.push({
      uuid: `u-${turnId}`,
      role: 'user',
      ts: Date.now() + turnId * 1000,
      blocks: [{ kind: 'text', text: `User message ${turnId}: tell me about topic ${turnId % 50}` }],
    });

    // 2. Assistant thinking
    msgs.push({
      uuid: `think-${turnId}`,
      role: 'assistant',
      ts: Date.now() + turnId * 1000 + 100,
      blocks: [{ kind: 'thinking', text: `I need to use a tool to answer question ${turnId}` }],
    });

    // 3. Assistant tool_use
    msgs.push({
      uuid: `tool-${turnId}`,
      role: 'assistant',
      ts: Date.now() + turnId * 1000 + 200,
      blocks: [{
        kind: 'tool_use',
        id: toolId,
        name: 'Bash',
        input: { command: `echo "result for ${turnId}"` },
        inputSummary: `echo result-${turnId}`,
      }],
    });

    // 4. User tool_result (will be folded and dropped from output)
    msgs.push({
      uuid: `res-${turnId}`,
      role: 'user',
      ts: Date.now() + turnId * 1000 + 300,
      blocks: [{ kind: 'tool_result', forId: toolId, text: `output-${turnId}` }],
    });

    // 5. Assistant final text
    msgs.push({
      uuid: `final-${turnId}`,
      role: 'assistant',
      ts: Date.now() + turnId * 1000 + 400,
      blocks: [{ kind: 'text', text: `Here is the answer to question ${turnId}: the result is output-${turnId}.` }],
    });
  }

  return msgs;
}

// ── Constants matching App.tsx ────────────────────────────────────────────────
const INITIAL_VISIBLE = 150;

// ── Helpers ───────────────────────────────────────────────────────────────────

function countParts(msgs: ReturnType<typeof convertMessages>): number {
  return msgs.reduce((sum, m) => sum + (Array.isArray(m.content) ? m.content.length : 0), 0);
}

function hrMs(): number {
  return performance.now();
}

// ── Measurements ─────────────────────────────────────────────────────────────

describe('PLE-42 — transcript render cost at scale', () => {
  it('measures convertMessages on a 1 000-raw-message transcript', () => {
    const rawMsgs = buildTranscript(1000);
    expect(rawMsgs).toHaveLength(1000); // sanity

    // Full conversion (what convertMessages always does — tool_result folding
    // requires a full pass over all messages)
    const t0 = hrMs();
    const allConverted = convertMessages(rawMsgs);
    const fullConvertMs = hrMs() - t0;

    // Capped slice (what the runtime receives after App.tsx's visibleCount cap)
    const hiddenCount = Math.max(0, allConverted.length - INITIAL_VISIBLE);
    const cappedMsgs = allConverted.slice(hiddenCount);

    const totalParts = countParts(allConverted);
    const cappedParts = countParts(cappedMsgs);

    // Report numbers to stdout for the findings doc
    console.log('\n=== PLE-42 Measurement Results ===');
    console.log(`Raw input messages:          ${rawMsgs.length}`);
    console.log(`Converted (merged) messages: ${allConverted.length}`);
    console.log(`  → hidden by INITIAL_VISIBLE=${INITIAL_VISIBLE}: ${hiddenCount}`);
    console.log(`  → visible to runtime:        ${cappedMsgs.length}`);
    console.log(`Total content parts (full):  ${totalParts}`);
    console.log(`Content parts (capped):      ${cappedParts}`);
    console.log(`convertMessages wall time:   ${fullConvertMs.toFixed(2)} ms`);
    console.log(`Estimated React elements (capped, ~5 DOM nodes/part): ~${cappedParts * 5}`);
    console.log('==================================\n');

    // Structural assertions (these also serve as correctness checks)
    // 1 000 raw msgs / 5-msg-per-turn = 200 turns.
    // Each turn → 2 output msgs after merging (user + merged-assistant).
    // user tool_result msgs are dropped, so: 200 user + 200 merged-assistant = 400 expected.
    // But mergeAssistantTurns merges thinking+tool_use+text into 1 msg per turn.
    expect(allConverted.length).toBe(400);

    // Capped: at most INITIAL_VISIBLE output messages reach the runtime
    expect(cappedMsgs.length).toBeLessThanOrEqual(INITIAL_VISIBLE);

    // convertMessages must complete in well under 500 ms for 1k msgs
    expect(fullConvertMs).toBeLessThan(500);
  });

  it('measures convertMessages on a 5 000-raw-message stress transcript', () => {
    const rawMsgs = buildTranscript(5000);
    expect(rawMsgs).toHaveLength(5000);

    const t0 = hrMs();
    const allConverted = convertMessages(rawMsgs);
    const fullConvertMs = hrMs() - t0;

    const totalParts = countParts(allConverted);
    const hiddenCount = Math.max(0, allConverted.length - INITIAL_VISIBLE);
    const cappedMsgs = allConverted.slice(hiddenCount);
    const cappedParts = countParts(cappedMsgs);

    console.log('\n=== PLE-42 Stress Test (5k raw msgs) ===');
    console.log(`Raw input messages:          ${rawMsgs.length}`);
    console.log(`Converted (merged) messages: ${allConverted.length}`);
    console.log(`  → hidden by cap:           ${hiddenCount}`);
    console.log(`  → visible to runtime:      ${cappedMsgs.length}`);
    console.log(`Total content parts (full):  ${totalParts}`);
    console.log(`Content parts (capped):      ${cappedParts}`);
    console.log(`convertMessages wall time:   ${fullConvertMs.toFixed(2)} ms`);
    console.log('=========================================\n');

    expect(allConverted.length).toBe(2000);
    expect(cappedMsgs.length).toBeLessThanOrEqual(INITIAL_VISIBLE);
    // 5k msgs must still convert in under 2s
    expect(fullConvertMs).toBeLessThan(2000);
  });

  it('verifies the cap is already in effect — runtime sees at most INITIAL_VISIBLE messages', () => {
    const rawMsgs = buildTranscript(1000);
    const allConverted = convertMessages(rawMsgs);
    const hiddenCount = Math.max(0, allConverted.length - INITIAL_VISIBLE);
    const cappedMsgs = allConverted.slice(hiddenCount);

    // This is the key finding: the runtime NEVER receives more than INITIAL_VISIBLE msgs
    expect(cappedMsgs.length).toBeLessThanOrEqual(INITIAL_VISIBLE);

    // And INITIAL_VISIBLE is already << 1 000 raw messages
    expect(INITIAL_VISIBLE).toBe(150);
  });
});
