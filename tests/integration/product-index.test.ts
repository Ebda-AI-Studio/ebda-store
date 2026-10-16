/**
 * Search program Task 11: the product embedding indexer against a real Postgres 17 + pgvector.
 * A deterministic fake provider stands in for Workers AI (no network). Fixtures use the
 * owner-role process client; the "as production" cases run on the strict-RLS role `ebda_app`
 * with the code-level tenant guard on (both layers), the way the Worker runs them.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto, { createHash } from 'node:crypto';
import { prisma, createPrismaClient, runWithRequestDb, runInStoreScope } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.hoisted(() => {
  process.env.SEARCH_EMBED_THROTTLE_MS = '0';
});
const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(async (e: { name: string; data: Record<string, unknown> }) => {
      sent.push(e);
      return { ids: [] };
    }),
    createFunction: vi.fn(() => ({})),
  },
}));

const alerts: Array<{ source: string; context?: Record<string, unknown> }> = [];
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async (a: { source: string; context?: Record<string, unknown> }) => {
    alerts.push(a);
  }),
}));

const { setEmbeddingProviderForTests, EMBED_DIMS, EMBED_MODEL, EmbeddingError } =
  await import('../../apps/api/src/lib/search/embedding-provider');
const { indexStore, findStaleProducts, storeIndexStatus, hasStaleProducts } =
  await import('../../apps/api/src/services/product-index.service');
const { handleSearchProductIndex, handleSearchIndexBackstop, INDEX_RETRIES } =
  await import('../../apps/api/src/lib/inngest/functions/search-product-index');

/** Deterministic fake: same text → same vector; counts calls. */
function fakeProvider() {
  const calls: string[][] = [];
  return {
    calls,
    provider: {
      model: EMBED_MODEL,
      async embed(texts: string[]) {
        calls.push(texts);
        return texts.map(t => {
          const h = createHash('sha256').update(t).digest();
          return Array.from({ length: EMBED_DIMS }, (_, i) => (h[i % 32] - 128) / 128);
        });
      },
    },
  };
}

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
/** Run as production does: the guarded client, on the strict-RLS role `ebda_app`. */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn);

/** A fake Inngest `step` that memoizes like Inngest and records sent events. */
function fakeStep() {
  const memo = new Map<string, unknown>();
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  return {
    events,
    memo,
    run: async (name: string, fn: () => Promise<unknown>) => {
      if (!memo.has(name)) memo.set(name, JSON.parse(JSON.stringify((await fn()) ?? null)));
      return memo.get(name);
    },
    sendEvent: async (
      _id: string,
      e:
        | { name: string; data: Record<string, unknown> }
        | Array<{ name: string; data: Record<string, unknown> }>
    ) => {
      events.push(...(Array.isArray(e) ? e : [e]));
    },
  };
}

const embeddingRow = async (productId: string) =>
  (
    await prisma.$queryRaw<
      Array<{ store_id: string; content_hash: string; model: string }>
    >`SELECT store_id, content_hash, model FROM product_embeddings WHERE product_id = ${productId}`
  )[0];

async function mkUser(tag: string) {
  return prisma.user.create({
    data: {
      email: `ix-${tag}-${crypto.randomUUID().slice(0, 8)}@test.local`,
      passwordHash: 'x',
      firstName: 'I',
      lastName: 'X',
      role: 'store_admin',
      emailVerified: true,
    },
  });
}
async function mkStore(ownerId: string, tag: string, status = 'active') {
  return prisma.store.create({
    data: {
      name: `ix ${tag}`,
      slug: `ix-${tag}-${crypto.randomUUID().slice(0, 8)}`,
      ownerId,
      status: status as 'active',
    },
  });
}
async function mkProduct(storeId: string, data: Record<string, unknown> = {}) {
  return (
    await prisma.product.create({
      data: {
        storeId,
        slug: `p-${crypto.randomUUID().slice(0, 10)}`,
        name: 'Shoes',
        nameAr: 'أحذية',
        price: 100,
        status: 'active', // only storefront-searchable products are indexed (review M5)
        ...data,
      },
    })
  ).id;
}

describe.skipIf(!hasDb)('product embedding indexer (Task 11)', () => {
  const ownerIds: string[] = [];
  const storeIds: string[] = [];
  let storeId: string;
  let pid: string;

  beforeAll(async () => {
    const owner = await mkUser('main');
    ownerIds.push(owner.id);
    storeId = (await mkStore(owner.id, 'main')).id;
    storeIds.push(storeId);
    pid = await mkProduct(storeId);
  });
  afterEach(() => {
    setEmbeddingProviderForTests(undefined);
    delete process.env.SEARCH_EMBED_STORE_DAILY_CAP;
    sent.length = 0;
  });
  afterAll(async () => {
    for (const id of storeIds) {
      await prisma.product.deleteMany({ where: { storeId: id } });
      await prisma.store.deleteMany({ where: { id } });
    }
    await prisma.user.deleteMany({ where: { id: { in: ownerIds } } });
  });

  it('embeds stale products once, then is a no-op until the text changes', async () => {
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    expect((await runInStoreScope(storeId, () => indexStore(storeId))).embedded).toBe(1);
    expect((await runInStoreScope(storeId, () => indexStore(storeId))).embedded).toBe(0);
    expect(f.calls).toHaveLength(1);
    await prisma.product.update({ where: { id: pid }, data: { searchTerms: 'gazma' } });
    expect(await runInStoreScope(storeId, () => findStaleProducts(storeId, 10))).toHaveLength(1);
    expect((await runInStoreScope(storeId, () => indexStore(storeId))).embedded).toBe(1);
    expect(f.calls.flat().some(t => t.includes('gazma'))).toBe(true);
    const row = await embeddingRow(pid);
    expect(row).toMatchObject({ store_id: storeId, model: EMBED_MODEL });
  });

  it('a model change makes every row stale', async () => {
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(storeId, () => indexStore(storeId));
    await prisma.$executeRaw`UPDATE product_embeddings SET model = 'old-model' WHERE product_id = ${pid}`;
    expect(await runInStoreScope(storeId, () => hasStaleProducts(storeId))).toBe(true);
    expect((await runInStoreScope(storeId, () => indexStore(storeId))).embedded).toBe(1);
    expect((await embeddingRow(pid)).model).toBe(EMBED_MODEL);
  });

  it('honours the per-store daily cap and reports capped (not for the per-call maxDocs)', async () => {
    await prisma.product.update({ where: { id: pid }, data: { searchTerms: 'kotshy' } });
    process.env.SEARCH_EMBED_STORE_DAILY_CAP = '0';
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    const r = await runInStoreScope(storeId, () => indexStore(storeId));
    expect(r).toMatchObject({ embedded: 0, capped: true, remaining: true });
    expect(f.calls).toHaveLength(0);
    delete process.env.SEARCH_EMBED_STORE_DAILY_CAP;
    const r2 = await runInStoreScope(storeId, () => indexStore(storeId));
    expect(r2).toMatchObject({ embedded: 1, capped: false, remaining: false });
  });

  it('maxDocs stops early with remaining=true and capped=false (preflight B-T11b)', async () => {
    const owner = await mkUser('max');
    ownerIds.push(owner.id);
    const s = (await mkStore(owner.id, 'max')).id;
    storeIds.push(s);
    for (let i = 0; i < 3; i++) await mkProduct(s, { name: `Item ${i}` });
    setEmbeddingProviderForTests(fakeProvider().provider);
    const r = await runInStoreScope(s, () => indexStore(s, { maxDocs: 2, batchSize: 1 }));
    expect(r).toMatchObject({ embedded: 2, remaining: true, capped: false });
    const r2 = await runInStoreScope(s, () => indexStore(s, { maxDocs: 2 }));
    expect(r2).toMatchObject({ embedded: 1, remaining: false, capped: false });
  });

  it('no provider → skipped, nothing written, no throw', async () => {
    await prisma.product.update({ where: { id: pid }, data: { searchTerms: 'no-provider' } });
    setEmbeddingProviderForTests(null);
    expect(await runInStoreScope(storeId, () => indexStore(storeId))).toMatchObject({
      skipped: 'no-provider',
    });
    expect(await runInStoreScope(storeId, () => hasStaleProducts(storeId))).toBe(true);
  });

  it('an empty doc is never embedded, and its old embedding is removed (SEARCH-T9-1)', async () => {
    const owner = await mkUser('empty');
    ownerIds.push(owner.id);
    const s = (await mkStore(owner.id, 'empty')).id;
    storeIds.push(s);
    const p = await mkProduct(s, { name: 'Bag', nameAr: null });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(s, () => indexStore(s));
    expect(await embeddingRow(p)).toBeDefined();
    await prisma.product.update({ where: { id: p }, data: { name: '   ' } });
    const r = await runInStoreScope(s, () => indexStore(s));
    expect(r).toMatchObject({ embedded: 0, remaining: false });
    expect(await embeddingRow(p)).toBeUndefined();
    expect(f.calls.flat().every(t => t.trim() !== '')).toBe(true);
    expect(await runInStoreScope(s, () => storeIndexStatus(s))).toEqual({
      products: 0,
      indexed: 0,
      stale: 0,
      failed: 0,
    });
  });

  it('a product edited between embed and write is not stamped with the old text', async () => {
    const owner = await mkUser('race');
    ownerIds.push(owner.id);
    const s = (await mkStore(owner.id, 'race')).id;
    storeIds.push(s);
    const p = await mkProduct(s, { name: 'Before' });
    const f = fakeProvider();
    let edited = false;
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      async embed(texts) {
        if (!edited) {
          edited = true;
          await prisma.product.update({ where: { id: p }, data: { name: 'After' } });
        }
        return f.provider.embed(texts);
      },
    });
    // One batch only: the vector of "Before" must NOT be written once the text became "After".
    const r = await runInStoreScope(s, () => indexStore(s, { maxDocs: 1 }));
    expect(r).toMatchObject({ embedded: 0, remaining: true });
    expect(await embeddingRow(p)).toBeUndefined();
    // The next run embeds the new text.
    await runInStoreScope(s, () => indexStore(s));
    expect(f.calls.flat().some(t => t.includes('After'))).toBe(true);
    expect(await runInStoreScope(s, () => hasStaleProducts(s))).toBe(false);
  });

  it('status counts only up-to-date rows as indexed', async () => {
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(storeId, () => indexStore(storeId));
    expect(await runInStoreScope(storeId, () => storeIndexStatus(storeId))).toEqual({
      products: 1,
      indexed: 1,
      stale: 0,
      failed: 0,
    });
    await prisma.product.update({ where: { id: pid }, data: { searchTerms: 'changed' } });
    expect(await runInStoreScope(storeId, () => storeIndexStatus(storeId))).toEqual({
      products: 1,
      indexed: 0,
      stale: 1,
      failed: 0,
    });
  });

  it('as ebda_app + guard: the Inngest handler embeds via memoized steps, a retry never re-pays', async () => {
    await prisma.product.update({ where: { id: pid }, data: { searchTerms: 'retry-safe' } });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    const step = fakeStep();
    const event = { data: { storeId, reason: 'test' } };
    const r1 = await asApp(() => handleSearchProductIndex({ event, step }));
    expect(r1).toMatchObject({ embedded: 1 });
    // Inngest replays the whole function on a retry; memoized steps return their stored output.
    await asApp(() => handleSearchProductIndex({ event, step }));
    expect(f.calls).toHaveLength(1);
    expect((await embeddingRow(pid)).store_id).toBe(storeId);
  });

  it('as ebda_app + guard: the backstop sweep finds only stores with stale rows, each under its own scope', async () => {
    const owner = await mkUser('bs');
    ownerIds.push(owner.id);
    const staleStore = (await mkStore(owner.id, 'bs-stale')).id;
    const freshStore = (await mkStore(owner.id, 'bs-fresh')).id;
    const pausedStore = (await mkStore(owner.id, 'bs-paused', 'suspended')).id;
    storeIds.push(staleStore, freshStore, pausedStore);
    await mkProduct(staleStore);
    await mkProduct(freshStore);
    await mkProduct(pausedStore);
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(freshStore, () => indexStore(freshStore));
    const step = fakeStep();
    const res = await asApp(() => handleSearchIndexBackstop({ step }));
    const targets = step.events.map(e => e.data.storeId);
    expect(targets).toContain(staleStore);
    expect(targets).not.toContain(freshStore);
    expect(targets).not.toContain(pausedStore);
    expect(step.events.every(e => e.name === 'search/store.reindex-requested')).toBe(true);
    expect((res as { failed: number }).failed).toBe(0);
  });

  it('review I1: a lost event leaving only an orphan vector (text cleared) is found by the backstop and pruned', async () => {
    const owner = await mkUser('i1');
    ownerIds.push(owner.id);
    const s = (await mkStore(owner.id, 'i1')).id;
    storeIds.push(s);
    const p = await mkProduct(s, { name: 'Lamp', nameAr: null });
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(s, () => indexStore(s));
    expect(await embeddingRow(p)).toBeDefined();
    // The merchant clears the text; the product.upserted send is lost (no event reaches the indexer).
    await prisma.product.update({ where: { id: p }, data: { name: ' ' } });
    const step = fakeStep();
    await asApp(() => handleSearchIndexBackstop({ step }));
    expect(step.events.map(e => e.data.storeId)).toContain(s);
    await asApp(() =>
      handleSearchProductIndex({ event: { data: { storeId: s } }, step: fakeStep() })
    );
    expect(await embeddingRow(p)).toBeUndefined();
  });

  it('review M5: soft delete and unpublish remove the vector; republish restores it', async () => {
    const owner = await mkUser('m5');
    ownerIds.push(owner.id);
    const s = (await mkStore(owner.id, 'm5')).id;
    storeIds.push(s);
    const gone = await mkProduct(s, { name: 'Gone', status: 'active' });
    const draft = await mkProduct(s, { name: 'Draft later', status: 'active' });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(s, () => indexStore(s));
    expect(await embeddingRow(gone)).toBeDefined();
    expect(await embeddingRow(draft)).toBeDefined();
    await prisma.product.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    await prisma.product.update({ where: { id: draft }, data: { status: 'draft' } });
    expect(await runInStoreScope(s, () => hasStaleProducts(s))).toBe(true);
    await asApp(() =>
      handleSearchProductIndex({ event: { data: { storeId: s } }, step: fakeStep() })
    );
    expect(await embeddingRow(gone)).toBeUndefined();
    expect(await embeddingRow(draft)).toBeUndefined();
    expect(await runInStoreScope(s, () => storeIndexStatus(s))).toEqual({
      products: 0,
      indexed: 0,
      stale: 0,
      failed: 0,
    });
    await prisma.product.update({ where: { id: draft }, data: { status: 'active' } });
    await runInStoreScope(s, () => indexStore(s));
    expect(await embeddingRow(draft)).toBeDefined();
  });

  describe('review I2: a poison product is quarantined, never stalls its store', () => {
    /** Fails any batch holding a doc with POISON (like a model rejecting one input). */
    function poisonProvider(err: () => Error) {
      const f = fakeProvider();
      return {
        calls: f.calls,
        provider: {
          model: EMBED_MODEL,
          async embed(texts: string[]) {
            if (texts.some(t => t.includes('POISON'))) {
              f.calls.push(texts);
              throw err();
            }
            return f.provider.embed(texts);
          },
        },
      };
    }
    const failureRow = async (productId: string) =>
      (
        await prisma.$queryRaw<
          Array<{ content_hash: string; error_kind: string }>
        >`SELECT content_hash, error_kind FROM product_embed_failures WHERE product_id = ${productId}`
      )[0];
    async function poisonStore(tag: string) {
      const owner = await mkUser(tag);
      ownerIds.push(owner.id);
      const s = (await mkStore(owner.id, tag)).id;
      storeIds.push(s);
      const good1 = await mkProduct(s, { name: 'Good one' });
      const bad = await mkProduct(s, { name: 'POISON item' });
      const good2 = await mkProduct(s, { name: 'Good two' });
      return { s, good1, bad, good2 };
    }

    it('non-retryable batch failure: isolates, embeds the rest, quarantines the poison, alerts once', async () => {
      const { s, good1, bad, good2 } = await poisonStore('i2a');
      const pp = poisonProvider(
        () => new EmbeddingError('provider', 'rejected', { retryable: false })
      );
      setEmbeddingProviderForTests(pp.provider);
      alerts.length = 0;
      await asApp(() =>
        handleSearchProductIndex({ event: { data: { storeId: s } }, step: fakeStep(), attempt: 0 })
      );
      expect(await embeddingRow(good1)).toBeDefined();
      expect(await embeddingRow(good2)).toBeDefined();
      expect(await embeddingRow(bad)).toBeUndefined();
      expect(await failureRow(bad)).toMatchObject({ error_kind: 'provider' });
      expect(alerts.filter(a => a.context?.productId === bad)).toHaveLength(1);
      expect(await runInStoreScope(s, () => storeIndexStatus(s))).toEqual({
        products: 3,
        indexed: 2,
        stale: 0,
        failed: 1,
      });
      // Next run: the quarantined product is skipped — no provider call, no second alert.
      const before = pp.calls.length;
      await asApp(() =>
        handleSearchProductIndex({ event: { data: { storeId: s } }, step: fakeStep(), attempt: 0 })
      );
      expect(pp.calls.length).toBe(before);
      expect(alerts.filter(a => a.context?.productId === bad)).toHaveLength(1);
      expect(await runInStoreScope(s, () => hasStaleProducts(s))).toBe(false);
      // Editing the text (a new hash) re-admits it; now it embeds and the quarantine row goes.
      await prisma.product.update({ where: { id: bad }, data: { name: 'Fixed item' } });
      expect(await runInStoreScope(s, () => hasStaleProducts(s))).toBe(true);
      await asApp(() =>
        handleSearchProductIndex({ event: { data: { storeId: s } }, step: fakeStep(), attempt: 0 })
      );
      expect(await embeddingRow(bad)).toBeDefined();
      expect(await failureRow(bad)).toBeUndefined();
    });

    it('retryable failure: earlier attempts throw for Inngest to retry; the final attempt isolates', async () => {
      const { s, good1, bad } = await poisonStore('i2b');
      setEmbeddingProviderForTests(
        poisonProvider(() => new EmbeddingError('provider', 'capacity', { retryable: true }))
          .provider
      );
      alerts.length = 0;
      await expect(
        asApp(() =>
          handleSearchProductIndex({
            event: { data: { storeId: s } },
            step: fakeStep(),
            attempt: 1,
          })
        )
      ).rejects.toThrow();
      expect(await failureRow(bad)).toBeUndefined();
      await asApp(() =>
        handleSearchProductIndex({
          event: { data: { storeId: s } },
          step: fakeStep(),
          attempt: INDEX_RETRIES,
        })
      );
      expect(await embeddingRow(good1)).toBeDefined();
      expect(await failureRow(bad)).toMatchObject({ error_kind: 'provider' });
    });

    it('an outage (every product fails) quarantines nothing and fails the run', async () => {
      const { s, good1, bad } = await poisonStore('i2c');
      setEmbeddingProviderForTests({
        model: EMBED_MODEL,
        async embed() {
          throw new EmbeddingError('timeout', 'down');
        },
      });
      await expect(
        asApp(() =>
          handleSearchProductIndex({
            event: { data: { storeId: s } },
            step: fakeStep(),
            attempt: INDEX_RETRIES,
          })
        )
      ).rejects.toThrow();
      expect(await failureRow(bad)).toBeUndefined();
      expect(await failureRow(good1)).toBeUndefined();
    });
  });

  it('as ebda_app: the vector rows are invisible from another store scope', async () => {
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(storeId, () => indexStore(storeId));
    const owner = await mkUser('iso');
    ownerIds.push(owner.id);
    const other = (await mkStore(owner.id, 'iso')).id;
    storeIds.push(other);
    const seen = await asApp(() =>
      runInStoreScope(
        other,
        () =>
          prisma.$queryRaw<
            unknown[]
          >`SELECT 1 FROM product_embeddings WHERE store_id = ${other} OR product_id = ${pid}`
      )
    );
    expect(seen).toHaveLength(0);
  });

  it('hard delete cascades the embedding', async () => {
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(storeId, () => indexStore(storeId));
    expect(await embeddingRow(pid)).toBeDefined();
    await prisma.product.delete({ where: { id: pid } });
    expect(await embeddingRow(pid)).toBeUndefined();
  });
});
