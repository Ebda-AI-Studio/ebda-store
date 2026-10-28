/**
 * Audit M-063 (fix group P09) against REAL Postgres: recording an InstaPay refund twice at once (a double click, or two
 * staff) must not double-count. Real transactions on real connections; the order + payment row locks are under test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@ebda/database';
import { InstapayService } from '@api/services/payment-providers/instapay.service';
import { hasDb } from '../helpers/bundle-fixtures';

const TAG = `irl-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
const uid = (l: string) => `${TAG}-${l}-${++seq}`;
let storeId = '';

async function mkPaidOrder(amount = 5000) {
  const order = await prisma.order.create({
    data: {
      storeId,
      orderNumber: uid('ORD'),
      status: 'confirmed',
      paymentStatus: 'paid',
      subtotal: amount,
      total: amount,
      shippingAddress: {},
      billingAddress: {},
    },
  });
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'instapay',
      status: 'completed',
      amount,
      currency: 'EGP',
      transactionId: uid('txn'),
      metadata: {},
    },
  });
  return { orderId: order.id, paymentId: payment.id };
}
const refund = (orderId: string, reference: string, amountMinor: number) =>
  InstapayService.recordRefund({
    storeId,
    orderId,
    actorUserId: 'actor',
    input: {
      reference,
      refundDate: '2026-10-20',
      refundTime: '12:00',
      recipientName: 'Mona A.',
      amountMinor,
    } as never,
  });
const settle = <T>(p: Promise<T>) =>
  p.then(
    v => ({ ok: true as const, v }),
    e => ({ ok: false as const, code: (e as { code?: string }).code })
  );

describe.skipIf(!hasDb)('P08/P09 InstaPay refund recording (real Postgres)', () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `${uid('o')}@example.test`,
        passwordHash: 'x'.repeat(60),
        firstName: 'I',
        lastName: 'R',
        role: 'store_admin',
        status: 'active',
        emailVerified: true,
      },
    });
    storeId = (
      await prisma.store.create({
        data: { name: 'IRL', slug: uid('s'), ownerId: owner.id, status: 'active' },
      })
    ).id;
  });

  it('the same reference submitted 6 times at once is recorded exactly once', async () => {
    const o = await mkPaidOrder();
    const res = await Promise.all(
      Array.from({ length: 6 }, () => settle(refund(o.orderId, '12345678901', 1000)))
    );
    expect(res.every(r => r.ok)).toBe(true);
    const fresh = res.filter(r => r.ok && !(r.v as { duplicate: boolean }).duplicate);
    expect(fresh).toHaveLength(1);
    const p = await prisma.payment.findUnique({ where: { id: o.paymentId } });
    expect(p!.refundedAmount).toBe(1000);
    expect(((p!.metadata as { refunds?: unknown[] }).refunds ?? []).length).toBe(1);
    expect(p!.status).toBe('partially_refunded');
  });

  it('two DIFFERENT references that together exceed the payment: exactly one wins, never an over-refund', async () => {
    const o = await mkPaidOrder(5000);
    const res = await Promise.all([
      settle(refund(o.orderId, '22222222201', 3000)),
      settle(refund(o.orderId, '22222222202', 3000)),
    ]);
    expect(res.filter(r => r.ok)).toHaveLength(1);
    expect(res.filter(r => !r.ok).map(r => (r as { code?: string }).code)).toEqual([
      'INVALID_REFUND_AMOUNT',
    ]);
    const p = await prisma.payment.findUnique({ where: { id: o.paymentId } });
    expect(p!.refundedAmount).toBe(3000);
    expect(((p!.metadata as { refunds?: unknown[] }).refunds ?? []).length).toBe(1);
  });

  it('two different references that fit both land, and neither record is lost from the array', async () => {
    const o = await mkPaidOrder(5000);
    const res = await Promise.all([
      settle(refund(o.orderId, '33333333301', 1000)),
      settle(refund(o.orderId, '33333333302', 2000)),
    ]);
    expect(res.every(r => r.ok)).toBe(true);
    const p = await prisma.payment.findUnique({ where: { id: o.paymentId } });
    expect(p!.refundedAmount).toBe(3000);
    expect(((p!.metadata as { refunds?: unknown[] }).refunds ?? []).length).toBe(2);
  });
});
