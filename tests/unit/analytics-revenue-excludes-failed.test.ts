/**
 * issue 2235 (owner 2026-10-01, ruling AUI-1a) — dashboard revenue excludes
 * orders whose payment FAILED; unpaid COD (payment not failed) still counts.
 * The Customers KPI strip reads the same population (countsTowardSpend), so
 * every revenue read here must carry the same predicate, or the two pages
 * disagree again. Source-level sweep: each `status notIn [cancelled,
 * refunded, awaiting_payment_confirmation]` revenue filter must be paired with the failed-payment exclusion.
 * The one deliberate exception is `getRevenueByPaymentStatus`, which is a
 * breakdown BY payment status and must keep showing the failed bucket.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countsTowardSpend } from '@api/services/customer-aggregate.service';

const src = readFileSync(
  join(__dirname, '../../apps/api/src/services/analytics.service.ts'),
  'utf8'
);

describe('revenue population excludes failed payments (issue 2235)', () => {
  it('every Prisma revenue filter outside the payment-status breakdown excludes failed', () => {
    const breakdownAt = src.indexOf('static async getRevenueByPaymentStatus');
    const filters = [
      ...src.matchAll(/status: \{ notIn: \[\.\.\.NON_REVENUE_ORDER_STATUSES\] \},/g),
    ].map(m => m.index!);
    const outside = filters.filter(i => i < breakdownAt || i > breakdownAt + 1500);
    expect(outside.length).toBeGreaterThanOrEqual(4);
    for (const i of outside) {
      expect(src.slice(i, i + 200)).toContain("paymentStatus: { not: 'failed' }");
    }
  });

  it('every raw-SQL revenue filter excludes failed', () => {
    const sqlFilters = [
      ...src.matchAll(
        /status NOT IN \('cancelled', 'refunded', 'awaiting_payment_confirmation'\)/g
      ),
    ].map(m => m.index!);
    expect(sqlFilters.length).toBe(2);
    for (const i of sqlFilters) {
      expect(src.slice(i, i + 120)).toMatch(/payment_status <> 'failed'/);
    }
  });

  // PR 2335 audit P3: the payment-status breakdown keeps failed payments ON
  // PURPOSE; the decision is pinned so it cannot drift silently either way.
  it('the payment-status breakdown deliberately keeps failed payments, and says so', () => {
    const at = src.indexOf('static async getRevenueByPaymentStatus');
    const body = src.slice(at, at + 1200);
    expect(body).not.toContain("paymentStatus: { not: 'failed' }");
    expect(src.slice(at - 600, at)).toMatch(
      /DELIBERATELY the full population, failed payments included/
    );
  });

  it('the Customers KPI uses the same population', () => {
    expect(countsTowardSpend('delivered', 'paid')).toBe(true);
    expect(countsTowardSpend('pending', 'unpaid')).toBe(true); // COD not yet collected
    expect(countsTowardSpend('pending', 'failed')).toBe(false);
    expect(countsTowardSpend('cancelled', 'paid')).toBe(false);
    expect(countsTowardSpend('refunded', 'refunded')).toBe(false);
  });
});
