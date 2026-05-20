import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@force/database';
import { RfmSegment } from '@force/database';

// No Gemini mock needed — analytics-rollup.service.ts does not call Gemini.
// narration is handled by a separate insights-narration service.

import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { runDailyRollup } from '../../../apps/api/src/services/accounting/analytics-rollup.service';

// Isolated OWNER — '...0033' is not used by any other accounting test suite.
const OWNER = '00000000-0000-0000-0000-000000000033';
let storeId: string;
let rollupResult: Awaited<ReturnType<typeof runDailyRollup>>;

// We create 5 customer users so RFM rollup has 5 subjects.
const CUSTOMER_IDS = [
  '00000000-1111-0000-0000-000000000001',
  '00000000-1111-0000-0000-000000000002',
  '00000000-1111-0000-0000-000000000003',
  '00000000-1111-0000-0000-000000000004',
  '00000000-1111-0000-0000-000000000005',
];

beforeAll(
  async () => {
    await prisma.user.upsert({
      where: { id: OWNER },
      update: {},
      create: {
        id: OWNER,
        email: `analytics-rollup-${Date.now()}@x.test`,
        passwordHash: 'x',
        firstName: 'A',
        lastName: 'R',
      },
    });

    const s = await prisma.store.create({
      data: {
        name: `analytics-rollup-test-${Date.now()}`,
        slug: `analytics-rollup-${Date.now()}`,
        ownerId: OWNER,
        aiFeaturesEnabled: true,
      },
    });
    storeId = s.id;
    await seedCoaForStore(storeId);

    // Create 5 customer users scoped to this store.
    // Email uniqueness within a store is enforced by the DB; use per-user unique emails.
    for (let i = 0; i < CUSTOMER_IDS.length; i++) {
      await prisma.user.upsert({
        where: { id: CUSTOMER_IDS[i] },
        update: {},
        create: {
          id: CUSTOMER_IDS[i],
          storeId,
          email: `customer-${i + 1}-${Date.now()}@rollup.test`,
          passwordHash: 'x',
          firstName: `Customer`,
          lastName: `${i + 1}`,
          role: 'customer',
        },
      });
    }

    // Customer 1: order 60 days ago (oldest cohort).
    const date60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    // Customers 2–3: orders 30 days ago.
    const date30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Customers 4–5: orders within last 7 days.
    const date7 = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    const orderDates = [date60, date30, date30, date7, date7];

    for (let i = 0; i < CUSTOMER_IDS.length; i++) {
      await prisma.order.create({
        data: {
          storeId,
          customerId: CUSTOMER_IDS[i],
          orderNumber: `ROLLUP-C${i + 1}-${Date.now()}-${i}`,
          status: 'confirmed',
          paymentStatus: 'paid',
          subtotal: 10000 * (i + 1),
          tax: 0,
          shipping: 0,
          discount: 0,
          total: 10000 * (i + 1),
          currency: 'KWD',
          shippingAddress: { email: `customer-${i + 1}@rollup.test`, phone: `+96599000${i}` },
          billingAddress: {},
          createdAt: orderDates[i],
        },
      });
    }

    // Run the rollup once in beforeAll so all test assertions just read from the DB.
    // The cohort calculation is O(customers × months × offsets) — runs in the hook timeout.
    rollupResult = await runDailyRollup(storeId);
  },
  // 120s hook timeout — cohort rollup over 2-month history × 5 customers
  // generates ~10 snapshot rows with multiple DB round-trips.
  120_000
);

afterAll(async () => {
  await prisma.customerRfmSnapshot.deleteMany({ where: { storeId } });
  await prisma.funnelSnapshot.deleteMany({ where: { storeId } });
  await prisma.customerCohortSnapshot.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  for (const customerId of CUSTOMER_IDS) {
    await prisma.user.deleteMany({ where: { id: customerId } });
  }
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('analytics rollup', () => {
  it('runs all three rollups and returns a valid shape', () => {
    // rollupResult was populated in beforeAll — no async work here.
    expect(rollupResult).toHaveProperty('cohortRows');
    expect(rollupResult).toHaveProperty('funnelDays');
    expect(rollupResult).toHaveProperty('rfmCustomers');
    expect(typeof rollupResult.cohortRows).toBe('number');
    expect(typeof rollupResult.funnelDays).toBe('number');
    expect(typeof rollupResult.rfmCustomers).toBe('number');
  });

  it('writes CustomerCohortSnapshot rows for the seeded order dates', async () => {
    const snapshots = await prisma.customerCohortSnapshot.findMany({ where: { storeId } });
    // 5 paid orders across at least 2 distinct calendar months → ≥2 cohort rows at offset 0.
    // The 60-day-ago order and the 30-day-ago order are in different months, so
    // cohort rollup must produce at least 3 rows total (≥2 cohort months × ≥1 offset each).
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
  });

  it('writes FunnelSnapshot rows covering recent days', async () => {
    const snapshots = await prisma.funnelSnapshot.findMany({ where: { storeId } });
    // runFunnelRollup defaults to daysBack=7 → 7 day-rows.
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
  });

  it('writes CustomerRfmSnapshot rows for all 5 customers with valid segments', async () => {
    const snapshots = await prisma.customerRfmSnapshot.findMany({ where: { storeId } });
    // All 5 seeded customers have paid orders → all 5 must be segmented.
    expect(snapshots.length).toBe(5);

    const validSegments = Object.values(RfmSegment) as string[];
    for (const snap of snapshots) {
      expect(validSegments).toContain(snap.segment);
      // Each snapshot must have a valid rfmScore and non-negative recency.
      expect(snap.rfmScore).toBeGreaterThan(0);
      expect(snap.recencyDays).toBeGreaterThanOrEqual(0);
    }
  });
});
