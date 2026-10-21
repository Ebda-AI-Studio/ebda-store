/**
 * Tier-aware partial return refunds (B2B Task 8b, Rulings B2B-10 / B2B-13), against real Postgres: preview equals confirm,
 * the adjustment flows through the SAME allocation the GL posts (VAT exclusive and inclusive), the provider is called with the
 * adjusted amount, an override is audited on the item, and a line sold before the ladder snapshot refunds unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma, withRlsBypass } from '@ebda/database';
import { ReturnService } from '@api/services/return.service';
import { OrderService } from '@api/services/order.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { allocatePartialReturn } from '@api/services/accounting/posting/partial-return-allocation';
import { hasDb } from '../helpers/bundle-fixtures';

const SUF = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const LADDER = [{ minQty: 100, priceMinor: 80 }];

describe.skipIf(!hasDb)('B2B Task 8b: tier-aware partial returns', () => {
  let storeId = '';
  let customerId = '';
  let productId = '';
  let seq = 0;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `b2brt-o-${SUF}@t.com`,
          passwordHash: 'x',
          role: 'store_admin',
          firstName: 'O',
          lastName: 'W',
        },
      });
      const cust = await tx.user.create({
        data: {
          email: `b2brt-c-${SUF}@t.com`,
          passwordHash: 'x',
          role: 'customer',
          firstName: 'C',
          lastName: 'U',
        },
      });
      customerId = cust.id;
      const store = await tx.store.create({
        data: {
          name: 'b2brt',
          slug: `b2brt-${SUF}`,
          template: 'modern',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      storeId = store.id;
      productId = (
        await tx.product.create({
          data: {
            storeId,
            name: `p-${SUF}`,
            slug: `p-${SUF}`,
            price: 100,
            inventory: 1000,
            trackInventory: true,
            status: 'active',
          },
        })
      ).id;
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await withRlsBypass(async tx => {
      await tx.returnItem.deleteMany({ where: { return: { storeId } } }).catch(() => {});
      await tx.return.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.payment.deleteMany({ where: { order: { storeId } } }).catch(() => {});
      await tx.orderEvent.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.inventoryHistory.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: SUF } } }).catch(() => {});
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** One tier line: 100 units paid at 80 (list 100), ladder [{100, 80}]. `legacy` = sold before B2B (no snapshots). */
  async function makeOrder(o: {
    tax: number;
    inclusive?: boolean;
    legacy?: boolean;
    payment?: number;
  }) {
    const subtotal = 8000;
    const total = o.inclusive ? subtotal : subtotal + o.tax;
    return withRlsBypass(async tx => {
      const order = await tx.order.create({
        data: {
          storeId,
          customerId,
          orderNumber: `B2BRT-${SUF}-${++seq}`,
          status: 'delivered',
          paymentStatus: 'paid',
          subtotal,
          tax: o.tax,
          taxIncludedInPrice: !!o.inclusive,
          total,
          shippingAddress: {},
          billingAddress: {},
          items: {
            create: [
              {
                productId,
                productName: 'tier-product',
                quantity: 100,
                price: 80,
                total: 8000,
                ...(o.legacy
                  ? {}
                  : {
                      listPrice: 100,
                      priceSource: 'tier',
                      priceTierMinQty: 100,
                      tierLadder: LADDER,
                    }),
              },
            ],
          },
        },
        include: { items: true },
      });
      if (o.payment) {
        await tx.payment.create({
          data: {
            orderId: order.id,
            provider: 'paymob',
            status: 'completed',
            amount: o.payment,
            currency: 'EGP',
            transactionId: `b2brt-${SUF}-${seq}`,
          },
        });
      }
      return { orderId: order.id, itemId: order.items[0]!.id, total };
    });
  }
  async function makeReturn(orderId: string, itemId: string, qty: number) {
    return withRlsBypass(tx =>
      tx.return.create({
        data: {
          storeId,
          orderId,
          customerId,
          returnNumber: `RET-B2BRT-${SUF}-${++seq}`,
          type: 'refund',
          status: 'received',
          reason: 'defective',
          refundAmount: qty * 80,
          items: {
            create: [
              { orderItemId: itemId, productId, productName: 'tier-product', quantity: qty },
            ],
          },
        },
        include: { items: true },
      })
    );
  }
  const alloc = (
    o: { tax: number; inclusive?: boolean },
    itemId: string,
    qty: number,
    adj: number
  ) =>
    allocatePartialReturn({
      subtotal: 8000,
      discount: 0,
      tax: o.tax,
      taxIncludedInPrice: !!o.inclusive,
      lines: [{ id: itemId, quantity: 100, price: 80 }],
      prevQty: new Map(),
      requested: [{ orderItemId: itemId, quantity: qty }],
      thisAdjustment: adj,
    });

  it('preview equals confirm: return 90 of 100 @ 80 -> kept 10 repriced at list, adjustment 200, VAT exclusive follows the adjusted value', async () => {
    const o = await makeOrder({ tax: 1120 });
    const ret = await makeReturn(o.orderId, o.itemId, 90);
    const preview = await ReturnService.refundPreview(storeId, ret.id);
    expect(preview.lines[0]).toMatchObject({
      standardRefund: 7200,
      adjustment: 200,
      adjustedRefund: 7000,
      shortfall: 0,
      keptQty: 10,
      keptUnitMinor: 100,
      reason: 'kept_below_tier',
    });
    const expected = alloc({ tax: 1120 }, o.itemId, 90, 200).cashCredit; // 7000 + 980 VAT share
    expect(expected).toBe(7980);
    expect(preview.recordedAmount).toBe(expected);
    vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    const done = await ReturnService.complete(storeId, ret.id, 'staff-1', 'cash');
    expect(done.refundAmount).toBe(preview.recordedAmount);
    const item = await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } });
    expect(item).toMatchObject({ tierAdjustment: 200, adjustmentOverridden: false });
  });

  it('VAT inclusive: the customer is owed the adjusted price and no VAT on top', async () => {
    const o = await makeOrder({ tax: 982, inclusive: true });
    const ret = await makeReturn(o.orderId, o.itemId, 90);
    const preview = await ReturnService.refundPreview(storeId, ret.id);
    expect(preview.recordedAmount).toBe(7000);
    const a = alloc({ tax: 982, inclusive: true }, o.itemId, 90, 200);
    expect(a.revenueDebit + a.taxThis).toBe(a.cashCredit);
  });

  it('the gateway is called with the ADJUSTED amount and the item-level flag', async () => {
    const o = await makeOrder({ tax: 1120, payment: 9120 });
    const ret = await makeReturn(o.orderId, o.itemId, 90);
    const refund = vi
      .spyOn(PaymentService, 'refund')
      .mockResolvedValue({ refundId: 'r', status: 'pending' } as never);
    vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    await ReturnService.complete(storeId, ret.id, 'staff-1', 'gateway');
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0]![0]).toMatchObject({ amount: 7980, itemLevel: true });
  });

  it('a line sold before the ladder snapshot refunds unchanged (never a guess)', async () => {
    const o = await makeOrder({ tax: 1120, legacy: true });
    const ret = await makeReturn(o.orderId, o.itemId, 90);
    const preview = await ReturnService.refundPreview(storeId, ret.id);
    expect(preview.lines[0]).toMatchObject({ adjustment: 0, adjustedRefund: 7200, reason: 'none' });
    expect(preview.recordedAmount).toBe(alloc({ tax: 1120 }, o.itemId, 90, 0).cashCredit);
  });

  it('override: recorded on the item with actor and reason; range and applicability are enforced', async () => {
    const o = await makeOrder({ tax: 1120 });
    const ret = await makeReturn(o.orderId, o.itemId, 90);
    const itemId = ret.items[0]!.id;
    await expect(
      ReturnService.complete(storeId, ret.id, 'staff-1', 'cash', {
        [itemId]: { amountMinor: 7201, reason: 'goodwill' },
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'OVERRIDE_OUT_OF_RANGE' });
    await expect(
      ReturnService.complete(storeId, ret.id, 'staff-1', 'cash', {
        'not-an-item': { amountMinor: 1, reason: 'goodwill' },
      })
    ).rejects.toMatchObject({ code: 'OVERRIDE_UNKNOWN_ITEM' });
    // the failed attempts released the claim: the return is still completable
    const preview = await ReturnService.refundPreview(storeId, ret.id, {
      [itemId]: { amountMinor: 7100, reason: 'goodwill' },
    });
    expect(preview.lines[0]).toMatchObject({
      adjustment: 100,
      adjustedRefund: 7100,
      overridden: true,
    });
    vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    const done = await ReturnService.complete(storeId, ret.id, 'staff-9', 'cash', {
      [itemId]: { amountMinor: 7100, reason: 'goodwill' },
    });
    expect(done.refundAmount).toBe(alloc({ tax: 1120 }, o.itemId, 90, 100).cashCredit);
    expect(await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } })).toMatchObject(
      {
        tierAdjustment: 100,
        adjustmentOverridden: true,
        adjustmentOverrideReason: 'goodwill',
        adjustmentOverrideBy: 'staff-9',
      }
    );
  });

  it('override is refused on a return that takes back the whole order (nothing to override)', async () => {
    const o = await makeOrder({ tax: 1120 });
    const ret = await makeReturn(o.orderId, o.itemId, 100);
    await expect(
      ReturnService.complete(storeId, ret.id, 'staff-1', 'cash', {
        [ret.items[0]!.id]: { amountMinor: 1, reason: 'goodwill' },
      })
    ).rejects.toMatchObject({ code: 'OVERRIDE_NOT_APPLICABLE' });
  });

  it('cumulative: 10 back (floor bites, nothing retained beyond the 800 refund), then 80 back releases only what was retained; the buyer is never refunded more than paid', async () => {
    const o = await makeOrder({ tax: 0 });
    vi.spyOn(OrderService, 'applyRefundEffects').mockResolvedValue(undefined);
    const r1 = await makeReturn(o.orderId, o.itemId, 10);
    const p1 = await ReturnService.refundPreview(storeId, r1.id);
    expect(p1.lines[0]).toMatchObject({
      standardRefund: 800,
      adjustment: 800,
      adjustedRefund: 0,
      shortfall: 1000,
    });
    await ReturnService.complete(storeId, r1.id, 'staff-1', 'cash');
    const r2 = await makeReturn(o.orderId, o.itemId, 80);
    const p2 = await ReturnService.refundPreview(storeId, r2.id);
    expect(p2.lines[0]).toMatchObject({
      standardRefund: 6400,
      adjustment: -800,
      adjustedRefund: 7200,
    });
    const done2 = await ReturnService.complete(storeId, r2.id, 'staff-1', 'cash');
    const first = await prisma.return.findUniqueOrThrow({ where: { id: r1.id } });
    expect(first.refundAmount + done2.refundAmount).toBe(7200); // 90 units x 80, exactly what was paid for them
  });

  it('the shopper-facing estimate at creation shows the adjusted figure', async () => {
    const o = await makeOrder({ tax: 0 });
    const created = await ReturnService.create(storeId, {
      orderId: o.orderId,
      customerId,
      type: 'refund',
      reason: 'defective',
      items: [{ orderItemId: o.itemId, productId, productName: 'tier-product', quantity: 90 }],
    });
    expect(created.refundAmount).toBe(7000);
  });
});
