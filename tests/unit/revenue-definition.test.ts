// STORE-QA-7: ONE revenue definition. A refunded order must not be sales on any surface.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NON_REVENUE_ORDER_STATUSES } from '@ebda/shared';
import * as api from '../../apps/api/src/lib/revenue-sql';
import * as repo from '../../packages/repo/src/revenue';
import { clampBackfillDays } from '../../apps/api/src/lib/inngest/functions/analytics-funnel-backfill';
import { cairoDaysAgo } from '../../apps/api/src/lib/inngest/functions/analytics-refund-correction';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('the two copies of the definition', () => {
  it('are byte-equal (the API must not import packages/repo statically)', () => {
    expect(read('apps/api/src/lib/revenue-sql.ts')).toBe(read('packages/repo/src/revenue.ts'));
  });
  it('exclude exactly the statuses @ebda/shared declares as non-revenue', () => {
    expect([...api.NON_REVENUE_ORDER_STATUSES]).toEqual([...NON_REVENUE_ORDER_STATUSES]);
  });
});

describe('netOrderRevenueMinor', () => {
  const o = { total: 4850, status: 'delivered', paymentStatus: 'paid' };
  it('a full refund (payment refunded, order still delivered) is 0', () => {
    expect(api.netOrderRevenueMinor({ ...o, paymentStatus: 'refunded' })).toBe(0);
  });
  it('a refunded / cancelled / failed / unconfirmed order is 0', () => {
    for (const status of ['refunded', 'cancelled', 'awaiting_payment_confirmation'])
      expect(api.netOrderRevenueMinor({ ...o, status })).toBe(0);
    expect(api.netOrderRevenueMinor({ ...o, paymentStatus: 'failed' })).toBe(0);
  });
  it('a partial refund is netted and never goes below 0', () => {
    expect(api.netOrderRevenueMinor({ ...o, refundedMinor: 1850 })).toBe(3000);
    expect(api.netOrderRevenueMinor({ ...o, refundedMinor: 999999 })).toBe(0);
    expect(api.netOrderRevenueMinor(o)).toBe(4850);
  });
});

describe('SQL fragments', () => {
  it('the predicate excludes refunded payments and the non-revenue statuses', () => {
    const sql = api.revenueOrderPredicateSql('o');
    expect(sql).toContain("o.payment_status NOT IN ('failed', 'refunded')");
    expect(sql).toContain(
      "o.status NOT IN ('cancelled', 'refunded', 'awaiting_payment_confirmation')"
    );
    expect(api.revenueOrderPredicateSql('o', { paidOnly: true })).toContain(
      "o.payment_status = 'paid'"
    );
  });
  it('net revenue subtracts the capped refund, per dialect', () => {
    expect(api.orderNetRevenueSql('o', 'pg')).toMatch(/LEAST\(o\.total, GREATEST\(/);
    expect(api.orderNetRevenueSql('o', 'pg')).toContain('public.returns');
    expect(api.orderNetRevenueSql('o', 'sqlite')).toMatch(/MIN\(o\.total, MAX\(/);
    expect(api.orderNetRevenueSql('o', 'sqlite')).not.toContain('public.');
  });
});

describe('every revenue surface uses the shared definition (grep guard)', () => {
  // file -> the shared symbol it must import. A new revenue aggregation that bypasses the definition is a failure here.
  const SURFACES: Record<string, RegExp> = {
    'apps/api/src/services/analytics.service.ts': /lib\/revenue-sql/,
    'apps/api/src/services/revenue.service.ts': /lib\/revenue-sql/,
    'apps/api/src/services/store.service.ts': /revenue\.service/,
    'apps/api/src/services/provisioning.service.ts': /revenue\.service/,
    'apps/api/src/routes/admin.routes.ts': /revenue\.service/,
    'apps/api/src/routes/insights.routes.ts': /revenue\.service/,
    'apps/api/src/services/accounting/analytics-rollup.service.ts': /revenue\.service/,
    'apps/api/src/services/abandoned-cart.service.ts': /lib\/revenue-sql/,
    'apps/api/src/services/customer-aggregate.service.ts': /lib\/revenue-sql/,
    'apps/api/src/lib/inngest/functions/store-usage-snapshot.ts': /revenue-sql/,
    'packages/repo/src/do/analytics-reads.ts': /\.\.\/revenue/,
    'packages/repo/src/do/job-ops-b.ts': /\.\.\/revenue/,
  };
  it.each(Object.entries(SURFACES))('%s imports the definition', (file, re) => {
    expect(read(file)).toMatch(re);
  });

  it('no revenue source file still carries the pre-fix population (payment_status <> failed only)', () => {
    const STALE = [/payment_status\s*<>\s*'failed'/, /paymentStatus:\s*\{\s*not:\s*'failed'/];
    for (const file of Object.keys(SURFACES)) {
      if (file.endsWith('revenue-sql.ts')) continue;
      const src = read(file);
      for (const re of STALE) expect(src, `${file} matches ${re}`).not.toMatch(re);
    }
  });

  it('the paid-only surfaces no longer hand-roll their own status list', () => {
    expect(read('apps/api/src/lib/inngest/functions/store-usage-snapshot.ts')).not.toContain(
      "AND o.status NOT IN ('cancelled', 'refunded')) AS revenue_fils"
    );
    expect(read('packages/repo/src/do/job-ops-b.ts')).not.toMatch(
      /payment_status = 'paid' AND status NOT IN \('cancelled', 'refunded'\)/
    );
  });
});

describe('refund correction of a closed rollup day', () => {
  it('names the Cairo day the order was placed in, counted back from today', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    expect(cairoDaysAgo(new Date('2026-11-18T09:00:00Z'), now)).toBe(1);
    expect(cairoDaysAgo(new Date('2026-10-01T09:00:00Z'), now)).toBe(49);
    expect(cairoDaysAgo(new Date('2026-11-19T09:00:00Z'), now)).toBe(0);
  });
  it('is registered as an order/refunded consumer and recomputes through runFunnelRollup', () => {
    const src = read('apps/api/src/lib/inngest/functions/analytics-refund-correction.ts');
    expect(src).toContain("event: 'order/refunded'");
    expect(src).toContain('runFunnelRollup(storeId, daysAgo, daysAgo)');
    expect(read('apps/api/src/lib/inngest/functions/index.ts')).toContain(
      'analyticsRefundCorrection'
    );
  });
});

describe('refund allocation to lines', () => {
  it('is pro rata, adds back to total minus refund exactly, and never goes negative', () => {
    const lines = [1000, 2000];
    const net = api.allocateRefundToLines(lines, 1000);
    expect(net).toEqual([667, 1333]);
    expect(net.reduce((a, b) => a + b, 0)).toBe(2000);
    for (const [ls, r] of [
      [[333, 333, 334], 100],
      [[1, 1, 1], 2],
      [[500], 500],
    ] as Array<[number[], number]>) {
      const n = api.allocateRefundToLines(ls, r);
      expect(n.reduce((a, b) => a + b, 0)).toBe(ls.reduce((a, b) => a + b, 0) - r);
      expect(Math.min(...n)).toBeGreaterThanOrEqual(0);
    }
    expect(api.allocateRefundToLines([100, 200], 0)).toEqual([100, 200]);
  });
});

describe('funnel backfill', () => {
  it('clamps the window and is dry-run by default', () => {
    expect(clampBackfillDays(undefined)).toBe(90);
    expect(clampBackfillDays(0)).toBe(1);
    expect(clampBackfillDays(99999)).toBe(400);
    const src = read('apps/api/src/lib/inngest/functions/analytics-funnel-backfill.ts');
    expect(src).toContain('if (apply !== true)');
    expect(read('apps/api/src/lib/inngest/functions/index.ts')).toContain(
      'analyticsFunnelBackfill'
    );
  });
});

describe('reconciliation uses the definition (detector for an unreversed refund journal)', () => {
  it('compares gross, paid-only net-sales population against the GL credits', () => {
    const src = read('apps/api/src/lib/inngest/functions/accounting-period-reconciliation.ts');
    expect(src).toContain('netRevenue(store.id, { from: since, paidOnly: true, gross: true })');
    expect(src).not.toMatch(/notIn: \['cancelled'/);
  });
});
