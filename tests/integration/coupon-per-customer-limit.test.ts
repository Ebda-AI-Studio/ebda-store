/**
 * Per-customer coupon limit for GUESTS (money, 2026-10-25). A one-per-customer coupon used to be unlimited for a guest
 * who left phone and email out, and N concurrent checkouts by one guest all read "0 used". The helper
 * (lib/coupon-per-customer-limit.ts) now refuses an unidentifiable guest and serialises redemptions per identity with a
 * transaction-scoped advisory lock; the redemption insert happens in the same transaction.
 * DB-direct like order-created-idempotency.test.ts; skipped without a real DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, runInTenantContext, withRlsBypass } from '@ebda/database';
import {
  countPriorCouponUses,
  phoneVariants,
} from '../../apps/api/src/lib/coupon-per-customer-limit';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');
const CODE = 'ONCE';

describe.skipIf(!hasDb)('per-customer coupon limit (guests)', () => {
  let storeId: string;
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `cpl-${suffix}@example.com`,
          passwordHash: 'x',
          role: 'store_admin',
          firstName: 'C',
          lastName: 'P',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'cpl',
          slug: `cpl-${suffix}`,
          template: 'qamar',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      storeId = store.id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
    });
  });

  /** One redemption attempt = what OrderService does: lock + count, then insert in the same transaction. */
  const redeem = (address: Record<string, string>, n: string) =>
    runInTenantContext(storeId, () =>
      prisma.$transaction(async tx => {
        const prior = await countPriorCouponUses(tx as never, storeId, CODE, {
          email: address.email,
          phone: address.phone,
        });
        if (prior >= 1) return 'blocked';
        await tx.order.create({
          data: {
            storeId,
            orderNumber: `CPL-${suffix}-${n}`,
            status: 'pending',
            paymentStatus: 'unpaid',
            subtotal: 1000,
            total: 900,
            couponCode: CODE,
            shippingAddress: address,
            billingAddress: address,
          },
        });
        return 'redeemed';
      })
    );

  it('12 concurrent redemptions by ONE guest (phone spelled three ways, email in three cases) -> exactly one wins', async () => {
    const spellings = ['+201012345678', '01012345678', '201012345678'];
    const emails = ['g@x.com', 'G@X.COM', ' g@x.com '];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        redeem({ phone: i % 2 ? spellings[i % 3] : '+201012345678', email: emails[i % 3] }, `a${i}`)
      )
    );
    // The stored phone is what the order stored; the helper matches every spelling of one number.
    expect(results.filter(r => r === 'redeemed').length).toBe(1);
  });

  it('a different guest is allowed; a cancelled order does not count; no contact at all is refused', async () => {
    expect(await redeem({ phone: '+201099998888', email: 'other@x.com' }, 'b1')).toBe('redeemed');
    await withRlsBypass(async tx => {
      await tx.order.updateMany({
        where: { storeId, orderNumber: `CPL-${suffix}-b1` },
        data: { status: 'cancelled' },
      });
    });
    expect(await redeem({ phone: '+201099998888', email: 'other@x.com' }, 'b2')).toBe('redeemed');
    await expect(redeem({}, 'c1')).rejects.toMatchObject({ code: 'COUPON_NEEDS_CONTACT' });
  });

  it('phone spellings: E.164, digits and the local 0 form are one number', () => {
    expect(phoneVariants('01012345678').sort()).toEqual([
      '+201012345678',
      '01012345678',
      '201012345678',
    ]);
  });
});
