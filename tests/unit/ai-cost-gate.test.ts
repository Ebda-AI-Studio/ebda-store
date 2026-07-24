/**
 * AI cost gate — enforced in the normal unit run (npm run test:unit), so it
 * runs in the existing CI unit job with no new workflow and no live API call.
 *
 * It re-derives each covered feature's prompt from the REAL builder and compares
 * the estimated $/day against the committed baseline. A prompt change that grows
 * the context beyond the budget delta fails HERE — before deploy — which is the
 * whole point ("a prompt change that doubles the context window should not sneak
 * into production"). If an increase is intentional: `npx tsx scripts/ai-cost-baseline.ts`
 * and commit the cost-baseline.json diff in the same PR.
 */
import { describe, it, expect } from 'vitest';
import { AI_COST_FEATURES } from '../../apps/api/src/lib/ai/cost/features';
import {
  evaluateCostGate,
  estimateFeatureCost,
  type FeatureCostInput,
} from '../../apps/api/src/lib/ai/cost/cost';
import baseline from '../../apps/api/src/lib/ai/cost/cost-baseline.json';
import budget from '../../apps/api/src/lib/ai/cost/cost-budget.json';

describe('ai cost gate', () => {
  it('every covered feature has a baseline entry (baseline is in sync with the registry)', () => {
    for (const f of AI_COST_FEATURES) {
      expect(
        (baseline as Record<string, number>)[f.feature],
        `${f.feature} has no cost-baseline.json entry — run: npx tsx scripts/ai-cost-baseline.ts`
      ).toBeGreaterThan(0);
    }
  });

  it('current prompt costs are within budget delta + total (fails on an un-baselined prompt bloat)', () => {
    const result = evaluateCostGate(AI_COST_FEATURES, baseline as Record<string, number>, budget);
    expect(
      result.violations,
      `cost gate violations:\n${result.violations.map(v => '  - ' + v.message).join('\n')}`
    ).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the gate actually bites — a doubled prompt trips the delta rule', () => {
    // Sanity check the gate is not a no-op: synthetically double one feature's prompt.
    const first = AI_COST_FEATURES[0];
    const bloated: FeatureCostInput = { ...first, prompt: first.prompt + first.prompt };
    const before = estimateFeatureCost(first).usdPerDay;
    const after = estimateFeatureCost(bloated).usdPerDay;
    expect(after).toBeGreaterThan(before); // more input tokens -> higher cost
    const result = evaluateCostGate([bloated], baseline as Record<string, number>, budget);
    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.feature === first.feature)).toBe(true);
  });
});
