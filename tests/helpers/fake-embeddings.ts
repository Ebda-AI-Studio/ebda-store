/**
 * Deterministic stand-in for Workers AI bge-m3 (no network), shared by the indexer (Task 11) and
 * hybrid search (Task 12) integration tests. Identical text → identical vector, so a query equal
 * to a product's embed doc lands at cosine distance 0; unrelated texts land near distance 1.
 * Proves plumbing, isolation and fallback only; semantic QUALITY is the eval harness's job.
 */
import { createHash } from 'node:crypto';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  type EmbedOptions,
} from '../../apps/api/src/lib/search/embedding-provider';

export function fakeVector(text: string): number[] {
  const h = createHash('sha256').update(text).digest();
  return Array.from({ length: EMBED_DIMS }, (_, i) => (h[i % 32] - 128) / 128);
}

/** Same text → same vector; records every call's texts and options. */
export function fakeProvider() {
  const calls: string[][] = [];
  const options: Array<EmbedOptions | undefined> = [];
  return {
    calls,
    options,
    provider: {
      model: EMBED_MODEL,
      async embed(texts: string[], opts?: EmbedOptions) {
        calls.push(texts);
        options.push(opts);
        return texts.map(fakeVector);
      },
    },
  };
}
