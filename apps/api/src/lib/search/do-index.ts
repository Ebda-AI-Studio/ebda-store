/**
 * The product indexer for a store on its Durable Object (Ruling CF-JOBS-4B). The DO holds the truth (its products, and
 * `product_vector_state`, what text each vector was built from); the vectors themselves live in Vectorize, namespace = the store id.
 * One round is three memoised steps, like the Postgres indexer: plan (DO, read) -> embed (Workers AI, no DO call held open) ->
 * write (Vectorize upsert, then ONE DO section that commits the state against the product's CURRENT text). An edit during the
 * embed leaves the product stale for the next round; a retry replays the memoised embeds, so nothing is paid for twice.
 */
import type { VectorizeLike, VectorWork } from '@ebda-src/repo';
import { NonRetriableError } from '../jobs/errors';
import { isStoreGoneError } from '../jobs/store-gone';
import logger from '../logger';
import { cfBindings } from '../../cf/bindings';
import { storeMoney } from '../repo-factory';
import { EMBED_MAX_BATCH, EmbeddingError, getEmbeddingProvider } from './embedding-provider';
import { embedStoreDailyCap, embedThrottleMs } from '../../services/product-index.service';
import { takeEmbedCalls } from './embed-budget';

export const DO_INDEX_BATCH = 25;
export const DO_MAX_ROUNDS = 8;
const idOf = (productId: string, kind: 'd' | 'w') => `${productId}:${kind}`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The Vectorize index, or null when it is not provisioned (see CfBindings.PRODUCT_VECTORS). */
export const productVectorIndex = (): VectorizeLike | null => cfBindings()?.PRODUCT_VECTORS ?? null;

interface IndexStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<unknown>;
  sendEvent(id: string, payload: unknown): Promise<unknown>;
}
type Built = { productId: string; d?: number[]; w?: number[] };
type Failure = { work: VectorWork; kind: string; retryable: boolean };

const textsOf = (w: VectorWork) => [
  ...(w.needDoc && w.doc ? [w.doc] : []),
  ...(w.needWords && w.words ? [w.words] : []),
];

async function embedTexts(texts: string[]): Promise<number[][]> {
  const provider = getEmbeddingProvider();
  if (!provider) throw new NonRetriableError('search-index: embedding provider went away');
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_MAX_BATCH) {
    const vs = await provider.embed(texts.slice(i, i + EMBED_MAX_BATCH));
    out.push(...vs.map(v => v.map(x => Number(x.toPrecision(5)))));
  }
  return out;
}
function assign(w: VectorWork, vs: number[][]): Built {
  let i = 0;
  const b: Built = { productId: w.productId };
  if (w.needDoc && w.doc) b.d = vs[i++];
  if (w.needWords && w.words) b.w = vs[i++];
  return b;
}

export async function indexRoundsDo(
  storeId: string,
  step: IndexStep,
  attempt: number,
  retries: number,
  counts: { permanent: number; temporary: number }
): Promise<Record<string, unknown>> {
  const index = productVectorIndex();
  if (!index) {
    logger.warn(
      { storeId },
      '[search-index] no Vectorize index bound (PRODUCT_VECTORS): DO store not indexed'
    );
    return { skipped: 'no-vector-index' };
  }
  let embedded = 0;
  for (let round = 0; round < DO_MAX_ROUNDS; round++) {
    const plan = (await step.run(`plan-${round}`, async () => {
      const money = await storeMoney(storeId);
      if (!money)
        throw new NonRetriableError(`search-index: store ${storeId} is not on its Durable Object`);
      try {
        return await money.vectorPlan({ limit: DO_INDEX_BATCH, dailyCap: embedStoreDailyCap() });
      } catch (e) {
        if (isStoreGoneError(e)) return { work: [], orphans: [], capped: false }; // deleted / closed: nothing to index
        throw e;
      }
    })) as { work: VectorWork[]; orphans: string[]; capped: boolean };
    if (plan.work.length === 0 && plan.orphans.length === 0) {
      return plan.capped ? { embedded, capped: true } : { embedded, done: true };
    }

    // embed: every text of the batch together; a batch the model refuses falls back to one product at a time
    const texts = plan.work.flatMap(textsOf);
    const batch = (await step.run(`embed-${round}`, async () => {
      if (texts.length === 0) return { built: [] as Built[], failures: [] as Failure[], sent: 0 };
      if (!(await takeEmbedCalls(Math.ceil(texts.length / EMBED_MAX_BATCH))))
        return { globalCapped: true };
      try {
        const vs = await embedTexts(texts);
        await sleep(embedThrottleMs());
        let at = 0;
        const built = plan.work.map(w => {
          const n = textsOf(w).length;
          const b = assign(w, vs.slice(at, at + n));
          at += n;
          return b;
        });
        return { built, failures: [] as Failure[], sent: texts.length };
      } catch (err) {
        if (!(err instanceof EmbeddingError)) throw err;
        if (err.retryable && attempt < retries) throw err;
      }
      const built: Built[] = [];
      const failures: Failure[] = [];
      let sent = 0;
      for (const w of plan.work) {
        try {
          built.push(assign(w, await embedTexts(textsOf(w))));
          sent += textsOf(w).length;
          await sleep(embedThrottleMs());
        } catch (err) {
          const e = err instanceof EmbeddingError ? err : null;
          failures.push({ work: w, kind: e?.kind ?? 'provider', retryable: e?.retryable ?? true });
        }
      }
      return { built, failures, sent };
    })) as { globalCapped?: boolean; built: Built[]; failures: Failure[]; sent: number };
    if (batch.globalCapped) return { embedded, capped: 'global' };

    const res = (await step.run(`write-${round}`, async () => {
      const money = await storeMoney(storeId);
      if (!money)
        throw new NonRetriableError(`search-index: store ${storeId} is not on its Durable Object`);
      const byId = new Map(plan.work.map(w => [w.productId, w]));
      const upserts = batch.built.flatMap(b => {
        const meta = { storeId, productId: b.productId, model: '@cf/baai/bge-m3' };
        return [
          ...(b.d
            ? [
                {
                  id: idOf(b.productId, 'd'),
                  values: b.d,
                  namespace: storeId,
                  metadata: { ...meta, kind: 'doc' },
                },
              ]
            : []),
          ...(b.w
            ? [
                {
                  id: idOf(b.productId, 'w'),
                  values: b.w,
                  namespace: storeId,
                  metadata: { ...meta, kind: 'words' },
                },
              ]
            : []),
        ];
      });
      // WRITE-time guard (audit P2-7): a store deleted while the embeds were in flight is CLOSED (410 on every money op); a read
      // of the DO answers that before a single vector lands, so the deletion's purge is not undone.
      try {
        await money.vectorStale({});
      } catch (e) {
        if (isStoreGoneError(e))
          return { gone: true, embedded: 0, permanent: 0, temporary: 0, retry: false };
        throw e;
      }
      if (upserts.length > 0) await index.upsert(upserts); // a throw writes NO state: the whole batch stays stale
      if (plan.orphans.length > 0)
        await index.deleteByIds(plan.orphans.flatMap(id => [idOf(id, 'd'), idOf(id, 'w')]));
      // a transient failure stays stale (the next round/backstop retries); a rejected text is quarantined
      const quarantine = batch.failures.filter(f => !f.retryable);
      const out = await money.vectorCommit({
        ready: batch.built.map(b => byId.get(b.productId)!).filter(Boolean),
        failures: quarantine.map(f => ({ work: f.work, kind: f.kind })),
        forget: plan.orphans,
        texts: batch.sent,
      });
      if (out.cleanup.length > 0) await index.deleteByIds(out.cleanup);
      return {
        embedded: out.embedded,
        permanent: quarantine.filter(f => f.kind === 'input' || f.kind === 'shape').length,
        temporary: quarantine.filter(f => f.kind !== 'input' && f.kind !== 'shape').length,
        retry: batch.failures.some(f => f.retryable),
      };
    })) as {
      gone?: boolean;
      embedded: number;
      permanent: number;
      temporary: number;
      retry: boolean;
    };
    if (res.gone) return { embedded, skipped: 'store-gone' };
    counts.permanent += res.permanent;
    counts.temporary += res.temporary;
    embedded += res.embedded;
    if (res.retry) return { embedded, retry: true };
    if (res.embedded === 0 && batch.failures.length === 0 && plan.orphans.length === 0) {
      logger.warn({ storeId, round }, '[search-index] DO batch wrote nothing; stopping this run');
      return { embedded, stopped: 'no-progress' };
    }
  }
  await step.sendEvent('continue', {
    name: 'search/store.reindex-requested',
    data: { storeId, reason: 'continue' },
  });
  return { embedded, continued: true };
}
