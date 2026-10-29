import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 PR D2b (Ruling CF-MONEY-1): money operations on real workerd. The DO is single threaded, so an earn and its
// idempotency check are one step: many concurrent requests for the same order can never credit twice, with NO row lock.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (
  stub: ReturnType<typeof stubFor>,
  store: string,
  name: string,
  args: object,
  key?: string
) => (await stub.moneyOp(store, name, encodeRpc(args), key)) as Answer;

async function seed(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'loyaltyReverseEarned', { orderId: 'nope' }); // binds the store
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO store_config (store_id, loyalty_enabled, loyalty_settings) VALUES (?, 1, '{}')`,
      store
    );
    state.storage.sql.exec(
      `INSERT INTO orders (id, store_id, customer_id, order_number, status, payment_status, subtotal, total, shipping_address, billing_address)
       VALUES ('o1', ?, 'c1', 'N1', 'delivered', 'paid', 10000, 10000, '{}', '{}')`,
      store
    );
  });
  return stub;
}
const count = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).one().n as number);

describe('StoreDO.moneyOp', () => {
  it('50 concurrent earns for one order credit it exactly once', async () => {
    const stub = await seed('money-race');
    const answers = await Promise.all(
      Array.from({ length: 50 }, () =>
        op(stub, 'money-race', 'loyaltyEarn', {
          customerId: 'c1',
          orderId: 'o1',
          featureEnabled: true,
        })
      )
    );
    expect(answers.every(a => a.ok)).toBe(true);
    const earned = answers.map(
      a => decodeRpc<{ pointsEarned: number }>((a as { json: string }).json).pointsEarned
    );
    expect(earned.filter(p => p > 0)).toEqual([100]);
    expect(
      await count(
        stub,
        `SELECT count(*) AS n FROM loyalty_transactions WHERE type = 'earn_purchase'`
      )
    ).toBe(1);
    expect(await count(stub, `SELECT points AS n FROM loyalty_points`)).toBe(100);
  });

  it('the same key fired 20 times applies once; a refusal is an answer, never a throw', async () => {
    const stub = await seed('money-key');
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        op(
          stub,
          'money-key',
          'loyaltyEarn',
          { customerId: 'c1', orderId: 'o1', featureEnabled: true },
          'earn:o1:loyalty'
        )
      )
    );
    expect(new Set(answers.map(a => (a as { json: string }).json)).size).toBe(1);
    expect(await count(stub, 'SELECT count(*) AS n FROM _money_ops')).toBe(1);
    const refused = await op(stub, 'money-key', 'loyaltyEarn', {
      customerId: 'c1',
      orderId: 'gone',
      featureEnabled: true,
    });
    expect(refused).toMatchObject({ ok: false, code: 'ORDER_NOT_FOUND', status: 404 });
    // the store id is bound on first use: another id on the same Durable Object is refused
    const other = await op(stub, 'money-other', 'loyaltyEarn', {});
    expect(other).toMatchObject({ ok: false, code: 'STORE_MISMATCH' });
  });
});
