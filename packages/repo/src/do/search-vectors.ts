// The semantic half of product search on the StoreDO + Cloudflare Vectorize (replaces pgvector `product_embeddings`;
// apps/api/src/services/product-index.service.ts + product-search.service.ts `vectorLeg`).
//
// Same model and dimensions as today: Workers AI `@cf/baai/bge-m3`, 1024 dims, cosine. Two vectors per product, as in
// Ruling SEARCH-T13-7: the DOC (names + descriptions, `ebda_product_embed_doc`) and the AI WORDS (`search_terms`).
// Vectorize holds the vectors in the store's NAMESPACE (the store id) with `storeId` in the metadata; vector ids are
// `<productId>:d` / `<productId>:w` (Vectorize ids are limited to 64 bytes, a store id plus a product id would not fit).
// The DO keeps `product_vector_state` (what text each vector was built from) so staleness is decided locally with no
// Vectorize read. External I/O (Workers AI, Vectorize) never happens inside a transaction: plan (sync) -> embed -> upsert
// -> commit the state only if the product still hashes to what was embedded (an edit in between leaves it stale and the
// next run re-embeds it; a product that became unindexable meanwhile has its fresh vectors deleted).
import { MoneyError, type SyncSql } from './sync-sql';

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const EMBED_DIMS = 1024;
export const EMBED_MAX_BATCH = 100;
export const DEFAULT_VECTOR_MAX_DISTANCE = 0.55;
export const HYBRID_LEG = 50;
export const DEFAULT_DAILY_CAP = 3000;
const TEMP_QUARANTINE_MS = 24 * 60 * 60 * 1000;
/** Vectorize `query` answers at most 100 matches when metadata is not returned. */
const VECTORIZE_TOPK_MAX = 100;

export const VECTOR_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS product_vector_state (
     product_id TEXT NOT NULL PRIMARY KEY, store_id TEXT NOT NULL, model TEXT NOT NULL,
     doc_hash TEXT, words_hash TEXT, embedded_at INTEGER NOT NULL,
     fail_key TEXT, fail_until INTEGER, fail_kind TEXT) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS product_vector_state_store_idx ON product_vector_state (store_id)`,
  // Workers AI spend: texts SENT to the provider per store per day, reserved atomically BEFORE each call (so a re-embed
  // loop, a failed batch and its single-product retries all count, which `count(state rows)` never could)
  `CREATE TABLE IF NOT EXISTS vector_usage (store_id TEXT NOT NULL, day INTEGER NOT NULL, texts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (store_id, day)) WITHOUT ROWID`,
];

export interface EmbeddingProviderLike {
  model: string;
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<number[][]>;
}
export interface VectorizeLike {
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      namespace: string;
      metadata: Record<string, string | number | boolean>;
    }>
  ): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(
    values: number[],
    opts: {
      topK: number;
      namespace: string;
      filter?: Record<string, unknown>;
      returnMetadata?: 'none' | 'indexed' | 'all';
    }
  ): Promise<{ matches: Array<{ id: string; score: number }> }>;
}
export class EmbeddingFailure extends Error {
  constructor(
    readonly kind: 'input' | 'shape' | 'provider' | 'timeout' | 'network',
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'EmbeddingFailure';
  }
}

// ---- texts and hashes ---------------------------------------------------------------------------------------------

/** PG `\s` in a UTF-8 database with the C locale: ASCII whitespace only (JS `\s` would add U+00A0 and friends). */
const WS = '[ \\t\\n\\r\\f\\v]';
const trimWs = (v: string | null | undefined): string =>
  (v ?? '').replace(new RegExp(`^${WS}+|${WS}+$`, 'g'), '');
const stripTags = (v: string | null | undefined): string => {
  const x = (v ?? '')
    .replace(/<\/?[A-Za-z][^<>]*>|<![^<>]*>/g, ' ')
    .replace(new RegExp(`${WS}+`, 'g'), ' ')
    .replace(/^ +| +$/g, '');
  return trimWs([...x].slice(0, 1500).join('')).replace(/^ +| +$/g, '');
};
/** TS twin of SQL `ebda_product_embed_doc(name, name_ar, desc, desc_ar)`: names + descriptions, null when every part is empty. */
export function buildEmbedDoc(p: {
  name?: string | null;
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
}): string | null {
  const parts = [
    trimWs(p.nameAr),
    trimWs(p.name),
    stripTags(p.descriptionAr),
    stripTags(p.description),
  ].filter(x => x !== '');
  return parts.length ? parts.join('\n') : null;
}
/** The AI search words as embedded and hashed: trimmed of all whitespace, null when empty. */
export const buildEmbedWords = (searchTerms: string | null | undefined): string | null =>
  trimWs(searchTerms) || null;

/** cyrb53: a synchronous 53-bit text hash. Staleness detection only (not security): a collision means one missed re-embed. */
export function textHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0') +
    s.length.toString(16)
  );
}

// ---- planning (sync) ----------------------------------------------------------------------------------------------

export interface VectorWork {
  productId: string;
  doc: string | null;
  words: string | null;
  docHash: string | null;
  wordsHash: string | null;
  needDoc: boolean;
  needWords: boolean;
  /** the quarantine key: the product's whole text set */
  key: string;
}
interface ProductRow {
  id: string;
  doc: string | null;
  words: string | null;
  indexable: boolean;
}
const INDEXABLE_SQL = `deleted_at IS NULL AND status = 'active'`;

function loadProducts(db: SyncSql, storeId: string, ids?: string[]): ProductRow[] {
  const rows = db.all(
    `SELECT id, name, name_ar, description, description_ar, search_terms, status, deleted_at
       FROM products WHERE store_id = ?${ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : ''}`,
    ids ? [storeId, ...ids] : [storeId]
  );
  return rows.map(r => {
    const doc = buildEmbedDoc({
      name: r.name as string,
      nameAr: r.name_ar as string | null,
      description: r.description as string | null,
      descriptionAr: r.description_ar as string | null,
    });
    return {
      id: r.id as string,
      doc,
      words: buildEmbedWords(r.search_terms as string | null),
      indexable: r.deleted_at === null && r.status === 'active' && doc !== null,
    };
  });
}

/** What needs a provider call, and the vectors to remove (products no longer indexable). */
export function planVectorWork(
  db: SyncSql,
  storeId: string,
  limit: number,
  now: number
): { work: VectorWork[]; orphans: string[] } {
  const state = new Map(
    db
      .all('SELECT * FROM product_vector_state WHERE store_id = ?', [storeId])
      .map(r => [r.product_id as string, r])
  );
  const work: VectorWork[] = [];
  const orphans: string[] = [];
  const seen = new Set<string>();
  for (const p of loadProducts(db, storeId)) {
    seen.add(p.id);
    const st = state.get(p.id);
    if (!p.indexable) {
      if (st && (st.doc_hash !== null || st.words_hash !== null)) orphans.push(p.id);
      continue;
    }
    const docHash = p.doc ? textHash(p.doc) : null;
    const wordsHash = p.words ? textHash(p.words) : null;
    const sameModel = st?.model === EMBED_MODEL;
    const needDoc = !st || !sameModel || st.doc_hash !== docHash;
    const needWords = p.words !== null && (!st || !sameModel || st.words_hash !== wordsHash);
    const clearWords = !!st && sameModel && p.words === null && st.words_hash !== null;
    if (!needDoc && !needWords && !clearWords) continue;
    const key = textHash(`${p.doc ?? ''}\u001f${p.words ?? ''}`);
    if (st && st.fail_key === key && (st.fail_until === null || (st.fail_until as number) > now))
      continue; // quarantined
    work.push({
      productId: p.id,
      doc: p.doc,
      words: p.words,
      docHash,
      wordsHash,
      needDoc,
      needWords,
      key,
    });
  }
  for (const id of state.keys()) if (!seen.has(id)) orphans.push(id); // product row gone entirely
  work.sort((a, b) => (a.productId < b.productId ? -1 : 1));
  return { work: work.slice(0, Math.max(0, limit)), orphans };
}

// ---- sync (embed + upsert) ----------------------------------------------------------------------------------------

export interface SyncDeps {
  provider: EmbeddingProviderLike;
  index: VectorizeLike;
  now?: number;
  /** texts sent to the provider per store per day (SEARCH_EMBED_STORE_DAILY_CAP); default 3000 */
  dailyCap?: number;
  batchLimit?: number;
  /** a text that could not be embedded (alert / Sentry hook) */
  onFailure?: (f: { productId: string; kind: string; retryable: boolean }) => void;
}
export interface SyncResult {
  embedded: number;
  deleted: number;
  quarantined: number;
  /** stale products left because the daily cap is spent */
  capped: boolean;
  /** a retryable failure happened: the caller (DO alarm) should run again later */
  retry: boolean;
}

const idOf = (productId: string, kind: 'd' | 'w') => `${productId}:${kind}`;
const checkVectors = (vs: number[][], n: number) => {
  if (!Array.isArray(vs) || vs.length !== n)
    throw new EmbeddingFailure('shape', `expected ${n} vectors`, false);
  for (const v of vs) {
    if (!Array.isArray(v) || v.length !== EMBED_DIMS)
      throw new EmbeddingFailure('shape', `expected ${EMBED_DIMS} dims`, false);
    for (const x of v)
      if (typeof x !== 'number' || !Number.isFinite(x))
        throw new EmbeddingFailure('shape', 'non-finite component', false);
  }
};
export class EmbedCapReached extends Error {
  constructor() {
    super('daily embedding cap reached');
    this.name = 'EmbedCapReached';
  }
}
const DAY_MS = 86_400_000;
const dayKey = (now: number) => Math.floor(now / DAY_MS) * DAY_MS;
/** Texts already sent to the provider today for this store. */
export const embedUsageToday = (db: SyncSql, storeId: string, now = Date.now()): number =>
  (db.all('SELECT texts FROM vector_usage WHERE store_id = ? AND day = ?', [
    storeId,
    dayKey(now),
  ])[0]?.texts as number | undefined) ?? 0;
/** Atomically add `n` texts to today's counter, or throw EmbedCapReached without counting. */
export function reserveEmbedTexts(
  db: SyncSql,
  storeId: string,
  n: number,
  cap: number,
  now = Date.now()
): void {
  db.transactionSync(() => {
    const used = embedUsageToday(db, storeId, now);
    if (used + n > cap) throw new EmbedCapReached();
    db.run(
      'INSERT INTO vector_usage (store_id, day, texts) VALUES (?, ?, ?) ON CONFLICT (store_id, day) DO UPDATE SET texts = texts + excluded.texts',
      [storeId, dayKey(now), n]
    );
  });
}

async function embedTexts(
  provider: EmbeddingProviderLike,
  texts: string[],
  reserve?: (n: number) => void
): Promise<number[][]> {
  if (provider.model !== EMBED_MODEL)
    throw new EmbeddingFailure(
      'provider',
      `embedding provider model ${provider.model} is not ${EMBED_MODEL}`,
      false
    );
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_MAX_BATCH) {
    const chunk = texts.slice(i, i + EMBED_MAX_BATCH);
    reserve?.(chunk.length);
    const vs = await provider.embed(chunk);
    checkVectors(vs, chunk.length);
    out.push(...vs);
  }
  return out;
}

/**
 * A text the model rejected, for this exact product text: quarantined until the text changes (the key changes with it). An input /
 * shape failure is permanent (no expiry); anything else is a 24 h quarantine.
 */
export function quarantineVectorFailure(
  db: SyncSql,
  storeId: string,
  w: Pick<VectorWork, 'productId' | 'key'>,
  kind: string,
  now: number
): void {
  db.run(
    `INSERT INTO product_vector_state (product_id, store_id, model, doc_hash, words_hash, embedded_at, fail_key, fail_until, fail_kind)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT (product_id) DO UPDATE SET fail_key = excluded.fail_key, fail_until = excluded.fail_until, fail_kind = excluded.fail_kind`,
    [
      w.productId,
      storeId,
      EMBED_MODEL,
      now,
      w.key,
      kind === 'input' || kind === 'shape' ? null : now + TEMP_QUARANTINE_MS,
      kind,
    ]
  );
}

/**
 * Commit the state of products whose vectors were just upserted, each against the CURRENT row: a product edited meanwhile stays
 * stale (the next pass re-embeds the new text); one that stopped being indexable has its fresh vectors listed for deletion.
 */
export function commitVectorWork(
  db: SyncSql,
  storeId: string,
  ready: VectorWork[],
  now: number
): { embedded: number; cleanup: string[] } {
  let embedded = 0;
  const cleanup: string[] = [];
  db.transactionSync(() => {
    const current = new Map(
      loadProducts(
        db,
        storeId,
        ready.map(w => w.productId)
      ).map(p => [p.id, p])
    );
    for (const w of ready) {
      const p = current.get(w.productId);
      const stillSame =
        p?.indexable === true &&
        (!w.needDoc || (p.doc !== null && textHash(p.doc) === w.docHash)) &&
        (!w.needWords || (p.words !== null && textHash(p.words) === w.wordsHash));
      if (!stillSame) {
        // edited meanwhile: stays stale (next pass re-embeds the new text); not indexable any more: drop what we just wrote
        if (!p?.indexable) cleanup.push(idOf(w.productId, 'd'), idOf(w.productId, 'w'));
        continue;
      }
      const prev = db.all(
        'SELECT model, doc_hash, words_hash FROM product_vector_state WHERE product_id = ?',
        [w.productId]
      )[0];
      const keep = prev?.model === EMBED_MODEL;
      const docHash = w.needDoc ? w.docHash : keep ? (prev!.doc_hash as string | null) : null;
      const wordsHash = w.needWords
        ? w.wordsHash
        : p.words === null
          ? null
          : keep
            ? (prev!.words_hash as string | null)
            : null;
      db.run(
        `INSERT INTO product_vector_state (product_id, store_id, model, doc_hash, words_hash, embedded_at, fail_key, fail_until, fail_kind)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
         ON CONFLICT (product_id) DO UPDATE SET model = excluded.model, doc_hash = excluded.doc_hash, words_hash = excluded.words_hash,
           embedded_at = excluded.embedded_at, fail_key = NULL, fail_until = NULL, fail_kind = NULL`,
        [w.productId, storeId, EMBED_MODEL, docHash, wordsHash, now]
      );
      if (p.words === null && prev?.words_hash) cleanup.push(idOf(w.productId, 'w')); // emptied words: the old words vector goes
      embedded++;
    }
  });
  return { embedded, cleanup };
}

/** One pass: embed up to `batchLimit` stale products, delete orphaned vectors. Call again while `embedded > 0`. */
export async function syncProductVectors(
  db: SyncSql,
  storeId: string,
  deps: SyncDeps
): Promise<SyncResult> {
  if (!storeId) throw new MoneyError('STORE_REQUIRED', 'storeId is required', 500);
  const now = deps.now ?? Date.now();
  const result: SyncResult = {
    embedded: 0,
    deleted: 0,
    quarantined: 0,
    capped: false,
    retry: false,
  };
  const plan = planVectorWork(db, storeId, deps.batchLimit ?? 50, now);

  // orphans: remove the vectors first (an idempotent external call), then forget the state
  if (plan.orphans.length > 0) {
    await deps.index.deleteByIds(plan.orphans.flatMap(id => [idOf(id, 'd'), idOf(id, 'w')]));
    db.transactionSync(() => {
      for (const id of plan.orphans)
        db.run('DELETE FROM product_vector_state WHERE product_id = ? AND store_id = ?', [
          id,
          storeId,
        ]);
    });
    result.deleted = plan.orphans.length;
  }

  let work = plan.work;
  const cap = deps.dailyCap ?? DEFAULT_DAILY_CAP;
  const reserve = (n: number) => reserveEmbedTexts(db, storeId, n, cap, now);
  const textCount = (w: VectorWork) =>
    (w.needDoc && w.doc ? 1 : 0) + (w.needWords && w.words ? 1 : 0);
  // trim the batch to what the day's budget still allows (greedy, in order); an exhausted budget embeds nothing
  let room = cap - embedUsageToday(db, storeId, now);
  const fit: VectorWork[] = [];
  for (const w of work) {
    const n = textCount(w);
    if (n > room) {
      result.capped = true;
      break;
    }
    room -= n;
    fit.push(w);
  }
  work = fit;
  if (work.length === 0) return result;

  // embed: every text of the batch together; on a batch failure fall back to one product at a time
  const textsOf = (w: VectorWork) => [
    ...(w.needDoc && w.doc ? [w.doc] : []),
    ...(w.needWords && w.words ? [w.words] : []),
  ];
  const vectors = new Map<string, { d?: number[]; w?: number[] }>();
  const fail = (w: VectorWork, e: unknown) => {
    const f =
      e instanceof EmbeddingFailure ? e : new EmbeddingFailure('provider', 'embed failed', true);
    deps.onFailure?.({ productId: w.productId, kind: f.kind, retryable: f.retryable });
    if (f.retryable) {
      result.retry = true;
      return; // transient: stays stale, the caller schedules another pass
    }
    quarantineVectorFailure(db, storeId, w, f.kind, now);
    result.quarantined++;
  };
  const assign = (w: VectorWork, vs: number[][]) => {
    let i = 0;
    const e: { d?: number[]; w?: number[] } = {};
    if (w.needDoc && w.doc) e.d = vs[i++];
    if (w.needWords && w.words) e.w = vs[i++];
    vectors.set(w.productId, e);
  };
  const all = work.flatMap(textsOf);
  try {
    const vs = await embedTexts(deps.provider, all, reserve);
    let at = 0;
    for (const w of work) {
      const n = textsOf(w).length;
      assign(w, vs.slice(at, at + n));
      at += n;
    }
  } catch (batchError) {
    if (batchError instanceof EmbedCapReached) result.capped = true;
    else
      for (const w of work) {
        try {
          assign(w, await embedTexts(deps.provider, textsOf(w), reserve));
        } catch (e) {
          if (e instanceof EmbedCapReached) {
            result.capped = true; // spend stops now; what is left stays stale for tomorrow
            break;
          }
          fail(w, e);
        }
      }
  }

  // upsert to Vectorize (external), then commit the state product by product against the CURRENT row
  const ready = work.filter(w => vectors.has(w.productId));
  if (ready.length === 0) return result;
  const upserts = ready.flatMap(w => {
    const v = vectors.get(w.productId)!;
    const meta = { storeId, productId: w.productId, model: EMBED_MODEL };
    return [
      ...(v.d
        ? [
            {
              id: idOf(w.productId, 'd'),
              values: v.d,
              namespace: storeId,
              metadata: { ...meta, kind: 'doc' },
            },
          ]
        : []),
      ...(v.w
        ? [
            {
              id: idOf(w.productId, 'w'),
              values: v.w,
              namespace: storeId,
              metadata: { ...meta, kind: 'words' },
            },
          ]
        : []),
    ];
  });
  if (upserts.length > 0) await deps.index.upsert(upserts); // a throw here writes NO state: the whole batch stays stale
  const committed = commitVectorWork(db, storeId, ready, now);
  result.embedded += committed.embedded;
  const cleanup = committed.cleanup;
  if (cleanup.length > 0) await deps.index.deleteByIds(cleanup);
  return result;
}

/** Embed everything stale, in passes (the backfill for existing products, and the alarm backstop). Stops on a retryable failure. */
export async function backfillProductVectors(
  db: SyncSql,
  storeId: string,
  deps: SyncDeps,
  maxPasses = 200
): Promise<{
  embedded: number;
  deleted: number;
  quarantined: number;
  capped: boolean;
  retry: boolean;
}> {
  const total = { embedded: 0, deleted: 0, quarantined: 0, capped: false, retry: false };
  for (let i = 0; i < maxPasses; i++) {
    const r = await syncProductVectors(db, storeId, deps);
    total.embedded += r.embedded;
    total.deleted += r.deleted;
    total.quarantined += r.quarantined;
    total.capped ||= r.capped;
    total.retry ||= r.retry;
    if (r.retry || r.capped || (r.embedded === 0 && r.quarantined === 0 && r.deleted === 0)) break;
  }
  return total;
}

/**
 * The index line of the search-insights page ("N of M ready / N failed"), counts only. `products` = indexable products with a
 * document; `stale` = those whose vectors are missing or out of date and that are not quarantined; `failed` = those quarantined
 * (their text set could not be embedded). Same staleness rules as `planVectorWork`; read-only (the DO twin of `storeIndexStatus`).
 */
export function vectorStatus(
  db: SyncSql,
  storeId: string,
  now = Date.now()
): { products: number; indexed: number; stale: number; failed: number } {
  const state = new Map(
    db
      .all('SELECT * FROM product_vector_state WHERE store_id = ?', [storeId])
      .map(r => [r.product_id as string, r])
  );
  let products = 0;
  let stale = 0;
  let failed = 0;
  for (const p of loadProducts(db, storeId)) {
    if (!p.indexable) continue;
    products++;
    const st = state.get(p.id);
    const sameModel = st?.model === EMBED_MODEL;
    const needDoc = !st || !sameModel || st.doc_hash !== (p.doc ? textHash(p.doc) : null);
    const needWords =
      p.words !== null && (!st || !sameModel || st.words_hash !== textHash(p.words));
    const clearWords = !!st && sameModel && p.words === null && st.words_hash !== null;
    if (!needDoc && !needWords && !clearWords) continue;
    const key = textHash(`${p.doc ?? ''}\u001f${p.words ?? ''}`);
    const quarantined =
      !!st && st.fail_key === key && (st.fail_until === null || (st.fail_until as number) > now);
    if (quarantined) failed++;
    else stale++;
  }
  return { products, indexed: products - stale - failed, stale, failed };
}

/** True while any indexable product still needs a vector (the cheap probe behind a retry alarm). */
export const hasStaleVectors = (db: SyncSql, storeId: string, now = Date.now()): boolean => {
  const p = planVectorWork(db, storeId, 1, now);
  return p.work.length > 0 || p.orphans.length > 0;
};

// ---- query ---------------------------------------------------------------------------------------------------------

/**
 * Of the product ids a Vectorize query returned, the ones the storefront may show: active, not deleted, public audience, and
 * vectored by THIS model. The Worker queries Vectorize (it holds the binding) and asks the DO this, so a stale or foreign vector
 * can never surface a hidden product (`vectorVisible` op).
 */
export function visibleVectorProductIds(db: SyncSql, storeId: string, ids: string[]): string[] {
  if (!storeId) throw new MoneyError('STORE_REQUIRED', 'storeId is required', 500);
  if (ids.length === 0) return [];
  if (ids.length > 200) throw new MoneyError('BAD_ARGS', 'ids', 400);
  return db
    .all(
      `SELECT p.id FROM products p JOIN product_vector_state s ON s.product_id = p.id AND s.model = ?
        WHERE p.store_id = ? AND p.${INDEXABLE_SQL.replace(' AND ', ' AND p.')} AND p.audience = 'public'
          AND p.id IN (${ids.map(() => '?').join(',')})`,
      [EMBED_MODEL, storeId, ...ids]
    )
    .map(r => r.id as string);
}

/**
 * The vector leg: product ids nearest to the query vector (cosine distance = 1 - Vectorize score), within
 * `maxDistance`, nearest first. Store-scoped twice (the namespace, then the DO's own rows decide visibility:
 * storefront = active, not deleted, public audience, vectors of THIS model only), so a stale or foreign vector can
 * never surface a product the storefront must not show.
 */
export async function semanticProductIds(
  db: SyncSql,
  storeId: string,
  queryVector: number[],
  index: VectorizeLike,
  opts: { limit?: number; maxDistance?: number } = {}
): Promise<string[]> {
  if (!storeId) throw new MoneyError('STORE_REQUIRED', 'storeId is required', 500);
  checkVectors([queryVector], 1);
  const limit = Math.max(1, Math.floor(opts.limit ?? HYBRID_LEG));
  const maxDistance = opts.maxDistance ?? DEFAULT_VECTOR_MAX_DISTANCE;
  const res = await index.query(queryVector, {
    topK: VECTORIZE_TOPK_MAX,
    namespace: storeId,
    filter: { storeId },
    returnMetadata: 'none',
  });
  const best = new Map<string, number>();
  for (const m of res.matches ?? []) {
    const productId = m.id.slice(0, m.id.lastIndexOf(':'));
    const d = 1 - m.score;
    if (!productId || !(d <= maxDistance)) continue;
    if (d < (best.get(productId) ?? Infinity)) best.set(productId, d);
  }
  if (best.size === 0) return [];
  const ids = [...best.keys()];
  const visible = new Set(visibleVectorProductIds(db, storeId, ids));
  return ids
    .filter(id => visible.has(id))
    .sort((a, b) => best.get(a)! - best.get(b)! || (a < b ? -1 : 1))
    .slice(0, limit);
}

/** Embed ONE query text (the caller races it against its own timeout and budget, like the Postgres path). */
export async function embedQuery(
  provider: EmbeddingProviderLike,
  text: string,
  budget?: { db: SyncSql; storeId: string; dailyCap?: number; now?: number }
): Promise<number[]> {
  const t = trimWs(text);
  if (!t) throw new EmbeddingFailure('input', 'empty query', false);
  const reserve = budget
    ? (n: number) =>
        reserveEmbedTexts(
          budget.db,
          budget.storeId,
          n,
          budget.dailyCap ?? DEFAULT_DAILY_CAP,
          budget.now
        )
    : undefined;
  return (await embedTexts(provider, [t], reserve))[0];
}
