/**
 * Audit M-022 (fix group P09) against REAL Postgres: purchase-order receive is serialised per PO and writes stock
 * relatively. A double click must add the stock once; a customer order decrementing the shelf during a receive must
 * not be overwritten. Real transactions on real connections, no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { createSupplier } from '../../../apps/api/src/services/accounting/supplier.service';
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  cancelPurchaseOrder,
} from '../../../apps/api/src/services/accounting/purchase-order.service';
import { hasDb } from '../../helpers/bundle-fixtures';

const OWNER = '00000000-0000-0000-0000-0000000000ab';
let storeId: string;
let supplierId: string;
const settle = <T>(p: Promise<T>) =>
  p.then(
    v => ({ ok: true as const, v }),
    e => ({ ok: false as const, code: (e as { code?: string }).code })
  );

async function mkProduct(inventory: number) {
  return prisma.product.create({
    data: {
      storeId,
      name: 'PO Race',
      slug: `po-race-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      price: 5000,
      costPrice: 2000,
      inventory,
      status: 'active',
    },
  });
}

describe.skipIf(!hasDb)('P09 PO receive concurrency (real Postgres)', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: OWNER },
      update: {},
      create: {
        id: OWNER,
        email: `po-race-${Date.now()}@x.test`,
        passwordHash: 'x',
        firstName: 'P',
        lastName: 'R',
      },
    });
    const s = await prisma.store.create({
      data: { name: `po-race-${Date.now()}`, slug: `po-race-${Date.now()}`, ownerId: OWNER },
    });
    storeId = s.id;
    await seedCoaForStore(storeId);
    supplierId = (await createSupplier({ storeId, name: 'Race Supplier' })).id;
  });

  afterAll(async () => {
    await prisma.backorderLine.deleteMany({ where: { storeId } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
    await prisma.journalEntry.deleteMany({ where: { storeId } });
    await prisma.sequence.deleteMany({ where: { storeId } });
    await prisma.purchaseOrderItem.deleteMany({ where: { po: { storeId } } });
    await prisma.purchaseOrder.deleteMany({ where: { storeId } });
    await prisma.supplier.deleteMany({ where: { storeId } });
    await prisma.inventoryHistory.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.account.deleteMany({ where: { storeId } });
    await prisma.store.delete({ where: { id: storeId } });
  });

  it('6 concurrent receives of one 10-unit PO add the stock exactly once', async () => {
    const p = await mkProduct(100);
    const po = await createPurchaseOrder({
      storeId,
      supplierId,
      items: [{ productId: p.id, qty: 10, unitCost: 2400 }],
    });
    const res = await Promise.all(
      Array.from({ length: 6 }, () =>
        settle(
          receivePurchaseOrder({
            storeId,
            poId: po.id,
            receipts: [{ poItemId: po.items[0].id, qtyReceived: 10 }],
          })
        )
      )
    );
    expect(res.filter(r => r.ok)).toHaveLength(1);
    expect(
      res
        .filter(r => !r.ok)
        .every(r =>
          ['PO_NOT_RECEIVABLE', 'RECEIVE_EXCEEDS_QTY'].includes((r as { code?: string }).code ?? '')
        )
    ).toBe(true);
    expect((await prisma.product.findUnique({ where: { id: p.id } }))!.inventory).toBe(110);
    const item = await prisma.purchaseOrderItem.findUnique({ where: { id: po.items[0].id } });
    expect(item!.qtyReceived).toBe(10);
    expect(
      await prisma.inventoryHistory.count({
        where: { storeId, productId: p.id, type: 'transfer_in' },
      })
    ).toBe(1);
  });

  it('a stream of customer orders during a receive is not overwritten (relative stock write)', async () => {
    for (let i = 0; i < 10; i++) {
      const p = await mkProduct(100);
      const po = await createPurchaseOrder({
        storeId,
        supplierId,
        items: [{ productId: p.id, qty: 10, unitCost: 2400 }],
      });
      // sales committing back to back while the receive reads, computes and writes
      const sales = (async () => {
        for (let n = 0; n < 25; n++)
          await prisma.product.update({
            where: { id: p.id },
            data: { inventory: { decrement: 1 } },
          });
      })();
      await Promise.all([
        receivePurchaseOrder({
          storeId,
          poId: po.id,
          receipts: [{ poItemId: po.items[0].id, qtyReceived: 10 }],
        }),
        sales,
      ]);
      // 100 on the shelf, 25 sold, 10 received
      expect((await prisma.product.findUnique({ where: { id: p.id } }))!.inventory).toBe(85);
    }
  });

  it('two POs for the SAME product received at once fulfil an open backorder exactly once', async () => {
    for (let n = 0; n < 4; n++) {
      const p = await mkProduct(-5); // 5 units of backorder debt (checkout force-decrements a non-variant line)
      const order = await prisma.order.create({
        data: {
          storeId,
          orderNumber: `BO-${Date.now()}-${n}-${Math.random().toString(36).slice(2, 6)}`,
          status: 'confirmed',
          paymentStatus: 'paid',
          subtotal: 25000,
          total: 25000,
          shippingAddress: {},
          billingAddress: {},
        },
      });
      const oi = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: p.id,
          productName: 'PO Race',
          quantity: 5,
          price: 5000,
          total: 25000,
          costPriceDeferred: true,
        },
      });
      const bo = await prisma.backorderLine.create({
        data: { storeId, orderItemId: oi.id, productId: p.id, qty: 5, stockTaken: 5 },
      });
      const mk = async () =>
        createPurchaseOrder({
          storeId,
          supplierId,
          items: [{ productId: p.id, qty: 5, unitCost: 2400 }],
        });
      const [po1, po2] = await Promise.all([mk(), mk()]);
      const results = await Promise.all(
        [po1, po2].map(po =>
          receivePurchaseOrder({
            storeId,
            poId: po.id,
            receipts: [{ poItemId: po.items[0].id, qtyReceived: 5 }],
          })
        )
      );
      const cleared = results.flatMap(r => r.clearedBackorders).reduce((a, c) => a + c.qty, 0);
      expect(cleared).toBe(5); // the customer's 5 units are cleared once, not twice
      const line = await prisma.backorderLine.findUnique({ where: { id: bo.id } });
      expect(line!.qtyFulfilled).toBe(5);
      // 5 units went to the customer (debt healed to 0), the other PO's 5 reached the shelf
      expect((await prisma.product.findUnique({ where: { id: p.id } }))!.inventory).toBe(5);
    }
  });

  it('cancelling a PO while it is being received never overwrites a received PO', async () => {
    for (let n = 0; n < 6; n++) {
      const p = await mkProduct(10);
      const po = await createPurchaseOrder({
        storeId,
        supplierId,
        items: [{ productId: p.id, qty: 5, unitCost: 2400 }],
      });
      const [rec, can] = await Promise.all([
        settle(
          receivePurchaseOrder({
            storeId,
            poId: po.id,
            receipts: [{ poItemId: po.items[0].id, qtyReceived: 5 }],
          })
        ),
        settle(cancelPurchaseOrder(storeId, po.id)),
      ]);
      const row = await prisma.purchaseOrder.findUnique({ where: { id: po.id } });
      const item = await prisma.purchaseOrderItem.findUnique({ where: { id: po.items[0].id } });
      if (item!.qtyReceived === 5) expect(row!.status).toBe('received'); // stock + AP posted: never "cancelled"
      expect(rec.ok || can.ok).toBe(true);
    }
  });
});
