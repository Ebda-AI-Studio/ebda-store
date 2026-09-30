/**
 * Two returns on ONE order, written at the same time (#1393), against a real
 * Postgres — the race lives between connections, so a mocked client cannot
 * show it.
 *
 * `complete()`'s claim is per Return row and `create()`'s over-claim check is a
 * read followed by an insert. Two different returns on the same order each
 * passed their own claim, each read the order's prior returns without the
 * other (neither had committed), and each took the same line: both refunded
 * it, or both reserved it. The order-level returns lock makes the second wait
 * for the first to commit and then read it.
 *
 * Each call runs in its own `runInTenantContext`, the same one-transaction
 * shape as a tenant-scoped HTTP request. Self-skips without a real DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { runInTenantContext, withRlsBypass } from '@force/database';
import { ReturnService } from '@api/services/return.service';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('returns on one order are serialised by the order lock', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  let storeId: string;
  let customerId: string;
  let productAId: string;
  let productBId: string;
  let seq = 0;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `rol-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'ROL',
          lastName: 'Owner',
        },
      });
      const customer = await tx.user.create({
        data: {
          email: `rol-cust-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'customer',
          firstName: 'ROL',
          lastName: 'Customer',
        },
      });
      customerId = customer.id;
      const store = await tx.store.create({
        data: {
          name: 'rol-test-store',
          slug: `rol-test-${suffix}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: owner.id,
        },
      });
      storeId = store.id;
      const a = await tx.product.create({
        data: {
          storeId,
          name: `rol-a-${suffix}`,
          slug: `rol-a-${suffix}`,
          price: 2000,
          inventory: 10,
          status: 'active',
        },
      });
      const b = await tx.product.create({
        data: {
          storeId,
          name: `rol-b-${suffix}`,
          slug: `rol-b-${suffix}`,
          price: 3000,
          inventory: 10,
          status: 'active',
        },
      });
      productAId = a.id;
      productBId = b.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.returnItem.deleteMany({ where: { return: { storeId } } }).catch(() => {});
      await tx.return.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A delivered order with line A (1 × 2000) and line B (1 × 3000). */
  async function deliveredOrder() {
    const n = `${suffix}-${++seq}-${Math.random().toString(36).substring(7)}`;
    return withRlsBypass(async tx => {
      const order = await tx.order.create({
        data: {
          storeId,
          customerId,
          orderNumber: `ROL-${n}`,
          status: 'delivered',
          paymentStatus: 'paid',
          subtotal: 5000,
          total: 5000,
          shippingAddress: {},
          billingAddress: {},
          items: {
            create: [
              {
                productId: productAId,
                productName: 'rol-a',
                quantity: 1,
                price: 2000,
                total: 2000,
              },
              {
                productId: productBId,
                productName: 'rol-b',
                quantity: 1,
                price: 3000,
                total: 3000,
              },
            ],
          },
        },
        include: { items: true },
      });
      const lineA = order.items.find(i => i.productId === productAId)!;
      return { orderId: order.id, lineAId: lineA.id };
    });
  }

  /** A received return of line A, written directly — as two racing creates would leave it. */
  async function receivedReturnOfLineA(orderId: string, lineAId: string) {
    const n = `${suffix}-${++seq}-${Math.random().toString(36).substring(7)}`;
    return withRlsBypass(tx =>
      tx.return.create({
        data: {
          storeId,
          orderId,
          customerId,
          returnNumber: `RET-ROL-${n}`,
          type: 'return',
          status: 'received',
          reason: 'defective',
          refundAmount: 2000,
          items: {
            create: [
              { orderItemId: lineAId, productId: productAId, productName: 'rol-a', quantity: 1 },
            ],
          },
        },
      })
    );
  }

  const inRequest = <T>(fn: () => Promise<T>) => runInTenantContext(storeId, fn);

  it('two completions claiming the same line: exactly one completes', async () => {
    const { orderId, lineAId } = await deliveredOrder();
    const r1 = await receivedReturnOfLineA(orderId, lineAId);
    const r2 = await receivedReturnOfLineA(orderId, lineAId);

    // Force the losing interleaving instead of hoping for it: the first
    // request finishes its work but holds its transaction open until the
    // second has READ the order's prior returns (or 1.5s pass). Without the
    // lock the second reads while the first is uncommitted and takes the same
    // line; with it, the second cannot get that far until the first commits.
    let secondRead!: () => void;
    const secondReadDone = new Promise<void>(resolve => (secondRead = resolve));
    const svc = ReturnService as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const allocate = svc.allocateThisReturn.bind(ReturnService);
    vi.spyOn(svc, 'allocateThisReturn').mockImplementation(async (...args: unknown[]) => {
      const result = await allocate(...args);
      if (args[1] === r2.id) secondRead();
      return result;
    });

    let firstDone!: () => void;
    const firstFinished = new Promise<void>(resolve => (firstDone = resolve));
    const first = inRequest(async () => {
      const done = await ReturnService.complete(storeId, r1.id, 'admin', 'bank_transfer');
      firstDone();
      await Promise.race([secondReadDone, new Promise(r => setTimeout(r, 1500))]);
      return done;
    });
    await firstFinished;
    const second = inRequest(() =>
      ReturnService.complete(storeId, r2.id, 'admin', 'bank_transfer')
    );

    const results = await Promise.allSettled([first, second]);

    const done = results.filter(r => r.status === 'fulfilled');
    const refused = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(done, 'the same unit must not be refunded by two returns').toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ code: 'PARTIAL_REFUND_NOTHING_TO_REFUND' });

    const completed = await withRlsBypass(tx =>
      tx.return.findMany({ where: { orderId, status: 'completed' } })
    );
    expect(completed).toHaveLength(1);
  });

  it('two requests reserving the same line: exactly one is created', async () => {
    const { orderId, lineAId } = await deliveredOrder();
    const request = () =>
      inRequest(() =>
        ReturnService.create(storeId, {
          orderId,
          customerId,
          type: 'return',
          reason: 'defective',
          items: [
            { orderItemId: lineAId, productId: productAId, productName: 'rol-a', quantity: 1 },
          ],
        })
      );

    const results = await Promise.allSettled([request(), request()]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ code: 'INVALID_QUANTITY' });
  });

  // Issues 2004 / 2030: complete() holds the order's returns lock across the
  // provider refund round-trip. A customer's create() on the same order must
  // not queue behind it until its own transaction times out — it waits a
  // short bounded window and then answers a clean 409.
  it('a create() behind a long-held order lock fails fast with RETURN_ORDER_BUSY', async () => {
    const { orderId, lineAId } = await deliveredOrder();
    let release!: () => void;
    const held = new Promise<void>(r => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>(r => (locked = r));
    // Stand-in for a completion mid-refund: holds the same advisory key.
    const holder = runInTenantContext(storeId, async () => {
      const { prisma } = await import('@force/database');
      await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`return-order:${orderId}`}, 0))`;
      locked();
      await held;
    });
    await lockTaken;
    const started = Date.now();
    try {
      await expect(
        inRequest(() =>
          ReturnService.create(storeId, {
            orderId,
            customerId,
            type: 'return',
            reason: 'defective',
            items: [
              { orderItemId: lineAId, productId: productAId, productName: 'rol-a', quantity: 1 },
            ],
          })
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'RETURN_ORDER_BUSY' });
      // Bounded: well inside the 30s interactive-transaction ceiling.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      release();
      await holder;
    }
    // Once the holder is gone the same request goes through.
    await expect(
      inRequest(() =>
        ReturnService.create(storeId, {
          orderId,
          customerId,
          type: 'return',
          reason: 'defective',
          items: [
            { orderItemId: lineAId, productId: productAId, productName: 'rol-a', quantity: 1 },
          ],
        })
      )
    ).resolves.toBeDefined();
  }, 30_000);
});
