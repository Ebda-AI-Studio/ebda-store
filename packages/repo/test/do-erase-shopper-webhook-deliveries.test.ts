// Ruling WH-7 (ported from tests/unit/webhook-erasure.test.ts + webhook-erasure-order.test.ts, which only asserted the retired
// relational statement): erasing a shopper strips `data.customer` from the stored webhook deliveries of THEIR orders and of any
// delivery naming their e-mail, and from no other shopper's. Order id / totals stay (the merchant's accounting record).
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { eraseShopper } from '../src/do/erase-shopper';
import { ensureCustomerAuthSchema } from '../src/do/customer-auth';
import { ensureReceiptSchema } from '../src/do/instapay-receipts';

vi.mock('@ebda/shared', async () => await import('../../shared/src/region'));

const erase = (db: ReturnType<typeof nodeSyncSql>, over: Record<string, unknown> = {}) =>
  eraseShopper(db, {
    storeId: 's1',
    userId: 'a',
    role: 'customer',
    email: 'A@x.co',
    phone: null,
    smsPhoneKey: null,
    provenBuyerKey: null,
    actorId: 'a',
    capWindowMs: 1000,
    now: 1_700_000_000_000,
    ...over,
  } as never);

function world() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureCustomerAuthSchema(db);
  ensureReceiptSchema(db);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('a', 's1', 'A', 'A')`);
  x(
    `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, shipping_address, billing_address) VALUES ('oA', 's1', 'a', 'ORD-A1', 100, 100, '{}', '{}')`
  );
  x(
    `INSERT INTO webhook_endpoints (id, store_id, url, events, secret_enc, secret_hint) VALUES ('e1', 's1', 'https://m.example/h', '[]', 'x', 'x')`
  );
  const delivery = (id: string, orderId: string, email: string) =>
    x(
      `INSERT INTO webhook_deliveries (id, store_id, endpoint_id, event_id, event_type, payload) VALUES (?, 's1', 'e1', ?, 'order.created', ?)`,
      id,
      `ev-${id}`,
      JSON.stringify({
        data: {
          order: { id: orderId, total: 100 },
          customer: { email, name: 'N', phone: '010' },
        },
      })
    );
  const payload = (id: string) =>
    JSON.parse(
      (
        raw.prepare(`SELECT payload FROM webhook_deliveries WHERE id = ?`).get(id) as {
          payload: string;
        }
      ).payload
    ) as { data: { order?: { id: string; total: number }; customer?: unknown } };
  return { db, delivery, payload };
}

describe('erase shopper: webhook_deliveries (WH-7)', () => {
  it("removes data.customer from the shopper's order deliveries and from deliveries naming their e-mail, keeps the order record", () => {
    const w = world();
    w.delivery('byOrder', 'oA', 'someone-else@x.co'); // matched through the erased order id
    w.delivery('byEmail', 'oOther', 'a@X.co'); // matched through the e-mail, case-insensitively
    erase(w.db);
    for (const id of ['byOrder', 'byEmail']) {
      expect(w.payload(id).data.customer).toBeUndefined();
      expect(w.payload(id).data.order!.total).toBe(100);
    }
  });

  it("never touches another shopper's delivery", () => {
    const w = world();
    w.delivery('mine', 'oA', 'a@x.co');
    w.delivery('other', 'oB', 'b@x.co');
    erase(w.db);
    expect(w.payload('mine').data.customer).toBeUndefined();
    expect(w.payload('other').data.customer).toMatchObject({ email: 'b@x.co' });
  });

  it('a shopper with no orders and no e-mail matches nothing', () => {
    const w = world();
    w.delivery('d1', 'oZ', 'b@x.co');
    erase(w.db, { email: null, userId: 'nobody' });
    expect(w.payload('d1').data.customer).toMatchObject({ email: 'b@x.co' });
  });
});
