import { describe, it, expect } from 'vitest';
import { PLAN_BASELINE, STORE_PLANS } from '@force/shared';
import { aiEligiblePlanFilter, isAiEligiblePlan } from '../../apps/api/src/lib/ai-plan-eligibility';

describe('AI plan eligibility', () => {
  it('excludes free from AI spend', () => {
    expect(isAiEligiblePlan('free')).toBe(false);
  });

  it('allows every paid plan', () => {
    for (const plan of ['starter', 'professional', 'enterprise'] as const) {
      expect(isAiEligiblePlan(plan)).toBe(true);
    }
  });

  it('the prisma filter excludes exactly the ineligible plans', () => {
    expect(aiEligiblePlanFilter.plan.notIn).toEqual(['free']);
  });

  it('every plan in STORE_PLANS is classified', () => {
    for (const plan of STORE_PLANS) {
      expect(typeof isAiEligiblePlan(plan)).toBe('boolean');
    }
  });

  // The reason this guard exists: `inventory.basic` gates both AI stock scans
  // AND sits in the `free` baseline (so a lapsed merchant can still view their
  // own stock). The feature key alone therefore cannot keep AI spend off free
  // tenants — if this assertion ever flips, the guard can be deleted.
  it('inventory.basic is in the free baseline, so the feature key alone is insufficient', () => {
    expect(PLAN_BASELINE.free).toContain('inventory.basic');
    expect(isAiEligiblePlan('free')).toBe(false);
  });
});
