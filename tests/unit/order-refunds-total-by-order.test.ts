/**
 * The assistant's orders summary takes its refunds from the SAME rule as the order payment card (`refundedTotal`), batched per page:
 * an order refunded through more than one channel counts every channel once (the old max(returns, payments) undercounted it).
 */
import { describe, it, expect } from 'vitest';
import { refundedTotalByOrder, refundedMinorByOrder } from '../../apps/api/src/lib/order-refunds';
import { refundedTotal } from '../../apps/api/src/services/order-refunded-total';
import { summariseOrders } from '../../apps/api/src/lib/wa/bridge/owner-tools';

type Row = Record<string, unknown>;
const pays: Row[] = [
  // MIXED: gateway refund 2000 (mirrors the gateway return's refund event "rk-gw"), a merchant partial refund 1000 booked as an event only, a cash return 500, a gateway return 2000, an exchange 9999
  { orderId: 'mixed', refundedAmount: 2000, metadata: { refundEventIds: ['rk-gw'] } },
  { orderId: 'gw', refundedAmount: 3000, metadata: null },
  { orderId: 'none', refundedAmount: 0, metadata: null },
  { orderId: 'toyzwo', refundedAmount: 326_000, metadata: null }, // live Amelia ORD-TOYZWO-A88OH: a 3,260 EGP payment refund
];
const events: Row[] = [
  { orderId: 'mixed', metadata: { amount: 1000, refundKey: 'rk-merchant' } }, // not on a payment row: counts
  { orderId: 'mixed', metadata: { amount: 2000, refundKey: 'rk-gw' } }, // mirrored on the payment: already inside refundedAmount
  { orderId: 'mixed', metadata: { amount: 700, external: true } }, // flagged external: already counted elsewhere
];
const returns: Row[] = [
  { orderId: 'mixed', refundMethod: 'cash', refundAmount: 500, type: 'return' },
  { orderId: 'mixed', refundMethod: 'original', refundAmount: 2000, type: 'return' }, // gateway: on the payment row
  { orderId: 'mixed', refundMethod: 'cash', refundAmount: 9999, type: 'exchange' }, // an exchange moves no money
  { orderId: 'toyzwo', refundMethod: 'cash', refundAmount: 10_000, type: 'return' }, // ...plus a 100 EGP completed partial return outside the gateway
];
const inIds = (w: any) => w.orderId?.in as string[];
const fakeDb: any = {
  payment: {
    findMany: async ({ where }: any) =>
      pays.filter(p => inIds(where).includes(p.orderId as string)),
  },
  orderEvent: {
    findMany: async ({ where }: any) =>
      events.filter(e => inIds(where).includes(e.orderId as string)),
  },
  return: {
    findMany: async ({ where }: any) =>
      returns.filter(r => inIds(where).includes(r.orderId as string) && r.type !== 'exchange'),
    groupBy: async ({ where }: any) => {
      const sums = new Map<string, number>();
      for (const r of returns)
        if (inIds(where).includes(r.orderId as string) && r.type !== 'exchange')
          sums.set(
            r.orderId as string,
            (sums.get(r.orderId as string) ?? 0) + Number(r.refundAmount)
          );
      return [...sums].map(([orderId, v]) => ({ orderId, _sum: { refundAmount: v } }));
    },
  },
};
fakeDb.payment.groupBy = async ({ where }: any) => {
  const sums = new Map<string, number>();
  for (const p of pays)
    if (inIds(where).includes(p.orderId as string))
      sums.set(p.orderId as string, Number(p.refundedAmount));
  return [...sums].map(([orderId, v]) => ({ orderId, _sum: { refundedAmount: v } }));
};

describe('refundedTotalByOrder', () => {
  it('a mixed-path order counts every channel once: payment 2000 + merchant partial 1000 + cash return 500 = 3500 (max() said 2500)', async () => {
    const m = await refundedTotalByOrder(fakeDb, 's', ['mixed', 'gw', 'none']);
    expect(m.get('mixed')).toBe(3500);
    expect(m.get('gw')).toBe(3000);
    expect(m.has('none')).toBe(false);
    expect((await refundedMinorByOrder(fakeDb, 's', ['mixed'])).get('mixed')).toBe(2500); // the rule the summary used before: an undercount
  });

  it('live shape ORD-TOYZWO-A88OH: 3,260 EGP payment refund + 100 EGP partial return = 3,360 on the card; max() gave 3,260 (the 100 EGP gap between the cards and the assistant)', async () => {
    expect((await refundedTotalByOrder(fakeDb, 's', ['toyzwo'])).get('toyzwo')).toBe(336_000);
    expect((await refundedMinorByOrder(fakeDb, 's', ['toyzwo'])).get('toyzwo')).toBe(326_000);
  });

  it('agrees with the order page for every order (same function, per order)', async () => {
    const m = await refundedTotalByOrder(fakeDb, 's', ['mixed', 'gw', 'none', 'toyzwo']);
    for (const id of ['mixed', 'gw', 'none', 'toyzwo']) {
      const card = refundedTotal(
        pays.filter(p => p.orderId === id) as never,
        events.filter(e => e.orderId === id) as never,
        returns.filter(r => r.orderId === id && r.type !== 'exchange') as never
      );
      expect(m.get(id) ?? 0, id).toBe(card);
    }
  });

  it('feeds the summary: refunds and net sales use the 3500', async () => {
    const m = await refundedTotalByOrder(fakeDb, 's', ['mixed']);
    const s = summariseOrders([
      {
        total: 10_000,
        status: 'confirmed',
        paymentStatus: 'paid',
        online: true,
        cod: false,
        refundedMinor: m.get('mixed') ?? 0,
      },
    ]);
    expect(s).toMatchObject({ refundsMinor: 3500, salesMinor: 6500, collectedOrders: 1 });
  });

  it('handles a page larger than the 500-id chunk', async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `o${i}`).concat('mixed');
    expect((await refundedTotalByOrder(fakeDb, 's', ids)).get('mixed')).toBe(3500);
  });
});
