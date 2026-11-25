// Ported from tests/integration/merchant-webhooks.test.ts (Postgres, ebda_app): the two cases that had no DO/unit twin.
// (fan-out to the event store only, dedupe per key, replay with a new endpoint, tenant isolation, the 50-row cap are covered by
// tests/unit/webhook-service.test.ts.) Here, on the real StoreDO schema (node:sqlite): M10 erasure strips `data.customer` from the
// erased shopper's stored deliveries only (this store, those orders / that email), keeps the order record; and deleting an
// endpoint cascades its deliveries (the composite FK).
import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { eraseShopper } from '../src/do/erase-shopper';
import { ensureCustomerAuthSchema } from '../src/do/customer-auth';
import { ensureReceiptSchema } from '../src/do/instapay-receipts';

vi.mock('@ebda/shared', async () => await import('../../shared/src/region'));

function rig() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureCustomerAuthSchema(db);
  ensureReceiptSchema(db);
  const x = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...(p as never[]));
  const all = (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as any[];
  for (const s of ['s1', 's2']) {
    x(
      `INSERT INTO webhook_endpoints (id, store_id, url, events, include_customer, secret_enc, secret_hint) VALUES ('ep-${s}', '${s}', 'https://hooks.example.com/x', '["order.created"]', 1, 'enc', 'abcd')`
    );
    x(
      `INSERT INTO webhook_deliveries (id, store_id, endpoint_id, event_id, event_type, dedupe_key, payload) VALUES ('d-${s}', '${s}', 'ep-${s}', 'evt-${s}', 'order.created', 'k', ?)`,
      JSON.stringify({
        data: {
          order: { id: 'o-shared' },
          customer: { name: 'A', email: 'a@x.co', phone: '1' },
        },
      })
    );
  }
  x(`INSERT INTO customers (id, store_id, first_name, last_name) VALUES ('a', 's1', 'A', 'A')`);
  return { raw, db, x, all };
}
const erase = (db: ReturnType<typeof rig>['db'], over: Record<string, unknown> = {}) =>
  eraseShopper(db, {
    storeId: 's1',
    userId: 'a',
    role: 'customer',
    email: 'a@x.co',
    phone: null,
    smsPhoneKey: null,
    provenBuyerKey: null,
    actorId: 'a',
    capWindowMs: 1000,
    now: 1_700_000_000_000,
    ...over,
  } as never);
const payload = (r: ReturnType<typeof rig>, id: string) =>
  JSON.parse(r.all('SELECT payload FROM webhook_deliveries WHERE id = ?', id)[0].payload);

describe('webhook delivery log vs shopper erasure on the StoreDO schema (review M10, Ruling WH-7)', () => {
  it('strips data.customer from this store only, keeps the order record', () => {
    const r = rig();
    r.x(
      `INSERT INTO orders (id, store_id, customer_id, order_number, subtotal, total, shipping_address, billing_address) VALUES ('o-shared', 's1', 'a', 'ORD-1', 100, 100, '{}', '{}')`
    );
    erase(r.db);
    const a = payload(r, 'd-s1');
    expect(a.data.customer).toBeUndefined();
    expect(a.data.order.id).toBe('o-shared');
    expect(payload(r, 'd-s2').data.customer).toEqual({ name: 'A', email: 'a@x.co', phone: '1' });
  });

  it('a delivery for another shopper in the same store keeps its customer block', () => {
    const r = rig();
    r.x(
      `INSERT INTO webhook_deliveries (id, store_id, endpoint_id, event_id, event_type, dedupe_key, payload) VALUES ('d-other', 's1', 'ep-s1', 'evt-o', 'order.created', 'k2', ?)`,
      JSON.stringify({ data: { order: { id: 'o-9' }, customer: { email: 'b@x.co' } } })
    );
    erase(r.db);
    expect(payload(r, 'd-s1').data.customer).toBeUndefined(); // matched by the erased email
    expect(payload(r, 'd-other').data.customer).toEqual({ email: 'b@x.co' });
  });

  it('deleting an endpoint cascades its deliveries (composite FK), and only its own', () => {
    const r = rig();
    r.x(`DELETE FROM webhook_endpoints WHERE id = 'ep-s1'`);
    const left = r.all('SELECT id FROM webhook_deliveries').map(x => x.id);
    expect(left).toEqual(['d-s2']);
  });
});
