/**
 * Search program Task 11: keep product_embeddings current (Rulings SEARCH-11, SEARCH-T11-*).
 *
 * `search-product-index` — per store, on `product.upserted` (ProductService create/update, MCP) and
 * `search/store.reindex-requested` (every other text writer, the backstop, its own continuation).
 * Debounced 20 s per store (max wait 2 min under a steady stream), one run per store at a time,
 * at most 4 stores at once (the Workers AI 3000 rpm account limit is shared with query embeds).
 * Each round is three MEMOIZED steps — plan (short reads) → embed (Workers AI, no transaction) →
 * write (one statement) — so an Inngest retry never pays for the same embeddings twice and no
 * transaction is ever held across the provider call. A run does at most MAX_ROUNDS rounds, then
 * hands the rest to a fresh run (keeps the memoized step state small).
 *
 * Failure bounds: a retryable provider error (429, 5xx, timeout) fails the step; Inngest retries it
 * `retries` times with backoff, then the run fails and `alerts-failure-watch` raises a P1. A
 * non-retryable one (bad shape/input) is a NonRetriableError at once. Either way the store is
 * retried by the next write or the backstop, never in a tight loop.
 *
 * `search-index-backstop` — cron `17 *\/6 * * *` (UTC). For every ACTIVE store, under that store's
 * own tenant transaction (`acrossStores`; an unscoped sweep is refused by the tenant guard and reads
 * nothing under RLS), asks "any stale row?" and fans one reindex event per such store. This is also
 * the BACKFILL: the first run after the Workers AI binding exists finds every un-embedded store.
 * The per-store daily cap (SEARCH_EMBED_STORE_DAILY_CAP) bounds what any one day embeds.
 */
import { NonRetriableError, type InngestFunction } from 'inngest';
import { acrossStores, runInStoreScope } from '@ebda/database';
import { inngest } from '../client';
import {
  embedDocs,
  embedThrottleMs,
  hasStaleProducts,
  planEmbedBatch,
  writeEmbeddings,
  type StaleDoc,
} from '../../../services/product-index.service';
import { EmbeddingError, getEmbeddingProvider } from '../../search/embedding-provider';
import logger from '../../logger';

export const REINDEX_EVENT = 'search/store.reindex-requested';
/** Products per provider call (bge-m3 takes up to 100; 25 keeps one call well under the timeout). */
export const INDEX_BATCH = 25;
/** Rounds per run before handing off to a continuation run (~200 products, ~1.6 MB step state). */
export const MAX_ROUNDS = 8;
const FAN_OUT_CHUNK = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ev = { name: string; data: Record<string, unknown> };
interface IndexStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<unknown>;
  sendEvent(id: string, payload: Ev | Ev[]): Promise<unknown>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The function body, exported for tests (a fake `step` memoizes like Inngest). */
export async function handleSearchProductIndex({
  event,
  step,
}: {
  event: { data?: Record<string, unknown> };
  step: IndexStep;
}): Promise<Record<string, unknown>> {
  const storeId = event.data?.storeId;
  if (typeof storeId !== 'string' || !UUID_RE.test(storeId)) return { skipped: 'missing-store' };
  if (!getEmbeddingProvider()) return { skipped: 'no-provider' };

  let embedded = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const plan = (await step.run(`plan-${round}`, () =>
      runInStoreScope(storeId, () => planEmbedBatch(storeId, INDEX_BATCH))
    )) as { items: StaleDoc[]; capped: boolean };
    if (plan.capped) {
      logger.info({ storeId, embedded }, '[search-index] daily cap reached');
      return { embedded, capped: true };
    }
    if (plan.items.length === 0) return { embedded, done: true };

    const literals = (await step.run(`embed-${round}`, async () => {
      const provider = getEmbeddingProvider();
      if (!provider) throw new NonRetriableError('search-index: embedding provider went away');
      try {
        const out = await embedDocs(
          provider,
          plan.items.map(i => i.doc)
        );
        await sleep(embedThrottleMs()); // sleep-after-success, per real call
        return out;
      } catch (err) {
        if (err instanceof EmbeddingError && !err.retryable)
          throw new NonRetriableError(`search-index: ${err.kind}: ${err.message}`, { cause: err });
        throw err;
      }
    })) as string[];

    const written = (await step.run(`write-${round}`, () =>
      runInStoreScope(storeId, () =>
        writeEmbeddings(
          storeId,
          plan.items.map(({ id, hash }) => ({ id, hash })),
          literals
        )
      )
    )) as number;
    embedded += written;
    if (written === 0) {
      // Every product in the batch changed between read and write: stop rather than spin; the
      // write paths that changed them already asked for a new run.
      logger.warn({ storeId, round }, '[search-index] batch wrote nothing; stopping this run');
      return { embedded, stopped: 'no-progress' };
    }
  }
  await step.sendEvent('continue', { name: REINDEX_EVENT, data: { storeId, reason: 'continue' } });
  return { embedded, continued: true };
}

export const searchProductIndex: InngestFunction.Any = inngest.createFunction(
  {
    id: 'search-product-index',
    name: 'Search: embed stale products for a store',
    concurrency: [{ key: 'event.data.storeId', limit: 1 }, { limit: 4 }],
    debounce: { key: 'event.data.storeId', period: '20s', timeout: '2m' },
    retries: 3,
    // `product.upserted` is not in the typed AppEvent registry (same cast as ai-autofill-product).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    triggers: [{ event: 'product.upserted' as any }, { event: REINDEX_EVENT }],
  },
  async ({ event, step }) =>
    handleSearchProductIndex({
      event: event as { data?: Record<string, unknown> },
      step: step as unknown as IndexStep,
    })
);

/** The backstop body, exported for tests. */
export async function handleSearchIndexBackstop({
  step,
}: {
  step: IndexStep;
}): Promise<Record<string, unknown>> {
  if (!getEmbeddingProvider()) return { skipped: 'no-provider' };
  const found = (await step.run('find-stale-stores', async () => {
    let failed = 0;
    const rows = await acrossStores(storeId => hasStaleProducts(storeId), {
      filter: s => s.status === 'active',
      onStoreError: (storeId, err) => {
        failed++;
        logger.error({ err, storeId }, '[search-index-backstop] store probe failed');
      },
    });
    return { stores: rows.filter(r => r.value).map(r => r.storeId), failed };
  })) as { stores: string[]; failed: number };
  // Inngest accepts at most 5,000 events per sendEvent (inngest.com/docs/usage-limits/inngest).
  for (let i = 0; i < found.stores.length; i += FAN_OUT_CHUNK) {
    await step.sendEvent(
      `fan-out-${i / FAN_OUT_CHUNK}`,
      found.stores
        .slice(i, i + FAN_OUT_CHUNK)
        .map(storeId => ({ name: REINDEX_EVENT, data: { storeId, reason: 'backstop' } }))
    );
  }
  logger.info(
    { stores: found.stores.length, failed: found.failed },
    '[search-index-backstop] done'
  );
  return { stores: found.stores.length, failed: found.failed };
}

export const searchIndexBackstop: InngestFunction.Any = inngest.createFunction(
  {
    id: 'search-index-backstop',
    name: 'Search: find stores with stale embeddings (backstop + backfill)',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '17 */6 * * *' }],
  },
  async ({ step }) => handleSearchIndexBackstop({ step: step as unknown as IndexStep })
);
