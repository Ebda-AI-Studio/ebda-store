// LOCAL ONLY (Task 14): a deterministic FAKE bge-m3 with optional injected latency, so the search
// load test never touches Workers AI. Vectors are concept-aware: every spelling of an eval type
// (msa / dialect / franco / en / sibling names) shares a concept vector, so the vector leg returns
// realistic neighbour sets (a "كوتشي" query lands near the sneaker products) instead of noise.
// It proves performance and wiring, never semantic quality (that is Task 13's real-model eval).
import { createHash } from 'node:crypto';
import { EVAL_PRODUCTS } from '../../tests/search-eval/catalogue';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  EmbeddingError,
} from '../../apps/api/src/lib/search/embedding-provider';
import type { EmbeddingProvider } from '../../apps/api/src/lib/search/embedding-provider';

export const tokens = (t: string): string[] =>
  t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 2);

const seeded = (label: string): Float32Array => {
  const out = new Float32Array(EMBED_DIMS);
  let h = createHash('sha256').update(label).digest();
  for (let i = 0; i < EMBED_DIMS; i += 32) {
    for (let j = 0; j < 32; j++) out[i + j] = (h[j] - 127.5) / 127.5;
    h = createHash('sha256').update(h).digest();
  }
  return out;
};

const tokenVec = new Map<string, Float32Array>();
const conceptVec = new Map<string, Float32Array>();
const get = (m: Map<string, Float32Array>, k: string, prefix: string) => {
  let v = m.get(k);
  if (!v) m.set(k, (v = seeded(prefix + k)));
  return v;
};

const conceptOf = new Map<string, string>();
for (const p of EVAL_PRODUCTS) {
  const texts = [p.nameAr, p.name, ...Object.values(p.q), ...(p.siblings ?? []).flat()];
  for (const t of texts) for (const w of tokens(t)) if (!conceptOf.has(w)) conceptOf.set(w, p.key);
}

export function fakeVector(text: string): number[] {
  const acc = new Float32Array(EMBED_DIMS);
  const toks = tokens(text);
  const seen = new Map<string, number>();
  for (const w of toks) {
    const wv = get(tokenVec, w, 'w:');
    for (let i = 0; i < EMBED_DIMS; i++) acc[i] += 0.35 * wv[i];
    const c = conceptOf.get(w);
    if (c) seen.set(c, (seen.get(c) ?? 0) + 1);
  }
  for (const [c, n] of seen) {
    const cv = get(conceptVec, c, 'c:');
    for (let i = 0; i < EMBED_DIMS; i++) acc[i] += n * cv[i];
  }
  if (!toks.length) acc.set(seeded('empty'));
  let norm = 0;
  for (let i = 0; i < EMBED_DIMS; i++) norm += acc[i] * acc[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(acc, x => x / norm);
}

export interface LatencyProfile {
  /** Median ms of the healthy mode. */
  p50: number;
  /** 95th percentile ms of the healthy mode (sets the lognormal sigma). */
  p95: number;
  /** Fraction of calls that are slow (well over the 400 ms query budget). */
  slowRate: number;
  /** Fraction of calls that fail outright (a provider error). */
  errorRate: number;
}
export const NO_LATENCY: LatencyProfile = { p50: 0, p95: 0, slowRate: 0, errorRate: 0 };

export interface EmbedStats {
  calls: number;
  aborted: number;
  errors: number;
  slow: number;
  latencies: number[];
}

const gauss = () =>
  Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

export function makeFakeProvider(profile: LatencyProfile, stats?: EmbedStats): EmbeddingProvider {
  const sigma = profile.p50 > 0 ? Math.log(profile.p95 / profile.p50) / 1.645 : 0;
  return {
    model: EMBED_MODEL,
    async embed(texts, opts) {
      let ms = 0;
      let fail = false;
      if (profile.p50 > 0) {
        const r = Math.random();
        if (r < profile.errorRate) {
          fail = true;
          ms = 40 + Math.random() * 100;
        } else if (r < profile.errorRate + profile.slowRate) {
          ms = 500 + Math.random() * 1000;
          if (stats) stats.slow++;
        } else ms = profile.p50 * Math.exp(sigma * gauss());
      }
      if (stats) stats.calls++;
      const t0 = performance.now();
      if (ms > 0)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          opts?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            if (stats) stats.aborted++;
            reject(
              new EmbeddingError('aborted', 'embedding aborted by the caller', { retryable: false })
            );
          });
        });
      if (stats) stats.latencies.push(performance.now() - t0);
      if (fail) {
        if (stats) stats.errors++;
        throw new EmbeddingError('provider', 'injected provider failure');
      }
      return texts.map(fakeVector);
    },
  };
}
