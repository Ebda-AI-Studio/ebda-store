import { storeRepo, type StoreWrites } from './repo-factory';

/**
 * Run an ordered batch of writes (lazy Prisma promises built from `storeWriter`) for one store.
 * - Durable Object store: ONE atomic `$transaction([...])` section in the DO (all rows or none).
 * - Postgres store: the statements are awaited in order on the request's own (ambient tenant) client, exactly as the
 *   interactive transaction they replace ran them; an array batch there would open a SECOND connection that cannot see this
 *   request's uncommitted rows and would not roll back with it (tests/unit/nested-transaction-registry.test.ts).
 */
export async function atomicWrites<T extends readonly PromiseLike<unknown>[]>(
  storeId: string | null,
  writer: Pick<StoreWrites, '$transaction'> | { $transaction: unknown },
  ops: [...T]
): Promise<{ [I in keyof T]: Awaited<T[I]> }> {
  if (storeId && (await storeRepo(storeId)).backend === 'do')
    return (writer as Pick<StoreWrites, '$transaction'>).$transaction(ops);
  const out: unknown[] = [];
  for (const op of ops) out.push(await op);
  return out as { [I in keyof T]: Awaited<T[I]> };
}
