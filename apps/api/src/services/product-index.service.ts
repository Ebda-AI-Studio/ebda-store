// Product embedding indexer (search program P1, Task 11; Rulings SEARCH-9, SEARCH-11, SEARCH-T11-*).
//
// What is embedded: `public.ebda_product_embed_doc(...)` (Task 9). A row in product_embeddings is
// STALE when it is missing, from another model, or its content_hash is not md5(current doc), so a
// missed writer is found in pure SQL (the backstop cron). A NULL doc (every text part empty) is
// never embedded; an existing row for it is deleted (SEARCH-T9-1).
//
// Transaction rule (Task 8 lesson): never hold a database transaction across the Workers AI call.
// Callers run these under `runInStoreScope` (each statement is its own short transaction): read the
// stale batch, call the provider OUTSIDE any transaction, then write in one statement. The Inngest
// function (`search-product-index.ts`) puts the three in separate memoized steps so a retry never
// pays for the same embeddings twice.
//
// Staleness class: BOUNDED-stale (SEARCH-11). Price, stock and status are never read from here.
import { Prisma, prisma } from '@ebda/database';
import { regionDayStart } from '@ebda/shared';
import {
  EMBED_MODEL,
  EmbeddingError,
  getEmbeddingProvider,
  toHalfvecLiteral,
  type EmbeddingProvider,
} from '../lib/search/embedding-provider';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';

/** Must stay byte-identical across every query below: the hash is md5 of exactly this. */
// A value-less Prisma.sql fragment (constant SQL, no Prisma.raw escape hatch).
const DOC = Prisma.sql`public.ebda_product_embed_doc(p.name, p.name_ar, p.search_terms, p.description, p.description_ar)`;
const STALE = Prisma.sql`(e.product_id IS NULL OR e.model <> ${EMBED_MODEL} OR e.content_hash <> md5(${DOC}))`;
/**
 * A product the index should hold a vector for: what storefront search can return (active, not
 * deleted, `product-search.service.ts` storefront scope) and has text. Any other product's vector
 * is an orphan and is deleted (review M5: soft delete and unpublish remove the vector; a republish
 * makes it stale again and it is re-embedded).
 */
const INDEXABLE = Prisma.sql`(p.deleted_at IS NULL AND p.status = 'active' AND ${DOC} IS NOT NULL)`;
/**
 * Quarantined (review I2, Ruling SEARCH-T11-10): this exact text failed to embed. Skipped until the
 * text changes (a new md5 re-admits it) or a later embed succeeds and deletes the row.
 */
const quarantined = (storeId: string) =>
  Prisma.sql`EXISTS (SELECT 1 FROM product_embed_failures f
                      WHERE f.product_id = p.id AND f.store_id = ${storeId} AND f.content_hash = md5(${DOC}))`;

const DEFAULT_DAILY_CAP = 3000;
/** `SEARCH_EMBED_STORE_DAILY_CAP` (docs/ENVIRONMENT.md). A bad value falls back to the default. */
export function embedStoreDailyCap(): number {
  const n = Number.parseInt(process.env.SEARCH_EMBED_STORE_DAILY_CAP ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

/**
 * Sleep after each SUCCESSFUL provider call (`SEARCH_EMBED_THROTTLE_MS`, default 200). Workers AI
 * text embeddings allow 3000 requests/minute per account (developers.cloudflare.com/workers-ai/
 * platform/limits, read 2026-10-16). One indexer run paces at most 300 calls/min; the function's
 * global concurrency cap (4) keeps the indexer under 1200/min, leaving the rest for query embeds.
 */
export function embedThrottleMs(): number {
  const n = Number.parseInt(process.env.SEARCH_EMBED_THROTTLE_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

export interface StaleDoc {
  id: string;
  doc: string;
  hash: string;
}

/** Non-deleted products with a non-NULL doc whose embedding is missing, from another model, or for older text. */
export async function findStaleProducts(storeId: string, limit: number): Promise<StaleDoc[]> {
  return prisma.$queryRaw<StaleDoc[]>`
    SELECT p.id, ${DOC} AS doc, md5(${DOC}) AS hash
      FROM products p LEFT JOIN product_embeddings e ON e.product_id = p.id AND e.store_id = ${storeId}
     WHERE p.store_id = ${storeId} AND ${INDEXABLE} AND ${STALE} AND NOT ${quarantined(storeId)}
     ORDER BY p.updated_at DESC, p.id
     LIMIT ${limit}`;
}

/**
 * Cheap existence check (the backstop's per-store probe): stops at the first hit. True when an
 * indexable product needs a vector OR a vector is left on a product that is no longer indexable
 * (review I1: a lost event after the text was cleared must not leave old words matching).
 */
export async function hasStaleProducts(storeId: string): Promise<boolean> {
  const [r] = await prisma.$queryRaw<Array<{ stale: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM products p LEFT JOIN product_embeddings e ON e.product_id = p.id AND e.store_id = ${storeId}
       WHERE p.store_id = ${storeId} AND ${INDEXABLE} AND ${STALE} AND NOT ${quarantined(storeId)}
    ) OR EXISTS (
      SELECT 1 FROM product_embeddings e JOIN products p ON p.id = e.product_id
       WHERE e.store_id = ${storeId} AND p.store_id = ${storeId} AND NOT ${INDEXABLE}
    ) AS stale`;
  return r?.stale === true;
}

/**
 * The viewer's numbers (Task 12, searches page: "{indexed} of {products} products ready").
 * `products` = active, non-deleted products that HAVE text to embed (INDEXABLE); `indexed` = those
 * whose embedding is current (same model, same text); `failed` = quarantined (this text could not be
 * embedded, SEARCH-T11-10); `stale` = the rest. A stale-but-present row is not "ready".
 */
export async function storeIndexStatus(
  storeId: string
): Promise<{ products: number; indexed: number; stale: number; failed: number }> {
  const [r] = await prisma.$queryRaw<Array<{ products: bigint; stale: bigint; failed: bigint }>>`
    SELECT count(*) AS products,
           count(*) FILTER (WHERE ${STALE} AND NOT ${quarantined(storeId)}) AS stale,
           count(*) FILTER (WHERE ${STALE} AND ${quarantined(storeId)}) AS failed
      FROM products p LEFT JOIN product_embeddings e ON e.product_id = p.id AND e.store_id = ${storeId}
     WHERE p.store_id = ${storeId} AND ${INDEXABLE}`;
  const products = Number(r?.products ?? 0);
  const stale = Number(r?.stale ?? 0);
  const failed = Number(r?.failed ?? 0);
  return { products, indexed: products - stale - failed, stale, failed };
}

/** Delete vectors of products that are no longer indexable (see INDEXABLE): they must not match old words. */
export async function pruneUnindexableEmbeddings(storeId: string): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM product_embeddings e USING products p
     WHERE e.product_id = p.id AND e.store_id = ${storeId} AND p.store_id = ${storeId}
       AND NOT ${INDEXABLE}`;
}

/**
 * Products embedded today (Cairo day) in this store. Counts DISTINCT products (one row each), so a
 * product re-embedded twice today counts once; re-embeds happen only when its text changed and are
 * debounced per store (Ruling SEARCH-T11-2).
 */
async function embeddedToday(storeId: string): Promise<number> {
  const since = regionDayStart(new Date());
  const [r] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM product_embeddings WHERE store_id = ${storeId} AND embedded_at >= ${since}`;
  return Number(r?.n ?? 0);
}

/**
 * Step 1 (READ, short statements): prune unindexable products' rows, apply the daily cap, pick the next batch.
 * `capped` is true ONLY when the per-store daily cap is spent (never for a caller's own limit).
 */
export async function planEmbedBatch(
  storeId: string,
  limit: number
): Promise<{ items: StaleDoc[]; capped: boolean }> {
  await pruneUnindexableEmbeddings(storeId);
  const left = embedStoreDailyCap() - (await embeddedToday(storeId));
  if (left <= 0) {
    const anyStale = await hasStaleProducts(storeId);
    return { items: [], capped: anyStale };
  }
  return { items: await findStaleProducts(storeId, Math.min(limit, left)), capped: false };
}

/**
 * Step 2 (EXTERNAL, no transaction): embed the docs and return `halfvec` literals. Components are
 * rounded to 5 significant digits — halfvec stores ~3.3, so nothing the column keeps is lost — which
 * keeps the memoized Inngest step output small (measured ~9.8 KB per product instead of ~20 KB).
 */
export async function embedDocs(
  provider: EmbeddingProvider,
  docs: string[],
  signal?: AbortSignal
): Promise<string[]> {
  if (provider.model !== EMBED_MODEL)
    throw new EmbeddingError(
      'provider',
      `embedding provider model ${provider.model} is not ${EMBED_MODEL}`,
      {
        retryable: false,
      }
    );
  const vectors = await provider.embed(docs, { signal });
  if (vectors.length !== docs.length)
    throw new EmbeddingError('shape', `embedding: expected ${docs.length} vectors`);
  return vectors.map(v => toHalfvecLiteral(v.map(x => Number(x.toPrecision(5)))));
}

/**
 * Step 3 (WRITE, ONE statement): upsert the vectors. A row is written only if the product still
 * exists, is not deleted, and its CURRENT doc still hashes to what was embedded — a product edited
 * between read and write is left stale (the next run re-embeds the new text), never stamped with
 * the old vector. Returns rows written.
 */
export async function writeEmbeddings(
  storeId: string,
  items: Array<{ id: string; hash: string }>,
  literals: string[]
): Promise<number> {
  if (items.length === 0) return 0;
  if (literals.length !== items.length)
    throw new Error('writeEmbeddings: one vector per item expected');
  const written = await prisma.$executeRaw`
    INSERT INTO product_embeddings (product_id, store_id, model, content_hash, embedding, embedded_at)
    SELECT p.id, p.store_id, ${EMBED_MODEL}, v.hash, v.emb::halfvec(1024), now()
      FROM unnest(${items.map(i => i.id)}::text[], ${items.map(i => i.hash)}::text[], ${literals}::text[])
           AS v(id, hash, emb)
      JOIN products p ON p.id = v.id
     WHERE p.store_id = ${storeId} AND p.deleted_at IS NULL AND md5(${DOC}) = v.hash
    ON CONFLICT (product_id) DO UPDATE
      SET model = EXCLUDED.model, content_hash = EXCLUDED.content_hash,
          embedding = EXCLUDED.embedding, embedded_at = EXCLUDED.embedded_at`;
  // A product that embedded is no longer quarantined (its text changed, or the provider recovered).
  await prisma.$executeRaw`
    DELETE FROM product_embed_failures
     WHERE store_id = ${storeId} AND product_id = ANY(${items.map(i => i.id)}::text[])`;
  return written;
}

export interface EmbedFailure {
  id: string;
  hash: string;
  kind: string;
}

/**
 * Step 2b (EXTERNAL, no transaction), used only after a batch failed for good: embed the items one
 * at a time. An item is a POISON (returned in `failed`) when it fails non-retryably, or fails while
 * another item in this same pass succeeded. When every item fails retryably that is an outage, not
 * poison: the last error is rethrown and nothing is quarantined.
 */
export async function embedEachIsolating(
  provider: EmbeddingProvider,
  items: StaleDoc[],
  throttleMs = 0
): Promise<{ literals: Array<string | null>; failed: EmbedFailure[] }> {
  const literals: Array<string | null> = [];
  const errors: Array<EmbeddingError | null> = [];
  for (const item of items) {
    try {
      const [lit] = await embedDocs(provider, [item.doc]);
      literals.push(lit);
      errors.push(null);
      if (throttleMs > 0) await sleep(throttleMs);
    } catch (err) {
      if (!(err instanceof EmbeddingError)) throw err;
      literals.push(null);
      errors.push(err);
    }
  }
  const anyOk = literals.some(l => l !== null);
  const failed: EmbedFailure[] = [];
  let outage: EmbeddingError | undefined;
  items.forEach((item, i) => {
    const err = errors[i];
    if (!err) return;
    if (!err.retryable || anyOk) failed.push({ id: item.id, hash: item.hash, kind: err.kind });
    else outage = err;
  });
  if (outage && failed.length === 0) throw outage;
  return { literals, failed };
}

/**
 * Quarantine products whose current text failed to embed, keyed on that text's md5. Returns the ids
 * NEWLY quarantined (new row, or a different text than the one already quarantined) and raises one
 * P1 per such product — a product that stays quarantined does not re-alert on later runs.
 */
export async function quarantineEmbedFailures(
  storeId: string,
  failures: EmbedFailure[]
): Promise<string[]> {
  if (failures.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ product_id: string }>>`
    INSERT INTO product_embed_failures (product_id, store_id, content_hash, error_kind, failed_at)
    SELECT p.id, p.store_id, v.hash, v.kind, now()
      FROM unnest(${failures.map(f => f.id)}::text[], ${failures.map(f => f.hash)}::text[],
                  ${failures.map(f => f.kind)}::text[]) AS v(id, hash, kind)
      JOIN products p ON p.id = v.id
     WHERE p.store_id = ${storeId}
    ON CONFLICT (product_id) DO UPDATE
      SET content_hash = EXCLUDED.content_hash, error_kind = EXCLUDED.error_kind, failed_at = now()
      WHERE product_embed_failures.content_hash <> EXCLUDED.content_hash
    RETURNING product_id`;
  const fresh = rows.map(r => r.product_id);
  for (const productId of fresh) {
    const kind = failures.find(f => f.id === productId)?.kind;
    logger.error(
      { storeId, productId, kind },
      '[search-index] product quarantined: text cannot be embedded'
    );
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'search-index.quarantine',
      title: 'Search: a product could not be embedded (quarantined)',
      body: `Product ${productId} in store ${storeId} was rejected by the embedding provider (${kind}). It stays out of semantic search until its text changes; the rest of the store keeps indexing.`,
      context: { storeId, productId, kind },
    }).catch(() => undefined);
  }
  return fresh;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Embed this store's stale products in batches, in-process (scripts, the eval harness, tests).
 * MUST run under `runInStoreScope(storeId, ...)`, never inside a tenant transaction: the provider
 * call happens between statements. Production indexing goes through the Inngest function, which
 * runs the same three steps memoized.
 */
export async function indexStore(
  storeId: string,
  opts: { batchSize?: number; maxDocs?: number } = {}
): Promise<{ embedded: number; remaining: boolean; capped: boolean; skipped?: 'no-provider' }> {
  const provider = getEmbeddingProvider();
  if (!provider) return { embedded: 0, remaining: false, capped: false, skipped: 'no-provider' };
  const maxDocs = Math.max(0, opts.maxDocs ?? 500);
  const batchSize = Math.max(1, opts.batchSize ?? 25);
  let embedded = 0;
  let attempted = 0;
  while (attempted < maxDocs) {
    const plan = await planEmbedBatch(storeId, Math.min(batchSize, maxDocs - attempted));
    if (plan.capped) return { embedded, remaining: true, capped: true };
    if (plan.items.length === 0) return { embedded, remaining: false, capped: false };
    let literals: Array<string | null>;
    let failed: EmbedFailure[] = [];
    try {
      literals = await embedDocs(
        provider,
        plan.items.map(i => i.doc)
      );
      await sleep(embedThrottleMs());
    } catch (err) {
      // In-process there is no retry: isolate at once (an outage still throws).
      if (!(err instanceof EmbeddingError)) throw err;
      ({ literals, failed } = await embedEachIsolating(provider, plan.items, embedThrottleMs()));
    }
    const ok = plan.items.flatMap((it, i) =>
      literals[i] ? [{ it, lit: literals[i] as string }] : []
    );
    const written = await writeEmbeddings(
      storeId,
      ok.map(o => o.it),
      ok.map(o => o.lit)
    );
    await quarantineEmbedFailures(storeId, failed);
    embedded += written;
    attempted += plan.items.length;
  }
  const remaining = await hasStaleProducts(storeId);
  if (remaining) logger.info({ storeId, embedded }, '[search-index] maxDocs reached, more remain');
  return { embedded, remaining, capped: false };
}
