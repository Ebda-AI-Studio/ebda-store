/**
 * Ruling NZ-INTEG-1: ONE scope resolver for `withStore` / `withUser` / `acrossStores` calls that have no ambient transaction
 * (reconciles NZ-TX-2 and NZ-C-3). A store served by its Durable Object, or a user scope once the platform data is on D1,
 * opens NO Postgres transaction; a Postgres store keeps BEGIN + set_config (tenant scoping never skipped); the user is carried
 * in both shapes; an unreadable decision throws instead of guessing Postgres.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acrossStores,
  prisma,
  runWithRequestDb,
  setScopeResolver,
  storeDirectory,
  withHiddenStores,
  withStore,
  withUser,
  type ScopeResolver,
} from '../index';

const PG_STORE = '11111111-1111-4111-8111-111111111111';
const DO_STORE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function fakeClient() {
  const log = { transactions: 0, gucs: [] as string[] };
  const tx = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      log.gucs.push(`${sql} <- ${params.join(',')}`);
      return [];
    },
  };
  const client = {
    $disconnect: async () => undefined,
    $transaction: async (cb: (t: typeof tx) => unknown) => {
      log.transactions++;
      return cb(tx);
    },
  };
  return { client: client as never, log };
}

const resolver = (over: Partial<ScopeResolver> = {}): ScopeResolver => ({
  lazyForStore: async id => id === DO_STORE,
  lazyForUser: () => true,
  ...over,
});

const run = <T>(f: () => Promise<T>) => {
  const fake = fakeClient();
  return runWithRequestDb(() => fake.client, f).then(value => ({ value, ...fake }));
};

afterEach(() => setScopeResolver(undefined));

describe('scope resolver (one implementation)', () => {
  it('unregistered: every call keeps the Postgres transaction and its store GUC', async () => {
    const { log } = await run(() => withStore(PG_STORE, async () => 1));
    expect(log.transactions).toBe(1);
    expect(log.gucs.join('|')).toContain(PG_STORE);
  });

  it('a Durable Object store opens NO Postgres transaction; a Postgres store keeps BEGIN + set_config', async () => {
    setScopeResolver(resolver());
    const lazy = await run(() => withStore(DO_STORE, async () => 'do'));
    expect(lazy.value).toBe('do');
    expect(lazy.log.transactions).toBe(0);
    const pg = await run(() => withStore(PG_STORE, async () => 'pg'));
    expect(pg.log.transactions).toBe(1);
    expect(pg.log.gucs.join('|')).toContain(PG_STORE);
  });

  it('a lazy store scope still tenant-scopes every Postgres query it makes (its own short transaction + GUC)', async () => {
    setScopeResolver(resolver());
    const { log } = await run(() =>
      withStore(DO_STORE, async () =>
        (prisma as never as { $queryRawUnsafe(s: string): Promise<unknown> }).$queryRawUnsafe(
          'select 1'
        )
      )
    );
    expect(log.transactions).toBe(1);
    expect(log.gucs.join('|')).toContain(DO_STORE);
  });

  it('withUser: lazy user scope carries the user into each query; the non-lazy one opens a user transaction', async () => {
    setScopeResolver(resolver());
    const lazy = await run(() =>
      withUser(USER, async () =>
        (prisma as never as { $queryRawUnsafe(s: string): Promise<unknown> }).$queryRawUnsafe(
          'select 1'
        )
      )
    );
    expect(lazy.log.transactions).toBe(1); // only the query's own short transaction, not a request-long one
    expect(lazy.log.gucs.join('|')).toContain(USER);
    setScopeResolver(resolver({ lazyForUser: () => false }));
    const tx = await run(() => withUser(USER, async () => 1));
    expect(tx.log.transactions).toBe(1);
    expect(tx.log.gucs.join('|')).toContain(USER);
  });

  it('withUser with a DO store: no transaction; with a Postgres store: transaction carrying store and user', async () => {
    setScopeResolver(resolver());
    expect((await run(() => withUser(USER, async () => 1, DO_STORE))).log.transactions).toBe(0);
    const pg = await run(() => withUser(USER, async () => 1, PG_STORE));
    expect(pg.log.transactions).toBe(1);
    expect(pg.log.gucs.join('|')).toContain(PG_STORE);
    expect(pg.log.gucs.join('|')).toContain(USER);
  });

  it('acrossStores decides per store with the same rule and lists the FULL directory when unfiltered (no cap)', async () => {
    const entry = (id: string) => ({
      id,
      slug: id,
      name: id,
      status: 'active',
      plan: 'starter',
      accountingEnabled: true,
      aiFeaturesEnabled: true,
      loyaltyEnabled: false,
      hasDomain: false,
      hasPendingDomain: false,
    });
    const many = Array.from(
      { length: 1203 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    setScopeResolver(
      resolver({
        lazyForStore: async () => true,
        directory: async () => [entry(DO_STORE), entry(PG_STORE), ...many.map(entry)],
      })
    );
    const { value, log } = await run(() => acrossStores(async id => id, {}));
    expect(value).toHaveLength(1205); // > the old 500 hub cap: nothing is cut
    expect(value.map(v => v.value)).toContain(many[1202]);
    expect(log.transactions).toBe(0); // every store lazy (no pg transaction)
  });

  it('storeDirectory reads the registered D1 directory (no Postgres query), applies the filter and the hidden-store drop', async () => {
    const e = (id: string, accountingEnabled: boolean) => ({
      id,
      slug: id,
      name: id,
      status: 'active',
      plan: 'starter',
      accountingEnabled,
      aiFeaturesEnabled: true,
      loyaltyEnabled: false,
      hasDomain: false,
      hasPendingDomain: false,
    });
    const directory = vi.fn(async () => [e(DO_STORE, true), e(PG_STORE, false)]);
    setScopeResolver(resolver({ directory }));
    const fake = fakeClient();
    const queryRaw = vi.fn(async () => {
      throw new Error('POSTGRES_REMOVED');
    });
    (fake.client as unknown as { $queryRaw: unknown }).$queryRaw = queryRaw;
    const out = await runWithRequestDb(
      () => fake.client,
      () => storeDirectory(s => s.accountingEnabled)
    );
    expect(out.map(s => s.id)).toEqual([DO_STORE]);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(directory).toHaveBeenCalledWith(expect.objectContaining({ includeDeleted: false }));
    const hidden = await runWithRequestDb(
      () => fake.client,
      () => withHiddenStores({ hidden: new Set([DO_STORE]) }, () => storeDirectory())
    );
    expect(hidden.map(s => s.id)).toEqual([PG_STORE]);
  });

  it('storeDirectory({ postgresOnly }) skips the D1 resolver (the drift reconcile reads the Postgres side as Postgres says it)', async () => {
    const directory = vi.fn(async () => []);
    setScopeResolver(resolver({ directory }));
    const fake = fakeClient();
    const queryRaw = vi.fn(async () => []);
    (fake.client as unknown as { $queryRaw: unknown }).$queryRaw = queryRaw;
    await runWithRequestDb(
      () => fake.client,
      () => storeDirectory(undefined, { postgresOnly: true })
    );
    expect(directory).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('an unreadable decision throws: never a silent Postgres fallback', async () => {
    const boom = new Error('directory unreadable');
    setScopeResolver(resolver({ lazyForStore: vi.fn().mockRejectedValue(boom) }));
    const fake = fakeClient();
    await expect(
      runWithRequestDb(
        () => fake.client,
        () => withStore(PG_STORE, async () => 1)
      )
    ).rejects.toBe(boom);
    expect(fake.log.transactions).toBe(0);
  });
});
