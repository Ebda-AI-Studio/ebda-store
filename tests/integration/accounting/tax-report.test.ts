/**
 * Integration test for generateTaxReport.
 *
 * Seeds a real store + COA + paid orders (some with tax, some without),
 * posts order journals via postOrderPaymentJournal, then asserts that
 * generateTaxReport returns the correct transaction rows and summary totals.
 *
 * Requires a live Postgres instance (DATABASE_URL env var).
 * Runs sequentially via vitest pool:forks + maxWorkers:1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { postOrderPaymentJournal } from '../../../apps/api/src/services/accounting/posting/order-posting';
import { generateTaxReport } from '../../../apps/api/src/services/accounting/tax-report.service';

const OWNER_ID = '00000000-0000-0000-0000-000000001234';
let storeId: string;
let productId: string;

// Orders seeded by this test suite, keyed by slug
const orderIds: Record<string, string> = {};

beforeAll(async () => {
  // ── User ─────────────────────────────────────────────────────────────────
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: `tax-report-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Tax',
      lastName: 'Report',
    },
  });

  // ── Store ────────────────────────────────────────────────────────────────
  const store = await prisma.store.create({
    data: {
      name: `tax-report-store-${Date.now()}`,
      slug: `tax-report-store-${Date.now()}`,
      ownerId: OWNER_ID,
      accountingEnabled: true,
    },
  });
  storeId = store.id;
  await seedCoaForStore(storeId);

  // ── Product ──────────────────────────────────────────────────────────────
  const product = await prisma.product.create({
    data: {
      storeId,
      name: 'Tax Report Test Product',
      slug: `tax-report-product-${Date.now()}`,
      price: 10_000, // 10 EGP
      inventory: 100,
      status: 'active',
    },
  });
  productId = product.id;

  // ─────────────────────────────────────────────────────────────────────────
  // Seed orders
  //
  // Order A: 10 EGP subtotal, 5% VAT = 500 piastres tax (paid, in-period)
  // Order B: 20 EGP subtotal, 5% VAT = 1000 piastres tax, 500 discount
  //          → taxable base = 20k - 0 discount on order level... wait,
  //          the GL posts order.subtotal and order.tax directly.
  //          taxable base in the report = subtotal - discount.
  //          Let's make: subtotal=20000, discount=0, tax=1000 → taxable=20000.
  // Order C: no tax (tax=0) — must NOT appear in the report
  // Order D: 15 EGP subtotal, 10% VAT = 1500 piastres tax (different rate)
  // Order E: 8 EGP subtotal, 5% VAT = 400 piastres, but paid OUTSIDE the report period
  //          → should NOT appear when period filter is applied

  const ts = Date.now();

  async function seedOrder(opts: {
    key: string;
    num: string;
    subtotal: number;
    tax: number;
    discount: number;
    shipping: number;
    paidAt: Date;
    postedAt: Date;
  }) {
    const total = opts.subtotal + opts.tax + opts.shipping - opts.discount;
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: opts.num,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal: opts.subtotal,
        tax: opts.tax,
        shipping: opts.shipping,
        discount: opts.discount,
        total,
        currency: 'EGP',
        shippingAddress: {},
        billingAddress: {},
        items: {
          create: [
            {
              productId,
              productName: 'Tax Report Test Product',
              quantity: 1,
              price: opts.subtotal,
              total: opts.subtotal,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'myfatoorah',
              status: 'completed',
              amount: total,
              paidAt: opts.paidAt,
            },
          ],
        },
      },
    });
    orderIds[opts.key] = order.id;

    // Post journal with a specific postedAt so we can test date filtering
    // We override postedAt by temporarily patching the DB after postEntry.
    // The simpler approach: call postOrderPaymentJournal normally, then
    // update the entry's postedAt to the desired date.
    await postOrderPaymentJournal({ orderId: order.id });

    // Patch postedAt on the 'order' source entry so date-range filtering works
    await prisma.journalEntry.updateMany({
      where: { storeId, source: 'order', sourceId: order.id },
      data: { postedAt: opts.postedAt },
    });
  }

  const inPeriodDate = new Date('2026-03-15T10:00:00.000Z');
  const outOfPeriodDate = new Date('2026-01-05T10:00:00.000Z');

  // A: 5% rate, 10 EGP taxable
  await seedOrder({
    key: 'A',
    num: `TAXRPT-A-${ts}`,
    subtotal: 10_000,
    tax: 500,
    discount: 0,
    shipping: 0,
    paidAt: inPeriodDate,
    postedAt: inPeriodDate,
  });

  // B: 5% rate, 20 EGP taxable
  await seedOrder({
    key: 'B',
    num: `TAXRPT-B-${ts}`,
    subtotal: 20_000,
    tax: 1_000,
    discount: 0,
    shipping: 0,
    paidAt: inPeriodDate,
    postedAt: inPeriodDate,
  });

  // C: 0 tax — must NOT appear in report
  await seedOrder({
    key: 'C',
    num: `TAXRPT-C-${ts}`,
    subtotal: 5_000,
    tax: 0,
    discount: 0,
    shipping: 0,
    paidAt: inPeriodDate,
    postedAt: inPeriodDate,
  });

  // D: 10% rate, 15 EGP taxable
  await seedOrder({
    key: 'D',
    num: `TAXRPT-D-${ts}`,
    subtotal: 15_000,
    tax: 1_500,
    discount: 0,
    shipping: 0,
    paidAt: inPeriodDate,
    postedAt: inPeriodDate,
  });

  // E: 5% rate, but OUTSIDE the query period
  await seedOrder({
    key: 'E',
    num: `TAXRPT-E-${ts}`,
    subtotal: 8_000,
    tax: 400,
    discount: 0,
    shipping: 0,
    paidAt: outOfPeriodDate,
    postedAt: outOfPeriodDate,
  });
});

afterAll(async () => {
  // Clean up in dependency order
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.payment.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: OWNER_ID } });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateTaxReport — integration (real DB)', () => {
  const FROM = new Date('2026-03-01T00:00:00.000Z');
  const TO = new Date('2026-03-31T23:59:59.999Z');

  it('returns only orders with tax > 0 (order C excluded)', async () => {
    const report = await generateTaxReport(storeId, { from: FROM, to: TO });
    const nums = report.rows.map(r => r.orderNumber);

    // Orders A, B, D should appear; C (tax=0) must not
    expect(nums.some(n => n.startsWith('TAXRPT-A'))).toBe(true);
    expect(nums.some(n => n.startsWith('TAXRPT-B'))).toBe(true);
    expect(nums.some(n => n.startsWith('TAXRPT-D'))).toBe(true);
    expect(nums.some(n => n.startsWith('TAXRPT-C'))).toBe(false);
  });

  it('excludes orders outside the date range (order E excluded)', async () => {
    const report = await generateTaxReport(storeId, { from: FROM, to: TO });
    const nums = report.rows.map(r => r.orderNumber);

    expect(nums.some(n => n.startsWith('TAXRPT-E'))).toBe(false);
  });

  it('summary counts and totals are correct', async () => {
    const report = await generateTaxReport(storeId, { from: FROM, to: TO });

    // A: 500 piastres tax, B: 1000 piastres tax, D: 1500 piastres tax
    expect(report.summary.transactionCount).toBe(3);
    expect(report.summary.totalTaxCollected).toBe(3_000); // 500 + 1000 + 1500
    expect(report.summary.totalTaxableSales).toBe(45_000); // 10k + 20k + 15k
  });

  it('by-rate breakdown groups 5% and 10% separately', async () => {
    const report = await generateTaxReport(storeId, { from: FROM, to: TO });
    const { byRate } = report.summary;

    expect(byRate).toHaveLength(2);

    const rate10 = byRate.find(r => r.taxRate === '10.00');
    const rate5 = byRate.find(r => r.taxRate === '5.00');

    expect(rate10).toBeDefined();
    expect(rate10!.transactionCount).toBe(1); // order D
    expect(rate10!.totalTaxCollected).toBe(1_500);
    expect(rate10!.totalSubtotal).toBe(15_000);

    expect(rate5).toBeDefined();
    expect(rate5!.transactionCount).toBe(2); // orders A + B
    expect(rate5!.totalTaxCollected).toBe(1_500); // 500 + 1000
    expect(rate5!.totalSubtotal).toBe(30_000); // 10k + 20k
  });

  it('row-level taxRate string matches computed rate', async () => {
    const report = await generateTaxReport(storeId, { from: FROM, to: TO });

    // Order D: 1500 / 15000 = 10%
    const rowD = report.rows.find(r => r.orderNumber.startsWith('TAXRPT-D'));
    expect(rowD).toBeDefined();
    expect(rowD!.taxRate).toBe('10.00');
    expect(rowD!.taxCollected).toBe(1_500);

    // Orders A: 500 / 10000 = 5%
    const rowA = report.rows.find(r => r.orderNumber.startsWith('TAXRPT-A'));
    expect(rowA).toBeDefined();
    expect(rowA!.taxRate).toBe('5.00');
    expect(rowA!.taxCollected).toBe(500);
  });

  it('returns empty result for a period with no data', async () => {
    const emptyFrom = new Date('2020-01-01');
    const emptyTo = new Date('2020-01-31');
    const report = await generateTaxReport(storeId, { from: emptyFrom, to: emptyTo });

    expect(report.rows).toHaveLength(0);
    expect(report.summary.totalTaxCollected).toBe(0);
    expect(report.summary.byRate).toHaveLength(0);
  });

  it('is tenant-scoped — different store sees 0 rows', async () => {
    const report = await generateTaxReport('00000000-0000-0000-0000-nonexiststore', {
      from: FROM,
      to: TO,
    });
    expect(report.rows).toHaveLength(0);
  });
});
