/**
 * Help grounding for the Store assistant. The bundled corpus (apps/help/content, built by apps/api/scripts/build-help-corpus.mjs, chunk id =
 * `<articleId>:<locale>:<index>`) is embedded with bge-m3 into the `PRODUCT_VECTORS` index under the shared namespace `__help__` (product vectors
 * use the store id as namespace, so they never meet). Indexing is skip-if-unchanged: the corpus hash lives in KV `sl:help-hash`, and the vector ids
 * of the previous run in `sl:help-ids`, so a shrunk article leaves no stale vector. Search embeds the MASKED question; chunk text comes back in the
 * vector metadata. Embedding goes through the product's one embedding provider (lib/search/embedding-provider.ts), never a direct model call here.
 */
import { foldArabic, maskForModel, type HelpHit, type Locale } from '@ebda/shared/smart-layer';
import { cfBindings } from '../cf/bindings';
import { getEmbeddingProvider } from '../lib/search/embedding-provider';

type HelpCorpusDoc = {
  articleId: string;
  locale: Locale;
  title: string;
  url: string;
  appPath: string | null;
  capabilityIds: string[];
  chunks: string[];
};
export type HelpCorpus = { hash: string; docs: HelpCorpusDoc[] };

/**
 * The corpus ships as its own Worker module (Ruling BUNDLE-BUDGET-12: apps/api/src/cf/modules/help-corpus.mjs, built by
 * scripts/build-help-corpus.mjs at build time, git-ignored, never committed; uploaded by the `rules` entry of wrangler.jsonc), so its 435 KB is not part of worker.js. It is
 * loaded on first use (the hourly index job, or the first assistant turn) and cached per isolate. A variable specifier is left
 * alone by the bundler: on the Worker it resolves to the uploaded module (named relative to src/), in Node to the file next to the
 * sources. A missing module rejects loudly (the cron job logs it, the turn fails) - it is never an empty corpus.
 */
let corpusPromise: Promise<HelpCorpus> | undefined;
// pq-allow(unused-export): imported by tests/unit/assistant-adapter.test.ts and assistant-eval.test.ts
export function helpCorpus(): Promise<HelpCorpus> {
  corpusPromise ??= (async () => {
    const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
    const spec =
      nav?.userAgent === 'Cloudflare-Workers'
        ? './cf/modules/help-corpus.mjs'
        : '../cf/modules/help-corpus.mjs';
    return ((await import(/* @vite-ignore */ spec)) as { default: HelpCorpus }).default;
  })().catch(err => {
    corpusPromise = undefined; // a failed load is retried, not cached
    throw err;
  });
  return corpusPromise;
}

const HELP_NAMESPACE = '__help__';
// pq-allow(unused-export): imported by tests/unit/assistant-adapter.test.ts
export const HASH_KEY = 'sl:help-hash';
// pq-allow(unused-export): imported by tests/unit/assistant-adapter.test.ts
export const IDS_KEY = 'sl:help-ids';
const BATCH = 50;

type Vec = {
  upsert(
    v: Array<{ id: string; values: number[]; namespace: string; metadata: Record<string, string> }>
  ): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(
    values: number[],
    o: { namespace: string; topK: number; returnMetadata: 'all' }
  ): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
};
type Kv = { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
export type HelpDeps = {
  kv: Kv | undefined;
  vectors: Vec | undefined;
  embed: ((texts: string[]) => Promise<number[][]>) | undefined;
};

export function helpDeps(): HelpDeps {
  const b = cfBindings();
  const provider = getEmbeddingProvider();
  return {
    kv: b?.KV_CACHE as Kv | undefined,
    vectors: b?.PRODUCT_VECTORS as unknown as Vec | undefined,
    embed: provider ? t => provider.embed(t) : undefined,
  };
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const vecId = async (chunkId: string) => (await sha256Hex(`help\u0001${chunkId}`)).slice(0, 32);

/** Embeds the corpus when its hash changed. 'unavailable' (no index / no model / no KV) never throws: answers then have no help grounding. */
export async function ensureHelpIndex(
  d: HelpDeps,
  corpus?: HelpCorpus
): Promise<'skipped' | 'indexed' | 'unavailable'> {
  if (!d.vectors || !d.embed || !d.kv) return 'unavailable';
  corpus ??= await helpCorpus();
  if ((await d.kv.get(HASH_KEY)) === corpus.hash) return 'skipped';
  const rows: Array<{ id: string; text: string; doc: HelpCorpusDoc }> = [];
  for (const doc of corpus.docs)
    for (let i = 0; i < doc.chunks.length; i++)
      rows.push({
        id: await vecId(`${doc.articleId}:${doc.locale}:${i}`),
        text: doc.chunks[i]!,
        doc,
      });
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH);
    const values = await d.embed(part.map(r => r.text));
    await d.vectors.upsert(
      part.map((r, j) => ({
        id: r.id,
        values: values[j]!,
        namespace: HELP_NAMESPACE,
        metadata: {
          articleId: r.doc.articleId,
          locale: r.doc.locale,
          title: r.doc.title,
          url: r.doc.url,
          appPath: r.doc.appPath ?? '',
          text: r.text,
        },
      }))
    );
  }
  const now = new Set(rows.map(r => r.id));
  const before = JSON.parse((await d.kv.get(IDS_KEY)) ?? '[]') as string[];
  const stale = before.filter(id => !now.has(id));
  for (let i = 0; i < stale.length; i += 100) await d.vectors.deleteByIds(stale.slice(i, i + 100));
  await d.kv.put(IDS_KEY, JSON.stringify([...now]));
  await d.kv.put(HASH_KEY, corpus.hash); // last: a half-finished pass is simply run again
  return 'indexed';
}

export async function helpSearch(
  d: HelpDeps,
  q: string,
  locale: Locale,
  k: number
): Promise<HelpHit[]> {
  if (!d.vectors || !d.embed || !q.trim()) return [];
  const [v] = await d.embed([maskForModel(q).slice(0, 400)]);
  if (!v) return [];
  const r = await d.vectors.query(v, {
    namespace: HELP_NAMESPACE,
    topK: Math.max(k * 3, 12),
    returnMetadata: 'all',
  });
  return r.matches
    .filter(m => m.metadata?.locale === locale)
    .slice(0, k)
    .map(m => {
      const md = m.metadata as Record<string, string>;
      return {
        articleId: md.articleId!,
        title: md.title!,
        url: md.url!,
        appPath: md.appPath || null,
        text: md.text!,
        score: m.score,
      };
    });
}

/** Figures the guides state (72 hours, 24 hours ...): typed sources for the binding-claim rail. A sentence may repeat a documented figure; an invented one is replaced by a pointer. */
export async function helpFigureSources(
  corpus?: HelpCorpus
): Promise<
  Array<{ kind: 'limit'; key: string; text: { ar: string; en: string }; values: string[] }>
> {
  corpus ??= await helpCorpus();
  const by = new Map<string, { title: string; values: Set<string> }>();
  for (const d of corpus.docs) {
    const e = by.get(d.articleId) ?? { title: d.title, values: new Set<string>() };
    for (const c of d.chunks)
      for (const m of foldArabic(c).matchAll(/\d+(?:[.,]\d+)*/g)) e.values.add(m[0]);
    by.set(d.articleId, e);
  }
  return [...by].map(([key, e]) => ({
    kind: 'limit' as const,
    key: `help:${key}`,
    text: { ar: e.title, en: e.title },
    values: [...e.values],
  }));
}
