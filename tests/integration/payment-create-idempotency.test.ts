/**
 * POST /payments/create idempotency (adversarial audit P2).
 *
 * The create route had no existing-payment guard: every COD replay re-added
 * the COD fee to `order.total` and minted another `cod_pending` Payment row
 * (a plain double-click corrupted real orders), and every online replay
 * minted another live gateway invoice for the same order — the customer
 * could pay BOTH, with no duplicate-capture detection anywhere.
 *
 * Fix under test:
 *   - an order with a live (non-terminal-failure) payment returns the
 *     EXISTING payment instead of creating a second one:
 *       - settled payment (completed/refunded/…) → 409 ORDER_ALREADY_PAID
 *       - cod_pending + provider 'cod' → replay the original COD response
 *       - pending same-provider with a stored paymentUrl → replay the URL
 *   - the COD fee is added to order.total only when NO prior COD payment
 *     row exists;
 *   - `alertIfDuplicateCapture` fires a P0 alert when a second payment on
 *     one order reaches a captured state (wired into the webhook handler).
 *
 * DB-direct integration test (real Postgres, supertest on the mounted
 * router), mirrors order-created-idempotency.test.ts conventions.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const h = vi.hoisted(() => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));

import express from 'express';
import request from 'supertest';
import { prisma, runInTenantContext, withRlsBypass } from '@force/database';
import paymentRoutes from '@api/routes/payment.routes';
import { alertIfDuplicateCapture } from '@api/services/payment-providers/payment.factory';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const app = express();
app.use(express.json());
app.use('/api/v1/payments', paymentRoutes);

describe.skipIf(!hasDb)('POST /payments/create idempotency', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  let storeId: string;
  let codOrderId: string;
  let onlineOrderId: string;
  let paidOrderId: string;
  const COD_FEE = 500;
  const ORDER_TOTAL = 10000;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `pci-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'PCI',
          lastName: 'Owner',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'pci-test-store',
          slug: `pci-test-${suffix}`,
          template: 'modern',
          currency: 'EGP',
          ownerId: owner.id,
        },
      });
      storeId = store.id;

      await tx.paymentConfig.create({
        data: {
          storeId,
          provider: 'cod',
          isEnabled: true,
          fixedFee: COD_FEE,
        },
      });

      const mkOrder = (n: string) =>
        tx.order.create({
          data: {
            storeId,
            customerId: null, // guest order — the route's guest branch
            orderNumber: `PCI-${n}-${suffix}`,
            status: 'pending',
            paymentStatus: 'unpaid',
            subtotal: ORDER_TOTAL,
            total: ORDER_TOTAL,
            shippingAddress: {},
            billingAddress: {},
          },
        });
      codOrderId = (await mkOrder('COD')).id;
      onlineOrderId = (await mkOrder('ONL')).id;
      paidOrderId = (await mkOrder('PAID')).id;

      // Pre-existing pending online payment with a live invoice URL.
      await tx.payment.create({
        data: {
          orderId: onlineOrderId,
          provider: 'paymob',
          status: 'pending',
          amount: ORDER_TOTAL,
          currency: 'EGP',
          transactionId: `pci-txn-${suffix}`,
          paymentUrl: 'https://pay.example.test/invoice-1',
        },
      });
      // Settled payment on the paid order.
      await tx.payment.create({
        data: {
          orderId: paidOrderId,
          provider: 'paymob',
          status: 'completed',
          amount: ORDER_TOTAL,
          currency: 'EGP',
          transactionId: `pci-txn-paid-${suffix}`,
        },
      });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.paymentEvent.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.payment.deleteMany({ where: { order: { storeId } } }).catch(() => {});
      await tx.auditLog.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.order.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.paymentConfig.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  it('replayed COD create adds the fee ONCE and keeps a single payment row', async () => {
    const first = await request(app)
      .post('/api/v1/payments/create')
      .send({ orderId: codOrderId, provider: 'cod' });
    expect(first.status).toBe(200);
    expect(first.body.data.cod).toBe(true);
    expect(first.body.data.codFee).toBe(COD_FEE);

    const afterFirst = await withRlsBypass(tx =>
      tx.order.findUniqueOrThrow({ where: { id: codOrderId } })
    );
    expect(afterFirst.total).toBe(ORDER_TOTAL + COD_FEE);

    // Replay (double-click / retry) — same response, NO second fee, NO
    // second payment row.
    const second = await request(app)
      .post('/api/v1/payments/create')
      .send({ orderId: codOrderId, provider: 'cod' });
    expect(second.status).toBe(200);
    expect(second.body.data.cod).toBe(true);
    expect(second.body.data.transactionId).toBe(first.body.data.transactionId);

    const afterSecond = await withRlsBypass(tx =>
      tx.order.findUniqueOrThrow({ where: { id: codOrderId } })
    );
    expect(afterSecond.total).toBe(ORDER_TOTAL + COD_FEE); // fee added exactly once

    const codPayments = await withRlsBypass(tx =>
      tx.payment.findMany({ where: { orderId: codOrderId } })
    );
    expect(codPayments).toHaveLength(1);
  });

  it('online create with a live pending payment returns the EXISTING paymentUrl', async () => {
    const res = await request(app)
      .post('/api/v1/payments/create')
      .send({ orderId: onlineOrderId, provider: 'paymob' });
    expect(res.status).toBe(200);
    expect(res.body.data.paymentUrl).toBe('https://pay.example.test/invoice-1');
    expect(res.body.data.transactionId).toBe(`pci-txn-${suffix}`);

    const payments = await withRlsBypass(tx =>
      tx.payment.findMany({ where: { orderId: onlineOrderId } })
    );
    expect(payments).toHaveLength(1); // no second invoice minted
  });

  it('create on an order with a settled payment is refused with 409', async () => {
    const res = await request(app)
      .post('/api/v1/payments/create')
      .send({ orderId: paidOrderId, provider: 'paymob' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_ALREADY_PAID');
  });

  it('alertIfDuplicateCapture fires a P0 alert when a second captured payment lands on one order', async () => {
    // Second completed payment on the already-paid order (the webhook race).
    const dup = await withRlsBypass(tx =>
      tx.payment.create({
        data: {
          orderId: paidOrderId,
          provider: 'kashier',
          status: 'completed',
          amount: ORDER_TOTAL,
          currency: 'EGP',
          transactionId: `pci-txn-dup-${suffix}`,
        },
      })
    );

    h.sendAlert.mockClear();
    // The webhook handler calls this inside the store's tenant scope.
    await runInTenantContext(storeId, () =>
      alertIfDuplicateCapture(dup.id, paidOrderId, 'kashier')
    );
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    expect(h.sendAlert.mock.calls[0][0]).toMatchObject({
      level: 'p0',
      source: 'payment.duplicate_capture',
    });

    // No sibling captured payment → no alert.
    h.sendAlert.mockClear();
    const solo = await withRlsBypass(tx =>
      tx.payment.findFirstOrThrow({ where: { orderId: onlineOrderId } })
    );
    await runInTenantContext(storeId, () =>
      alertIfDuplicateCapture(solo.id, onlineOrderId, 'paymob')
    );
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
});
