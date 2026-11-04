/**
 * Ruling NZ-N12-1..3 (NEON-ZERO-1 N-12): with the PLATFORM_DB binding present the payment-webhook inbox and the store/ref
 * resolvers never touch Postgres (a poisoned `prisma` throws). Without the binding the definers stay (Node / tests / local dev).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`Postgres touched: prisma.${String(p)}`);
      },
    }
  ),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({ prisma: h.prisma })
);

import { setCfBindings } from '../../apps/api/src/cf/bindings';
import {
  getOrderStoreId,
  getPaymentStoreId,
  resolveStoreFromWebhookRef,
  storefrontForStoreId,
  webhookInbox,
} from '../../apps/api/src/lib/definer';

const A = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;
/** A tiny D1 double: the inbox table as an array, the entity index and the store flag as maps. */
function d1() {
  const inbox: Row[] = [];
  const index = new Map<string, string>([
    ['order:o1', A],
    ['payment:p1', A],
    ['webhook:paymob:T1', A],
  ]);
  const stmt = (sql: string) => ({
    bind: (...a: unknown[]) => ({
      first: async () => {
        if (/storage_backend FROM stores/.test(sql))
          return a[0] === A ? { storage_backend: 'do' } : null;
        if (/FROM entity_index/.test(sql)) {
          const s = index.get(`${a[0]}:${a[1]}`);
          return s ? { store_id: s } : null;
        }
        if (/SELECT id FROM webhook_events WHERE idempotency_key/.test(sql))
          return inbox.find(r => r.idempotency_key === a[0]) ?? null;
        if (/SELECT \* FROM webhook_events WHERE id/.test(sql))
          return inbox.find(r => r.id === a[0]) ?? null;
        if (/SELECT slug, domain, domain_status FROM stores/.test(sql))
          return a[0] === A
            ? { slug: 'shop', domain: 'shop.example', domain_status: 'pending' }
            : null;
        if (/count\(\*\)/.test(sql)) return { n: inbox.length };
        return null;
      },
      all: async () => {
        if (/FROM webhook_events/.test(sql) && /received_at </.test(sql))
          return { results: inbox.filter(r => (r.received_at as number) < (a[0] as number)) };
        if (/FROM webhook_events/.test(sql)) return { results: inbox };
        return { results: [{ id: A }] };
      },
      run: async () => {
        if (/^INSERT INTO webhook_events/.test(sql)) {
          const hit = inbox.find(r => r.idempotency_key === a[2]);
          if (hit) {
            if (hit.status !== 'processed') Object.assign(hit, { payload: a[4], raw_body: a[5] });
          } else
            inbox.push({
              id: a[0],
              provider: a[1],
              idempotency_key: a[2],
              store_id: a[3],
              payload: a[4],
              raw_body: a[5],
              signature: a[6],
              status: 'received',
              attempts: 0,
              last_error: null,
              result_order_id: null,
              result_status: null,
              received_at: 1000,
            });
          return { meta: { changes: 1 } };
        }
        if (/^UPDATE webhook_events/.test(sql)) {
          const r = inbox.find(x => x.id === a[0]);
          if (!r) return { meta: { changes: 0 } };
          if (a[7]) Object.assign(r, { status: 'received', attempts: 0, last_error: null });
          else {
            if (a[1]) r.status = a[1];
            if (a[3]) r.attempts = (r.attempts as number) + 1;
            if (a[4])
              Object.assign(r, { result_order_id: a[5], result_status: a[6], last_error: null });
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    }),
    all: async () => ({ results: [{ id: A }] }),
  });
  return { inbox, binding: { prepare: stmt } };
}

afterEach(() => setCfBindings(undefined as never));

describe('webhook inbox on D1 (PG poisoned)', () => {
  it('record -> get -> update -> stuck, and a redelivery of a processed row is not overwritten', async () => {
    const { binding, inbox } = d1();
    setCfBindings({ PLATFORM_DB: binding } as never);
    const id = await webhookInbox.record({
      provider: 'paymob',
      idempotencyKey: 'k1',
      storeId: A,
      payload: { a: 1 },
      rawBody: '{"a":1}',
      signature: 's',
    });
    expect(await webhookInbox.get(id)).toMatchObject({
      id,
      provider: 'paymob',
      storeId: A,
      payload: { a: 1 },
    });
    expect(await webhookInbox.update(id, { status: 'processing', incrementAttempts: true })).toBe(
      true
    );
    expect(inbox[0]).toMatchObject({ status: 'processing', attempts: 1 });
    expect(
      await webhookInbox.update(id, {
        markProcessed: { resultOrderId: 'o1', resultStatus: 'completed' },
      })
    ).toBe(true);
    expect(inbox[0]).toMatchObject({ result_order_id: 'o1', result_status: 'completed' });
    expect(await webhookInbox.update('missing', { status: 'x' })).toBe(false);
    expect((await webhookInbox.stuck(new Date(5000), 10)).map(r => r.id)).toEqual([id]);
  });
});

describe('store resolvers on D1 (PG poisoned)', () => {
  it('a webhook reference resolves from the index alone; an unknown one is null, not a Postgres lookup', async () => {
    setCfBindings({ PLATFORM_DB: d1().binding } as never);
    expect(await resolveStoreFromWebhookRef({ transactionId: 'T1', provider: 'paymob' })).toBe(A);
    expect(
      await resolveStoreFromWebhookRef({ transactionId: 'nope', provider: 'paymob' })
    ).toBeNull();
    expect(await resolveStoreFromWebhookRef({ transactionId: 'T1' })).toBeNull();
  });
  it('an order and a payment id of a DO store resolve from the index; the callback storefront comes from D1 (inactive domain hidden)', async () => {
    setCfBindings({ PLATFORM_DB: d1().binding } as never);
    expect(await getOrderStoreId('o1')).toBe(A);
    expect(await getPaymentStoreId('p1')).toBe(A);
    expect(await storefrontForStoreId(A)).toEqual({ slug: 'shop', domain: null });
    expect(await storefrontForStoreId('other')).toBeNull();
  });
});
