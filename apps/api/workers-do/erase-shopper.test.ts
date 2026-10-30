import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 R6a (Ruling CF-R6A-3) on real workerd, no Postgres. The Postgres function ran in one transaction; the DO runs the
// store-owned half in ONE section. Many concurrent erasures of one shopper (a double submit, a retention-cron retry racing a
// self-service request) must converge: the wallet is written off ONCE, the send cap never shrinks, nothing is half-erased.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer =
  | { ok: true; json: string }
  | { ok: false; code: string; status: number; message?: string };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const rows = <T>(stub: ReturnType<typeof stubFor>, sql: string, ...b: unknown[]) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql, ...b).toArray() as T[]);

const HOUR = 3_600_000;
async function seeded(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
  const now = Date.now();
  const x = (sql: string, ...b: unknown[]) => rows(stub, sql, ...b);
  await x(
    "INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, shipping_address, billing_address, customer_notes, buyer_key, created_at, updated_at) VALUES ('o1', ?, 'u1', 'EB-1', 1000, 1500, '{\"phone\":\"+201011111111\"}', '{}', 'note', ?, 1, 1)",
    store,
    'a'.repeat(64)
  );
  await x(
    "INSERT INTO customer_wallets (id, store_id, customer_id, balance, created_at, updated_at) VALUES ('w1', ?, 'u1', 500, 1, 1)",
    store
  );
  await x(
    "INSERT INTO wallet_transactions (id, store_id, wallet_id, customer_id, amount, balance_after, type, idempotency_key, note, created_at) VALUES ('t1', ?, 'w1', 'u1', 500, 500, 'admin_adjust', 'k1', 'goodwill', 1)",
    store
  );
  await x(
    "INSERT INTO campaigns (id, store_id, name, subject, body_html, status, created_at, updated_at) VALUES ('c1', ?, 'c', 's', '<p>x</p>', 'sent', 1, 1), ('c2', ?, 'c', 's', '<p>x</p>', 'sent', 1, 1)",
    store,
    store
  );
  await x(
    "INSERT INTO campaign_recipients (id, campaign_id, store_id, email, locale, status, sent_at, provider_message_id, error) VALUES ('r1', 'c1', ?, 'shop@example.test', 'en', 'sent', ?, 'm1', 'e'), ('r2', 'c2', ?, 'shop@example.test', 'en', 'sent', ?, 'm0', NULL)",
    store,
    now - HOUR,
    store,
    now - 3 * 86_400_000
  );
  await x(
    "INSERT INTO newsletter_subscribers (id, store_id, email, subscribed_at, is_active) VALUES ('n1', ?, 'shop@example.test', 1, 1)",
    store
  );
  return stub;
}
const args = {
  userId: 'u1',
  role: 'customer',
  email: 'Shop@Example.test',
  phone: '+201011111111',
  smsPhoneKey: '201011111111',
  provenBuyerKey: null,
  actorId: 'system',
  capWindowMs: 86_400_000,
};
const capCount = (stub: ReturnType<typeof stubFor>, since: number) =>
  rows<{ n: number }>(
    stub,
    'SELECT count(*) AS n FROM campaign_recipients WHERE sent_at >= ?',
    since
  ).then(r => r[0].n);

describe('shopper erasure on the store DO', () => {
  it('20 concurrent erasures: one wallet write-off, the in-window mail anonymised (cap intact), the order pseudonymised', async () => {
    const store = 'es-race';
    const stub = await seeded(store);
    const since = Date.now() - 86_400_000;
    expect(await capCount(stub, since)).toBe(1);
    const r = await Promise.all(
      Array.from({ length: 20 }, () => op(stub, store, 'eraseShopper', args))
    );
    expect(r.filter(a => !a.ok)).toEqual([]);
    const forfeits = r.map(
      a => decodeRpc<{ walletForfeited: number }>((a as { json: string }).json).walletForfeited
    );
    expect(forfeits.reduce((s, n) => s + n, 0)).toBe(500);
    expect(
      await rows(stub, "SELECT id FROM wallet_transactions WHERE type = 'expire'")
    ).toHaveLength(1);
    expect(await rows(stub, 'SELECT balance FROM customer_wallets')).toEqual([{ balance: 0 }]);
    expect(await rows(stub, "SELECT note FROM wallet_transactions WHERE id = 't1'")).toEqual([
      { note: null },
    ]);
    // the send cap still counts the mail sent an hour ago, as a tombstone; the old and the unsent are gone
    expect(await capCount(stub, since)).toBe(1);
    const rec = await rows<Record<string, unknown>>(
      stub,
      'SELECT id, email, provider_message_id, error FROM campaign_recipients'
    );
    expect(rec).toEqual([
      { id: 'r1', email: 'erased-r1@anonymized.local', provider_message_id: null, error: null },
    ]);
    expect(await rows(stub, 'SELECT id FROM newsletter_subscribers')).toEqual([]);
    const o = await rows<Record<string, unknown>>(
      stub,
      'SELECT customer_id, shipping_address, customer_notes, buyer_key, total FROM orders'
    );
    expect(o).toEqual([
      {
        customer_id: null,
        shipping_address: '{"anonymized":true}',
        customer_notes: null,
        buyer_key: null,
        total: 1500,
      },
    ]);
  });

  it('a replay returns the SAVED scope (orders already unlinked), so the caller can finish what a failed first attempt left', async () => {
    const store = 'es-replay';
    const stub = await seeded(store);
    const first = decodeRpc<{
      orders: unknown[];
      replayed: boolean;
      provenBuyerKey: string | null;
    }>(
      (
        (await op(stub, store, 'eraseShopper', { ...args, provenBuyerKey: 'b'.repeat(64) })) as {
          json: string;
        }
      ).json
    );
    expect(first).toMatchObject({ replayed: false, provenBuyerKey: 'b'.repeat(64) });
    expect(first.orders).toHaveLength(1);
    expect(await rows(stub, 'SELECT customer_id FROM orders')).toEqual([{ customer_id: null }]);
    // the retry has no linked order and no proof left; the ledger supplies both
    const again = decodeRpc<typeof first & { receiptIds: string[] }>(
      ((await op(stub, store, 'eraseShopper', args)) as { json: string }).json
    );
    expect(again).toMatchObject({ replayed: true, provenBuyerKey: 'b'.repeat(64) });
    expect(again.orders).toEqual(first.orders);
    expect(await rows(stub, 'SELECT user_id FROM erasure_ledger')).toEqual([{ user_id: 'u1' }]);
  });

  it('an admin role is refused and nothing changes', async () => {
    const store = 'es-admin';
    const stub = await seeded(store);
    const a = await op(stub, store, 'eraseShopper', { ...args, role: 'super_admin' });
    expect(a).toMatchObject({ ok: false, code: 'FORBIDDEN', status: 403 });
    expect(await rows(stub, 'SELECT balance FROM customer_wallets')).toEqual([{ balance: 500 }]);
    expect(await rows(stub, 'SELECT customer_id FROM orders')).toEqual([{ customer_id: 'u1' }]);
  });
});
