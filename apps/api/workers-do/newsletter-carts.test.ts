import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { createDoClient, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 PR R4 (Rulings CF-R4-4, CF-R4-5) on real workerd. Postgres serialised these with the (store, email) unique
// index, a conditional UPDATE (the once-per-cart claim) and an upsert; the single DO thread plus the same unique index do it here.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
const clientFor = (storeId: string) => {
  const stub = stubFor(storeId);
  return createDoClient(
    q => stub.query(storeId, q as never),
    m => stub.mutate(storeId, m as never)
  ) as any;
};
const count = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).one().n as number);

describe('newsletter subscribers on the StoreDO', () => {
  it('40 concurrent signups of one address create one row, the other 39 are unique violations; consent is never lost', async () => {
    const c = clientFor('nl-race');
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () =>
        c.newsletterSubscriber.create({
          data: { storeId: 'nl-race', email: 'same@example.test', source: 'footer' },
        })
      )
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const codes = results.flatMap(r => (r.status === 'rejected' ? [(r.reason as any).code] : []));
    expect(new Set(codes)).toEqual(new Set(['P2002']));
    expect(
      await count(stubFor('nl-race'), `SELECT count(*) AS n FROM newsletter_subscribers`)
    ).toBe(1);
  });

  it('a one-click unsubscribe racing 30 re-subscribes ends in one of the two states, never a torn row, and a repeated unsubscribe is a no-op', async () => {
    const c = clientFor('nl-flip');
    const row = await c.newsletterSubscriber.create({
      data: { storeId: 'nl-flip', email: 'flip@example.test' },
    });
    await Promise.all([
      ...Array.from({ length: 30 }, () =>
        c.newsletterSubscriber.update({
          where: { id: row.id, storeId: 'nl-flip' },
          data: { isActive: true, unsubscribedAt: null },
        })
      ),
      c.newsletterSubscriber.updateMany({
        where: { id: row.id, storeId: 'nl-flip', isActive: true },
        data: { isActive: false, unsubscribedAt: new Date() },
      }),
    ]);
    const after = await c.newsletterSubscriber.findFirst({ where: { id: row.id } });
    // never active WITH an unsubscribed timestamp, never inactive without one
    expect(after.isActive).toBe(after.unsubscribedAt === null);
    const again = await c.newsletterSubscriber.updateMany({
      where: { id: row.id, storeId: 'nl-flip', isActive: true },
      data: { isActive: false, unsubscribedAt: new Date() },
    });
    expect(again.count).toBe(after.isActive ? 1 : 0);
  });
});

describe('abandoned-cart job writes on the StoreDO', () => {
  it('the once-per-cart e-mail claim (NULL -> queued): 30 concurrent sweeps claim the cart exactly once', async () => {
    const c = clientFor('ac-claim');
    const cart = await c.cart.create({ data: { storeId: 'ac-claim', sessionId: 's1' } });
    const ac = await c.abandonedCart.create({
      data: {
        storeId: 'ac-claim',
        cartId: cart.id,
        sessionId: 's1',
        customerEmail: 'a@example.test',
        cartTotal: 1000,
        cartItemCount: 1,
        cartItems: [],
        status: 'pending',
      },
    });
    const claims = await Promise.all(
      Array.from({ length: 30 }, () =>
        c.abandonedCart.updateMany({
          where: { id: ac.id, storeId: 'ac-claim', emailStatus: null },
          data: { emailStatus: 'queued' },
        })
      )
    );
    expect(claims.reduce((n: number, r: any) => n + r.count, 0)).toBe(1);
    // and the later finish (queued -> sent) is a conditional write too: once
    const fin = await Promise.all(
      Array.from({ length: 10 }, () =>
        c.abandonedCart.updateMany({
          where: { id: ac.id, storeId: 'ac-claim', emailStatus: 'queued' },
          data: { emailStatus: 'sent' },
        })
      )
    );
    expect(fin.reduce((n: number, r: any) => n + r.count, 0)).toBe(1);
  });

  it('the recovery coupon: 25 concurrent step-3 sends for one cart create ONE coupon and link it', async () => {
    const store = 'ac-coupon';
    const stub = stubFor(store);
    const c = clientFor(store);
    await stub.moneyOp(store, 'cancel', encodeRpc({ orderId: 'nope' })); // binds the store
    const cart = await c.cart.create({ data: { storeId: store, sessionId: 's1' } });
    const ac = await c.abandonedCart.create({
      data: {
        storeId: store,
        cartId: cart.id,
        sessionId: 's1',
        cartTotal: 1000,
        cartItemCount: 1,
        cartItems: [],
        status: 'step2_sent',
      },
    });
    const answers = await Promise.all(
      Array.from({ length: 25 }, () =>
        stub.moneyOp(
          store,
          'recoveryCoupon',
          encodeRpc({
            abandonedCartId: ac.id,
            code: 'RECOVER-ABC123',
            percent: 10,
            maxDiscount: null,
            expiresAt: Date.now() + 3_600_000,
          })
        )
      )
    );
    expect(answers.every(a => a.ok)).toBe(true);
    expect(
      await count(stub, `SELECT count(*) AS n FROM coupons WHERE code = 'RECOVER-ABC123'`)
    ).toBe(1);
    expect(
      await count(
        stub,
        `SELECT count(*) AS n FROM abandoned_carts a JOIN coupons c ON c.id = a.coupon_id WHERE a.id = '${ac.id}'`
      )
    ).toBe(1);
  });
});
