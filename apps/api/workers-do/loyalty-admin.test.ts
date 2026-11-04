import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// L-1 (Ruling FP-2) on real workerd: a manual award lands in the ledger the DO redeem reads, so the members list equals what
// was earned and an award is spendable. The DO is single threaded: concurrent awards each apply once and never lose an update.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const data = <T>(a: Answer): T => decodeRpc<T>((a as { json: string }).json);

async function seed(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'loyaltyReverseEarned', { orderId: 'nope' }); // binds the store
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO store_config (store_id, loyalty_enabled, loyalty_settings) VALUES (?, 1, '{"minRedeemPoints":50}')`,
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

describe('StoreDO loyalty admin ops (L-1)', () => {
  it('earn, then award, then the members list shows both', async () => {
    const stub = await seed('loy-admin');
    await op(stub, 'loy-admin', 'loyaltyEarn', {
      customerId: 'c1',
      orderId: 'o1',
      featureEnabled: true,
    });
    const award = await op(stub, 'loy-admin', 'loyaltyAward', {
      customerId: 'c1',
      points: 50,
      type: 'earn_manual',
      featureEnabled: true,
    });
    expect(data<{ newBalance: number }>(award).newBalance).toBe(150);
    const members = data<{ members: Array<{ points: number }> }>(
      await op(stub, 'loy-admin', 'loyaltyMembers', {})
    );
    expect(members.members.map(m => m.points)).toEqual([150]);
  });

  it('25 concurrent awards of 10 points add exactly 250', async () => {
    const stub = await seed('loy-race');
    const answers = await Promise.all(
      Array.from({ length: 25 }, () =>
        op(stub, 'loy-race', 'loyaltyAward', {
          customerId: 'c1',
          points: 10,
          type: 'earn_manual',
          featureEnabled: true,
        })
      )
    );
    expect(answers.every(a => a.ok)).toBe(true);
    const stats = data<{ totalPointsIssued: number; outstandingPoints: number }>(
      await op(stub, 'loy-race', 'loyaltyStats', {})
    );
    expect(stats).toMatchObject({ totalPointsIssued: 250, outstandingPoints: 250 });
  });

  it('a refusal is an answer: awards are off when the platform flag is off', async () => {
    const stub = await seed('loy-off');
    const r = await op(stub, 'loy-off', 'loyaltyAward', {
      customerId: 'c1',
      points: 10,
      type: 'earn_manual',
      featureEnabled: false,
    });
    expect(r).toMatchObject({ ok: false, code: 'LOYALTY_DISABLED', status: 400 });
  });
});
