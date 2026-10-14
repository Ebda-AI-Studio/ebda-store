/**
 * #618 + #1589 against real Postgres, in the shape production runs them: the
 * order-status-changed / order-refunded Inngest functions call the service
 * inside `runInTenantContext`, and Inngest delivers at least once.
 *
 *  - Duplicate concurrent deliveries must credit (and reverse) the commission
 *    exactly once.
 *  - The commission_recorded / commission_reversed audit rows must exist once
 *    the tenant context has returned (they used to be `void`-ed and raced the
 *    commit).
 *
 * Retry-safe: every fixture is created per test with a per-call unique id.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, runInTenantContext } from '@ebda/database';
import { affiliateService } from '../../apps/api/src/services/affiliate.service';

const OWNER_ID = '00000000-0000-0000-0000-000000006180';
let storeId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER_ID },
    update: {},
    create: {
      id: OWNER_ID,
      email: `aff-race-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'Aff',
      lastName: 'Race',
    },
  });
  const slug = `aff-race-${randomUUID().slice(0, 8)}`;
  const store = await prisma.store.create({ data: { name: slug, slug, ownerId: OWNER_ID } });
  storeId = store.id;
});

async function seedConvertedReferral() {
  const id = randomUUID().slice(0, 8);
  const affiliate = await prisma.affiliate.create({
    data: {
      storeId,
      name: 'Race Affiliate',
      email: `aff-${id}@example.test`,
      referralCode: `race${id}`,
      status: 'approved',
      commissionRate: 10,
    },
  });
  const order = await prisma.order.create({
    data: {
      storeId,
      orderNumber: `AFF-${id}`,
      status: 'delivered',
      paymentStatus: 'paid',
      subtotal: 10_000,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: 10_000,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
    },
  });
  await prisma.affiliateReferral.create({
    data: {
      storeId,
      affiliateId: affiliate.id,
      orderId: order.id,
      referralCode: affiliate.referralCode,
      status: 'converted',
      convertedAt: new Date(),
      cookieExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { affiliateId: affiliate.id, orderId: order.id };
}

const DUPLICATES = 6;

describe('affiliate commission under duplicate Inngest delivery', () => {
  it('credits the commission exactly once and records its audit row', async () => {
    const { affiliateId, orderId } = await seedConvertedReferral();

    const results = await Promise.all(
      Array.from({ length: DUPLICATES }, () =>
        runInTenantContext(storeId, () => affiliateService.processCommission(storeId, orderId))
      )
    );

    expect(results.filter(r => r !== null)).toHaveLength(1);
    const affiliate = await prisma.affiliate.findUniqueOrThrow({ where: { id: affiliateId } });
    expect(affiliate.totalEarned).toBe(1_000); // 10% of 10.000 EGP, once
    expect(affiliate.pendingBalance).toBe(1_000);

    const events = await prisma.affiliateEvent.findMany({
      where: { affiliateId, eventType: 'commission_recorded' },
    });
    expect(events).toHaveLength(1);
  });

  it('reverses the commission exactly once and records its audit row', async () => {
    const { affiliateId, orderId } = await seedConvertedReferral();
    await runInTenantContext(storeId, () => affiliateService.processCommission(storeId, orderId));

    const results = await Promise.all(
      Array.from({ length: DUPLICATES }, () =>
        runInTenantContext(storeId, () => affiliateService.reverseCommission(storeId, orderId))
      )
    );

    expect(results.filter(r => r !== null)).toHaveLength(1);
    const affiliate = await prisma.affiliate.findUniqueOrThrow({ where: { id: affiliateId } });
    expect(affiliate.totalEarned).toBe(0);
    expect(affiliate.pendingBalance).toBe(0);

    const events = await prisma.affiliateEvent.findMany({
      where: { affiliateId, eventType: 'commission_reversed' },
    });
    expect(events).toHaveLength(1);
  });

  it('two concurrent payouts that each fit the balance cannot both be paid out of it', async () => {
    const { affiliateId, orderId } = await seedConvertedReferral();
    await runInTenantContext(storeId, () => affiliateService.processCommission(storeId, orderId));
    // pendingBalance is now 1.000 EGP; ask for 0.600 twice at once.

    const results = await Promise.allSettled(
      [1, 2].map(() =>
        runInTenantContext(storeId, () =>
          affiliateService.createPayout(storeId, affiliateId, { amount: 600 })
        )
      )
    );

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const affiliate = await prisma.affiliate.findUniqueOrThrow({ where: { id: affiliateId } });
    expect(affiliate.pendingBalance).toBe(400);
    expect(affiliate.totalPaid).toBe(600);
    expect(await prisma.affiliatePayout.count({ where: { affiliateId } })).toBe(1);
  });
});
