/**
 * Unit tests for generateTaxReport aggregation logic.
 *
 * The service uses prisma.$queryRawUnsafe, so we mock the @force/database
 * module and drive the business logic in-process — no DB required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @force/database BEFORE importing the service ─────────────────────
const mockQueryRawUnsafe = vi.fn();
vi.mock('@force/database', () => ({
  prisma: {
    $queryRawUnsafe: (...args: unknown[]) => mockQueryRawUnsafe(...args),
  },
}));

import { generateTaxReport } from '../../apps/api/src/services/accounting/tax-report.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRow(overrides: {
  posted_at?: Date;
  order_number?: string;
  customer_name?: string | null;
  subtotal?: bigint;
  discount?: bigint;
  tax_collected?: bigint;
  order_total?: bigint;
}) {
  return {
    posted_at: overrides.posted_at ?? new Date('2026-01-15'),
    order_number: overrides.order_number ?? 'ORD-001',
    customer_name: overrides.customer_name ?? 'Ahmad Sharaf',
    subtotal: overrides.subtotal ?? BigInt(10_000), // 10 KWD in fils
    discount: overrides.discount ?? BigInt(0),
    tax_collected: overrides.tax_collected ?? BigInt(500), // 5% of 10 KWD
    order_total: overrides.order_total ?? BigInt(10_500),
  };
}

const STORE_ID = 'store-unit-test-001';
const FROM = new Date('2026-01-01');
const TO = new Date('2026-01-31');

beforeEach(() => {
  mockQueryRawUnsafe.mockReset();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('generateTaxReport — basic aggregation', () => {
  it('returns empty result for period with no tax entries', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.rows).toHaveLength(0);
    expect(result.summary.transactionCount).toBe(0);
    expect(result.summary.totalTaxableSales).toBe(0);
    expect(result.summary.totalTaxCollected).toBe(0);
    expect(result.summary.byRate).toHaveLength(0);
  });

  it('computes one row correctly — fils math, taxRate derivation', async () => {
    // 10 KWD taxable, 500 fils tax = 5% effective rate
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ subtotal: BigInt(10_000), discount: BigInt(0), tax_collected: BigInt(500) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.subtotal).toBe(10_000); // taxable base = subtotal - discount (fils)
    expect(row.taxCollected).toBe(500);
    expect(row.taxRate).toBe('5.00');
    expect(row.orderNumber).toBe('ORD-001');
    expect(row.customerName).toBe('Ahmad Sharaf');
    expect(row.date).toBe('2026-01-15');
  });

  it('subtracts discount from subtotal for taxable base', async () => {
    // subtotal 20 KWD, discount 5 KWD → taxable base 15 KWD, tax 750 fils = 5%
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ subtotal: BigInt(20_000), discount: BigInt(5_000), tax_collected: BigInt(750) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    const row = result.rows[0];
    expect(row.subtotal).toBe(15_000); // 20k - 5k discount
    expect(row.taxCollected).toBe(750);
    expect(row.taxRate).toBe('5.00');
  });

  it('totals sum all rows correctly — fils remain integers', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ order_number: 'ORD-001', subtotal: BigInt(10_000), tax_collected: BigInt(500) }),
      makeRow({ order_number: 'ORD-002', subtotal: BigInt(20_000), tax_collected: BigInt(1_000) }),
      makeRow({ order_number: 'ORD-003', subtotal: BigInt(5_000), tax_collected: BigInt(250) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.summary.transactionCount).toBe(3);
    expect(result.summary.totalTaxableSales).toBe(35_000); // 10k + 20k + 5k
    expect(result.summary.totalTaxCollected).toBe(1_750); // 500 + 1000 + 250
  });

  it('groups by-rate breakdown — single rate', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ order_number: 'ORD-001', subtotal: BigInt(10_000), tax_collected: BigInt(500) }),
      makeRow({ order_number: 'ORD-002', subtotal: BigInt(20_000), tax_collected: BigInt(1_000) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.summary.byRate).toHaveLength(1);
    const group = result.summary.byRate[0];
    expect(group.taxRate).toBe('5.00');
    expect(group.transactionCount).toBe(2);
    expect(group.totalSubtotal).toBe(30_000);
    expect(group.totalTaxCollected).toBe(1_500);
  });

  it('groups by-rate breakdown — multi-rate (5% and 10%)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      // 5% rate: 10 KWD taxable, 500 fils tax
      makeRow({ order_number: 'ORD-001', subtotal: BigInt(10_000), tax_collected: BigInt(500) }),
      // 10% rate: 20 KWD taxable, 2000 fils tax
      makeRow({ order_number: 'ORD-002', subtotal: BigInt(20_000), tax_collected: BigInt(2_000) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.summary.byRate).toHaveLength(2);
    // byRate sorted descending by rate
    const [high, low] = result.summary.byRate;
    expect(high.taxRate).toBe('10.00');
    expect(high.totalTaxCollected).toBe(2_000);
    expect(low.taxRate).toBe('5.00');
    expect(low.totalTaxCollected).toBe(500);
  });

  it('handles guest orders (null customer_name)', async () => {
    // Explicitly pass customer_name: null to simulate a guest order
    mockQueryRawUnsafe.mockResolvedValueOnce([
      {
        ...makeRow({}),
        customer_name: null,
      },
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.rows[0].customerName).toBeNull();
  });

  it('zero taxable base yields 0.00% effective rate (no divide-by-zero)', async () => {
    // Edge: subtotal=0 and somehow tax_collected=0 (shouldn't happen but guard it)
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ subtotal: BigInt(0), discount: BigInt(0), tax_collected: BigInt(0) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    // Should not throw; rate is 0.00
    expect(result.rows[0].taxRate).toBe('0.00');
  });

  it('date boundaries are preserved in the row.date field', async () => {
    const startOfMonth = new Date('2026-01-01T00:00:00.000Z');
    const endOfMonth = new Date('2026-01-31T23:59:59.999Z');
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ posted_at: startOfMonth, order_number: 'ORD-START' }),
      makeRow({ posted_at: endOfMonth, order_number: 'ORD-END' }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.rows[0].date).toBe('2026-01-01');
    expect(result.rows[1].date).toBe('2026-01-31');
  });

  it('passes storeId, from, to as positional params to queryRawUnsafe', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);

    await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(mockQueryRawUnsafe).toHaveBeenCalledOnce();
    const [sql, sid, f, t] = mockQueryRawUnsafe.mock.calls[0];
    expect(typeof sql).toBe('string');
    expect(sql).toContain("code = '2100'");
    expect(sid).toBe(STORE_ID);
    expect(f).toBe(FROM);
    expect(t).toBe(TO);
  });
});
