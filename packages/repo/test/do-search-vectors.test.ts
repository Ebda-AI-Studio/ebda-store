// Semantic search on the DO + Vectorize with fakes: a deterministic 1024-dim bag-of-words embedder and an in-memory
// namespaced cosine index with Vectorize's behaviour (ids <= 64 bytes, topK <= 100, namespace isolation).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { ensureSearchIndex } from '../src/do/search';
import { closeStore } from '../src/do/closure';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  EmbeddingFailure,
  backfillProductVectors,
  buildEmbedDoc,
  buildEmbedWords,
  embedQuery,
  embedUsageToday,
  hasStaleVectors,
  semanticProductIds,
  syncProductVectors,
  textHash,
  type EmbeddingProviderLike,
  type VectorizeLike,
} from '../src/do/search-vectors';

function vec(text: string): number[] {
  const v = new Array(EMBED_DIMS).fill(0);
  for (const w of text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)) {
    let h = 7;
    for (const c of w) h = (h * 131 + c.codePointAt(0)!) % EMBED_DIMS;
    v[h] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}
function fakeProvider(
  o: { failOn?: (t: string) => EmbeddingFailure | null; batchFail?: boolean } = {}
) {
  const calls: string[][] = [];
  const p: EmbeddingProviderLike & { calls: string[][] } = {
    model: EMBED_MODEL,
    calls,
    async embed(texts) {
      calls.push(texts);
      if (o.batchFail && texts.length > 1)
        throw new EmbeddingFailure('provider', 'batch down', true);
      for (const t of texts) {
        const f = o.failOn?.(t);
        if (f) throw f;
      }
      return texts.map(vec);
    },
  };
  return p;
}
function fakeIndex() {
  const store = new Map<
    string,
    { values: number[]; namespace: string; metadata: Record<string, unknown> }
  >();
  const idx: VectorizeLike & { store: typeof store; failUpsert: boolean } = {
    store,
    failUpsert: false,
    async upsert(vs) {
      if (idx.failUpsert) throw new Error('vectorize down');
      for (const v of vs) {
        if (new TextEncoder().encode(v.id).length > 64) throw new Error('id > 64 bytes');
        if (v.values.length !== EMBED_DIMS) throw new Error('dims');
        store.set(`${v.namespace}|${v.id}`, {
          values: v.values,
          namespace: v.namespace,
          metadata: v.metadata,
        });
      }
    },
    async deleteByIds(ids) {
      for (const k of [...store.keys()]) if (ids.includes(k.split('|')[1])) store.delete(k);
    },
    async query(q, o) {
      if (o.topK > 100) throw new Error('topK > 100');
      const m = [...store.values()]
        .filter(
          v =>
            v.namespace === o.namespace &&
            // Production has NO metadata index: any `filter` matches nothing (measured 2026-11-11).
            !o.filter
        )
        .map(v => ({
          id: [...store].find(([, s]) => s === v)![0].split('|')[1],
          score: q.reduce((s, x, i) => s + x * v.values[i], 0),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, o.topK);
      return { matches: m };
    },
  };
  return idx;
}
function fx() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureSearchIndex(db);
  const add = (
    id: string,
    name: string,
    o: {
      nameAr?: string;
      desc?: string;
      terms?: string;
      status?: string;
      audience?: string;
      store?: string;
      deleted?: boolean;
    } = {}
  ) =>
    raw
      .prepare(
        `INSERT INTO products (id, store_id, name, name_ar, description, search_terms, slug, price, status, audience, deleted_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)`
      )
      .run(
        id,
        o.store ?? 's1',
        name,
        o.nameAr ?? null,
        o.desc ?? null,
        o.terms ?? null,
        id,
        o.status ?? 'active',
        o.audience ?? 'public',
        o.deleted ? 1 : null
      );
  const state = (id: string) =>
    raw.prepare('SELECT * FROM product_vector_state WHERE product_id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
  return { raw, db, add, state };
}
const q = async (
  f: ReturnType<typeof fx>,
  idx: VectorizeLike,
  text: string,
  o: { store?: string; max?: number } = {}
) =>
  semanticProductIds(f.db, o.store ?? 's1', await embedQuery(fakeProvider(), text), idx, {
    maxDistance: o.max,
  });

describe('embed document', () => {
  it('names (Arabic first) + descriptions, tags become spaces, 1500-char cap, null when empty; words trimmed', () => {
    expect(
      buildEmbedDoc({
        name: ' Ring ',
        nameAr: 'خاتم',
        description: '<p>Solid</p><p>gold</p>',
        descriptionAr: null,
      })
    ).toBe('خاتم\nRing\nSolid gold');
    expect(buildEmbedDoc({ name: 'a', description: 'price < 50 > 3' })).toBe('a\nprice < 50 > 3');
    expect(buildEmbedDoc({ name: '  ', description: ' \n ' })).toBeNull();
    expect([
      ...buildEmbedDoc({ name: 'n', description: 'x'.repeat(2000) })!.split('\n')[1],
    ]).toHaveLength(1500);
    expect(buildEmbedWords(' \t ')).toBeNull();
    expect(buildEmbedWords(' a, b ')).toBe('a, b');
  });
  it('model and dimensions equal the Postgres indexer (pgvector today)', () => {
    const src = fs.readFileSync(
      new URL('../../../apps/api/src/lib/search/embedding-provider.ts', import.meta.url),
      'utf8'
    );
    expect(src).toContain(`EMBED_MODEL = '${EMBED_MODEL}'`);
    expect(src).toContain(`EMBED_DIMS = ${EMBED_DIMS}`);
  });
});

describe('a deleted (closed) store is never indexed (audit P2-7)', () => {
  const ddl = (f: ReturnType<typeof fx>) =>
    f.raw.exec('CREATE TABLE IF NOT EXISTS do_flags (name TEXT PRIMARY KEY, value INTEGER)');

  it('a closed store writes nothing and calls no provider', async () => {
    const f = fx();
    ddl(f);
    f.add('a', 'Gold ring', { desc: 'solid gold' });
    closeStore(f.db);
    const idx = fakeIndex();
    const prov = fakeProvider();
    expect(await syncProductVectors(f.db, 's1', { provider: prov, index: idx })).toMatchObject({
      embedded: 0,
    });
    expect(idx.store.size).toBe(0);
    expect(prov.calls.length).toBe(0);
  });

  it('an index job in flight when the store is deleted does not write the vectors back', async () => {
    const f = fx();
    ddl(f);
    f.add('a', 'Gold ring', { desc: 'solid gold' });
    const idx = fakeIndex();
    const inner = fakeProvider();
    const prov = {
      ...inner,
      async embed(texts: string[]) {
        const out = await inner.embed(texts);
        closeStore(f.db); // the deletion lands while the provider call is in flight
        return out;
      },
    };
    const r = await syncProductVectors(f.db, 's1', { provider: prov, index: idx });
    expect(idx.store.size).toBe(0);
    expect(r.embedded).toBe(0);
    expect(f.state('a')).toBeUndefined();
  });
});

describe('sync + backfill', () => {
  it('embeds only active, public-or-not, non-deleted products WITH text; second pass is a no-op; ids fit Vectorize', async () => {
    const f = fx();
    const idx = fakeIndex();
    f.add('a', 'Gold ring', { desc: 'solid gold', terms: 'jewellery, ذهب' });
    f.add('wsale', 'Wholesale ring', { audience: 'wholesale_only' });
    f.add('draft', 'Draft ring', { status: 'draft' });
    f.add('del', 'Deleted ring', { deleted: true });
    f.add('empty', ' ');
    const prov = fakeProvider();
    const r = await backfillProductVectors(f.db, 's1', { provider: prov, index: idx });
    expect(r.embedded).toBe(2); // a + wholesale (indexed, hidden at query time)
    expect([...idx.store.keys()].sort()).toEqual(['s1|a:d', 's1|a:w', 's1|wsale:d']);
    const calls = prov.calls.length;
    expect(await syncProductVectors(f.db, 's1', { provider: prov, index: idx })).toMatchObject({
      embedded: 0,
      deleted: 0,
    });
    expect(prov.calls.length).toBe(calls);
    expect(hasStaleVectors(f.db, 's1')).toBe(false);
  });

  it('an edit re-embeds only what changed (words only / doc only); emptied words delete the words vector', async () => {
    const f = fx();
    const idx = fakeIndex();
    f.add('a', 'Gold ring', { terms: 'shiny' });
    const prov = fakeProvider();
    const deps = { provider: prov, index: idx };
    await syncProductVectors(f.db, 's1', deps);
    prov.calls.length = 0;
    f.raw.exec(`UPDATE products SET search_terms = 'bright' WHERE id = 'a'`);
    await syncProductVectors(f.db, 's1', deps);
    expect(prov.calls.flat()).toEqual(['bright']);
    prov.calls.length = 0;
    f.raw.exec(`UPDATE products SET name = 'Silver ring' WHERE id = 'a'`);
    await syncProductVectors(f.db, 's1', deps);
    expect(prov.calls.flat()).toEqual(['Silver ring']);
    f.raw.exec(`UPDATE products SET search_terms = NULL WHERE id = 'a'`);
    await syncProductVectors(f.db, 's1', deps);
    expect([...idx.store.keys()].sort()).toEqual(['s1|a:d']);
    expect(f.state('a')!.words_hash).toBeNull();
  });

  it('unpublish, delete and hard-delete remove the vectors; republish re-embeds', async () => {
    const f = fx();
    const idx = fakeIndex();
    const deps = { provider: fakeProvider(), index: idx };
    f.add('a', 'Ring');
    f.add('b', 'Chain');
    await syncProductVectors(f.db, 's1', deps);
    f.raw.exec(`UPDATE products SET status = 'draft' WHERE id = 'a'`);
    f.raw.exec(`DELETE FROM products WHERE id = 'b'`);
    expect(hasStaleVectors(f.db, 's1')).toBe(true);
    expect((await syncProductVectors(f.db, 's1', deps)).deleted).toBe(2);
    expect(idx.store.size).toBe(0);
    f.raw.exec(`UPDATE products SET status = 'active' WHERE id = 'a'`);
    expect((await syncProductVectors(f.db, 's1', deps)).embedded).toBe(1);
  });

  it('a Vectorize failure writes NO state (retried whole); a model change re-embeds everything', async () => {
    const f = fx();
    const idx = fakeIndex();
    f.add('a', 'Ring');
    idx.failUpsert = true;
    await expect(
      syncProductVectors(f.db, 's1', { provider: fakeProvider(), index: idx })
    ).rejects.toThrow('vectorize down');
    expect(f.state('a')).toBeUndefined();
    idx.failUpsert = false;
    await syncProductVectors(f.db, 's1', { provider: fakeProvider(), index: idx });
    f.raw.exec(`UPDATE product_vector_state SET model = 'old-model'`);
    expect(
      (await syncProductVectors(f.db, 's1', { provider: fakeProvider(), index: idx })).embedded
    ).toBe(1);
  });

  it('an edit between embed and commit leaves the product stale (never stamped with the old vector); unpublished meanwhile -> vectors deleted', async () => {
    const f = fx();
    const idx = fakeIndex();
    f.add('a', 'Ring');
    f.add('b', 'Chain');
    const racing: EmbeddingProviderLike = {
      model: EMBED_MODEL,
      async embed(texts) {
        f.raw.exec(`UPDATE products SET name = 'Ring v2' WHERE id = 'a'`);
        f.raw.exec(`UPDATE products SET status = 'draft' WHERE id = 'b'`);
        return texts.map(vec);
      },
    };
    const r = await syncProductVectors(f.db, 's1', { provider: racing, index: idx });
    expect(r.embedded).toBe(0);
    expect(f.state('a')).toBeUndefined();
    expect(idx.store.has('s1|b:d')).toBe(false);
    expect(
      (await syncProductVectors(f.db, 's1', { provider: fakeProvider(), index: idx })).embedded
    ).toBe(1);
  });

  it('failures: transient -> retry flag, nothing stored; permanent -> quarantined until the text changes; batch failure falls back to singles', async () => {
    const f = fx();
    const idx = fakeIndex();
    f.add('good', 'Fine ring');
    f.add('bad', 'POISON ring');
    const seen: string[] = [];
    const prov = fakeProvider({
      failOn: t => (t.includes('POISON') ? new EmbeddingFailure('input', 'rejected', false) : null),
    });
    const r = await syncProductVectors(f.db, 's1', {
      provider: prov,
      index: idx,
      onFailure: x => seen.push(`${x.productId}:${x.kind}`),
    });
    expect(r).toMatchObject({ embedded: 1, quarantined: 1 });
    expect(seen).toEqual(['bad:input']);
    prov.calls.length = 0;
    await syncProductVectors(f.db, 's1', { provider: prov, index: idx });
    expect(prov.calls).toEqual([]); // quarantined: not retried
    f.raw.exec(`UPDATE products SET name = 'Clean ring' WHERE id = 'bad'`);
    expect((await syncProductVectors(f.db, 's1', { provider: prov, index: idx })).embedded).toBe(1);
    const f2 = fx();
    f2.add('x', 'Ring');
    const down = fakeProvider({ failOn: () => new EmbeddingFailure('timeout', 't', true) });
    const r2 = await syncProductVectors(f2.db, 's1', { provider: down, index: fakeIndex() });
    expect(r2).toMatchObject({ embedded: 0, retry: true });
    expect(f2.state('x')).toBeUndefined();
  });

  it('daily cap counts TEXTS SENT: 1,000 re-embeds of one product hit it; unchanged text is debounced; queries count; a wrong-dimension answer is refused', async () => {
    const g = fx();
    g.add('one', 'Ring 0');
    const gi = fakeIndex();
    const gp = fakeProvider();
    let capped = false;
    for (let i = 1; i <= 1000 && !capped; i++) {
      g.raw.exec(`UPDATE products SET name = 'Ring ${i}' WHERE id = 'one'`);
      capped = (await syncProductVectors(g.db, 's1', { provider: gp, index: gi, dailyCap: 50 }))
        .capped;
    }
    expect(capped).toBe(true);
    expect(gp.calls.flat().length).toBe(50); // spend stopped exactly at the cap, not 1,000
    expect(embedUsageToday(g.db, 's1')).toBe(50);
    g.raw.exec(`UPDATE products SET name = 'Ring z' WHERE id = 'one'`);
    expect(
      (await syncProductVectors(g.db, 's1', { provider: gp, index: gi, dailyCap: 50 })).embedded
    ).toBe(0);
    expect(gp.calls.flat().length).toBe(50);
    await expect(embedQuery(gp, 'ring', { db: g.db, storeId: 's1', dailyCap: 50 })).rejects.toThrow(
      'cap'
    );
    // debounce: touching a column that is not embedded text never calls the provider
    const h = fx();
    h.add('p', 'Ring');
    const hp = fakeProvider();
    await syncProductVectors(h.db, 's1', { provider: hp, index: fakeIndex() });
    const before = hp.calls.length;
    h.raw.exec(`UPDATE products SET price = 99, slug = 'zz' WHERE id = 'p'`);
    h.raw.exec(`UPDATE products SET name = 'Ring' WHERE id = 'p'`);
    await syncProductVectors(h.db, 's1', { provider: hp, index: fakeIndex() });
    expect(hp.calls.length).toBe(before);

    const f = fx();
    const idx = fakeIndex();
    for (let i = 0; i < 5; i++) f.add(`p${i}`, `Item ${i}`);
    const r1 = await syncProductVectors(f.db, 's1', {
      provider: fakeProvider(),
      index: idx,
      dailyCap: 3,
    });
    expect(r1).toMatchObject({ embedded: 3, capped: true });
    expect(
      (
        await syncProductVectors(f.db, 's1', {
          provider: fakeProvider(),
          index: idx,
          dailyCap: 3,
        })
      ).embedded
    ).toBe(0);
    const short: EmbeddingProviderLike = {
      model: EMBED_MODEL,
      embed: async t => t.map(() => [1, 2, 3]),
    };
    const f2 = fx();
    f2.add('a', 'Ring');
    expect(
      (await syncProductVectors(f2.db, 's1', { provider: short, index: fakeIndex() })).quarantined
    ).toBe(1);
  });
});

describe('semantic query', () => {
  it('nearest first within the max distance; wholesale-only, draft, deleted and other stores never surface', async () => {
    const f = fx();
    const idx = fakeIndex();
    f.add('ring', 'gold ring wedding');
    f.add('chain', 'silver chain necklace');
    f.add('ws', 'gold ring wedding', { audience: 'wholesale_only' });
    f.add('other', 'gold ring wedding', { store: 's2' });
    await syncProductVectors(f.db, 's1', { provider: fakeProvider(), index: idx });
    await syncProductVectors(f.db, 's2', { provider: fakeProvider(), index: idx });
    expect(await q(f, idx, 'gold ring')).toEqual(['ring']);
    expect(await q(f, idx, 'gold ring', { store: 's2' })).toEqual(['other']);
    expect(await q(f, idx, 'gold ring', { max: 0.0001 })).toEqual([]); // distance gate
    expect(await q(f, idx, 'gold ring', { store: 's3' })).toEqual([]);
    f.raw.exec(`UPDATE products SET status = 'draft' WHERE id = 'ring'`); // unpublished, vector not yet removed
    expect(await q(f, idx, 'gold ring')).toEqual([]);
    f.raw.exec(`UPDATE products SET status = 'active' WHERE id = 'ring'`);
    f.raw.exec(`UPDATE product_vector_state SET model = 'old' WHERE product_id = 'ring'`); // another model's vector
    expect(await q(f, idx, 'gold ring')).toEqual([]);
  });

  it('the better of the doc and words vectors wins; one entry per product; a refused query vector throws', async () => {
    const f = fx();
    const idx = fakeIndex();
    f.add('a', 'plain thing', { terms: 'جوال موبايل' });
    await syncProductVectors(f.db, 's1', { provider: fakeProvider(), index: idx });
    expect(await q(f, idx, 'جوال موبايل')).toEqual(['a']);
    await expect(semanticProductIds(f.db, 's1', [1, 2], idx)).rejects.toThrow();
  });
});

describe('text hash', () => {
  it('is stable, text-sensitive and length-aware', () => {
    expect(textHash('abc')).toBe(textHash('abc'));
    expect(new Set(['a', 'b', 'ab', 'ba', '', ' ', 'عباية']).size).toBe(7);
    expect(new Set(['a', 'b', 'ab', 'ba', '', ' ', 'عباية'].map(textHash)).size).toBe(7);
  });
});

describe('real-shaped scores (production bge-m3, 2026-11-11)', () => {
  const idx = {
    async query(_q: number[], o: { filter?: unknown; namespace: string }) {
      if (o.filter) return { matches: [] }; // no metadata index in production
      return {
        matches: [
          { id: 'p1:w', score: 0.465 }, // "gift for my wife": relevant top score
          { id: 'p1:d', score: 0.44 },
          { id: 'p2:d', score: 0.536 }, // "something for the sea"
          { id: 'p3:d', score: 0.413 }, // below the cut-off (0.45)
        ],
      };
    },
  } as unknown as VectorizeLike;
  it('keeps hits at score >= 0.45, drops the rest, and sends no filter', async () => {
    const db = { all: (_sql: string, p: unknown[]) => p.slice(2).map(id => ({ id })) };
    const ids = await semanticProductIds(db as never, 's1', new Array(EMBED_DIMS).fill(0.01), idx);
    expect(ids).toEqual(['p2', 'p1']); // nearest first; p3 (0.413) is beyond 0.55 distance
  });
});
