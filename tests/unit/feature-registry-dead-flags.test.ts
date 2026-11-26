/**
 * F2 (live QA 2026-11-17): a VISIBLE feature that is in no plan baseline shows merchants and super admins
 * "not included" on every plan. Unless something else turns it on, that row is a dead flag. `inventory` (the legacy
 * parent, which gates nothing; the `inventory.*` sub-keys do) said "not included" while every inventory page worked.
 * Every visible feature outside all baselines must be on this list, with the reason it is still a real switch.
 */
import { describe, it, expect } from 'vitest';
import { getVisibleFeatures, PLAN_BASELINE } from '../../packages/shared/src/index';

const OUTSIDE_BASELINES_ON_PURPOSE: Record<string, string> = {
  agent_checkout_open_writes: 'super-admin security escape hatch, never part of a plan',
  merchant_mcp: "derived from the plan's automation flags (getAutomationFlags), not the baseline",
  merchant_mcp_write: "derived from the plan's automation flags, with the merchant's own switch",
  remove_branding: 'plan limit brandingRemoval + sold add-on (Ruling PLANS-1)',
  bundles: 'sold add-on (Ruling PLANS-1); Business baseline lands with #847',
  customer_intelligence: 'owner self-toggle (Ruling CI-10)',
};

describe('feature registry: no dead visible flags (F2)', () => {
  it('every visible feature outside all plan baselines is a listed, real switch', () => {
    const inSomePlan = new Set(Object.values(PLAN_BASELINE).flat() as string[]);
    const outside = getVisibleFeatures()
      .map(f => f.key as string)
      .filter(k => !inSomePlan.has(k));
    const unexplained = outside.filter(k => !(k in OUTSIDE_BASELINES_ON_PURPOSE));
    expect(
      unexplained,
      `visible but in no plan and not explained: ${unexplained.join(', ')}`
    ).toEqual([]);
  });

  it('the legacy `inventory` parent is not shown (the inventory.* sub-features are the gates)', () => {
    expect(getVisibleFeatures().map(f => f.key)).not.toContain('inventory');
  });
});
