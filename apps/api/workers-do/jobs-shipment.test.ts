import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { createDoClient, decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// Ruling CF-JOBS-4 on real workerd: the shipment-create job claims the shipment row through the DO write path. A booking
// delivered twice (an at-least-once queue) books ONCE: 25 concurrent claims of one order leave one row, and 25 concurrent
// re-claims of a failed booking win exactly once.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (s: string) => e.STORE_DO.get(e.STORE_DO.idFromName(s));
const clientFor = (s: string) => {
  const stub = stubFor(s);
  return createDoClient(
    q => stub.query(s, q as never),
    m => stub.mutate(s, m as never)
  ) as any;
};
async function seedOrder(s: string): Promise<string> {
  const stub = stubFor(s);
  await runInDurableObject(stub, (_i, st) => {
    st.storage.sql.exec(
      `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')`,
      s,
      s
    );
    st.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status, cost_price) VALUES ('p1', ?, 'Widget', 'widget', 1000, 20, 'active', 400)`,
      s
    );
  });
  const a = (await stub.moneyOp(
    s,
    'createOrder',
    encodeRpc({
      lines: [{ productId: 'p1', quantity: 1 }],
      shippingAddress: { phone: '01000000001' },
    })
  )) as { ok: boolean; json: string };
  if (!a.ok) throw new Error('seed failed');
  return decodeRpc<{ orderId: string }>(a.json).orderId;
}
const data = (s: string, orderId: string) => ({
  storeId: s,
  orderId,
  carrier: 'bosta',
  status: 'creating',
  codAmount: 0,
  pickupAddress: { name: 'S' },
  deliveryAddress: { name: 'C' },
  createAttempts: 1,
});

describe('shipment claim on the store DO', () => {
  it('25 concurrent first claims of one order: one row, the rest lose the unique race', async () => {
    const s = 'ship-claim';
    const orderId = await seedOrder(s);
    const c = clientFor(s);
    const r = await Promise.allSettled(
      Array.from({ length: 25 }, () => c.shipment.create({ data: data(s, orderId) }))
    );
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await c.shipment.count({ where: { orderId } })).toBe(1);
  });

  it('25 concurrent re-claims of a failed booking: exactly one wins and counts the attempt', async () => {
    const s = 'ship-reclaim';
    const orderId = await seedOrder(s);
    const c = clientFor(s);
    const row = await c.shipment.create({
      data: { ...data(s, orderId), status: 'creation_failed' },
    });
    const r = await Promise.all(
      Array.from({ length: 25 }, () =>
        c.shipment.updateMany({
          where: {
            id: row.id,
            storeId: s,
            OR: [{ status: { in: ['creation_failed', 'cancelled'] } }],
          },
          data: { status: 'creating', createAttempts: { increment: 1 } },
        })
      )
    );
    expect(r.reduce((n: number, x: { count: number }) => n + x.count, 0)).toBe(1);
    const after = await c.shipment.findFirst({ where: { id: row.id } });
    expect(after.status).toBe('creating');
    expect(after.createAttempts).toBe(2);
  });
});
