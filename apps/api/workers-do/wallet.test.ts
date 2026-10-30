import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';

// INFRA-CF-1 R3 (Ruling WALLET-GL-1): wallet movements and their GL half on real workerd. The Postgres wallet row lock
// (`FOR UPDATE`) is the DO's single thread: concurrent debits cannot overdraw, a replayed key moves money and posts once.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO> };
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: ReturnType<typeof stubFor>, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const num = (stub: ReturnType<typeof stubFor>, sql: string) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql).one().n as number);
const codes = (a: Answer[]) =>
  a.reduce<Record<string, number>>((m, x) => {
    const k = x.ok ? 'ok' : x.code;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

async function seed(store: string) {
  const stub = stubFor(store);
  await op(stub, store, 'cancel', { orderId: 'nope' }); // binds the store
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT OR REPLACE INTO store_config (store_id, accounting_enabled) VALUES (?, 1)`,
      store
    );
    s.storage.sql.exec(
      `INSERT INTO customers (id, store_id, first_name, last_name, user_id) VALUES ('crm-c1', ?, 'A', 'B', 'c1')`,
      store
    );
  });
  return stub;
}
const entry = (
  stub: ReturnType<typeof stubFor>,
  store: string,
  amount: number,
  key: string,
  type = 'admin_adjust'
) => op(stub, store, 'walletEntry', { customerId: 'c1', amount, type, idempotencyKey: key });

describe('wallet entries on the store DO', () => {
  it('20 concurrent debits of 300 against a balance of 1000 apply 3 times, the rest are refused, 2150 equals the balance', async () => {
    const store = 'wal-conc';
    const stub = await seed(store);
    expect((await entry(stub, store, 1_000, 'seed')).ok).toBe(true);
    const r = await Promise.all(
      Array.from({ length: 20 }, (_, i) => entry(stub, store, -300, `d${i}`))
    );
    expect(codes(r)).toEqual({ ok: 3, INSUFFICIENT_WALLET_BALANCE: 17 });
    expect(await num(stub, 'SELECT balance n FROM customer_wallets')).toBe(100);
    expect(
      await num(
        stub,
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) n FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '2150'`
      )
    ).toBe(100);
    expect(await num(stub, 'SELECT COUNT(*) n FROM journal_entries')).toBe(4);
  });

  it('20 concurrent replays of one key move the balance and post the journal once', async () => {
    const store = 'wal-replay';
    const stub = await seed(store);
    const r = await Promise.all(Array.from({ length: 20 }, () => entry(stub, store, 500, 'same')));
    expect(codes(r)).toEqual({ ok: 20 });
    expect(await num(stub, 'SELECT balance n FROM customer_wallets')).toBe(500);
    expect(await num(stub, 'SELECT COUNT(*) n FROM wallet_transactions')).toBe(1);
    expect(await num(stub, 'SELECT COUNT(*) n FROM journal_entries')).toBe(1);
  });
});
