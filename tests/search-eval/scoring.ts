/**
 * Search eval scoring (Task 13): pure functions, no DB and no network, unit-tested in
 * tests/unit/search-eval-scoring.test.ts. `ranked` lists hold relevance TYPES (each product id
 * mapped to its type key, see catalogue.ts), so "recall@10" = a product of the wanted type is in
 * the first 10, and the reciprocal rank is that of the first such product.
 */
import { hybridOrder } from '../../apps/api/src/lib/search/rrf';

export const recallAt = (ranked: readonly string[], target: string, k: number): 0 | 1 =>
  ranked.slice(0, k).includes(target) ? 1 : 0;

export const reciprocalRank = (ranked: readonly string[], target: string): number => {
  const i = ranked.indexOf(target);
  return i < 0 ? 0 : 1 / (i + 1);
};

/** nDCG@k, binary relevance; the ideal list holds min(k, relevantTotal) relevant items. */
export function ndcgAt(
  ranked: readonly string[],
  target: string,
  k: number,
  relevantTotal: number
): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((t, i) => {
    if (t === target) dcg += 1 / Math.log2(i + 2);
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(k, relevantTotal); i++) ideal += 1 / Math.log2(i + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

/**
 * The storefront order for one keyword-strong threshold, composed from the two legs exactly as
 * `rankedSearchWithMode` does (product-search.service.ts): at or over `strongAt` keyword matches
 * the list is keyword-only, else the first `head` keyword ids are fused (RRF) with the vector ids
 * and the keyword tail is appended. `strongAt = null` = no threshold (always fused). The harness
 * asserts this equals the real `rankedSearch` at the shipped constants, so it cannot drift.
 */
export function hybridVariant(
  lexical: readonly string[],
  vector: readonly string[],
  strongAt: number | null,
  head: number
): string[] {
  if (strongAt !== null && lexical.length >= strongAt) return [...lexical];
  return hybridOrder([...lexical], [...vector], head);
}

export interface QueryScore {
  cls: string;
  core: boolean;
  key: string;
  q: string;
  recall10: 0 | 1;
  rr: number;
  ndcg10: number;
  /** No result at all. */
  empty: boolean;
}

export interface ClassScore {
  n: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
  /** Share of queries with no result at all. */
  zero: number;
}

export interface Summary {
  byClass: Record<string, ClassScore>;
  /** The core set (msa + dialect + franco + en). */
  core: ClassScore;
}

function mean(rows: readonly QueryScore[]): ClassScore {
  const n = rows.length;
  const avg = (f: (r: QueryScore) => number) => (n ? rows.reduce((a, r) => a + f(r), 0) / n : 0);
  return {
    n,
    recall10: avg(r => r.recall10),
    mrr: avg(r => r.rr),
    ndcg10: avg(r => r.ndcg10),
    zero: avg(r => (r.empty ? 1 : 0)),
  };
}

export function summarise(scores: readonly QueryScore[]): Summary {
  const byClass: Record<string, ClassScore> = {};
  for (const cls of [...new Set(scores.map(s => s.cls))])
    byClass[cls] = mean(scores.filter(s => s.cls === cls));
  return { byClass, core: mean(scores.filter(s => s.core)) };
}

export interface BarResult {
  ok: boolean;
  /** Names of the failed rules (empty when ok). */
  failed: string[];
  /** Hybrid minus lexical recall@10 over dialect + franco together. */
  lift: number;
  /** lift >= +0.15: semantic search is earning its cost (else STOP-3b stays off). */
  earnsCost: boolean;
  checks: Array<{ name: string; value: number; need: string; ok: boolean }>;
}

const EPS = 1e-9;

/**
 * Ruling SEARCH-10: hybrid recall@10 >= 0.90 overall and >= 0.80 on each of dialect and franco;
 * MRR >= 0.70; no msa or en regression worse than -0.02 against lexical-only; and a dialect +
 * franco lift of at least +0.15 recall@10, or semantic is not earning its cost.
 */
export function passBar(lexical: Summary, hybrid: Summary): BarResult {
  const c = (s: Summary, cls: string) =>
    s.byClass[cls] ?? { n: 0, recall10: 0, mrr: 0, ndcg10: 0, zero: 0 };
  const df = ['dialect', 'franco'];
  const nDf = df.reduce((a, k) => a + c(hybrid, k).n, 0);
  const lift = nDf
    ? df.reduce(
        (a, k) => a + (c(hybrid, k).recall10 - c(lexical, k).recall10) * c(hybrid, k).n,
        0
      ) / nDf
    : 0;
  const checks = [
    {
      name: 'hybrid recall@10 overall',
      value: hybrid.core.recall10,
      need: '>= 0.90',
      ok: hybrid.core.recall10 >= 0.9 - EPS,
    },
    {
      name: 'dialect recall@10',
      value: c(hybrid, 'dialect').recall10,
      need: '>= 0.80',
      ok: c(hybrid, 'dialect').recall10 >= 0.8 - EPS,
    },
    {
      name: 'franco recall@10',
      value: c(hybrid, 'franco').recall10,
      need: '>= 0.80',
      ok: c(hybrid, 'franco').recall10 >= 0.8 - EPS,
    },
    {
      name: 'hybrid MRR overall',
      value: hybrid.core.mrr,
      need: '>= 0.70',
      ok: hybrid.core.mrr >= 0.7 - EPS,
    },
    ...['msa', 'en'].map(k => {
      const d = c(hybrid, k).recall10 - c(lexical, k).recall10;
      return { name: `${k} no regression`, value: d, need: '>= -0.02', ok: d >= -0.02 - EPS };
    }),
    { name: 'dialect+franco lift', value: lift, need: '>= +0.15', ok: lift >= 0.15 - EPS },
  ];
  const failed = checks.filter(x => !x.ok).map(x => x.name);
  return { ok: failed.length === 0, failed, lift, earnsCost: lift >= 0.15 - EPS, checks };
}
