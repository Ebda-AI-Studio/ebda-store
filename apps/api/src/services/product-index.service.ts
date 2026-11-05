// Product embedding indexer (search program P1, Task 11; Rulings SEARCH-9, SEARCH-11, SEARCH-T11-*).
//
// What is embedded, per product, as TWO vectors on one row (Ruling SEARCH-T13-7):
//  - the doc, `public.ebda_product_embed_doc(...)` (names + descriptions, SEARCH-T13-5), in
//    `embedding` / `content_hash`;
//  - the AI search words alone (`products.search_terms`, trimmed), in `terms_embedding` /
//    `terms_hash`; NULL when the product has no words (no provider call for them).
// Each vector has its own md5, so a words-only edit re-embeds only the words vector, and a missed
// writer is found in pure SQL (the backstop cron). A NULL doc (every text part empty) is never
// embedded; an existing row for it is deleted (SEARCH-T9-1); emptied words clear the words vector.
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
  EMBED_MAX_BATCH,
  EMBED_MODEL,
  EmbeddingError,
  getEmbeddingProvider,
  toHalfvecLiteral,
  type EmbeddingProvider,
} from '../lib/search/embedding-provider';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';
import { storeMoney } from '../lib/repo-factory';
import { takeEmbedCalls } from '../lib/search/embed-budget';

/** Must stay byte-identical across every query below: the hash is md5 of exactly this. */
// A value-less Prisma.sql fragment (constant SQL, no Prisma.raw escape hatch).
// Names + descriptions, NOT the AI search words (Ruling SEARCH-T13-5, migration 20261024000100):
// the words stay in the keyword leg; in the vector they diluted paraphrase matches.
const DOC = Prisma.sql`public.ebda_product_embed_doc(p.name, p.name_ar, p.description, p.description_ar)`;
/** The words text, as embedded and hashed: trimmed of all whitespace, NULL when empty. */
const WORDS = Prisma.sql`nullif(regexp_replace(p.search_terms, '^\\s+|\\s+$', '', 'g'), '')`;
const DOC_STALE = Prisma.sql`(e.product_id IS NULL OR e.model <> ${EMBED_MODEL} OR e.content_hash <> md5(${DOC}))`;
/** Words vector out of date: missing for present words, built from other words or another model, or left for emptied words. */
const WORDS_STALE = Prisma.sql`(e.product_id IS NULL OR e.model <> ${EMBED_MODEL} OR e.terms_hash IS DISTINCT FROM md5(${WORDS}))`;
const STALE = Prisma.sql`(${DOC_STALE} OR ${WORDS_STALE})`;
/** Needs a provider call (an emptied-words row only needs clearing, done by the prune). */
const NEEDS_EMBED = Prisma.sql`(${DOC_STALE} OR (${WORDS} IS NOT NULL AND ${WORDS_STALE}))`;
/**
 * The quarantine key: md5 of the product's whole text SET (doc + words). A text the model rejects
 * keeps the product out until either text changes (SEARCH-T13-7, extends SEARCH-T11-10).
 */
const TEXT_KEY = Prisma.sql`md5(coalesce(${DOC}, '') || chr(31) || coalesce(${WORDS}, ''))`;
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
                      WHERE f.product_id = p.id AND f.store_id = ${storeId} AND f.content_hash = ${TEXT_KEY}
                        AND f.model = ${EMBED_MODEL}
                        AND (f.expires_at IS NULL OR f.expires_at > now()))`;

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
  /** md5(doc). */
  hash: string;
  /** The words text (trimmed), or null when the product has none. */
  words: string | null;
  wordsHash: string | null;
  /** Quarantine key: md5 of doc + words (TEXT_KEY). */
  key: string;
  needDoc: boolean;
  needWords: boolean;
}

/**
 * Indexable products that need a provider call: the doc vector is missing, from another model or
 * for older text, and/or the words vector is (for present words). Quarantined text sets are skipped.
 */
export async function findStaleProducts(storeId: string, limit: number): Promise<StaleDoc[]> {
  return prisma.$queryRaw<StaleDoc[]>`
    SELECT p.id, ${DOC} AS doc, md5(${DOC}) AS hash, ${WORDS} AS words, md5(${WORDS}) AS "wordsHash",
           ${TEXT_KEY} AS key, ${DOC_STALE} AS "needDoc",
           (${WORDS} IS NOT NULL AND ${WORDS_STALE}) AS "needWords"
      FROM products p LEFT JOIN product_embeddings e ON e.product_id = p.id AND e.store_id = ${storeId}
     WHERE p.store_id = ${storeId} AND ${INDEXABLE} AND ${NEEDS_EMBED} AND NOT ${quarantined(storeId)}
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
 * whose DOC vector is current (same model, same text) — the words vector is optional for "ready"
 * (SEARCH-T13-7); `failed` = quarantined (this text set could not be embedded, SEARCH-T11-10);
 * `stale` = the rest. A stale-but-present row is not "ready".
 */
export async function storeIndexStatus(
  storeId: string
): Promise<{ products: number; indexed: number; stale: number; failed: number }> {
  // Ruling NZ-PG-7: a store on its Durable Object keeps its index state there (product_vector_state); no Postgres read.
  const money = await storeMoney(storeId);
  if (money) return money.vectorStatus({});
  const [r] = await prisma.$queryRaw<Array<{ products: bigint; stale: bigint; failed: bigint }>>`
    SELECT count(*) AS products,
           count(*) FILTER (WHERE ${DOC_STALE} AND NOT ${quarantined(storeId)}) AS stale,
           count(*) FILTER (WHERE ${DOC_STALE} AND ${quarantined(storeId)}) AS failed
      FROM products p LEFT JOIN product_embeddings e ON e.product_id = p.id AND e.store_id = ${storeId}
     WHERE p.store_id = ${storeId} AND ${INDEXABLE}`;
  const products = Number(r?.products ?? 0);
  const stale = Number(r?.stale ?? 0);
  const failed = Number(r?.failed ?? 0);
  return { products, indexed: products - stale - failed, stale, failed };
}

/** Delete vectors of products that are no longer indexable (see INDEXABLE): they must not match old words. */
export async function pruneUnindexableEmbeddings(storeId: string): Promise<number> {
  const removed = await prisma.$executeRaw`
    DELETE FROM product_embeddings e USING products p
     WHERE e.product_id = p.id AND e.store_id = ${storeId} AND p.store_id = ${storeId}
       AND NOT ${INDEXABLE}`;
  // SEARCH-T13-7: words emptied → the words vector must stop matching (no provider call needed).
  await prisma.$executeRaw`
    UPDATE product_embeddings e SET terms_embedding = NULL, terms_hash = NULL
      FROM products p
     WHERE e.product_id = p.id AND e.store_id = ${storeId} AND p.store_id = ${storeId}
       AND e.terms_hash IS NOT NULL AND ${WORDS} IS NULL`;
  // PR3 minor 5: a quarantine row for a product that left the index is dead data; a product that
  // comes back (republished, text restored) is retried from scratch.
  await prisma.$executeRaw`
    DELETE FROM product_embed_failures f USING products p
     WHERE f.product_id = p.id AND f.store_id = ${storeId} AND p.store_id = ${storeId}
       AND NOT ${INDEXABLE}`;
  return removed;
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

/** One product's new vectors (halfvec literals); a missing one is not being (re)written. */
export interface ItemVectors {
  id: string;
  hash: string;
  wordsHash: string | null;
  doc?: string;
  words?: string;
}

const textsOf = (it: StaleDoc): string[] => [
  ...(it.needDoc ? [it.doc] : []),
  ...(it.needWords && it.words ? [it.words] : []),
];

/** Provider calls `embedItems` makes for these items (texts are sent EMBED_MAX_BATCH per call). */
export function providerCallsFor(items: StaleDoc[]): number {
  return Math.ceil(items.reduce((n, it) => n + textsOf(it).length, 0) / EMBED_MAX_BATCH);
}

/**
 * Step 2 for both vectors (SEARCH-T13-7): every text the items need (doc and/or words) goes to the
 * provider together, so a batch of up to 50 products is ONE call (bge-m3 takes 100 texts a call).
 */
export async function embedItems(
  provider: EmbeddingProvider,
  items: StaleDoc[],
  signal?: AbortSignal
): Promise<ItemVectors[]> {
  const texts: string[] = [];
  const slots: Array<[number, 'doc' | 'words']> = [];
  items.forEach((it, i) => {
    if (it.needDoc) slots.push([i, 'doc']);
    if (it.needWords && it.words) slots.push([i, 'words']);
    texts.push(...textsOf(it));
  });
  const lits = texts.length ? await embedDocs(provider, texts, signal) : [];
  const out: ItemVectors[] = items.map(it => ({
    id: it.id,
    hash: it.hash,
    wordsHash: it.wordsHash,
  }));
  slots.forEach(([i, k], j) => (out[i][k] = lits[j]));
  return out;
}

/**
 * Step 3 (WRITE): upsert the vectors. A vector is written only if the product still exists, is still
 * INDEXABLE (not deleted, active — PR3 minor 4), and its CURRENT text still hashes to what was
 * embedded — a product edited between read and write is left stale (the next run re-embeds the new
 * text), never stamped with the old vector. The doc vector upserts the row (a model change also
 * drops the old model's words vector); the words vector then updates the same row. Returns how
 * many products got at least one vector.
 */
export async function writeEmbeddings(storeId: string, vecs: ItemVectors[]): Promise<number> {
  const docs = vecs.filter(v => v.doc);
  const words = vecs.filter(v => v.words && v.wordsHash);
  const touched = new Set<string>();
  if (docs.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ product_id: string }>>`
      INSERT INTO product_embeddings (product_id, store_id, model, content_hash, embedding, embedded_at)
      SELECT p.id, p.store_id, ${EMBED_MODEL}, v.hash, v.emb::halfvec(1024), now()
        FROM unnest(${docs.map(i => i.id)}::text[], ${docs.map(i => i.hash)}::text[], ${docs.map(i => i.doc!)}::text[])
             AS v(id, hash, emb)
        JOIN products p ON p.id = v.id
       WHERE p.store_id = ${storeId} AND ${INDEXABLE} AND md5(${DOC}) = v.hash
      ON CONFLICT (product_id) DO UPDATE
        SET model = EXCLUDED.model, content_hash = EXCLUDED.content_hash,
            embedding = EXCLUDED.embedding, embedded_at = EXCLUDED.embedded_at,
            terms_embedding = CASE WHEN product_embeddings.model = EXCLUDED.model
                                   THEN product_embeddings.terms_embedding END,
            terms_hash = CASE WHEN product_embeddings.model = EXCLUDED.model
                              THEN product_embeddings.terms_hash END
      RETURNING product_id`;
    rows.forEach(r => touched.add(r.product_id));
  }
  if (words.length > 0) {
    const rows = await prisma.$queryRaw<Array<{ product_id: string }>>`
      UPDATE product_embeddings e
         SET terms_embedding = v.emb::halfvec(1024), terms_hash = v.hash, embedded_at = now()
        FROM unnest(${words.map(i => i.id)}::text[], ${words.map(i => i.wordsHash!)}::text[], ${words.map(i => i.words!)}::text[])
             AS v(id, hash, emb)
        JOIN products p ON p.id = v.id
       WHERE e.product_id = v.id AND e.store_id = ${storeId} AND p.store_id = ${storeId}
         AND e.model = ${EMBED_MODEL} AND ${INDEXABLE} AND md5(${WORDS}) = v.hash
      RETURNING e.product_id`;
    rows.forEach(r => touched.add(r.product_id));
  }
  // A product that embedded is no longer quarantined (its text changed, or the provider recovered).
  if (touched.size > 0)
    await prisma.$executeRaw`
      DELETE FROM product_embed_failures
       WHERE store_id = ${storeId} AND product_id = ANY(${[...touched]}::text[])`;
  return touched.size;
}

export interface EmbedFailure {
  id: string;
  hash: string;
  kind: string;
  /** false = rejected non-retryably (permanent); true = failed retryably twice (24 h). */
  retryable: boolean;
}

/** One product's single-call outcome: its vectors, or why it failed. `hash` = its quarantine key. */
export type SingleResult =
  | { id: string; hash: string; vec: ItemVectors }
  | { id: string; hash: string; kind: string; retryable: boolean };

/** Quarantine for a product that failed retryably twice (review N-I1); then it is re-admitted. */
export const TEMP_QUARANTINE_HOURS = 24;
/** Backoff between the single pass and the single retry (Workers AI limits are per minute). */
export const SINGLE_RETRY_BACKOFF = '60s';
export const SINGLE_RETRY_BACKOFF_MS = 60_000;

/**
 * Step 2b (EXTERNAL, no transaction), used only after a batch failed for good: embed each item on
 * its own. Never throws for an embedding failure: each item reports its literal or its error.
 */
export async function embedSingles(
  provider: EmbeddingProvider,
  items: StaleDoc[],
  throttleMs = 0
): Promise<SingleResult[]> {
  const out: SingleResult[] = [];
  for (const item of items) {
    try {
      const [vec] = await embedItems(provider, [item]);
      out.push({ id: item.id, hash: item.key, vec });
      if (throttleMs > 0) await sleep(throttleMs);
    } catch (err) {
      if (!(err instanceof EmbeddingError)) throw err;
      out.push({ id: item.id, hash: item.key, kind: err.kind, retryable: err.retryable });
    }
  }
  return out;
}

/**
 * Decide from EVIDENCE (review N-I1): a non-retryable failure in either pass is permanent; a product
 * that failed retryably in the first single pass AND again in the single retry (after a backoff) is
 * temporary (24 h); a product that succeeded in either pass is written. If nothing succeeded and
 * nothing failed non-retryably, it is an outage: nothing is quarantined and the caller fails.
 */
export function settleSingles(
  first: SingleResult[],
  retried: SingleResult[]
): {
  ok: Array<{ id: string; hash: string; vec: ItemVectors }>;
  failures: EmbedFailure[];
  outage: boolean;
} {
  const second = new Map(retried.map(r => [r.id, r]));
  const ok: Array<{ id: string; hash: string; vec: ItemVectors }> = [];
  const failures: EmbedFailure[] = [];
  for (const r of first) {
    const final = 'vec' in r || !r.retryable ? r : (second.get(r.id) ?? r);
    if ('vec' in final) ok.push(final);
    else if (!final.retryable) failures.push({ ...final, retryable: false });
    else if (second.has(r.id)) failures.push({ ...final, retryable: true });
  }
  const outage = ok.length === 0 && failures.every(f => f.retryable);
  return { ok, failures: outage ? [] : failures, outage };
}

/** The products of `results` that failed retryably (they get one single retry). */
export function retryableFailures(items: StaleDoc[], results: SingleResult[]): StaleDoc[] {
  const ids = new Set(results.filter(r => !('vec' in r) && r.retryable).map(r => r.id));
  return items.filter(i => ids.has(i.id));
}

/**
 * Quarantine products whose current text failed to embed, keyed on that text's md5 and the model,
 * and delete their existing vectors (an older text's vector must stop matching; review N-M1).
 * Permanent rows have no expiry; retryable ones expire after TEMP_QUARANTINE_HOURS. Returns how
 * many were NEWLY quarantined (a new row, a changed text/model, or a re-quarantine after expiry) —
 * the caller raises ONE summary alert per run (`alertQuarantined`), never one per product.
 */
export async function quarantineEmbedFailures(
  storeId: string,
  failures: EmbedFailure[]
): Promise<{ permanent: number; temporary: number }> {
  if (failures.length === 0) return { permanent: 0, temporary: 0 };
  const rows = await prisma.$queryRaw<Array<{ product_id: string; retryable: boolean }>>`
    INSERT INTO product_embed_failures
           (product_id, store_id, content_hash, error_kind, model, retryable, expires_at, failed_at)
    SELECT p.id, p.store_id, v.hash, v.kind, ${EMBED_MODEL}, v.retryable,
           CASE WHEN v.retryable THEN now() + make_interval(hours => ${TEMP_QUARANTINE_HOURS}) END,
           now()
      FROM unnest(${failures.map(f => f.id)}::text[], ${failures.map(f => f.hash)}::text[],
                  ${failures.map(f => f.kind)}::text[], ${failures.map(f => f.retryable)}::boolean[])
           AS v(id, hash, kind, retryable)
      JOIN products p ON p.id = v.id
     WHERE p.store_id = ${storeId}
    ON CONFLICT (product_id) DO UPDATE
      SET content_hash = EXCLUDED.content_hash, error_kind = EXCLUDED.error_kind,
          model = EXCLUDED.model, retryable = EXCLUDED.retryable,
          expires_at = EXCLUDED.expires_at, failed_at = now()
      WHERE product_embed_failures.content_hash <> EXCLUDED.content_hash
         OR product_embed_failures.model <> EXCLUDED.model
         OR (product_embed_failures.expires_at IS NOT NULL AND product_embed_failures.expires_at <= now())
    RETURNING product_id, retryable`;
  // Review N-M1: a quarantined product must not keep matching on its OLD text's vector.
  await prisma.$executeRaw`
    DELETE FROM product_embeddings
     WHERE store_id = ${storeId} AND product_id = ANY(${failures.map(f => f.id)}::text[])`;
  const temporary = rows.filter(r => r.retryable).length;
  logger.warn(
    { storeId, permanent: rows.length - temporary, temporary },
    '[search-index] products quarantined'
  );
  return { permanent: rows.length - temporary, temporary };
}

/** ONE P1 per indexer run that quarantined anything (review N-I1), with the counts. */
export async function alertQuarantined(
  storeId: string,
  counts: { permanent: number; temporary: number }
): Promise<void> {
  if (counts.permanent + counts.temporary === 0) return;
  await sendAlert({
    level: 'p1',
    scope: 'platform',
    source: 'search-index.quarantine',
    title: `Search: ${counts.permanent + counts.temporary} product(s) could not be embedded`,
    body:
      `Store ${storeId}: ${counts.permanent} product(s) rejected by the embedding model (out of ` +
      `semantic search until their text or the model changes) and ${counts.temporary} that failed ` +
      `twice with a retryable error (re-admitted after ${TEMP_QUARANTINE_HOURS} h). The rest of the ` +
      'store keeps indexing. Rows: product_embed_failures.',
    context: { storeId, ...counts },
  }).catch(() => undefined);
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
  opts: { batchSize?: number; maxDocs?: number; retryBackoffMs?: number } = {}
): Promise<{ embedded: number; remaining: boolean; capped: boolean; skipped?: 'no-provider' }> {
  const provider = getEmbeddingProvider();
  if (!provider) return { embedded: 0, remaining: false, capped: false, skipped: 'no-provider' };
  const maxDocs = Math.max(0, opts.maxDocs ?? 500);
  const batchSize = Math.max(1, opts.batchSize ?? 25);
  const counts = { permanent: 0, temporary: 0 };
  const finish = async <T>(r: T): Promise<T> => {
    await alertQuarantined(storeId, counts);
    return r;
  };
  let embedded = 0;
  let attempted = 0;
  while (attempted < maxDocs) {
    const plan = await planEmbedBatch(storeId, Math.min(batchSize, maxDocs - attempted));
    if (plan.capped) return finish({ embedded, remaining: true, capped: true });
    if (plan.items.length === 0) return finish({ embedded, remaining: false, capped: false });
    let ok: Array<{ id: string; hash: string; vec: ItemVectors }>;
    let failures: EmbedFailure[] = [];
    // Account-wide ceiling on provider calls (SEARCH-T11-19): charged per real call — a batch's doc
    // AND words texts share one call (SEARCH-T13-7), one per single.
    if (!(await takeEmbedCalls(providerCallsFor(plan.items))))
      return finish({ embedded, remaining: true, capped: true });
    try {
      const vectors = await embedItems(provider, plan.items);
      await sleep(embedThrottleMs());
      ok = vectors.map((vec, i) => ({ id: vec.id, hash: plan.items[i].key, vec }));
    } catch (err) {
      // In-process there is no Inngest retry: go straight to the single pass + one retry.
      if (!(err instanceof EmbeddingError)) throw err;
      if (!(await takeEmbedCalls(plan.items.length)))
        return finish({ embedded, remaining: true, capped: true });
      const first = await embedSingles(provider, plan.items, embedThrottleMs());
      const again = retryableFailures(plan.items, first);
      let retried: SingleResult[] = [];
      if (again.length > 0) {
        await sleep(opts.retryBackoffMs ?? SINGLE_RETRY_BACKOFF_MS);
        if (!(await takeEmbedCalls(again.length)))
          return finish({ embedded, remaining: true, capped: true });
        retried = await embedSingles(provider, again, embedThrottleMs());
      }
      const settled = settleSingles(first, retried);
      if (settled.outage) throw err;
      ({ ok, failures } = settled);
    }
    const written = await writeEmbeddings(
      storeId,
      ok.map(o => o.vec)
    );
    const q = await quarantineEmbedFailures(storeId, failures);
    counts.permanent += q.permanent;
    counts.temporary += q.temporary;
    embedded += written;
    attempted += plan.items.length;
  }
  const remaining = await hasStaleProducts(storeId);
  if (remaining) logger.info({ storeId, embedded }, '[search-index] maxDocs reached, more remain');
  return finish({ embedded, remaining, capped: false });
}
