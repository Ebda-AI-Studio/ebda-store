/**
 * Barcode scan on a real DB: (1) two scanners racing the same order line never over-pick it;
 * (2) a cycle-count reconcile posts a DELTA, so a sale that lands between the scan and the
 * reconcile is preserved (counted - system at scan time, applied as an atomic increment).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import {
  pickOrderItemByBarcode,
  openCountSession,
  submitCountLine,
  closeCountSession,
  reconcileCountSession,
} from '../../apps/api/src/services/barcode-scan.service';

describe('barcode pick + count: concurrency', () => {
  let storeId: string;
  let userId: string;
  const tag = `bpc-${Date.now()}`;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `${tag}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'Bar',
        lastName: 'Code',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    userId = user.id;
    storeId = (
      await prisma.store.create({
        data: { name: 'Barcode Race Store', slug: tag, ownerId: user.id, status: 'active' },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.countSession.deleteMany({ where: { storeId } });
    await prisma.stockAdjustment.deleteMany({ where: { storeId } });
    await prisma.inventoryHistory.deleteMany({ where: { storeId } });
    await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
    await prisma.order.deleteMany({ where: { storeId } });
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function product(inventory: number, barcode: string) {
    return prisma.product.create({
      data: {
        storeId,
        name: `P ${barcode}`,
        slug: `${tag}-${barcode}`,
        price: 1000,
        inventory,
        barcode,
        status: 'active',
      },
    });
  }

  it('qty 3 line, 12 concurrent scans -> picked is exactly 3, the rest are refused', async () => {
    const p = await product(50, `${tag}-A`);
    const order = await prisma.order.create({
      data: {
        storeId,
        orderNumber: `${tag}-O1`,
        subtotal: 3000,
        total: 3000,
        shippingAddress: {},
        billingAddress: {},
      },
    });
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: p.id,
        productName: p.name,
        quantity: 3,
        price: 1000,
        total: 3000,
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => pickOrderItemByBarcode(storeId, order.id, `${tag}-A`, 1))
    );
    const ok = results.filter(r => r.status === 'fulfilled');
    const refused = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    expect(refused.every(r => r.reason.code === 'ALREADY_PICKED')).toBe(true);
    const line = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
    expect(line?.pickedQty).toBe(3);
    expect(line?.pickedAt).not.toBeNull();
  });

  it('a sale that lands mid-count is preserved: stock 10, count 8, sale of 3 -> 5', async () => {
    const p = await product(10, `${tag}-B`);
    const session = await openCountSession(storeId, userId);
    // The shelf is counted at 8 against a system quantity of 10: variance -2.
    await submitCountLine(storeId, session.id, { productId: p.id, countedQty: 8 });
    // Then a customer buys 3 before the merchant reconciles.
    await prisma.product.update({ where: { id: p.id }, data: { inventory: { decrement: 3 } } });
    await closeCountSession(storeId, session.id);
    const r = await reconcileCountSession(storeId, session.id, userId);

    expect(r.linesReconciled).toBe(1);
    const after = await prisma.product.findUnique({ where: { id: p.id } });
    expect(after?.inventory).toBe(5); // 7 after the sale, -2 from the count (absolute 8 would be wrong)
    const audit = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM audit_logs
      WHERE action = 'inventory.count.reconciled' AND resource_id = ${session.id}`;
    expect(Number(audit[0].n)).toBe(1);
  });
});
