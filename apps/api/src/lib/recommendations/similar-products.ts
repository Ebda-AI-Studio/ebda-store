/**
 * "Similar items" for a product page: the nearest neighbours of the product's OWN stored vector in Vectorize
 * (`PRODUCT_VECTORS`, ids `<productId>:d|w`, namespace = store id, Ruling CF-VEC-1). No embedding call is made: the vector is
 * already there, so the cost is one `getByIds` + one `query`.
 *
 * Tenant isolation: the query is pinned to `namespace: storeId`; a vector whose namespace is another store is refused; and the
 * caller re-reads every id from the store's own database (storeId + visible + active), so an id from anywhere else cannot
 * render even if the index misbehaved.
 *
 * FAIL-SOFT: no binding, no vector, a timeout or any Vectorize error returns `{ ids: [], degraded }` and never throws. The
 * caller serves the curated picks and does not cache the result as the full answer.
 */
import { cfBindings } from '../../cf/bindings';
import logger from '../logger';

/** Vectorize `getByIds` (part of the platform API, absent from the repo's minimal VectorizeLike). */
interface VectorizeNeighbours {
  getByIds?(
    ids: string[]
  ): Promise<Array<{ id: string; values: ArrayLike<number>; namespace?: string }>>;
  query(
    values: number[],
    opts: { topK: number; namespace: string; returnMetadata?: 'none' | 'indexed' | 'all' }
  ): Promise<{ matches: Array<{ id: string; score: number }> }>;
}

const SIMILAR_TIMEOUT_MS = 600;
const SIMILAR_TOPK = 30;
/** Cosine score floor (distance <= 0.45): below it a "neighbour" is just the least-bad product, not a similar one. */
const SIMILAR_MIN_SCORE = 0.55;

const productIdOf = (vectorId: string) => vectorId.slice(0, vectorId.lastIndexOf(':'));

async function neighbours(
  index: VectorizeNeighbours,
  storeId: string,
  productId: string,
  limit: number
): Promise<string[]> {
  if (!index.getByIds) return [];
  const own = await index.getByIds([`${productId}:d`]);
  const v = own.find(x => x.id === `${productId}:d` && (x.namespace ?? storeId) === storeId);
  if (!v) return [];
  const res = await index.query(Array.from(v.values), {
    topK: SIMILAR_TOPK,
    namespace: storeId,
    returnMetadata: 'none',
  });
  const best = new Map<string, number>();
  for (const m of res.matches ?? []) {
    const id = productIdOf(m.id);
    if (!id || id === productId || m.score < SIMILAR_MIN_SCORE) continue;
    if (m.score > (best.get(id) ?? -Infinity)) best.set(id, m.score);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([id]) => id);
}

export async function similarProductIds(
  storeId: string,
  productId: string,
  limit: number,
  timeoutMs = SIMILAR_TIMEOUT_MS
): Promise<{ ids: string[]; degraded: boolean }> {
  const index = (cfBindings()?.PRODUCT_VECTORS ?? null) as VectorizeNeighbours | null;
  if (!index) return { ids: [], degraded: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ids = await Promise.race([
      neighbours(index, storeId, productId, limit),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('similar-timeout')), timeoutMs);
      }),
    ]);
    return { ids, degraded: false };
  } catch (err) {
    logger.warn(
      { storeId, err: err instanceof Error ? err.message : 'unknown' },
      '[recommendations] similar items skipped (Vectorize)'
    );
    return { ids: [], degraded: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
