/**
 * Ruling NZ-N12-1..3 (NEON-ZERO-1 N-12): with the PLATFORM_DB binding present the payment-webhook inbox and the store/ref
 * resolvers never touch Postgres (a poisoned `prisma` throws). Without the binding the definers stay (Node / tests / local dev).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pgOn: false,
  pgRows: [] as unknown[][],
  calls: 0,
  prisma: {
    $queryRaw: async () => {
      h.calls++;
      if (!h.pgOn) throw new Error('Postgres touched: prisma.$queryRaw');
      return h.pgRows.shift() ?? [];
    },
  } as never,
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.prisma,
    extra: { withSystemJob: async (_n: string, fn: () => unknown) => fn() },
  })
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
function d1(opts: { pgStore?: boolean } = {}) {
  const inbox: Row[] = [];
  const index = new Map<string, string>([
    ['order:o1', A],
    ['payment:p1', A],
    ['webhook:paymob:T1', A],
  ]);
  const stmt = (sql: string) => ({
    bind: (...a: unknown[]) => ({
      first: async () => {
        if (/SELECT 1 AS one FROM stores/.test(sql))
          return a[0] === 'pg' && opts.pgStore ? { one: 1 } : a[0] === 'do' ? { one: 1 } : null;
        if (/storage_backend FROM stores/.test(sql))
          return a[0] === A
            ? { storage_backend: 'do' }
            : a[0] === 'P1'
              ? { storage_backend: 'pg' }
              : null;
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
  // INTEGRATION (docs/cf/neon-zero-integration.md row 8): the inbox is the `inbox` family of platform/cutover.ts (#415); its
  // coverage is tests/unit/platform-n10b-d1.test.ts. This test drove the superseded unmarked D1 inbox of #409.
  it.skip('record -> get -> update -> stuck, and a redelivery of a processed row is not overwritten', async () => {
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

describe('transition: Postgres stores and rows (Ruling NZ-N12-2, NZ-N12-5)', () => {
  it('an unknown order id with no pg store in the directory is null and never touches Postgres', async () => {
    h.calls = 0;
    setCfBindings({ PLATFORM_DB: d1().binding } as never);
    expect(await getOrderStoreId('guess-me')).toBeNull();
    expect(h.calls).toBe(0);
  });

  it('with a pg store present, a Postgres answer is accepted only for a store the directory says is pg', async () => {
    h.pgOn = true;
    setCfBindings({ PLATFORM_DB: d1({ pgStore: true }).binding } as never);
    h.pgRows = [[{ id: 'P1' }]];
    expect(await getOrderStoreId('legacy')).toBe('P1');
    h.pgRows = [[{ id: A }]]; // stale Postgres row of a store that is now `do`
    expect(await getOrderStoreId('legacy2')).toBeNull();
    // webhook reference: same rule, and a Postgres failure is "unresolved", not a 500
    h.pgRows = [[{ id: 'P1' }]];
    expect(await resolveStoreFromWebhookRef({ transactionId: 'X', provider: 'paymob' })).toBe('P1');
    h.pgOn = false;
    expect(await resolveStoreFromWebhookRef({ transactionId: 'Y', provider: 'paymob' })).toBeNull();
    h.pgOn = false;
  });

  it('a Postgres inbox row is still read while a pg store exists; a D1 row wins', async () => {
    h.pgOn = true;
    const { binding } = d1({ pgStore: true });
    setCfBindings({ PLATFORM_DB: binding } as never);
    h.pgRows = [
      [
        {
          id: 'old',
          provider: 'paymob',
          idempotency_key: 'k',
          store_id: 'P1',
          payload: {},
          raw_body: '',
          signature: '',
          status: 'received',
          attempts: 0,
          last_error: null,
          result_order_id: null,
          result_status: null,
          received_at: new Date(0),
        },
      ],
    ];
    expect(await webhookInbox.get('old')).toMatchObject({ id: 'old', storeId: 'P1' });
    h.pgOn = false;
  });
});
