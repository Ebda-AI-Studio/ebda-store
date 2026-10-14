/**
 * Stand-ins for the `@ebda/database` tenant helpers, for unit tests that mock
 * the module (the real ones need a database).
 *
 * `acrossStores` & co. run the callback ONCE for each store id given in
 * `opts.storeIds`, else for the ids `prisma.store.findMany` returns when the
 * test mocks it, else for a single synthetic store (`defaultStoreIds`). The
 * callback is invoked directly (there is no transaction), so the test's own
 * `prisma` mock answers it. Use it from a `vi.mock` factory:
 *
 *   vi.mock('@ebda/database', async () =>
 *     (await import('./helpers/database-mock')).databaseMock({ prisma: mockPrisma }));
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface DatabaseMockOptions {
  prisma?: Any;
  /** Store ids a store-fan-out visits when nothing else names them. */
  defaultStoreIds?: string[];
  /** Extra exports merged over the stand-ins. */
  extra?: Record<string, unknown>;
}

export function databaseMock(opts: DatabaseMockOptions = {}): Record<string, unknown> {
  const prisma = opts.prisma ?? {};
  const defaults = opts.defaultStoreIds ?? ['store-1'];

  const storeIdsFor = async (o?: { storeIds?: string[] }): Promise<string[]> => {
    if (o?.storeIds) return o.storeIds;
    const found = await prisma.store?.findMany?.({});
    if (Array.isArray(found) && found.length) return found.map((s: { id: string }) => s.id);
    return defaults;
  };

  const acrossStores = async (
    fn: (id: string) => Promise<unknown>,
    o?: { storeIds?: string[] }
  ) => {
    const ids = await storeIdsFor(o);
    const out: Array<{ storeId: string; value: unknown }> = [];
    for (const storeId of ids) out.push({ storeId, value: await fn(storeId) });
    return out;
  };

  return {
    prisma,
    withStore: async (_storeId: string, fn: (tx: Any) => Promise<unknown>) => fn(prisma),
    withUser: async (_userId: string, fn: (tx: Any) => Promise<unknown>) => fn(prisma),
    runInTenantContext: async (_storeId: string, fn: () => Promise<unknown>) => fn(),
    runInStoreScope: async (_storeId: string, fn: () => Promise<unknown>) => fn(),
    acrossStores,
    acrossStoresFlat: async (fn: (id: string) => Promise<unknown[]>, o?: { storeIds?: string[] }) =>
      (await acrossStores(fn, o)).flatMap(r => r.value as unknown[]),
    ...opts.extra,
  };
}
