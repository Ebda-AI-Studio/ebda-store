/**
 * Admin/manual (phone) orders ENFORCE a coupon's rules by default, with an
 * explicit, recorded store-admin override (owner decision 2026-09-25, #1370,
 * ruling M-OVR-1).
 *
 * Before: `createAdminOrder` checked only the coupon's dates / store-wide
 * limit / minimum, never its targeting, and discounted the WHOLE subtotal —
 * so a scoped or customer-group coupon applied to anything typed into the
 * phone-order form. It also never counted the use toward `usageCount`, while
 * cancelling the order decremented it.
 *
 * Real Postgres, real `OrderService.createAdminOrder`; per-call unique
 * fixtures (retry-safe).
 */
import { describe, it, expect, vi } from 'vitest';
import { withRlsBypass } from '@force/database';
import { OrderService } from '@api/services/order.service';
import {
  handleOrderRefunded,
  ADMIN_COUPON_RESERVE_CUTOVER,
} from '@api/lib/inngest/functions/order-refunded';
import { CouponService } from '@api/services/coupon.service';
import { hasDb, seedBundleStore, DEFAULT_TEST_SHIPPING_ADDRESS } from '../helpers/bundle-fixtures';

const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const ADMIN = { role: 'store_admin' };

async function fixture(coupon: Record<string, unknown> = {}) {
  const suffix = uid();
  const store = await seedBundleStore(suffix);
  return withRlsBypass(async tx => {
    const mk = (n: string, price: number) =>
      tx.product.create({
        data: {
          storeId: store.storeId,
          name: `coupon-${n}-${suffix}`,
          slug: `coupon-${n}-${suffix}`,
          price,
          inventory: 50,
          status: 'active',
        },
      });
    const a = await mk('a', 2000);
    const b = await mk('b', 3000);
    const code = `ADM${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const c = await tx.coupon.create({
      data: {
        storeId: store.storeId,
        code,
        name: 'Admin coupon',
        type: 'percentage',
        value: 10,
        ...coupon,
      },
    });
    return { ...store, a: a.id, b: b.id, code, couponId: c.id };
  });
}

/** Guest shipping identity unique per call — first-order checks key on it. */
function guest() {
  const n = Math.floor(Math.random() * 1e7)
    .toString()
    .padStart(7, '0');
  return { ...DEFAULT_TEST_SHIPPING_ADDRESS, phone: `9656${n}`, email: `g-${uid()}@example.com` };
}

function order(
  fx: Awaited<ReturnType<typeof fixture>>,
  extra: Record<string, unknown> = {},
  actor: { role?: string } = ADMIN,
  shippingAddress: Record<string, unknown> = guest()
) {
  return OrderService.createAdminOrder(
    fx.storeId,
    fx.ownerId,
    {
      shippingAddress,
      items: [
        { productId: fx.a, quantity: 1 },
        { productId: fx.b, quantity: 1 },
      ],
      paymentMethod: 'cod',
      couponCode: fx.code,
      ...extra,
    },
    actor
  );
}

const usage = (couponId: string) =>
  withRlsBypass(tx => tx.coupon.findUniqueOrThrow({ where: { id: couponId } })).then(
    c => c.usageCount
  );

const overrideEvents = (orderId: string) =>
  withRlsBypass(tx => tx.orderEvent.findMany({ where: { orderId, toStatus: 'coupon_override' } }));

describe.skipIf(!hasDb)('admin order coupon rules (#1370)', () => {
  it('a product-scoped coupon discounts only its in-scope lines (was: the whole order)', async () => {
    const fx = await fixture();
    await withRlsBypass(tx =>
      tx.coupon.update({ where: { id: fx.couponId }, data: { scopeProductIds: [fx.a] } })
    );
    const o = await order(fx);
    expect(o.subtotal).toBe(5000);
    expect(o.discount).toBe(200); // 10% of A (2000), not of 5000
    expect(await overrideEvents(o.id)).toHaveLength(0);
  });

  it('rejects a coupon scoped to products the order does not contain', async () => {
    const fx = await fixture();
    await withRlsBypass(async tx => {
      const other = await tx.product.create({
        data: {
          storeId: fx.storeId,
          name: `other-${uid()}`,
          slug: `other-${uid()}`,
          price: 1,
          status: 'active',
        },
      });
      await tx.coupon.update({
        where: { id: fx.couponId },
        data: { scopeProductIds: [other.id] },
      });
    });
    await expect(order(fx)).rejects.toMatchObject({ statusCode: 400, code: 'COUPON_NOT_ELIGIBLE' });
    expect(await usage(fx.couponId)).toBe(0);
  });

  it('rejects a customer-group coupon for a customer outside the group', async () => {
    const fx = await fixture();
    await withRlsBypass(async tx => {
      const g = await tx.customerGroup.create({ data: { storeId: fx.storeId, name: 'VIP' } });
      await tx.coupon.update({ where: { id: fx.couponId }, data: { customerGroupId: g.id } });
    });
    await expect(order(fx)).rejects.toMatchObject({ code: 'COUPON_NOT_ELIGIBLE' });
  });

  it('rejects a first-order coupon for a returning customer', async () => {
    const fx = await fixture({ firstOrderOnly: true });
    const who = guest();
    await order(fx, { couponCode: undefined }, ADMIN, who); // their first order, no coupon
    await expect(order(fx, {}, ADMIN, who)).rejects.toMatchObject({ code: 'COUPON_NOT_ELIGIBLE' });
  });

  it('enforces dates and the store-wide usage limit, and counts each use', async () => {
    const expired = await fixture({ expiresAt: new Date(Date.now() - 60_000) });
    await expect(order(expired)).rejects.toMatchObject({ code: 'COUPON_EXPIRED' });

    const limited = await fixture({ usageLimit: 1 });
    await order(limited);
    expect(await usage(limited.couponId)).toBe(1); // admin orders now count
    await expect(order(limited)).rejects.toMatchObject({ code: 'COUPON_LIMIT_REACHED' });
    expect(await usage(limited.couponId)).toBe(1);
  });

  it('the atomic reservation refuses a use the rules pre-check let through (a concurrent redemption landed in between)', async () => {
    // The pre-check reads usageCount OUTSIDE the order transaction, so two
    // admin orders racing on a last-use coupon can both pass it. Only the
    // `usageCount < usageLimit` guard on the in-tx reservation stops the second
    // one. Simulate the losing side of that race deterministically: the limit
    // is already reached, but the pre-check reports no violation.
    const fx = await fixture({ usageLimit: 1 });
    await withRlsBypass(tx =>
      tx.coupon.update({ where: { id: fx.couponId }, data: { usageCount: 1 } })
    );
    const spy = vi.spyOn(CouponService, 'adminOrderCouponViolations').mockReturnValue([]);
    try {
      await expect(order(fx)).rejects.toMatchObject({ code: 'COUPON_LIMIT_REACHED' });
    } finally {
      spy.mockRestore();
    }
    expect(await usage(fx.couponId)).toBe(1);
  });

  it('store admin override: applies the coupon, records who and why (event + audit log)', async () => {
    const fx = await fixture({ expiresAt: new Date(Date.now() - 60_000), usageLimit: 1 });
    await withRlsBypass(tx =>
      tx.coupon.update({ where: { id: fx.couponId }, data: { usageCount: 1 } })
    );
    const o = await order(fx, {
      overrideCouponRules: true,
      couponOverrideReason: 'Loyal customer, owner approved on the phone',
    });
    expect(o.discount).toBe(500); // 10% of 5000
    expect(o.couponCode).toBe(fx.code);
    expect(await usage(fx.couponId)).toBe(2); // the use still counts

    const events = await overrideEvents(o.id);
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(fx.ownerId);
    expect(events[0].metadata).toMatchObject({
      couponCode: fx.code,
      reason: 'Loyal customer, owner approved on the phone',
      actorRole: 'store_admin',
      violations: ['COUPON_EXPIRED', 'COUPON_LIMIT_REACHED'],
      discount: 500,
    });
    const audit = await withRlsBypass(tx =>
      tx.auditLog.findFirst({ where: { resourceId: o.id, action: 'order.coupon_override' } })
    );
    expect(audit).toMatchObject({ userId: fx.ownerId, storeId: fx.storeId });
    expect(audit!.details).toMatchObject({
      description: 'Loyal customer, owner approved on the phone',
    });
  });

  it('override of a scope miss applies the coupon to the whole order', async () => {
    const fx = await fixture();
    await withRlsBypass(tx =>
      tx.coupon.update({
        where: { id: fx.couponId },
        data: { scopeCategoryIds: ['00000000-0000-0000-0000-00000000c0de'] },
      })
    );
    const o = await order(fx, { overrideCouponRules: true, couponOverrideReason: 'goodwill' });
    expect(o.discount).toBe(500);
  });

  it('staff cannot override (403), and nothing is written', async () => {
    const fx = await fixture({ expiresAt: new Date(Date.now() - 60_000) });
    const before = await withRlsBypass(tx => tx.order.count({ where: { storeId: fx.storeId } }));
    await expect(
      order(fx, { overrideCouponRules: true, couponOverrideReason: 'please' }, { role: 'staff' })
    ).rejects.toMatchObject({ statusCode: 403, code: 'COUPON_OVERRIDE_FORBIDDEN' });
    expect(await withRlsBypass(tx => tx.order.count({ where: { storeId: fx.storeId } }))).toBe(
      before
    );
    expect(await usage(fx.couponId)).toBe(0);
  });

  it('an override needs a reason', async () => {
    const fx = await fixture();
    await expect(order(fx, { overrideCouponRules: true })).rejects.toMatchObject({
      statusCode: 400,
      code: 'COUPON_OVERRIDE_REASON_REQUIRED',
    });
  });

  it('an override never revives a coupon the merchant switched off', async () => {
    const fx = await fixture({ isActive: false });
    await expect(
      order(fx, { overrideCouponRules: true, couponOverrideReason: 'try anyway' })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

// issue 2303 — an admin order created BEFORE admin orders reserved their
// coupon never incremented usageCount, so its cancel must not decrement:
// that handed another customer's live redemption back to the limit.
describe.skipIf(!hasDb)('cancelling a pre-cutover admin order (issue 2303)', () => {
  const stepStub = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };
  const before = new Date(ADMIN_COUPON_RESERVE_CUTOVER.getTime() - 86_400_000);

  it('does not give back a redemption the order never took', async () => {
    const fx = await fixture();
    const o = await order(fx);
    // Recreate the pre-cutover state: the order is older than the cutover and
    // its create did not count — the 3 uses on the coupon are other customers'.
    await withRlsBypass(async tx => {
      await tx.order.update({ where: { id: o.id }, data: { createdAt: before } });
      await tx.coupon.update({ where: { id: fx.couponId }, data: { usageCount: 3 } });
      await tx.auditLog.create({
        data: { action: 'order.admin_created', resourceType: 'order', resourceId: o.id },
      });
    });

    await handleOrderRefunded(o.id, fx.storeId, false, false, stepStub);
    expect(await usage(fx.couponId)).toBe(3);
    // Redelivery is a no-op too.
    await handleOrderRefunded(o.id, fx.storeId, false, false, stepStub);
    expect(await usage(fx.couponId)).toBe(3);
  });

  it('a post-cutover admin order reserved its use, so its cancel gives it back', async () => {
    const fx = await fixture();
    const o = await order(fx);
    expect(await usage(fx.couponId)).toBe(1);
    await handleOrderRefunded(o.id, fx.storeId, false, false, stepStub);
    expect(await usage(fx.couponId)).toBe(0);
  });
});
