/**
 * Item-level refund effects for partial returns (adversarial audit P1-2).
 *
 * Before this fix, `ReturnService.complete` on a PARTIAL return either fired
 * the WHOLE-order `order/refunded` fanout (manual refund methods — restoring
 * inventory the customer still holds, reversing the coupon, clawing back the
 * full affiliate commission and loyalty points), or fired NOTHING (gateway
 * partial refunds — physically returned goods never restocked).
 *
 * The fix threads the returned item list + quantities through the
 * `order/refunded` event as `partial: { items, refundKey, refundAmount }`:
 *   - a partial event restores ONLY the listed lines/quantities, idempotent
 *     per refundKey (the Return id);
 *   - whole-order reversals (coupon, affiliate, loyalty, backorder-cancel of
 *     unrelated lines, the refundReversedAt completion stamp, the GL journal
 *     reversal) do NOT run for a partial event;
 *   - a later FULL event (order cancelled/refunded outright) restores only the
 *     REMAINDER — quantities already restored by partial returns are
 *     subtracted, so stock is never invented;
 *   - `ReturnService.create` rejects cumulative over-returning of a line
 *     across multiple return requests;
 *   - `ReturnService.complete` routes: full return → full event (unless the
 *     gateway already fired it), partial return → partial event on BOTH the
 *     manual and the gateway path.
 *
 * DB-direct integration test, mirrors order-created-idempotency.test.ts:
 * seeds with withRlsBypass, unique suffix, cleans up in afterAll, self-skips
 * without a real DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma, withRlsBypass } from '@force/database';
import { handleOrderRefunded } from '@api/lib/inngest/functions/order-refunded';
import { ReturnService } from '@api/services/return.service';
import { OrderService } from '@api/services/order.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const stepStub = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };

describe.skipIf(!hasDb)('partial-return refund effects', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  let storeId: string;
  let customerId: string;
  let orderId: string;
  let productAId: string; // qty 1 on the order
  let productBId: string; // qty 2 on the order
  let itemAId: string;
  let itemBId: string;
  const couponCode = `PRT-${suffix}`;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `prt-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'PRT',
          lastName: 'Owner',
        },
      });
      const customer = await tx.user.create({
        data: {
          email: `prt-cust-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'customer',
          firstName: 'PRT',
          lastName: 'Customer',
        },
      });
      customerId = customer.id;

      const store = await tx.store.create({
        data: {
          name: 'prt-test-store',
          slug: `prt-test-${suffix}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: owner.id,
        },
      });
      storeId = store.id;

      const productA = await tx.product.create({
        data: {
          storeId,
          name: `prt-product-a-${suffix}`,
          slug: `prt-product-a-${suffix}`,
          price: 1000,
          inventory: 10,
          trackInventory: true,
          status: 'active',
        },
      });
      productAId = productA.id;
      const productB = await tx.product.create({
        data: {
          storeId,
          name: `prt-product-b-${suffix}`,
          slug: `prt-product-b-${suffix}`,
          price: 5000,
          inventory: 10,
          trackInventory: true,
          status: 'active',
        },
      });
      productBId = productB.id;

      await tx.coupon.create({
        data: {
          storeId,
          code: couponCode,
          name: 'prt-test-coupon',
          type: 'fixed',
          value: 500,
          usageCount: 1,
          isActive: true,
        },
      });

      const order = await tx.order.create({
        data: {
          storeId,
          customerId,
          orderNumber: `PRT-TEST-${suffix}`,
          status: 'delivered',
          paymentStatus: 'paid',
          couponCode,
          subtotal: 11000,
          total: 10500,
          shippingAddress: {},
          billingAddress: {},
          items: {
            create: [
              {
                productId: productAId,
                productName: 'prt-product-a',
                quantity: 1,
                price: 1000,
                total: 1000,
              },
              {
                productId: productBId,
                productName: 'prt-product-b',
                quantity: 2,
                price: 5000,
                total: 10000,
              },
            ],
          },
        },
        include: { items: true },
      });
      orderId = order.id;
      itemAId = order.items.find(i => i.productId === productAId)!.id;
      itemBId = order.items.find(i => i.productId === productBId)!.id;
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await withRlsBypass(async tx => {
      await tx.inventoryHistory.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.orderEvent.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.returnItem.deleteMany({ where: { return: { storeId } } }).catch(() => {});
      await tx.return.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.payment.deleteMany({ where: { order: { storeId } } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.coupon.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const inv = async (id: string) =>
    (await withRlsBypass(tx => tx.product.findUniqueOrThrow({ where: { id } }))).inventory;
  const couponUsage = async () =>
    (
      await withRlsBypass(tx =>
        tx.coupon.findFirstOrThrow({ where: { storeId, code: couponCode } })
      )
    ).usageCount;

  it('a partial order/refunded event restores only the returned line and no whole-order reversal', async () => {
    await handleOrderRefunded(orderId, storeId, true, false, stepStub, {
      items: [{ orderItemId: itemAId, quantity: 1 }],
      refundKey: `ret-a-${suffix}`,
      refundAmount: 1000,
    });

    expect(await inv(productAId)).toBe(11); // returned line restored
    expect(await inv(productBId)).toBe(10); // kept line untouched
    expect(await couponUsage()).toBe(1); // coupon NOT reversed on a partial

    const order = await withRlsBypass(tx => tx.order.findUniqueOrThrow({ where: { id: orderId } }));
    // A partial return is not a whole-order reversal — the sweep's completion
    // claim must stay unstamped so a later cancel/refund is still swept.
    expect(order.refundReversedAt).toBeNull();
  });

  it('re-delivering the same partial event is a no-op (idempotent per refundKey)', async () => {
    await handleOrderRefunded(orderId, storeId, true, false, stepStub, {
      items: [{ orderItemId: itemAId, quantity: 1 }],
      refundKey: `ret-a-${suffix}`,
      refundAmount: 1000,
    });
    expect(await inv(productAId)).toBe(11);
    expect(await inv(productBId)).toBe(10);
  });

  it('a second partial return (different refundKey) restores its own line once', async () => {
    await handleOrderRefunded(orderId, storeId, true, false, stepStub, {
      items: [{ orderItemId: itemBId, quantity: 1 }],
      refundKey: `ret-b-${suffix}`,
      refundAmount: 5000,
    });
    expect(await inv(productBId)).toBe(11);
  });

  it('a later FULL event restores only the remainder and reverses the coupon exactly once', async () => {
    await handleOrderRefunded(orderId, storeId, true, false, stepStub);

    // Line A (qty 1) was fully restored by the partial — nothing more to add.
    expect(await inv(productAId)).toBe(11);
    // Line B (qty 2): 1 already restored partially, only the remaining 1 now.
    expect(await inv(productBId)).toBe(12);
    expect(await couponUsage()).toBe(0);

    const order = await withRlsBypass(tx => tx.order.findUniqueOrThrow({ where: { id: orderId } }));
    expect(order.refundReversedAt).not.toBeNull();

    // And the full event re-delivered is still a no-op.
    await handleOrderRefunded(orderId, storeId, true, false, stepStub);
    expect(await inv(productAId)).toBe(11);
    expect(await inv(productBId)).toBe(12);
    expect(await couponUsage()).toBe(0);
  });

  it('create() rejects a return whose cumulative quantity exceeds the ordered quantity', async () => {
    // First request for the full qty of line B is fine.
    const first = await ReturnService.create(storeId, {
      orderId,
      customerId,
      type: 'refund',
      reason: 'defective',
      items: [
        { orderItemId: itemBId, productId: productBId, productName: 'prt-product-b', quantity: 2 },
      ],
    });
    expect(first.id).toBeTruthy();

    // A second request for the same line must be rejected — qty already spoken for.
    await expect(
      ReturnService.create(storeId, {
        orderId,
        customerId,
        type: 'refund',
        reason: 'defective',
        items: [
          {
            orderItemId: itemBId,
            productId: productBId,
            productName: 'prt-product-b',
            quantity: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_QUANTITY' });

    // Duplicate line entries inside ONE request must also be summed.
    await expect(
      ReturnService.create(storeId, {
        orderId,
        customerId,
        type: 'refund',
        reason: 'defective',
        items: [
          {
            orderItemId: itemAId,
            productId: productAId,
            productName: 'prt-product-a',
            quantity: 1,
          },
          {
            orderItemId: itemAId,
            productId: productAId,
            productName: 'prt-product-a',
            quantity: 1,
          },
        ],
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_QUANTITY' });

    // Clean up so the routing tests below control their own return rows.
    await withRlsBypass(async tx => {
      await tx.returnItem.deleteMany({ where: { returnId: first.id } });
      await tx.return.deleteMany({ where: { id: first.id } });
    });
  });

  it('complete() with a manual method fires a PARTIAL event for a partial return', async () => {
    const ret = await withRlsBypass(tx =>
      tx.return.create({
        data: {
          storeId,
          orderId,
          customerId,
          returnNumber: `RET-PRT-M-${suffix}`,
          type: 'refund',
          status: 'received',
          reason: 'defective',
          refundAmount: 1000,
          items: {
            create: [
              {
                orderItemId: itemAId,
                productId: productAId,
                productName: 'prt-product-a',
                quantity: 1,
              },
            ],
          },
        },
      })
    );

    const effectsSpy = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);

    await ReturnService.complete(storeId, ret.id, 'test-user', 'cash');

    expect(effectsSpy).toHaveBeenCalledTimes(1);
    const [calledStoreId, calledOrderId, options] = effectsSpy.mock.calls[0];
    expect(calledStoreId).toBe(storeId);
    expect(calledOrderId).toBe(orderId);
    expect(options?.partial).toMatchObject({
      refundKey: ret.id,
      refundAmount: 1000,
      items: [{ orderItemId: itemAId, quantity: 1 }],
    });

    await withRlsBypass(async tx => {
      await tx.returnItem.deleteMany({ where: { returnId: ret.id } });
      await tx.return.deleteMany({ where: { id: ret.id } });
    });
  });

  it('complete() with a GATEWAY method fires a PARTIAL event too (goods restocked)', async () => {
    await withRlsBypass(tx =>
      tx.payment.create({
        data: {
          orderId,
          provider: 'myfatoorah',
          status: 'completed',
          amount: 10500,
          currency: 'KWD',
          transactionId: `prt-txn-${suffix}`,
        },
      })
    );
    const ret = await withRlsBypass(tx =>
      tx.return.create({
        data: {
          storeId,
          orderId,
          customerId,
          returnNumber: `RET-PRT-G-${suffix}`,
          type: 'refund',
          status: 'received',
          reason: 'defective',
          refundAmount: 5000,
          items: {
            create: [
              {
                orderItemId: itemBId,
                productId: productBId,
                productName: 'prt-product-b',
                quantity: 1,
              },
            ],
          },
        },
      })
    );

    const refundSpy = vi
      .spyOn(PaymentService, 'refund')
      .mockResolvedValue({ refundId: 'r1', status: 'pending' } as never);
    const effectsSpy = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);

    await ReturnService.complete(storeId, ret.id, 'test-user', 'gateway');

    expect(refundSpy).toHaveBeenCalledTimes(1);
    // The gateway refund is PARTIAL (5000 < 10500) so PaymentService.refund
    // applied no internal effects — complete() must fire the partial event.
    expect(effectsSpy).toHaveBeenCalledTimes(1);
    const [, , options] = effectsSpy.mock.calls[0];
    expect(options?.partial).toMatchObject({
      refundKey: ret.id,
      refundAmount: 5000,
      items: [{ orderItemId: itemBId, quantity: 1 }],
    });

    await withRlsBypass(async tx => {
      await tx.returnItem.deleteMany({ where: { returnId: ret.id } });
      await tx.return.deleteMany({ where: { id: ret.id } });
    });
  });

  it('complete() on a FULL return with a manual method fires the whole-order event', async () => {
    const ret = await withRlsBypass(tx =>
      tx.return.create({
        data: {
          storeId,
          orderId,
          customerId,
          returnNumber: `RET-PRT-F-${suffix}`,
          type: 'refund',
          status: 'received',
          reason: 'defective',
          refundAmount: 11000,
          items: {
            create: [
              {
                orderItemId: itemAId,
                productId: productAId,
                productName: 'prt-product-a',
                quantity: 1,
              },
              {
                orderItemId: itemBId,
                productId: productBId,
                productName: 'prt-product-b',
                quantity: 2,
              },
            ],
          },
        },
      })
    );

    const effectsSpy = vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);

    await ReturnService.complete(storeId, ret.id, 'test-user', 'cash');

    expect(effectsSpy).toHaveBeenCalledTimes(1);
    const [, , options] = effectsSpy.mock.calls[0];
    // Full return → whole-order semantics, no partial payload.
    expect(options?.partial).toBeUndefined();

    await withRlsBypass(async tx => {
      await tx.returnItem.deleteMany({ where: { returnId: ret.id } });
      await tx.return.deleteMany({ where: { id: ret.id } });
    });
  });
});
