/**
 * Unit tests for generateTaxReport aggregation logic.
 *
 * The service uses prisma.$queryRawUnsafe, so we mock the @ebda/database
 * module and drive the business logic in-process — no DB required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @ebda/database BEFORE importing the service ─────────────────────
const mockQueryRawUnsafe = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: {
    $queryRawUnsafe: (...args: unknown[]) => mockQueryRawUnsafe(...args),
  },
}));

const mockStoreMoney = vi.fn();
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeMoney: (...a: unknown[]) => mockStoreMoney(...a),
}));

import { generateTaxReport } from '../../apps/api/src/services/accounting/tax-report.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * One aggregated query row — the per-entry shape the SQL returns since the
 * issue-1188 rewrite: `base_delta` is the entry's net Sales Revenue (4000)
 * movement, `tax_delta` its net Tax Payable (2100) movement. Reversal rows
 * carry negative deltas.
 */
function makeRow(overrides: {
  posted_at?: Date;
  order_number?: string;
  customer_name?: string | null;
  tax_delta?: bigint;
  base_delta?: bigint;
  order_total?: bigint;
  is_sale?: boolean;
}) {
  return {
    posted_at: overrides.posted_at ?? new Date('2026-01-15'),
    order_number: overrides.order_number ?? 'ORD-001',
    customer_name: overrides.customer_name ?? 'Ahmad Sharaf',
    tax_delta: overrides.tax_delta ?? BigInt(500), // 5% of 10 EGP
    base_delta: overrides.base_delta ?? BigInt(10_000), // 10 EGP in piastres
    order_total: overrides.order_total ?? BigInt(10_500),
    is_sale: overrides.is_sale ?? true,
  };
}

const STORE_ID = 'store-unit-test-001';
const FROM = new Date('2026-01-01');
const TO = new Date('2026-01-31');

beforeEach(() => {
  mockQueryRawUnsafe.mockReset();
  mockStoreMoney.mockReset();
  mockStoreMoney.mockResolvedValue(null);
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

  it('computes one row correctly — piastres math, taxRate derivation', async () => {
    // 10 EGP taxable, 500 piastres tax = 5% effective rate
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ base_delta: BigInt(10_000), tax_delta: BigInt(500) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.subtotal).toBe(10_000); // taxable base = subtotal - discount (piastres)
    expect(row.taxCollected).toBe(500);
    expect(row.taxRate).toBe('5.00');
    expect(row.orderNumber).toBe('ORD-001');
    expect(row.customerName).toBe('Ahmad Sharaf');
    expect(row.date).toBe('2026-01-15');
  });

  it('uses the entry revenue movement as the taxable base (discount already netted by the GL)', async () => {
    // Sale posted 15 EGP net revenue (20 EGP gross − 5 EGP discount), tax 750 piastres = 5%
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ base_delta: BigInt(15_000), tax_delta: BigInt(750) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    const row = result.rows[0];
    expect(row.subtotal).toBe(15_000); // the entry's net 4000 movement
    expect(row.taxCollected).toBe(750);
    expect(row.taxRate).toBe('5.00');
  });

  it('totals sum all rows correctly — piastres remain integers', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ order_number: 'ORD-001', base_delta: BigInt(10_000), tax_delta: BigInt(500) }),
      makeRow({ order_number: 'ORD-002', base_delta: BigInt(20_000), tax_delta: BigInt(1_000) }),
      makeRow({ order_number: 'ORD-003', base_delta: BigInt(5_000), tax_delta: BigInt(250) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.summary.transactionCount).toBe(3);
    expect(result.summary.totalTaxableSales).toBe(35_000); // 10k + 20k + 5k
    expect(result.summary.totalTaxCollected).toBe(1_750); // 500 + 1000 + 250
  });

  it('groups by-rate breakdown — single rate', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ order_number: 'ORD-001', base_delta: BigInt(10_000), tax_delta: BigInt(500) }),
      makeRow({ order_number: 'ORD-002', base_delta: BigInt(20_000), tax_delta: BigInt(1_000) }),
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
      // 5% rate: 10 EGP taxable, 500 piastres tax
      makeRow({ order_number: 'ORD-001', base_delta: BigInt(10_000), tax_delta: BigInt(500) }),
      // 10% rate: 20 EGP taxable, 2000 piastres tax
      makeRow({ order_number: 'ORD-002', base_delta: BigInt(20_000), tax_delta: BigInt(2_000) }),
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
    // Edge: an entry that moved tax but no revenue (shouldn't happen but guard it)
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ base_delta: BigInt(0), tax_delta: BigInt(100) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    // Should not throw; rate is 0.00
    expect(result.rows[0].taxRate).toBe('0.00');
  });

  it('nets refund/partial-return reversal rows into the summary (issue 1188)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      // Sale: 8 EGP net revenue, 900 piastres tax
      makeRow({ order_number: 'ORD-001', base_delta: BigInt(8_000), tax_delta: BigInt(900) }),
      // Partial-return adjustment: negative deltas, same effective rate
      makeRow({ order_number: 'ORD-001', base_delta: BigInt(-1_778), tax_delta: BigInt(-200) }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.rows).toHaveLength(2);
    const reversal = result.rows[1];
    expect(reversal.taxCollected).toBe(-200);
    expect(reversal.subtotal).toBe(-1_778);
    // Negative/negative → the same positive rate bucket as the sale
    expect(reversal.taxRate).toBe('11.25');
    expect(result.summary.totalTaxCollected).toBe(700); // 900 − 200
    expect(result.summary.totalTaxableSales).toBe(6_222); // 8000 − 1778
    expect(result.summary.byRate).toHaveLength(1); // both rows in the 11.25 bucket
  });

  // #1253 — every row of an order carried the full order total and the same
  // order number, with nothing to tell the sale from its refund/return rows,
  // so summing the exported Order Total column counted an order once per
  // journal entry (a sold, partly returned, then refunded 9.400 order read as
  // 37.600).
  it('marks the sale row and its reversal rows, and carries the order total on the sale only', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ base_delta: BigInt(8_000), tax_delta: BigInt(900), order_total: BigInt(9_400) }),
      makeRow({
        base_delta: BigInt(-1_778),
        tax_delta: BigInt(-200),
        order_total: BigInt(9_400),
        is_sale: false,
      }),
      makeRow({
        base_delta: BigInt(-6_222),
        tax_delta: BigInt(-700),
        order_total: BigInt(9_400),
        is_sale: false,
      }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.rows.map(r => r.kind)).toEqual(['sale', 'reversal', 'reversal']);
    expect(result.rows.map(r => r.total)).toEqual([9_400, null, null]);
    expect(result.rows.reduce((s, r) => s + (r.total ?? 0), 0)).toBe(9_400);
    // The netted tax figures are unchanged by this.
    expect(result.summary.totalTaxCollected).toBe(0);
    expect(result.summary.transactionCount).toBe(3);
  });

  // #1208 — the merchant-facing count is ORDERS; the entry count (sales plus
  // their refund/return rows) is kept alongside it.
  it('counts distinct orders separately from journal entries', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ order_number: 'ORD-9', base_delta: BigInt(8_000), tax_delta: BigInt(900) }),
      makeRow({
        order_number: 'ORD-9',
        base_delta: BigInt(-1_778),
        tax_delta: BigInt(-200),
        is_sale: false,
      }),
      makeRow({
        order_number: 'ORD-9',
        base_delta: BigInt(-8_000),
        tax_delta: BigInt(-900),
        is_sale: false,
      }),
      makeRow({ order_number: 'ORD-10' }),
    ]);

    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(result.rows.map(r => r.kind)).toEqual(['sale', 'reversal', 'reversal', 'sale']);
    expect(result.rows.map(r => r.total)).toEqual([10_500, null, null, 10_500]);
    expect(result.summary.transactionCount).toBe(4);
    expect(result.summary.orderCount).toBe(2);
  });

  it('asks the database which entry is the sale (sourceId = the order id)', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    await generateTaxReport(STORE_ID, { from: FROM, to: TO });
    const sql = mockQueryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toMatch(/\(e\.source_id = o\.id\) AS is_sale/);
  });

  it('row.date is the posting day in the store time zone (Ruling FRT-1)', async () => {
    // Cairo in January is UTC+2 (DST only runs late April → late October):
    // Jan 1 00:00 local = Dec 31 22:00Z; Jan 31 23:59 local = Jan 31 21:59Z.
    const startOfMonth = new Date('2025-12-31T22:00:00.000Z');
    const endOfMonth = new Date('2026-01-31T21:59:59.999Z');
    const nextMonthKw = new Date('2026-01-31T22:30:00.000Z'); // 00:30 Feb 1 in Cairo
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ posted_at: startOfMonth, order_number: 'ORD-START' }),
      makeRow({ posted_at: endOfMonth, order_number: 'ORD-END' }),
      makeRow({ posted_at: nextMonthKw, order_number: 'ORD-NEXT' }),
    ]);

    const result = await generateTaxReport(STORE_ID, {
      from: FROM,
      to: TO,
      timeZone: 'Africa/Cairo',
    });

    expect(result.rows.map(r => r.date)).toEqual(['2026-01-01', '2026-01-31', '2026-02-01']);
  });

  it('row.date defaults to Africa/Cairo when no zone is passed', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([
      makeRow({ posted_at: new Date('2026-01-31T22:30:00.000Z') }),
    ]);
    const result = await generateTaxReport(STORE_ID, { from: FROM, to: TO });
    expect(result.rows[0].date).toBe('2026-02-01');
  });

  it('passes storeId + ISO-string from/to as positional params to queryRawUnsafe', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);

    await generateTaxReport(STORE_ID, { from: FROM, to: TO });

    expect(mockQueryRawUnsafe).toHaveBeenCalledOnce();
    const [sql, sid, f, t] = mockQueryRawUnsafe.mock.calls[0];
    expect(typeof sql).toBe('string');
    expect(sql).toContain("code = '2100'");
    expect(sid).toBe(STORE_ID);
    // Dates are serialized to ISO strings — Prisma 6.19 $queryRawUnsafe
    // rejects raw JS Date objects.
    expect(f).toBe(FROM.toISOString());
    expect(t).toBe(TO.toISOString());
  });
});

describe('generateTaxReport on a Durable Object store (Ruling NZ-ACCT-1)', () => {
  const WIN = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-01-31T23:59:59Z') };
  const line = (o: Record<string, unknown>) => ({
    postedAtMs: Date.parse('2026-01-15T10:00:00Z'),
    orderNumber: 'ORD-9',
    customerName: 'Mona Ali',
    taxDelta: 140,
    baseDelta: 1000,
    orderTotal: 1140,
    isSale: true,
    ...o,
  });

  it('reads the DO op with the window in ms and never touches Postgres', async () => {
    const taxReportLines = vi.fn().mockResolvedValue([line({})]);
    mockStoreMoney.mockResolvedValue({ taxReportLines });
    const r = await generateTaxReport('s1', { ...WIN, timeZone: 'UTC' });
    expect(taxReportLines).toHaveBeenCalledWith({
      fromMs: WIN.from.getTime(),
      toMs: WIN.to.getTime(),
    });
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      kind: 'sale',
      orderNumber: 'ORD-9',
      customerName: 'Mona Ali',
      subtotal: 1000,
      taxCollected: 140,
      taxRate: '14.00',
      total: 1140,
    });
  });

  it('an empty window is an empty report, and a reversal row keeps its negative tax with no order total', async () => {
    mockStoreMoney.mockResolvedValue({ taxReportLines: vi.fn().mockResolvedValue([]) });
    const empty = await generateTaxReport('s1', { ...WIN, timeZone: 'UTC' });
    expect(empty.rows).toEqual([]);
    mockStoreMoney.mockResolvedValue({
      taxReportLines: vi
        .fn()
        .mockResolvedValue([
          line({ isSale: false, taxDelta: -140, baseDelta: -1000, customerName: null }),
        ]),
    });
    const rev = await generateTaxReport('s1', { ...WIN, timeZone: 'UTC' });
    expect(rev.rows[0]).toMatchObject({
      kind: 'reversal',
      taxCollected: -140,
      total: null,
      customerName: null,
    });
  });

  it('a DO refusal propagates (never falls back to Postgres)', async () => {
    mockStoreMoney.mockResolvedValue({
      taxReportLines: vi.fn().mockRejectedValue(new Error('DO down')),
    });
    await expect(generateTaxReport('s1', WIN)).rejects.toThrow('DO down');
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });
});
