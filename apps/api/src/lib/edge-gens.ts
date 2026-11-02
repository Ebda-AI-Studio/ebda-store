import type { Request } from 'express';
import { generationNamesFor } from './public-cache';
import { redis } from '../services/redis.service';
import { storeLookupForHost } from './store-host';
import { memoisedGens } from './edge-gens-memo';

/**
 * Edge-cache validity stamp (SEO-3 / P14).
 *
 * The Worker's public edge cache (`cf/public-edge-cache.ts`) may serve a stored response ONLY while the
 * cache GENERATIONS it was filled under are unchanged. These are the very counters every write path already
 * bumps through `invalidateCached` / `invalidateCachedPrefix` (lib/public-cache.ts, FIX-001) and that live in
 * the strongly consistent AuthState Durable Object, not in KV. So a price, stock, category or store-status
 * write invalidates the edge copy in EVERY data centre at once, with no new call-site, and the TTL is only an
 * outer bound (a Cache API `delete` would clear one data centre and nothing else). Because the counters sit
 * above the data path, this survives the Durable Object / D1 cutover unchanged: whichever repository a write
 * lands in, its service/route calls the same `invalidateStore*` function.
 *
 * STALENESS CLASS: price/stock/store-status are NEVER-stale (event-invalidated here). The feature-flag
 * backorder gate and similar per-request entitlements stay BOUNDED-stale (edge window, documented in
 * routes/public.routes.ts, Ruling FU46-W1b-6).
 */
export const EDGE_FILL_HEADER = 'x-ebda-edge-fill';
export const EDGE_CLASS_HEADER = 'x-ebda-edge-class';

export interface EdgeSnapshot {
  storeId: string;
  /** The `public:store:resolve:<host>` host (slug host or verified custom domain). */
  host: string;
  /** `readEdgeGens(edgeDepNames(storeId, host))` taken BEFORE the handler read any data. */
  gens: string;
}

/**
 * Every generation a cached public product/category response of this store depends on: each cache key a
 * public read can be filled from, expanded to the covering `seg:` prefixes `invalidateCachedPrefix` bumps.
 */
export function edgeDepNames(storeId: string, host: string): string[] {
  const keys = [
    `public:products:${storeId}:x`,
    `public:product:${storeId}:x`,
    `public:categories:${storeId}`,
    `public:bundles:v2:${storeId}`,
    // Store status / domain / settings: a suspended or re-pointed store must stop being served at once.
    `public:store:resolve:${host}`,
  ];
  return [...new Set(keys.flatMap(generationNamesFor))];
}

/**
 * Stamp layout epoch. Bumped when the generation shard layout changes (Ruling NZ-D3: per-store shards): a counter on a new
 * shard restarts from 0 and could otherwise equal a stamp taken under the old layout, validating an old copy as fresh (ABA).
 * `v2:` makes every pre-shard stamp a guaranteed miss.
 */
export const EDGE_STAMP_EPOCH = 'v2:';

/** The status generation of a store host: NEVER-stale (Ruling NZ-D1), so it is read fresh on every hit and never memoised. */
const isStatusGeneration = (name: string): boolean => /^public:store:resolve:.+/.test(name);

/** Raw values of `names` (null = unverifiable). */
export async function readEdgeGenValues(names: string[]): Promise<string[] | null> {
  try {
    return (await redis.getCacheGenerations(names)).map(v => v ?? '0');
  } catch {
    return null;
  }
}

const stamp = (values: string[]): string => EDGE_STAMP_EPOCH + values.join(',');

/** The generations as one comparable string, or null when the shared layer cannot vouch for them. */
export async function readEdgeGens(names: string[]): Promise<string | null> {
  const v = await readEdgeGenValues(names);
  return v === null ? null : stamp(v);
}

/**
 * Hit validation (Ruling NZ-D3): every generation EXCEPT the store status generation is memoised per isolate for 2 s
 * (lib/edge-gens-memo.ts); the status generation (`public:store:resolve:<host>`, on its own per-host shard) is read fresh every
 * time. Never used for a fill.
 */
export async function readEdgeGensForHit(names: string[]): Promise<string | null> {
  const fresh = names.filter(isStatusGeneration);
  const memoed = names.filter(n => !isStatusGeneration(n));
  const [m, f] = await Promise.all([
    memoed.length ? memoisedGens(memoed, readEdgeGenValues) : Promise.resolve([] as string[]),
    fresh.length ? readEdgeGenValues(fresh) : Promise.resolve([] as string[]),
  ]);
  if (m === null || f === null) return null;
  const byName = new Map<string, string>();
  memoed.forEach((n, i) => byName.set(n, m[i]));
  fresh.forEach((n, i) => byName.set(n, f[i]));
  return stamp(names.map(n => byName.get(n)!));
}

const SNAPSHOT = Symbol('ebda.edgeSnapshot');

/**
 * Called once the request's store id is resolved and BEFORE any data read. Only for a request the Worker's
 * edge layer marked as a fill (`x-ebda-edge-fill: 1`, set by the layer itself; a client-supplied copy is
 * stripped at the Worker entry). Never throws: no snapshot simply means the response is not stored.
 */
export async function captureEdgeSnapshot(req: Request, storeId: string): Promise<void> {
  if (req.headers[EDGE_FILL_HEADER] !== '1') return;
  const lookup = storeLookupForHost(req.headers['x-store-domain'] as string | undefined);
  if (!lookup) return;
  const gens = await readEdgeGens(edgeDepNames(storeId, lookup.cacheHost));
  if (gens === null) return;
  (req as unknown as Record<symbol, EdgeSnapshot>)[SNAPSHOT] = {
    storeId,
    host: lookup.cacheHost,
    gens,
  };
}

export function edgeSnapshotOf(req: Request | undefined): EdgeSnapshot | undefined {
  return req ? (req as unknown as Record<symbol, EdgeSnapshot | undefined>)[SNAPSHOT] : undefined;
}
