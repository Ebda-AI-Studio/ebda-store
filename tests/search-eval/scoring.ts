/**
 * Search eval scoring (Task 13): pure functions, no DB and no network, unit-tested in
 * tests/unit/search-eval-scoring.test.ts. `ranked` lists hold relevance TYPES (each product id
 * mapped to its type key, see catalogue.ts).
 *
 * The headline metric is HIT-RATE@10 at TYPE level (review M1): 1 when ANY product of the wanted
 * type is in the first 10, else 0. It is not recall: a type with 21 t-shirts scores 1 on one
 * t-shirt, and a sibling that does not match the query's attribute (a navy abaya for "black
 * abaya") counts as a hit. SEARCH-10's "recall@10" is measured as this hit-rate. nDCG@10 is the
 * metric that rewards filling the top 10 with the right type. The reciprocal rank is that of the
 * first product of the type.
 */
import { hybridOrder } from '../../apps/api/src/lib/search/rrf';

export const hitAt = (ranked: readonly string[], target: string, k: number): 0 | 1 =>
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
  hit10: 0 | 1;
  rr: number;
  ndcg10: number;
  /** No result at all. */
  empty: boolean;
}

export interface ClassScore {
  n: number;
  hit10: number;
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
    hit10: avg(r => r.hit10),
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

export interface BarCheck {
  name: string;
  value: number;
  need: string;
  ok: boolean;
  /**
   * How many queries of this check's class can still go wrong before it fails (negative = how many
   * short): floor((value - minimum) × n). For MRR it is the rank headroom in "whole first hits".
   */
  marginQueries: number;
}

export interface BarResult {
  ok: boolean;
  /** Names of the failed rules (empty when ok). */
  failed: string[];
  /** Hybrid minus lexical hit-rate@10 over dialect + franco together. */
  lift: number;
  /** lift >= +0.15: semantic search is earning its cost (else STOP-3b stays off). */
  earnsCost: boolean;
  checks: BarCheck[];
}

const EPS = 1e-9;
/** One query in 50, the same tolerance SEARCH-10 already uses for "no regression". */
export const FLOOR_TOLERANCE = 0.02;

function check(name: string, value: number, min: number, n: number, need?: string): BarCheck {
  return {
    name,
    value,
    need: need ?? `>= ${min.toFixed(2)}`,
    ok: value >= min - EPS,
    marginQueries: Math.floor((value - min) * n + 1e-6),
  };
}

/**
 * Ruling SEARCH-10: hybrid hit-rate@10 >= 0.90 overall and >= 0.80 on each of dialect and franco;
 * MRR >= 0.70; no msa or en regression worse than -0.02 against lexical-only; and a dialect +
 * franco lift of at least +0.15 hit-rate@10, or semantic is not earning its cost.
 * Plus ABSOLUTE floors (review M5, Ruling SEARCH-T13-4): msa and en hybrid hit-rate@10 never below
 * `floors` (the names-only hybrid result of record, baseline.json) minus FLOOR_TOLERANCE, so a
 * change that helps Franco but costs MSA or English (AI words did: msa 0.98 → 0.94) is visible.
 */
export function passBar(
  lexical: Summary,
  hybrid: Summary,
  floors: Record<'msa' | 'en', number>
): BarResult {
  const c = (s: Summary, cls: string) =>
    s.byClass[cls] ?? { n: 0, hit10: 0, mrr: 0, ndcg10: 0, zero: 0 };
  const df = ['dialect', 'franco'];
  const nDf = df.reduce((a, k) => a + c(hybrid, k).n, 0);
  const lift = nDf
    ? df.reduce((a, k) => a + (c(hybrid, k).hit10 - c(lexical, k).hit10) * c(hybrid, k).n, 0) / nDf
    : 0;
  const checks: BarCheck[] = [
    check('hybrid hit-rate@10 overall', hybrid.core.hit10, 0.9, hybrid.core.n),
    check('dialect hit-rate@10', c(hybrid, 'dialect').hit10, 0.8, c(hybrid, 'dialect').n),
    check('franco hit-rate@10', c(hybrid, 'franco').hit10, 0.8, c(hybrid, 'franco').n),
    check('hybrid MRR overall', hybrid.core.mrr, 0.7, hybrid.core.n),
    ...(['msa', 'en'] as const).map(k =>
      check(
        `${k} no regression`,
        c(hybrid, k).hit10 - c(lexical, k).hit10,
        -0.02,
        c(hybrid, k).n,
        '>= -0.02'
      )
    ),
    ...(['msa', 'en'] as const).map(k =>
      check(
        `${k} floor`,
        c(hybrid, k).hit10,
        floors[k] - FLOOR_TOLERANCE,
        c(hybrid, k).n,
        `>= ${floors[k].toFixed(2)} - ${FLOOR_TOLERANCE}`
      )
    ),
    check('dialect+franco lift', lift, 0.15, nDf, '>= +0.15'),
  ];
  const failed = checks.filter(x => !x.ok).map(x => x.name);
  return { ok: failed.length === 0, failed, lift, earnsCost: lift >= 0.15 - EPS, checks };
}
