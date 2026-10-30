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
import { NonRetriableError } from '../../jobs/errors';
import type { JobDef } from '../../jobs/types';
import { acrossStores, runInStoreScope } from '@ebda/database';
import { inngest } from '../client';
import {
  alertQuarantined,
  embedItems,
  embedSingles,
  providerCallsFor,
  type ItemVectors,
  quarantineEmbedFailures,
  retryableFailures,
  settleSingles,
  SINGLE_RETRY_BACKOFF,
  type EmbedFailure,
  type SingleResult,
  embedThrottleMs,
  hasStaleProducts,
  planEmbedBatch,
  writeEmbeddings,
  type StaleDoc,
} from '../../../services/product-index.service';
import { EmbeddingError, getEmbeddingProvider } from '../../search/embedding-provider';
import { alertOutageOnce, takeEmbedCalls } from '../../search/embed-budget';
import logger from '../../logger';
import { doStoreIds } from '../../jobs/do-guard';
import { alarmStoreId } from '../../jobs/store-scope';
import { storeMoney } from '../../repo-factory';
import { indexRoundsDo, productVectorIndex } from '../../search/do-index';

export const REINDEX_EVENT = 'search/store.reindex-requested';
/**
 * Products per batch: up to 50 texts (doc + words each, SEARCH-T13-7), one provider call (bge-m3
 * takes up to 100); 25 keeps one call well under the timeout.
 */
export const INDEX_BATCH = 25;
/**
 * Rounds per run before handing off to a continuation run (~200 products). Step state per product,
 * with the words vector (SEARCH-T13-7): up to 2 vectors × ~9.8 KB (measured for one) + ≤ ~7 KB of
 * doc + ≤ ~1 KB of words (search_terms is capped at 500 characters) ≈ 27.6 KB, so ≤ ~5.4 MiB per
 * run (200 products) and ≤ ~490 KB per embed step (25 products × 19.6 KB of vectors), inside
 * Inngest's 4 MiB per step / 32 MiB per run (inngest.com/docs/usage-limits/inngest).
 */
export const MAX_ROUNDS = 8;
/**
 * Products per memoized step in the single pass (review N-M3). Worst case per step: 5 × (the 15 s
 * per-call timeout, EMBED_TIMEOUT_MS, + the 200 ms throttle) ≈ 76 s and ≤ ~100 KB of output (5 ×
 * 2 vectors × ~9.8 KB, SEARCH-T13-7). Inngest allows a step "up to 2 hours, subject to the
 * function host's shorter timeout" and 4 MiB of output
 * (inngest.com/docs/usage-limits/inngest); the host, a Worker HTTP request, has no wall-clock limit
 * while Inngest stays connected but only a 20-minute grace when the runtime is updated
 * (developers.cloudflare.com/workers/platform/limits). 76 s sits far inside both.
 */
export const ISOLATE_CHUNK = 5;
/** Inngest retries per step; attempt numbers run 0..INDEX_RETRIES. */
export const INDEX_RETRIES = 3;
const FAN_OUT_CHUNK = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ev = { name: string; data: Record<string, unknown> };
interface IndexStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<unknown>;
  sendEvent(id: string, payload: Ev | Ev[]): Promise<unknown>;
  /** Durable sleep (no compute while waiting). */
  sleep(id: string, duration: string): Promise<unknown>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The function body, exported for tests (a fake `step` memoizes like Inngest). */
export async function handleSearchProductIndex({
  event,
  step,
  attempt = 0,
}: {
  event: { data?: Record<string, unknown> };
  step: IndexStep;
  /** Inngest's zero-indexed attempt of the step being executed; `INDEX_RETRIES` is the last one. */
  attempt?: number;
}): Promise<Record<string, unknown>> {
  const storeId = event.data?.storeId;
  if (typeof storeId !== 'string' || !UUID_RE.test(storeId)) return { skipped: 'missing-store' };
  if (!getEmbeddingProvider()) return { skipped: 'no-provider' };

  // Review M6: a price/stock/flag-only `product.upserted` costs ONE plan step and no AI call — the
  // plan selects only products whose doc hash (or model, or indexability) changed. The handler does
  // NOT trust `event.data.changedFields` to skip earlier: the 20 s per-store debounce delivers only
  // the LAST event, so a text edit followed by a price edit would arrive as `changedFields: ['price']`
  // and be lost. The hash is the source of truth.
  const counts = { permanent: 0, temporary: 0 };
  // A store on its Durable Object (Ruling CF-JOBS-4B): its products and index state are in the DO, its vectors in Vectorize
  const onDo = await step.run('is-do-store', async () => (await doStoreIds()).has(storeId));
  const result = onDo
    ? await indexRoundsDo(storeId, step, attempt, INDEX_RETRIES, counts)
    : await indexRounds(storeId, step, attempt, counts);
  // Review N-I1 (c): ONE P1 per run that quarantined anything, with the counts — never per product.
  if (counts.permanent + counts.temporary > 0)
    await step.run('alert-quarantine', () => alertQuarantined(storeId, counts));
  return { ...result, quarantined: counts };
}

type Settled = {
  ok: Array<{ id: string; hash: string; vec: ItemVectors }>;
  failures: EmbedFailure[];
};

async function indexRounds(
  storeId: string,
  step: IndexStep,
  attempt: number,
  counts: { permanent: number; temporary: number }
): Promise<Record<string, unknown>> {
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

    const batch = (await step.run(`embed-${round}`, async () => {
      const provider = getEmbeddingProvider();
      if (!provider) throw new NonRetriableError('search-index: embedding provider went away');
      // Account-wide ceiling on provider calls (SEARCH-T11-19), charged per real call: a batch's
      // doc AND words texts share one call (SEARCH-T13-7).
      if (!(await takeEmbedCalls(providerCallsFor(plan.items)))) return { globalCapped: true };
      try {
        const vectors = await embedItems(provider, plan.items);
        await sleep(embedThrottleMs()); // sleep-after-success, per real call
        return { vectors };
      } catch (err) {
        if (!(err instanceof EmbeddingError)) throw err;
        // A retryable batch failure is retried by Inngest first. On the LAST attempt, or at once for
        // a non-retryable one, fall through to the single pass below (reviews I2, N-I1).
        if (err.retryable && attempt < INDEX_RETRIES) throw err;
        return { failed: err.kind };
      }
    })) as { vectors?: ItemVectors[]; failed?: string; globalCapped?: boolean };
    if (batch.globalCapped) {
      logger.warn({ storeId, embedded }, '[search-index] global daily embedding budget reached');
      return { embedded, capped: 'global' };
    }

    let settled: Settled;
    if (batch.vectors) {
      const vectors = batch.vectors;
      settled = {
        ok: vectors.map((vec, i) => ({ id: vec.id, hash: plan.items[i].key, vec })),
        failures: [],
      };
    } else {
      const isolated = await isolate(storeId, step, round, plan.items, batch.failed ?? 'provider');
      if (isolated === 'global-capped') return { embedded, capped: 'global' };
      if (isolated === 'outage') return { embedded, outage: true };
      settled = isolated;
    }

    const res = (await step.run(`write-${round}`, () =>
      runInStoreScope(storeId, async () => {
        const written = await writeEmbeddings(
          storeId,
          settled.ok.map(o => o.vec)
        );
        const q = await quarantineEmbedFailures(storeId, settled.failures);
        return { written, ...q };
      })
    )) as { written: number; permanent: number; temporary: number };
    counts.permanent += res.permanent;
    counts.temporary += res.temporary;
    embedded += res.written;
    if (res.written === 0 && settled.failures.length === 0) {
      // Every product in the batch changed between read and write: stop rather than spin; the
      // write paths that changed them already asked for a new run.
      logger.warn({ storeId, round }, '[search-index] batch wrote nothing; stopping this run');
      return { embedded, stopped: 'no-progress' };
    }
  }
  await step.sendEvent('continue', { name: REINDEX_EVENT, data: { storeId, reason: 'continue' } });
  return { embedded, continued: true };
}

/**
 * The batch failed for good: find the poison from EVIDENCE (review N-I1). Each product is embedded
 * on its own (memoized); the ones that failed retryably wait a durable backoff (`step.sleep`, no
 * compute) and get ONE more single try in their own step. `settleSingles` then decides: a
 * non-retryable failure is permanent, a second retryable failure is a 24 h quarantine, and if
 * nothing succeeded and nothing was rejected outright it is an outage — nothing is quarantined, the
 * run ends `outage` (not failed) and ONE platform P1 is raised per 6 h window (PR3 minor 7).
 */
async function isolate(
  storeId: string,
  step: IndexStep,
  round: number,
  items: StaleDoc[],
  batchKind: string
): Promise<Settled | 'global-capped' | 'outage'> {
  // Review N-M3: memoized steps of ISOLATE_CHUNK products, so no step holds 25 sequential calls.
  const singles = async (label: string, list: StaleDoc[]): Promise<SingleResult[] | null> => {
    const out: SingleResult[] = [];
    for (let c = 0; c * ISOLATE_CHUNK < list.length; c++) {
      const chunk = list.slice(c * ISOLATE_CHUNK, (c + 1) * ISOLATE_CHUNK);
      const res = (await step.run(`${label}-${c}`, async () => {
        const provider = getEmbeddingProvider();
        if (!provider) throw new NonRetriableError('search-index: embedding provider went away');
        if (!(await takeEmbedCalls(chunk.length))) return null; // SEARCH-T11-19
        return embedSingles(provider, chunk, embedThrottleMs());
      })) as SingleResult[] | null;
      if (res === null) return null;
      out.push(...res);
    }
    return out;
  };

  const first = await singles(`single-${round}`, items);
  if (first === null) return 'global-capped';
  const again = retryableFailures(items, first);
  let retried: SingleResult[] = [];
  if (again.length > 0) {
    await step.sleep(`backoff-${round}`, SINGLE_RETRY_BACKOFF);
    const r = await singles(`retry-${round}`, again);
    if (r === null) return 'global-capped';
    retried = r;
  }
  const settled = settleSingles(first, retried);
  if (settled.outage) {
    // PR3 minor 7: not a failed run per store (alerts-failure-watch would raise one P1 per store per
    // backstop tick) but ONE platform alert per window; the store is retried by the next event or
    // backstop tick. Nothing is quarantined.
    await step.run(`outage-${round}`, () => alertOutageOnce({ storeId, kind: batchKind }));
    return 'outage';
  }
  return { ok: settled.ok, failures: settled.failures };
}

export const searchProductIndex: JobDef = inngest.createFunction(
  {
    id: 'search-product-index',
    name: 'Search: embed stale products for a store',
    concurrency: [{ key: 'event.data.storeId', limit: 1 }, { limit: 4 }],
    debounce: { key: 'event.data.storeId', period: '20s', timeout: '2m' },
    retries: INDEX_RETRIES,
    // `product.upserted` is not in the typed AppEvent registry (same cast as ai-autofill-product).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    triggers: [{ event: 'product.upserted' as any }, { event: REINDEX_EVENT }],
  },
  async ({ event, step, attempt }) =>
    handleSearchProductIndex({
      event: event as { data?: Record<string, unknown> },
      step: step as unknown as IndexStep,
      attempt,
    })
);

/** The backstop body, exported for tests. */
export async function handleSearchIndexBackstop({
  step,
  event,
}: {
  step: IndexStep;
  event?: { data?: unknown };
}): Promise<Record<string, unknown>> {
  if (!getEmbeddingProvider()) return { skipped: 'no-provider' };
  // The alarm of a store on its Durable Object probes that store's own index state (Ruling CF-JOBS-4B)
  const only = alarmStoreId(event);
  const onlyOnDo = only
    ? await step.run('is-do-store', async () => (await doStoreIds()).has(only))
    : false;
  if (only && onlyOnDo) {
    if (!productVectorIndex()) return { skipped: 'no-vector-index' };
    const stale = (await step.run('find-stale-do-store', async () =>
      Boolean((await (await storeMoney(only))?.vectorStale({}))?.stale)
    )) as boolean;
    if (stale)
      await step.sendEvent('fan-out-0', [
        { name: REINDEX_EVENT, data: { storeId: only, reason: 'backstop' } },
      ]);
    return { stores: stale ? 1 : 0, failed: 0 };
  }
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

export const searchIndexBackstop: JobDef = inngest.createFunction(
  {
    id: 'search-index-backstop',
    name: 'Search: find stores with stale embeddings (backstop + backfill)',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '17 */6 * * *' }],
  },
  async ({ step, event }) =>
    handleSearchIndexBackstop({ step: step as unknown as IndexStep, event })
);
