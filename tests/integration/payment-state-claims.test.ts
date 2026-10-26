/**
 * Audit M-049 / M-064 (fix group P08) against REAL Postgres: concurrent pull-side confirmations settle an order ONCE
 * (one fan-out), and a late "failed/expired" answer can never overwrite a PAID order, whatever the interleaving. No mocks
 * on the database: the conditional UPDATE and its row lock are what is under test (only the fan-out sinks are stubbed).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

const inngestSend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@api/lib/inngest/client', async importOriginal => {
  const mod = await importOriginal<typeof import('@api/lib/inngest/client')>();
  mod.inngest.send = inngestSend as never; // only the fan-out sink is stubbed
  return mod;
});
vi.mock('@api/services/onesignal.service', () => ({
  OneSignalService: { notifyAdminsOfPaymentSuccess: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@api/services/provider-verification.service', () => ({
  recordPaymentSettled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/services/card-testing-guard.service', () => ({
  CardTestingGuard: { recordDecline: vi.fn().mockResolvedValue(undefined) },
}));

import { confirmPaymentFromProviderStatus } from '@api/services/payment-confirm.service';

const TAG = `psc-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const uid = (l: string) => `${TAG}-${l}-${++seq}`;
let storeId = '';

async function mkOrder(
  status: 'pending' | 'confirmed' = 'pending',
  paymentStatus: 'unpaid' | 'paid' = 'unpaid'
) {
  const order = await prisma.order.create({
    data: {
      storeId,
      orderNumber: uid('ORD'),
      status,
      paymentStatus,
      subtotal: 5000,
      total: 5000,
      shippingAddress: {},
      billingAddress: {},
    },
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'paymob',
      status: paymentStatus === 'paid' ? 'completed' : 'pending',
      amount: 5000,
      currency: 'EGP',
      transactionId: uid('txn'),
    },
  });
  return { order, payment };
}
const answer = (status: 'completed' | 'expired' | 'failed') =>
  ({
    success: true,
    provider: 'paymob',
    transactionId: 't',
    invoiceId: 't',
    status,
    amount: 5000,
    currency: 'EGP',
  }) as never;
const confirm = (
  o: Awaited<ReturnType<typeof mkOrder>>,
  status: 'completed' | 'expired' | 'failed',
  snapshot = 'unpaid'
) =>
  confirmPaymentFromProviderStatus({
    payment: {
      id: o.payment.id,
      status: o.payment.status,
      provider: 'paymob',
      metadata: {},
      amount: 5000,
    } as never,
    order: { id: o.order.id, storeId, paymentStatus: snapshot, locale: 'ar' },
    providerStatus: answer(status),
    source: 'guest_verify',
  });

describe.skipIf(!hasDb)('P08 payment state claims (real Postgres)', () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${uid('o')}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'P',
        lastName: 'S',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    storeId = (
      await prisma.store.create({
        data: { name: 'PSC', slug: uid('s'), ownerId: owner.id, status: 'active' },
      })
    ).id;
  });

  it('8 concurrent verify calls on one unpaid order: exactly one transition, exactly one fan-out (M-049)', async () => {
    const o = await mkOrder();
    inngestSend.mockClear();
    const results = await Promise.all(Array.from({ length: 8 }, () => confirm(o, 'completed')));
    expect(results.filter(r => r.statusChanged)).toHaveLength(1);
    expect(results.every(r => r.paymentStatus === 'paid')).toBe(true);
    expect(inngestSend).toHaveBeenCalledTimes(1);
    const after = await prisma.order.findUnique({ where: { id: o.order.id } });
    expect(after).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  it('paid and expired racing on one order, 12 times: the order always ends PAID (M-064)', async () => {
    for (let i = 0; i < 12; i++) {
      const o = await mkOrder();
      await Promise.all([confirm(o, 'expired'), confirm(o, 'completed'), confirm(o, 'failed')]);
      const after = await prisma.order.findUnique({ where: { id: o.order.id } });
      // the failure may land first (unpaid -> failed) and the payment still confirms it (failed -> paid); never the reverse
      expect(after!.paymentStatus).toBe('paid');
      expect((await prisma.payment.findUnique({ where: { id: o.payment.id } }))!.status).toBe(
        'completed'
      );
    }
  });

  it('a late expired answer for an order that is already PAID changes nothing (stale snapshot and admin Refresh)', async () => {
    const o = await mkOrder('confirmed', 'paid');
    const r = await confirm(o, 'expired', 'unpaid'); // a snapshot read before the payment landed
    expect(r.statusChanged).toBe(false);
    expect(r.paymentStatus).toBe('paid');
    const after = await prisma.order.findUnique({ where: { id: o.order.id } });
    expect(after!.paymentStatus).toBe('paid');
    expect((await prisma.payment.findUnique({ where: { id: o.payment.id } }))!.status).toBe(
      'completed'
    );
    const viaAdmin = await confirm(o, 'failed', 'paid');
    expect(viaAdmin).toMatchObject({ paymentStatus: 'paid', statusChanged: false });
  });
});
