#!/usr/bin/env tsx
/**
 * Search quality eval (search program P1, Task 13; Ruling SEARCH-10). MANUAL / on demand, never
 * per-push: it needs a real embedding model (and, for --generate-ai-terms, Gemini).
 *
 * Seeds the SYNTHETIC store of catalogue.ts into a throwaway store on DATABASE_URL, embeds it with
 * the production indexer, runs every query through the production code (`searchProductIds`,
 * `semanticProductIds`, `rankedSearchWithMode`: budgets, race, cache, SQL), and scores keyword-only
 * against hybrid per query class, for keyword-strong thresholds 20 / 50 / none and vector
 * distances 0.45 / 0.55 / 0.65 / none. DATABASE_URL and REDIS_URL must both be loopback (guards.ts:
 * the eval writes a store and INCRs the shared embed-budget counters). Exit 0 = the shipped
 * configuration meets the bar, 1 = below the bar (a finding, not a test to edit), 2 = harness
 * error, 3 = fake embeddings (NOT REPRESENTATIVE: no verdict).
 *
 * Embedding provider, first that applies:
 *   --real                the local proxy Worker (embed-proxy/), started and stopped by this run:
 *                         real bge-m3 via the AI binding on the `wrangler login` account (Whisky),
 *                         127.0.0.1 only, a per-run secret header (proxy.ts); no token copied
 *   CF_AI_ACCOUNT_ID + CF_AI_API_TOKEN   the production REST provider
 *   neither               a hash fake (plumbing only)
 * Query vectors are fetched once, up front, outside the 400 ms race (a laptop's round trip to
 * Workers AI is not the Worker's), then served to the production path from memory: the eval
 * measures quality; latency is Task 14's job.
 *
 *   DATABASE_URL=$TEST_DB DIRECT_URL=$TEST_DB REDIS_URL=$TEST_REDIS \
 *     npm run search:eval -- --real --ai-terms --out f.json
 * ($TEST_DB = the migrated local pg17 + pgvector of the plan's Global Constraints.)
 *
 * --real                real bge-m3 (above)
 * --ai-terms            fill products.search_terms from ai-terms.json (Task 8 generator output)
 * --generate-ai-terms   regenerate ai-terms.json with the Task 8 generator first (GEMINI_API_KEY;
 *                       one Gemini call per product), then run with them
 * --out <file>          write the full results (every variant, every query) as JSON
 * --two-vector-sim      with --ai-terms: also score a SIMULATED second vector for the words (harness
 *                       KNN, not production code; Ruling SEARCH-T13-5)
 * --keep                keep the seeded store (default: deleted at the end)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { assertLocalTargets } from './guards';
import { startEmbedProxy } from './proxy';
import { createHash } from 'node:crypto';
import { catalogueRows, evalQueries, EVAL_ABSENT, EVAL_FORMS, type EvalQuery } from './catalogue';
import {
  hybridVariant,
  ndcgAt,
  passBar,
  hitAt,
  reciprocalRank,
  summarise,
  type BarResult,
  type QueryScore,
  type Summary,
} from './scoring';

export { hitAt, reciprocalRank } from './scoring';

const AI_TERMS_FILE = new URL('./ai-terms.json', import.meta.url);
const BASELINE_FILE = new URL('./baseline.json', import.meta.url);
const THRESHOLDS: Array<number | null> = [20, 50, null];
const DISTANCES: Array<number | null> = [0.45, 0.55, 0.65, null];
const SEARCHER = 'eval:harness';

interface AiTermsFile {
  note: string;
  model: string;
  generatedAt: string;
  /** False while a --generate-ai-terms run is still filling it (it resumes from here). */
  complete: boolean;
  terms: Record<string, string | null>;
}

const arg = (name: string) => process.argv.includes(name);
const argValue = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fmt = (n: number) => n.toFixed(2);
const label = (t: number | null, d: number | null) => `t=${t ?? 'none'} d=${d ?? 'none'}`;

async function main(): Promise<number> {
  const { databaseUrl: dbUrl } = assertLocalTargets(process.env);
  // A local scratch process: lift the spend guards that exist for anonymous traffic (the eval's own
  // spend is bounded by its size: ~250 product embeds + ~270 query embeds per run).
  for (const [k, v] of Object.entries({
    SEARCH_SEMANTIC_ENABLED: 'true',
    SEARCH_EMBED_PER_SEARCHER_PER_MIN: '1000000',
    SEARCH_QUERY_EMBED_STORE_DAILY_CAP: '1000000',
    SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP: '1000000',
    SEARCH_EMBED_GLOBAL_DAILY_CAP: '1000000',
    SEARCH_EMBED_STORE_DAILY_CAP: '1000000',
    AI_STORE_DAILY_REQUEST_CAP: '100000',
    INNGEST_DRY_RUN: 'true',
    LOG_LEVEL: 'warn',
  }))
    process.env[k] ??= v;
  delete process.env.SEARCH_VECTOR_MAX_DISTANCE; // the shipped default is what gets the verdict

  const ep = await import('../../apps/api/src/lib/search/embedding-provider');
  const search = await import('../../apps/api/src/services/product-search.service');
  const index = await import('../../apps/api/src/services/product-index.service');
  const { redis } = await import('../../apps/api/src/services/redis.service');
  const db = await import('@ebda/database');
  const { fakeVector } = await import('../helpers/fake-embeddings');

  // ---- embedding provider -------------------------------------------------------------------
  const remote = ep.getEmbeddingProvider(); // REST when CF_AI_* are set
  const proxy = arg('--real') ? await startEmbedProxy(ep.EMBED_MAX_BATCH) : null;
  const mode: 'proxy' | 'rest' | 'fake' = proxy ? 'proxy' : remote ? 'rest' : 'fake';
  const backend = async (texts: string[]): Promise<number[][]> => {
    if (proxy) return proxy.embed(texts);
    if (mode === 'rest') return remote!.embed(texts);
    return texts.map(fakeVector);
  };
  const prefetched = new Map<string, number[]>();
  let providerCalls = 0;
  let backendCalls = 0;
  ep.setEmbeddingProviderForTests({
    model: ep.EMBED_MODEL,
    async embed(texts) {
      providerCalls++;
      if (texts.every(t => prefetched.has(t))) return texts.map(t => prefetched.get(t)!);
      backendCalls++;
      return backend(texts);
    },
  });
  if (mode === 'fake')
    console.log(
      '\n*** FAKE EMBEDDINGS: NOT REPRESENTATIVE. Plumbing only; no verdict on the bar. ***\n'
    );
  console.log(`[eval] embedding provider: ${mode} (${ep.EMBED_MODEL})`);

  await redis.connect();
  const owner = db.createPrismaClient({ connectionString: dbUrl, role: 'owner' });
  const run = `${Date.now().toString(36)}${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 4)}`;
  const rows = catalogueRows();
  const typeOf = new Map<string, string>();
  const rowOf = new Map<string, (typeof rows)[number]>();
  const relevantTotal = new Map<string, number>();
  for (const r of rows) relevantTotal.set(r.type, (relevantTotal.get(r.type) ?? 0) + 1);

  const user = await owner.user.create({
    data: {
      email: `search-eval-${run}@example.test`,
      passwordHash: 'x',
      firstName: 'Search',
      lastName: 'Eval',
      role: 'store_admin',
      emailVerified: true,
      status: 'active',
    },
  });
  const store = await owner.store.create({
    data: {
      name: `Search eval ${run}`,
      nameAr: 'متجر تقييم البحث',
      slug: `search-eval-${run}`,
      ownerId: user.id,
      status: 'active',
      currency: 'EGP',
      template: 'qamar',
      theme: {},
      settings: { defaultLanguage: 'ar' },
    },
  });
  const S = store.id;
  try {
    // ---- AI search terms (Task 8 generator) -------------------------------------------------
    let aiTerms: AiTermsFile | null = null;
    if (arg('--generate-ai-terms')) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('--generate-ai-terms needs GEMINI_API_KEY');
      const { generateProductSearchTerms } =
        await import('../../apps/api/src/lib/ai/product-search-terms-generator');
      const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
      const throttle = Number(process.env.AI_BULK_THROTTLE_MS ?? 1000);
      // Resumable: written after every product, so a Gemini outage loses nothing; a rerun only
      // generates the products still missing.
      let prior: AiTermsFile | null = null;
      try {
        prior = JSON.parse(readFileSync(AI_TERMS_FILE, 'utf8')) as AiTermsFile;
      } catch {
        prior = null;
      }
      const file: AiTermsFile = {
        note: 'SYNTHETIC eval store (tests/search-eval/catalogue.ts): Task 8 generator output, products seeded with names only, no description, no category.',
        model,
        generatedAt: new Date().toISOString(),
        complete: false,
        terms: prior && !prior.complete && prior.model === model ? prior.terms : {},
      };
      const save = () => writeFileSync(AI_TERMS_FILE, JSON.stringify(file, null, 2) + '\n');
      for (const r of rows) {
        if (r.id in file.terms) continue;
        for (let attempt = 1; ; attempt++) {
          try {
            file.terms[r.id] = await db.runInStoreScope(S, () =>
              generateProductSearchTerms(
                {
                  storeId: S,
                  storeName: 'متجر',
                  product: { name: r.name, nameAr: r.nameAr },
                  categoryNames: [],
                },
                key,
                model
              )
            );
            break;
          } catch (err) {
            if (attempt >= 8) throw err;
            const wait = 15_000 * attempt;
            console.warn(
              `[eval] terms for ${r.id} failed (attempt ${attempt}); retrying in ${wait / 1000} s`
            );
            await sleep(wait);
          }
        }
        save();
        await sleep(throttle);
      }
      file.complete = true;
      save();
      aiTerms = file;
      console.log(`[eval] ai-terms.json complete: ${rows.length} products`);
    } else if (arg('--ai-terms')) {
      aiTerms = JSON.parse(readFileSync(AI_TERMS_FILE, 'utf8')) as AiTermsFile;
      if (!aiTerms.complete)
        throw new Error('ai-terms.json is incomplete: rerun --generate-ai-terms');
    }

    // ---- seed + index ------------------------------------------------------------------------
    await owner.product.createMany({
      data: rows.map(r => ({
        storeId: S,
        slug: `${r.id}-${run}`,
        name: r.name,
        nameAr: r.nameAr,
        searchTerms: aiTerms?.terms[r.id] ?? null,
        price: 10_000,
        inventory: 10,
        status: 'active' as const,
      })),
    });
    for (const p of await owner.product.findMany({
      where: { storeId: S },
      select: { id: true, slug: true },
    })) {
      const r = rows.find(x => `${x.id}-${run}` === p.slug)!;
      typeOf.set(p.id, r.type);
      rowOf.set(p.id, r);
    }
    for (;;) {
      const r = await db.runInStoreScope(S, () =>
        index.indexStore(S, { batchSize: 50, maxDocs: 1000 })
      );
      if (r.skipped || r.capped) throw new Error(`indexer stopped: ${JSON.stringify(r)}`);
      if (!r.remaining) break;
    }
    const status = await db.runInStoreScope(S, () => index.storeIndexStatus(S));
    if (status.indexed !== rows.length)
      throw new Error(`indexed ${status.indexed} of ${rows.length}: ${JSON.stringify(status)}`);
    console.log(
      `[eval] store ${S}: ${rows.length} products indexed (${aiTerms ? 'WITH AI search terms' : 'no search terms'})`
    );

    // ---- query vectors, once, outside the race ----------------------------------------------
    const queries = evalQueries();
    const texts = [
      ...new Set(
        [...queries.map(q => q.q), ...EVAL_ABSENT]
          .filter(q => search.shouldEmbedQuery(q))
          .map(q => search.queryEmbedText(q))
      ),
    ];
    const vecs = await backend(texts);
    texts.forEach((t, i) => prefetched.set(t, vecs[i]));
    const callsBefore = providerCalls;
    const backendBefore = backendCalls;

    // ---- run every query ---------------------------------------------------------------------
    interface Legs {
      q: EvalQuery;
      lexical: string[];
      vector: Map<number | null, string[]>;
      shipped: string[];
      degraded: boolean;
      embeddable: boolean;
      /** Harness-side vector legs (--two-vector-sim): 'one@d' and 'two@d'. */
      sim?: Map<string, string[]>;
    }
    const legs: Legs[] = [];
    const tenant = <T>(fn: () => Promise<T>) => db.runInTenantContext(S, fn);
    for (const q of queries) {
      const lexical = await tenant(() => search.searchProductIds(S, q.q, { scope: 'storefront' }));
      // The shipped path first (default distance), exactly what /public/products ranks with.
      const shippedRun = await tenant(() =>
        search.rankedSearchWithMode(S, q.q, { searcher: SEARCHER })
      );
      const vector = new Map<number | null, string[]>();
      for (const d of DISTANCES) {
        process.env.SEARCH_VECTOR_MAX_DISTANCE = String(d ?? 2);
        vector.set(
          d,
          await tenant(() => search.semanticProductIds(S, q.q, { searcher: SEARCHER }))
        );
      }
      delete process.env.SEARCH_VECTOR_MAX_DISTANCE;
      legs.push({
        q,
        lexical,
        vector,
        shipped: shippedRun.ids,
        degraded: shippedRun.degraded,
        embeddable: search.shouldEmbedQuery(q.q),
      });
    }
    // Absent products: the right answer is nothing.
    const absent: Array<Pick<Legs, 'lexical' | 'vector' | 'sim'> & { q: string }> = [];
    for (const q of EVAL_ABSENT) {
      const lexical = await tenant(() => search.searchProductIds(S, q, { scope: 'storefront' }));
      const vector = new Map<number | null, string[]>();
      for (const d of DISTANCES) {
        process.env.SEARCH_VECTOR_MAX_DISTANCE = String(d ?? 2);
        vector.set(d, await tenant(() => search.semanticProductIds(S, q, { searcher: SEARCHER })));
      }
      delete process.env.SEARCH_VECTOR_MAX_DISTANCE;
      absent.push({ q, lexical, vector });
    }
    const degraded = legs.filter(l => l.degraded).length;
    if (degraded) throw new Error(`${degraded} queries ran degraded (vector leg unavailable)`);
    // Drift guard: the composed shipped variant must equal the real ranked list.
    const shippedD = search.vectorMaxDistance();
    for (const l of legs) {
      const composed = hybridVariant(
        l.lexical,
        l.vector.get(shippedD)!,
        search.KEYWORD_STRONG_AT,
        search.HYBRID_LEG
      );
      if (JSON.stringify(composed) !== JSON.stringify(l.shipped))
        throw new Error(`harness drift: composed order != rankedSearch for "${l.q.q}"`);
    }

    // ---- two-vector SIMULATION (--two-vector-sim, needs --ai-terms) ---------------------------
    // Ruling SEARCH-T13-5 asks whether a SECOND vector for the AI words beats one vector without
    // them. Not production code: the KNN runs here in JS over real bge-m3 vectors of (a) each
    // product's doc as the DB holds it now (names; the eval store has no descriptions) and (b) its
    // words alone; a product's distance is the nearer of the two. Since SEARCH-T13-7 production IS
    // two-vector: "two@d" must reproduce the production vector leg (agreement printed); "one@d"
    // (doc only) is the pre-T13-7 baseline for comparison.
    let simAgreement: number | null = null;
    if (arg('--two-vector-sim')) {
      if (!aiTerms) throw new Error('--two-vector-sim needs --ai-terms');
      const unit = (v: number[]) => {
        const n = Math.hypot(...v);
        return v.map(x => x / n);
      };
      const ids = [...rowOf.keys()];
      const docVec = (
        await backend(ids.map(id => `${rowOf.get(id)!.nameAr}\n${rowOf.get(id)!.name}`))
      ).map(unit);
      const withWords = ids.filter(id => aiTerms!.terms[rowOf.get(id)!.id]);
      const wordVecs = (await backend(withWords.map(id => aiTerms!.terms[rowOf.get(id)!.id]!))).map(
        unit
      );
      const wordVec = new Map(withWords.map((id, i) => [id, wordVecs[i]]));
      const dist = (a: number[], b: number[]) => 1 - a.reduce((x, y, i) => x + y * b[i], 0);
      const knn = (q: string, d: number, two: boolean): string[] => {
        if (!search.shouldEmbedQuery(q)) return [];
        const qv = unit(prefetched.get(search.queryEmbedText(q))!);
        return ids
          .map((id, i) => {
            const w = two ? wordVec.get(id) : undefined;
            return { id, d: Math.min(dist(qv, docVec[i]), w ? dist(qv, w) : 2) };
          })
          .filter(x => x.d <= d)
          .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
          .slice(0, search.HYBRID_LEG)
          .map(x => x.id);
      };
      const simFor = (q: string) => {
        const m = new Map<string, string[]>();
        for (const d of [0.55, 0.65]) {
          m.set(`one@${d}`, knn(q, d, false));
          m.set(`two@${d}`, knn(q, d, true));
        }
        return m;
      };
      for (const l of legs) l.sim = simFor(l.q.q);
      for (const a of absent) a.sim = simFor(a.q);
      simAgreement =
        legs.filter(
          l => JSON.stringify(l.sim!.get('two@0.55')) === JSON.stringify(l.vector.get(0.55))
        ).length / legs.length;
    }

    // ---- score -------------------------------------------------------------------------------
    const types = (ids: string[]) => ids.map(id => typeOf.get(id)!);
    const score = (l: Legs, ids: string[]): QueryScore & { top: string[]; negIn10: number } => {
      const t = types(ids);
      return {
        cls: l.q.cls,
        core: l.q.core,
        key: l.q.key,
        q: l.q.q,
        hit10: hitAt(t, l.q.key, 10),
        rr: reciprocalRank(t, l.q.key),
        ndcg10: ndcgAt(t, l.q.key, 10, relevantTotal.get(l.q.key)!),
        empty: ids.length === 0,
        top: t.slice(0, 5),
        negIn10: t.slice(0, 10).filter(x => x.startsWith('x-')).length,
      };
    };
    const variants: Record<string, (l: Pick<Legs, 'lexical' | 'vector' | 'sim'>) => string[]> = {
      lexical: l => l.lexical,
      'vector-only d=0.55': l => l.vector.get(0.55)!,
    };
    for (const d of DISTANCES)
      for (const t of THRESHOLDS)
        variants[label(t, d)] = l =>
          hybridVariant(l.lexical, l.vector.get(d)!, t, search.HYBRID_LEG);
    if (simAgreement !== null)
      for (const k of ['one@0.55', 'two@0.55', 'two@0.65'])
        variants[`SIM ${k}`] = l =>
          hybridVariant(l.lexical, l.sim!.get(k)!, search.KEYWORD_STRONG_AT, search.HYBRID_LEG);
    const shippedLabel = label(search.KEYWORD_STRONG_AT, shippedD);
    const results: Record<
      string,
      {
        summary: Summary;
        bar: BarResult;
        negIn10: number;
        /** Share of absent-product queries answered with at least one product (false positives). */
        absentAnswered: number;
        /** Mean products in the first 10 for an absent-product query. */
        absentIn10: number;
        scores: ReturnType<typeof score>[];
      }
    > = {};
    for (const [name, f] of Object.entries(variants)) {
      const scores = legs.map(l => score(l, f(l)));
      results[name] = {
        scores,
        summary: summarise(scores),
        bar: undefined as unknown as BarResult,
        negIn10: scores.reduce((a, s) => a + s.negIn10, 0) / scores.length,
        absentAnswered: absent.filter(a => f(a).length > 0).length / absent.length,
        absentIn10: absent.reduce((a, x) => a + Math.min(10, f(x).length), 0) / absent.length,
      };
    }
    const { floors } = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as {
      floors: Record<'msa' | 'en', number>;
    };
    for (const r of Object.values(results))
      r.bar = passBar(results.lexical.summary, r.summary, floors);

    // ---- report ------------------------------------------------------------------------------
    const L = results.lexical;
    const H = results[shippedLabel];
    const hardClasses = EVAL_FORMS.map(f => `hard-${f}`);
    const classes = [...EVAL_FORMS, 'typo', 'ortho', 'mixed', 'phrase', ...hardClasses];
    console.log(
      `\nPer class: keyword-only vs hybrid (shipped: ${shippedLabel}). hit-rate@10 / MRR / nDCG@10 / zero-result`
    );
    console.log('class     n    | lexical                   | hybrid');
    for (const c of [...classes, 'CORE']) {
      const l = c === 'CORE' ? L.summary.core : L.summary.byClass[c];
      const h = c === 'CORE' ? H.summary.core : H.summary.byClass[c];
      if (!l || !h) continue;
      const cell = (x: typeof l) =>
        `${fmt(x.hit10)} / ${fmt(x.mrr)} / ${fmt(x.ndcg10)} / ${fmt(x.zero)}`;
      console.log(`${c.padEnd(8)} ${String(l.n).padStart(3)}   | ${cell(l)} | ${cell(h)}`);
    }
    console.log(
      `\nVariants on the core 200: hit-rate@10 / MRR / nDCG@10 · d+f lift · negatives in top 10 · absent (${absent.length}) answered / shown · bar`
    );
    for (const [name, r] of Object.entries(results)) {
      const s = r.summary.core;
      console.log(
        `${name.padEnd(20)} ${fmt(s.hit10)} / ${fmt(s.mrr)} / ${fmt(s.ndcg10)} · ${fmt(r.bar.lift).padStart(5)} · ${fmt(r.negIn10)} · ${fmt(r.absentAnswered)} / ${fmt(r.absentIn10)} · ${r.bar.ok ? 'PASS' : 'fail: ' + r.bar.failed.join(', ')}`
      );
    }
    console.log(
      `\nPer class hit-rate@10 / nDCG@10 by vector distance (threshold ${search.KEYWORD_STRONG_AT}):`
    );
    for (const d of DISTANCES) {
      const r = results[label(search.KEYWORD_STRONG_AT, d)].summary.byClass;
      console.log(
        `  d=${String(d ?? 'none').padEnd(5)} ` +
          classes.map(c => `${c} ${fmt(r[c]?.hit10 ?? 0)}/${fmt(r[c]?.ndcg10 ?? 0)}`).join('  ')
      );
    }
    const buckets = { '0': 0, '1-19': 0, '20-49': 0, '50+': 0 };
    for (const l of legs) {
      const n = l.lexical.length;
      buckets[n === 0 ? '0' : n < 20 ? '1-19' : n < 50 ? '20-49' : '50+']++;
    }
    // Hard set (review M2): lift of hybrid over keyword-only, per form and together.
    const liftOf = (cls: string[]) => {
      const n = cls.reduce((a, c) => a + (H.summary.byClass[c]?.n ?? 0), 0);
      return n
        ? cls.reduce(
            (a, c) =>
              a +
              ((H.summary.byClass[c]?.hit10 ?? 0) - (L.summary.byClass[c]?.hit10 ?? 0)) *
                (H.summary.byClass[c]?.n ?? 0),
            0
          ) / n
        : 0;
    };
    console.log(
      `\nHard set lift (hybrid − keyword-only hit-rate@10): ` +
        hardClasses.map(c => `${c} ${fmt(liftOf([c]))}`).join('  ') +
        ` · dialect+franco ${fmt(liftOf(['hard-dialect', 'hard-franco']))} · all ${fmt(liftOf(hardClasses))}`
    );
    console.log(`\nKeyword matches per query: ${JSON.stringify(buckets)}`);
    if (simAgreement !== null)
      console.log(
        `SIMULATION check: harness two-vector KNN equals the production (two-vector, SEARCH-T13-7) vector leg on ${(simAgreement * 100).toFixed(1)} % of queries (d=0.55)`
      );
    console.log(
      `Embeddable queries: ${legs.filter(l => l.embeddable).length}/${legs.length}; provider calls during queries: ${providerCalls - callsBefore}, of them not from the prefetch: ${backendCalls - backendBefore}`
    );
    console.log(`\nCore misses (hybrid, shipped config, target type not in top 10):`);
    for (const s of H.scores.filter(x => x.core && !x.hit10))
      console.log(
        `  ${s.cls.padEnd(7)} ${s.key.padEnd(11)} "${s.q}" → ${s.top.join(', ') || '(none)'}`
      );
    console.log(`\nWorse than keyword-only (reciprocal rank dropped):`);
    H.scores.forEach((s, i) => {
      const l = L.scores[i];
      if (s.rr < l.rr)
        console.log(
          `  ${s.cls.padEnd(7)} "${s.q}" rr ${fmt(l.rr)} → ${fmt(s.rr)} · top: ${s.top.join(', ')}`
        );
    });

    const verdict = H.bar;
    console.log(`\nBar (SEARCH-10) on the shipped config ${shippedLabel}:`);
    for (const c of verdict.checks)
      console.log(
        `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${fmt(c.value)} (${c.need}) · margin ${c.marginQueries} ${Math.abs(c.marginQueries) === 1 ? 'query' : 'queries'}`
      );
    if (!verdict.earnsCost)
      console.log(
        'SEMANTIC NOT EARNING ITS COST: keep SEARCH_SEMANTIC_ENABLED off (Ruling SEARCH-10)'
      );
    const out = argValue('--out');
    if (out) {
      writeFileSync(
        out,
        JSON.stringify(
          {
            mode,
            aiTerms: Boolean(aiTerms),
            products: rows.length,
            queries: legs.length,
            shipped: shippedLabel,
            buckets,
            results,
          },
          null,
          1
        )
      );
      console.log(`[eval] wrote ${out}`);
    }
    if (mode === 'fake') {
      console.log('\n*** FAKE EMBEDDINGS: NOT REPRESENTATIVE. Exit 3, no verdict. ***');
      return 3;
    }
    return verdict.ok ? 0 : 1;
  } finally {
    if (!arg('--keep')) {
      await owner.store.delete({ where: { id: S } });
      await owner.user.delete({ where: { id: user.id } });
    }
    await owner.$disconnect();
    await redis.disconnect();
    proxy?.stop();
  }
}

if (process.argv[1]?.endsWith('run.ts'))
  main().then(
    code => process.exit(code),
    err => {
      console.error(err);
      process.exit(2);
    }
  );
