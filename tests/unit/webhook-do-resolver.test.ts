/**
 * Ruling CF-PAY-1 + WEBHOOK-SCOPE-1: the D1 entity-index resolver for a Durable Object store's webhook matches the Postgres
 * resolver (`ebda_webhook_resolve_store_scoped`): provider-scoped only, the URL's store decides, never a default.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setCfBindings } from '../../apps/api/src/cf/bindings';
import { resolveDoStoreFromWebhookRef } from '../../apps/api/src/lib/definer';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** A D1 double over the two tables the resolver reads: the entity index and the store directory flag (the one source). */
function d1(rows: Array<[string, string, string]>, doStores: string[]) {
  return {
    prepare: (sql: string) => ({
      all: async () => ({ results: doStores.map(id => ({ id })) }),
      bind: (...args: string[]) => ({
        first: async () => {
          if (/storage_backend FROM stores/.test(sql))
            return doStores.includes(args[0]) ? { storage_backend: 'do' } : null;
          const r = rows.find(x => x[0] === args[0] && x[1] === args[1]);
          return r ? { store_id: r[2] } : null;
        },
        run: async () => ({}),
      }),
    }),
  };
}
const withD1 = (rows: Array<[string, string, string]>, doStores: string[] = [A, B]) =>
  setCfBindings({ PLATFORM_DB: d1(rows, doStores) } as never);

afterEach(() => {
  setCfBindings(undefined as never);
});

describe('resolveDoStoreFromWebhookRef', () => {
  it('resolves a provider-scoped reference to its store', async () => {
    withD1([['webhook', 'paymob:T1', A]]);
    expect(await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: 'paymob' })).toBe(A);
    expect(await resolveDoStoreFromWebhookRef({ invoiceId: 'T1', provider: 'paymob' })).toBe(A);
  });

  it('the same reference string under another provider is not a match', async () => {
    withD1([['webhook', 'paymob:T1', A]]);
    expect(
      await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: 'fawry' })
    ).toBeNull();
  });

  it('an empty provider refuses, even when an unscoped payment row would match', async () => {
    withD1([
      ['webhook', 'paymob:T1', A],
      ['payment', 'T1', A],
    ]);
    expect(await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: '' })).toBeNull();
    expect(await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: null })).toBeNull();
    expect(await resolveDoStoreFromWebhookRef({ transactionId: 'T1' })).toBeNull();
  });

  it('never falls back to the unscoped payment kind for a gateway reference', async () => {
    withD1([['payment', 'T1', A]]);
    expect(
      await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: 'paymob' })
    ).toBeNull();
  });

  it('the same ref held by two stores resolves only inside the signed store', async () => {
    // the index is write-once per id: store A got there first, so B's delivery for the same string is NOT routed to A
    withD1([['webhook', 'paymob:SAME', A]]);
    expect(
      await resolveDoStoreFromWebhookRef({
        transactionId: 'SAME',
        provider: 'paymob',
        preferStoreId: A,
      })
    ).toBe(A);
    expect(
      await resolveDoStoreFromWebhookRef({
        transactionId: 'SAME',
        provider: 'paymob',
        preferStoreId: B,
      })
    ).toBeNull();
  });

  it('a URL that names another store than the index row refuses (same answer as unknown)', async () => {
    withD1([['webhook', 'paymob:T1', A]]);
    expect(
      await resolveDoStoreFromWebhookRef({
        transactionId: 'T1',
        provider: 'paymob',
        preferStoreId: B,
      })
    ).toBeNull();
  });

  it('a store the D1 flag does not list is never routed', async () => {
    withD1([['webhook', 'paymob:T1', '33333333-3333-4333-8333-333333333333']]);
    expect(
      await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: 'paymob' })
    ).toBeNull();
  });

  it('no flagged store at all means no D1 lookup', async () => {
    withD1([['webhook', 'paymob:T1', A]], []);
    expect(
      await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: 'paymob' })
    ).toBeNull();
  });

  it('a store flipped ONLY in D1 (env list empty) is resolved: D1 is the one source', async () => {
    withD1([['webhook', 'paymob:T1', A]], [A]);
    expect(await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: 'paymob' })).toBe(A);
  });

  it('a store listed only in the env is NOT routed once D1 is bound', async () => {
    process.env.STORE_DO_ENABLED_IDS = A;
    try {
      withD1([['webhook', 'paymob:T1', A]], []);
      expect(
        await resolveDoStoreFromWebhookRef({ transactionId: 'T1', provider: 'paymob' })
      ).toBeNull();
    } finally {
      delete process.env.STORE_DO_ENABLED_IDS;
    }
  });
});
