/**
 * Delete a store's product vectors from Vectorize when the store is deleted or its owner's account is closed (audit 2026-11-12 P2-7).
 * The vectors live in the store's NAMESPACE (the store id) under ids `<productId>:d` / `<productId>:w` (packages/repo/src/do/search-vectors.ts);
 * the binding has no "delete namespace", so every product id of the store (a superset of `product_vector_state`: deleted products
 * included) is turned into its two vector ids and removed with `deleteByIds`. Products come from the DO's READ path, which keeps
 * answering after the store is closed. Idempotent (deleting an absent id is a no-op), so a retry converges; a failure THROWS so the
 * caller's retry + alert path sees it. No Vectorize binding = nothing was ever indexed = nothing to delete.
 */
import type { VectorizeLike } from '@ebda-src/repo';
import { cfBindings } from '../../cf/bindings';
import { storeDo } from '../store-backend';

const PAGE = 200;

interface VectorPurgeDeps {
  index: VectorizeLike | null;
  /** Product ids of the store with id > `after`, ascending, at most `limit`. */
  listProductIds(storeId: string, after: string, limit: number): Promise<string[]>;
}

// pq-allow(unused-export): test seam, imported by tests/unit/store-delete-vectors.test.ts
export async function purgeStoreVectorsWith(
  storeId: string,
  deps: VectorPurgeDeps
): Promise<number> {
  if (!storeId) throw new Error('purgeStoreVectors: storeId required');
  if (!deps.index) return 0;
  let after = '';
  let deleted = 0;
  for (;;) {
    const ids = await deps.listProductIds(storeId, after, PAGE);
    if (ids.length === 0) return deleted;
    await deps.index.deleteByIds(ids.flatMap(id => [`${id}:d`, `${id}:w`]));
    deleted += ids.length;
    after = ids[ids.length - 1]!;
    if (ids.length < PAGE) return deleted;
  }
}

async function listProductIdsFromDo(
  storeId: string,
  after: string,
  limit: number
): Promise<string[]> {
  const { decodeRpc } = await import('@ebda-src/repo');
  const stub = storeDo(storeId) as unknown as {
    query(
      storeId: string,
      queries: unknown[]
    ): Promise<{ ok: true; json: string } | { ok: false; code: string; message: string }>;
  };
  const r = await stub.query(storeId, [
    {
      model: 'Product',
      op: 'findMany',
      args: {
        where: { storeId, ...(after ? { id: { gt: after } } : {}) },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: limit,
      },
    },
  ]);
  if (!r.ok) throw new Error(`purgeStoreVectors: product read refused (${r.code})`);
  return (decodeRpc<Array<Array<{ id: string }>>>(r.json)[0] ?? []).map(p => p.id);
}

/** Production wiring: the bound Vectorize index and the store's DO. */
export const purgeStoreVectors = (storeId: string): Promise<number> =>
  purgeStoreVectorsWith(storeId, {
    index: cfBindings()?.PRODUCT_VECTORS ?? null,
    listProductIds: listProductIdsFromDo,
  });
