/** grant-plan-d1.mjs (P17): pure decision + SQL builder. The runner is run against production by the controller. */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs ops script
import { planGrant, buildStatements, addInterval } from '../../scripts/ops/grant-plan-d1.mjs';

const plan = { code: 'business', feature_tier: 'enterprise', price_yearly_minor: 8991000 };
const store = { id: 's1', slug: 'x', status: 'active', plan: 'professional', deleted_at: null };
const sub = {
  plan_code: 'growth',
  status: 'trialing',
  billing_interval: 'monthly',
  billing_method: 'instapay',
  current_period_end: 1,
  pending_plan_code: 'business',
  updated_at: 1000,
};
const want = { planCode: 'business', interval: 'yearly' };

describe('planGrant', () => {
  it('grants from a trialing sub and reports what it replaces', () => {
    const d = planGrant({ store, sub, plan, hasPaid: false }, want);
    expect(d.action).toBe('grant');
    expect(d.from).toMatchObject({ plan: 'growth', status: 'trialing', pending: 'business' });
  });
  it('refuses a missing or deleted store, a missing plan and a missing subscription', () => {
    expect(planGrant({ store: undefined, sub, plan }, want)).toEqual({
      action: 'refuse',
      reason: 'store_missing_or_deleted',
    });
    expect(planGrant({ store: { ...store, deleted_at: 5 }, sub, plan }, want).action).toBe(
      'refuse'
    );
    expect(planGrant({ store, sub, plan: undefined }, want)).toEqual({
      action: 'refuse',
      reason: 'plan_not_found',
    });
    expect(planGrant({ store, sub: undefined, plan }, want)).toEqual({
      action: 'refuse',
      reason: 'no_subscription',
    });
  });
  it('is a noop when already on that plan, active, same interval, nothing pending (idempotent re-run)', () => {
    const done = {
      ...sub,
      plan_code: 'business',
      status: 'active',
      billing_interval: 'yearly',
      pending_plan_code: null,
    };
    expect(planGrant({ store, sub: done, plan, hasPaid: false }, want)).toEqual({
      action: 'noop',
      reason: 'already_granted',
    });
  });
  it('refuses to overwrite an active instapay store with payment history', () => {
    const paid = { ...sub, plan_code: 'growth', status: 'active' };
    expect(planGrant({ store, sub: paid, plan, hasPaid: true }, want)).toEqual({
      action: 'refuse',
      reason: 'has_paid_history',
    });
  });
});

describe('buildStatements', () => {
  const now = new Date('2026-11-12T09:45:50.188Z');
  const st: string[] = buildStatements({
    storeId: 's1',
    plan,
    interval: 'yearly',
    now,
    expectedUpdatedAt: 1000,
    reason: "internal test store, owner family, Ahmad 2026-11-12 'q'",
    auditId: 'a1',
  });
  it('period is now -> +1 year (UTC)', () => {
    expect(addInterval(now, 'yearly').toISOString()).toBe('2027-11-12T09:45:50.188Z');
    expect(st[0]).toContain(`current_period_start=${now.getTime()}`);
    expect(st[0]).toContain(`current_period_end=${addInterval(now, 'yearly').getTime()}`);
  });
  it('statement 1 is compare-and-set on updated_at and clears pending/trial', () => {
    expect(st[0]).toContain('IS 1000');
    expect(st[0]).toContain('pending_plan_code=NULL');
    expect(st[0]).toContain('trial_ends_at=NULL');
    expect(st[0]).toContain("billing_method='instapay'");
  });
  it('statements 2 and 3 only write when statement 1 landed (EXISTS on the new updated_at + plan)', () => {
    for (const s of [st[1], st[2]]) {
      expect(s).toContain('EXISTS (SELECT 1 FROM store_subscriptions');
      expect(s).toContain(`updated_at=${now.getTime()}`);
      expect(s).toContain("plan_code='business'");
    }
    expect(st[1]).toContain("plan='enterprise'");
  });
  it('writes NO money row and escapes the audit reason', () => {
    expect(st.join('\n')).not.toMatch(/billing_events/);
    expect(st[2]).toContain('platform_audit_log');
    expect(st[2]).toContain("'q");
    expect(st).toHaveLength(3);
  });
});
