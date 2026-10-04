/**
 * The ledger must follow the ORDER's committed state (audit 2026-09-30,
 * finding 4 — two wady-aljuz orders).
 *
 * 1. ORD-1781512189610-9972A710 is delivered + paid, but its sale entry was
 *    reversed "refund applied". On 2026-07-09 a delivered→refunded status
 *    change ran inside a request transaction that then rolled back, while the
 *    refund side effects had already committed and `order/refunded` had
 *    already been sent — the GL poster reversed a refund that never happened.
 *    `applyRefundEffects` now sends `order/refunded` only after the caller's
 *    request transaction commits; a rolled-back request sends nothing.
 *
 * 2. ORD-1778670342233-50212B65 is refunded (paymentStatus left 'paid' by the
 *    May status-button refund) and its sale was booked on 2026-07-09 by the
 *    order-created stuck sweep's fanout — revenue with no reversal.
 *    `postOrderPaymentJournal` now refuses to book a sale for an order that is
 *    already cancelled or refunded.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { prisma, runInTenantContext } from '@force/database';
import { inngest } from '@api/lib/inngest/client';
import { withDeferredWork } from '@api/lib/after-tenant-commit';
import { OrderService } from '@api/services/order.service';
import { seedCoaForStore } from '@api/services/accounting/account.service';
import { postOrderPaymentJournal } from '@api/services/accounting/posting/order-posting';
import { handlePartialReturnReversalSweep } from '@api/lib/inngest/functions/refund-reversal-stuck-sweep';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const OWNER = '00000000-0000-0000-0000-0000000000f9';
let storeId: string;
let productId: string;

beforeAll(async () => {
  if (!hasDb) return;
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `ledger-state-owner-${Date.now()}@example.test`,
      passwordHash: 'x',
      firstName: 'L',
      lastName: 'S',
    },
  });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const store = await prisma.store.create({
    data: { name: `ledger-state-${suffix}`, slug: `ledger-state-${suffix}`, ownerId: OWNER },
  });
  storeId = store.id;
  await seedCoaForStore(storeId);
  const p = await prisma.product.create({
    data: {
      storeId,
      name: 'Ledger State Product',
      slug: `ledger-state-product-${suffix}`,
      price: 2000,
      costPrice: 800,
      inventory: 50,
      status: 'active',
    },
  });
  productId = p.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.journalLine.deleteMany({ where: { entry: { storeId } } });
  await prisma.journalEntry.updateMany({ where: { storeId }, data: { reversedById: null } });
  await prisma.journalEntry.deleteMany({ where: { storeId } });
  await prisma.sequence.deleteMany({ where: { storeId } });
  await prisma.returnItem.deleteMany({ where: { return: { storeId } } });
  await prisma.return.deleteMany({ where: { storeId } });
  await prisma.orderEvent.deleteMany({ where: { storeId } });
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.payment.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

async function paidOrder(status: 'delivered' | 'refunded' | 'cancelled') {
  return prisma.order.create({
    data: {
      storeId,
      orderNumber: `LS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status,
      paymentStatus: 'paid',
      subtotal: 2000,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: 2000,
      currency: 'EGP',
      shippingAddress: {},
      billingAddress: {},
      items: {
        create: [
          {
            productId,
            productName: 'Ledger State Product',
            quantity: 1,
            price: 2000,
            total: 2000,
            costPrice: 800,
          },
        ],
      },
      payments: {
        create: [{ provider: 'paymob', status: 'completed', amount: 2000, paidAt: new Date() }],
      },
    },
  });
}

const refundedEvents = (spy: ReturnType<typeof vi.spyOn>, orderId: string) =>
  spy.mock.calls.filter(([payload]) => {
    const p = payload as { name?: string; data?: { orderId?: string } };
    return p?.name === 'order/refunded' && p.data?.orderId === orderId;
  });

describe.skipIf(!hasDb)('order/refunded is sent only for a committed refund', () => {
  it('a status change whose request transaction rolls back sends NO order/refunded', async () => {
    const order = await paidOrder('delivered');
    await postOrderPaymentJournal({ orderId: order.id });
    const spy = vi.spyOn(inngest, 'send');

    await expect(
      withDeferredWork({ storeId }, () =>
        runInTenantContext(storeId, async () => {
          await OrderService.updateStatus(storeId, order.id, 'refunded');
          // Anything that fails the request after the status change — the
          // 2026-07-09 incident was the 30s transaction timeout.
          throw new Error('simulated request failure after updateStatus');
        })
      )
    ).rejects.toThrow('simulated request failure');

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('delivered');
    expect(refundedEvents(spy, order.id)).toHaveLength(0);
    const sale = await prisma.journalEntry.findFirst({
      where: { storeId, source: 'order', sourceId: order.id },
    });
    expect(sale?.status).toBe('posted');
  });

  it('the same status change, committed, sends order/refunded exactly once', async () => {
    const order = await paidOrder('delivered');
    const spy = vi.spyOn(inngest, 'send');

    await withDeferredWork({ storeId }, () =>
      runInTenantContext(storeId, () => OrderService.updateStatus(storeId, order.id, 'refunded'))
    );

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('refunded');
    expect(refundedEvents(spy, order.id)).toHaveLength(1);
  });

  it('outside a request (Inngest / script caller) the event is sent inline', async () => {
    const order = await paidOrder('delivered');
    const spy = vi.spyOn(inngest, 'send');
    await OrderService.applyRefundEffects(storeId, order.id);
    expect(refundedEvents(spy, order.id)).toHaveLength(1);
  });
});

describe.skipIf(!hasDb)('no sale entry for an order that is already cancelled/refunded', () => {
  it.each(['refunded', 'cancelled'] as const)(
    'a paid order already %s gets no sale entry (nothing would ever reverse it)',
    async status => {
      const order = await paidOrder(status);
      await postOrderPaymentJournal({ orderId: order.id });
      const entries = await prisma.journalEntry.count({
        where: { storeId, source: 'order', sourceId: { startsWith: order.id } },
      });
      expect(entries).toBe(0);
    }
  );

  it('control: a delivered paid order still gets its sale + COGS entries', async () => {
    const order = await paidOrder('delivered');
    await postOrderPaymentJournal({ orderId: order.id });
    const entries = await prisma.journalEntry.findMany({
      where: { storeId, source: 'order', sourceId: { startsWith: order.id } },
    });
    expect(entries.map(e => e.sourceId).sort()).toEqual([order.id, `${order.id}:cogs`].sort());
  });
});

// Issues 2246 / 2267 (Ruling AP-2's residual): a PARTIAL return's item-level
// event is sent after COMMIT; if that enqueue fails, nothing used to notice.
describe.skipIf(!hasDb)('a partial return whose post-commit enqueue fails is recovered', () => {
  async function completedPartialReturn() {
    const order = await paidOrder('delivered');
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const ret = await prisma.return.create({
      data: {
        storeId,
        orderId: order.id,
        customerId: OWNER,
        returnNumber: `RET-LS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'return',
        status: 'completed',
        reason: 'defective',
        refundAmount: 1000,
        refundedAt: new Date(),
        items: {
          create: [
            { orderItemId: line.id, productId, productName: 'Ledger State Product', quantity: 1 },
          ],
        },
      },
    });
    return { order, line, ret };
  }
  const partialFor = (retId: string, lineId: string) => ({
    items: [{ orderItemId: lineId, quantity: 1 }],
    refundKey: retId,
    refundAmount: 1000,
  });

  it('arms the Return in the committing request, and the sweep re-sends the item-level event', async () => {
    const { order, line, ret } = await completedPartialReturn();
    const failing = vi.spyOn(inngest, 'send').mockRejectedValue(new Error('inngest down'));

    // The deferred send fails AFTER commit — swallowed + alerted by contract.
    await withDeferredWork({ storeId }, () =>
      runInTenantContext(storeId, () =>
        OrderService.applyRefundEffects(storeId, order.id, {
          partial: partialFor(ret.id, line.id),
        })
      )
    );
    expect(failing).toHaveBeenCalled();
    failing.mockRestore();

    const armed = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(armed.reversalRequestedAt).not.toBeNull();
    expect(armed.reversalAppliedAt).toBeNull();

    // Past the staleness window, the sweep re-sends it.
    await prisma.return.update({
      where: { id: ret.id },
      data: { reversalRequestedAt: new Date(Date.now() - 20 * 60_000) },
    });
    const spy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    await handlePartialReturnReversalSweep({ run: (_id, fn) => fn() });
    const resent = refundedEvents(spy, order.id);
    expect(resent).toHaveLength(1);
    expect((resent[0][0] as { data: unknown }).data).toMatchObject({
      restoreInventory: true,
      notify: false,
      partial: { refundKey: ret.id, items: [{ orderItemId: line.id, quantity: 1 }] },
    });
  });

  it('a request that rolls back leaves nothing armed (no refund happened)', async () => {
    const { order, line, ret } = await completedPartialReturn();
    await expect(
      withDeferredWork({ storeId }, () =>
        runInTenantContext(storeId, async () => {
          await OrderService.applyRefundEffects(storeId, order.id, {
            partial: partialFor(ret.id, line.id),
          });
          throw new Error('simulated request failure');
        })
      )
    ).rejects.toThrow('simulated request failure');
    const after = await prisma.return.findUniqueOrThrow({ where: { id: ret.id } });
    expect(after.reversalRequestedAt).toBeNull();
  });
});
