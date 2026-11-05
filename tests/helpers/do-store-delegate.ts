/**
 * The contract tests hand-build a Durable Object repo (`createDoClient` over an in-memory SQLite schema). The real DO repo
 * (`apps/api/src/lib/repo-factory.ts` `withStoreDelegate`) also carries a split-aware `store` delegate, because the DO tables have
 * no `Store` (Ruling NZ-D8: `Store` is platform data on both backends) and the jobs / services now read the store row through
 * `storeDb(id).store`. A bare `createDoClient` has none ("prisma-lite: no model delegate \"store\""). The fixture world keeps the
 * store row in Postgres on both sides, so the delegate here reads it from there.
 */
import { prisma } from '@ebda/database';

export function withPgStoreDelegate<T extends object>(client: T): T {
  const store = {
    findUnique: (args: unknown) => (prisma as any).store.findUnique(args),
    findFirst: (args: unknown) => (prisma as any).store.findFirst(args),
  };
  return new Proxy(client, {
    get: (t, prop, recv) => (prop === 'store' ? store : Reflect.get(t, prop, recv)),
  });
}
