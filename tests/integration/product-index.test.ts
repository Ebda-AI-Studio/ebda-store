/**
 * Search program Task 11: the product embedding indexer against a real Postgres 17 + pgvector.
 * A deterministic fake provider stands in for Workers AI (no network). Fixtures use the
 * owner-role process client; the "as production" cases run on the strict-RLS role `ebda_app`
 * with the code-level tenant guard on (both layers), the way the Worker runs them.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  prisma,
  createPrismaClient,
  runWithRequestDb,
  runInStoreScope,
  runInTenantContext,
} from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { fakeProvider } from '../helpers/fake-embeddings';

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

const { setEmbeddingProviderForTests, EMBED_MODEL, EmbeddingError } =
  await import('../../apps/api/src/lib/search/embedding-provider');
const { indexStore, findStaleProducts, storeIndexStatus, hasStaleProducts, writeEmbeddings } =
  await import('../../apps/api/src/services/product-index.service');
const { requestStoreReindex } = await import('../../apps/api/src/lib/search/reindex');
const { handleSearchProductIndex, handleSearchIndexBackstop, INDEX_RETRIES, ISOLATE_CHUNK } =
  await import('../../apps/api/src/lib/inngest/functions/search-product-index');

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
  const sleeps: string[] = [];
  return {
    events,
    memo,
    sleeps,
    /** Inngest's durable sleep; a no-op here that records its id. */
    sleep: async (id: string, _duration: string) => {
      sleeps.push(id);
    },
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
    // The account-wide call budget lives in Redis and fails closed without it (SEARCH-T11-19).
    const { redis } = await import('../../apps/api/src/services/redis.service');
    await redis.connect();
    const { embedCallBudgetKey } = await import('../../apps/api/src/lib/search/embed-budget');
    await redis.getClient()?.del(embedCallBudgetKey(new Date()));
    const owner = await mkUser('main');
    ownerIds.push(owner.id);
    storeId = (await mkStore(owner.id, 'main')).id;
    storeIds.push(storeId);
    pid = await mkProduct(storeId);
  });
  afterEach(() => {
    setEmbeddingProviderForTests(undefined);
    delete process.env.SEARCH_EMBED_STORE_DAILY_CAP;
    delete process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP;
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
    await prisma.product.update({ where: { id: pid }, data: { description: 'جلد طبيعي' } });
    expect(await runInStoreScope(storeId, () => findStaleProducts(storeId, 10))).toHaveLength(1);
    expect((await runInStoreScope(storeId, () => indexStore(storeId))).embedded).toBe(1);
    expect(f.calls.flat().some(t => t.includes('جلد طبيعي'))).toBe(true);
    const row = await embeddingRow(pid);
    expect(row).toMatchObject({ store_id: storeId, model: EMBED_MODEL });
  });

  it('SEARCH-T13-5: a vector hashed from the old words-included doc is stale and re-embedded without them', async () => {
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    const o = await mkUser('t135');
    ownerIds.push(o.id);
    const st = (await mkStore(o.id, 't135')).id;
    storeIds.push(st);
    const p = await mkProduct(st, { name: 'Mug', nameAr: 'مج', searchTerms: 'mug, kobaya' });
    await runInStoreScope(st, () => indexStore(st));
    // What a row written before migrations 20261024000100/0200 carries: md5 of name_ar, name AND
    // words, and no words vector (the columns did not exist).
    await prisma.$executeRaw`
      UPDATE product_embeddings e SET terms_embedding = NULL, terms_hash = NULL,
          content_hash = md5(p.name_ar || E'\n' || p.name || E'\n' || p.search_terms)
        FROM products p WHERE p.id = e.product_id AND e.product_id = ${p}`;
    const before = (await embeddingRow(p)).content_hash;
    expect(await runInStoreScope(st, () => hasStaleProducts(st))).toBe(true);
    const stale = await runInStoreScope(st, () => findStaleProducts(st, 50));
    expect(stale.map(x => x.id)).toContain(p);
    f.calls.length = 0;
    await runInStoreScope(st, () => indexStore(st));
    // the doc vector (names only) AND the words vector, in ONE provider call (SEARCH-T13-7)
    expect(f.calls).toEqual([['مج\nMug', 'mug, kobaya']]);
    expect((await embeddingRow(p)).content_hash).not.toBe(before);
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
    await prisma.product.update({ where: { id: pid }, data: { description: 'kotshy' } });
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
    await prisma.product.update({ where: { id: pid }, data: { description: 'no-provider' } });
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
    await prisma.product.update({ where: { id: pid }, data: { description: 'changed' } });
    expect(await runInStoreScope(storeId, () => storeIndexStatus(storeId))).toEqual({
      products: 1,
      indexed: 0,
      stale: 1,
      failed: 0,
    });
  });

  it('as ebda_app + guard: the Inngest handler embeds via memoized steps, a retry never re-pays', async () => {
    await prisma.product.update({ where: { id: pid }, data: { description: 'retry-safe' } });
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
          Array<{
            content_hash: string;
            error_kind: string;
            retryable: boolean;
            ttl_h: number | null;
          }>
        >`SELECT content_hash, error_kind, retryable,
                 round(extract(epoch FROM (expires_at - now())) / 3600)::int AS ttl_h
            FROM product_embed_failures WHERE product_id = ${productId}`
      )[0];
    const quarantineAlerts = () => alerts.filter(a => a.source === 'search-index.quarantine');
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
      // (a) non-retryable: permanent at once (no expiry), and ONE summary P1 for the run.
      expect(await failureRow(bad)).toMatchObject({
        error_kind: 'provider',
        retryable: false,
        ttl_h: null,
      });
      expect(quarantineAlerts()).toHaveLength(1);
      expect(quarantineAlerts()[0].context).toMatchObject({ permanent: 1, temporary: 0 });
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
      expect(quarantineAlerts()).toHaveLength(1);
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

    it('retryable failure: Inngest retries first; on the last attempt a product failing twice is quarantined for 24 h', async () => {
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
      const step = fakeStep();
      await asApp(() =>
        handleSearchProductIndex({
          event: { data: { storeId: s } },
          step,
          attempt: INDEX_RETRIES,
        })
      );
      expect(await embeddingRow(good1)).toBeDefined();
      // (b) one more single retry after a durable backoff, in its own step; failing again = 24 h.
      expect(step.sleeps).toEqual(['backoff-0']);
      expect([...step.memo.keys()].some(k => k.startsWith('retry-0-'))).toBe(true);
      expect(await failureRow(bad)).toMatchObject({ retryable: true, ttl_h: 24 });
      expect(quarantineAlerts()).toHaveLength(1);
      expect(quarantineAlerts()[0].context).toMatchObject({ permanent: 0, temporary: 1 });
    });

    it('a 429 burst on single calls quarantines nothing when the retry succeeds', async () => {
      const { s, good1, bad, good2 } = await poisonStore('nI1-burst');
      await prisma.product.update({ where: { id: bad }, data: { name: 'Flaky item' } });
      const f = fakeProvider();
      let flakyFailures = 0;
      setEmbeddingProviderForTests({
        model: EMBED_MODEL,
        async embed(texts: string[]) {
          // The batch call is rate limited, and so is the FIRST single call for the flaky product.
          if (texts.length > 1 || (texts[0].includes('Flaky') && flakyFailures++ === 0))
            throw new EmbeddingError('http', '429', { status: 429 });
          return f.provider.embed(texts);
        },
      });
      alerts.length = 0;
      await asApp(() =>
        handleSearchProductIndex({
          event: { data: { storeId: s } },
          step: fakeStep(),
          attempt: INDEX_RETRIES,
        })
      );
      for (const id of [good1, bad, good2]) expect(await embeddingRow(id)).toBeDefined();
      expect(await failureRow(bad)).toBeUndefined();
      expect(quarantineAlerts()).toHaveLength(0);
    });

    it('a temporary quarantine expires and the product is re-admitted', async () => {
      const { s, bad } = await poisonStore('nI1-exp');
      setEmbeddingProviderForTests(
        poisonProvider(() => new EmbeddingError('provider', 'capacity', { retryable: true }))
          .provider
      );
      await asApp(() =>
        handleSearchProductIndex({
          event: { data: { storeId: s } },
          step: fakeStep(),
          attempt: INDEX_RETRIES,
        })
      );
      expect(await failureRow(bad)).toMatchObject({ retryable: true });
      expect(await runInStoreScope(s, () => hasStaleProducts(s))).toBe(false);
      await prisma.$executeRaw`UPDATE product_embed_failures SET expires_at = now() - interval '1 minute' WHERE product_id = ${bad}`;
      expect(await runInStoreScope(s, () => hasStaleProducts(s))).toBe(true);
      // Same text, provider recovered: it embeds and the quarantine row goes (re-admitted by expiry, not by an edit).
      setEmbeddingProviderForTests(fakeProvider().provider);
      await asApp(() =>
        handleSearchProductIndex({ event: { data: { storeId: s } }, step: fakeStep() })
      );
      expect(await embeddingRow(bad)).toBeDefined();
      expect(await failureRow(bad)).toBeUndefined();
    });

    it('(c) several poisons in one run raise ONE summary P1 with the count', async () => {
      const { s, good1 } = await poisonStore('nI1-sum');
      await mkProduct(s, { name: 'POISON two' });
      setEmbeddingProviderForTests(
        poisonProvider(() => new EmbeddingError('input', 'rejected', { retryable: false })).provider
      );
      alerts.length = 0;
      await asApp(() =>
        handleSearchProductIndex({ event: { data: { storeId: s } }, step: fakeStep() })
      );
      expect(await embeddingRow(good1)).toBeDefined();
      expect(quarantineAlerts()).toHaveLength(1);
      expect(quarantineAlerts()[0].context).toMatchObject({
        storeId: s,
        permanent: 2,
        temporary: 0,
      });
    });

    /** Quarantine `productId` against its CURRENT text, as model `model`, by hand. */
    const quarantineAs = (productId: string, model: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO product_embed_failures (product_id, store_id, content_hash, error_kind, model)
         SELECT p.id, p.store_id,
                md5(coalesce(public.ebda_product_embed_doc(p.name, p.name_ar, p.description, p.description_ar), '') || chr(31) || coalesce(nullif(regexp_replace(p.search_terms, '^\\s+|\\s+$', '', 'g'), ''), '')),
                'provider', $2
           FROM products p WHERE p.id = $1`,
        productId,
        model
      );

    it('review N-M3: the single pass runs in memoized steps of at most ISOLATE_CHUNK products', async () => {
      const { s, bad } = await poisonStore('nm3');
      for (let i = 0; i < 4; i++) await mkProduct(s, { name: `Extra ${i}` });
      setEmbeddingProviderForTests(
        poisonProvider(() => new EmbeddingError('input', 'rejected', { retryable: false })).provider
      );
      const step = fakeStep();
      await asApp(() => handleSearchProductIndex({ event: { data: { storeId: s } }, step }));
      const singleSteps = [...step.memo.entries()].filter(([k]) => k.startsWith('single-0-'));
      expect(singleSteps.map(([k]) => k)).toEqual(['single-0-0', 'single-0-1']);
      for (const [, out] of singleSteps)
        expect((out as unknown[]).length).toBeLessThanOrEqual(ISOLATE_CHUNK);
      expect(await failureRow(bad)).toMatchObject({ retryable: false });
    });

    it('review N-M1: quarantining a product deletes its old vector (old words stop matching)', async () => {
      const { s, bad } = await poisonStore('nm1');
      await prisma.product.update({ where: { id: bad }, data: { name: 'Clean text' } });
      setEmbeddingProviderForTests(fakeProvider().provider);
      await runInStoreScope(s, () => indexStore(s));
      expect(await embeddingRow(bad)).toBeDefined();
      await prisma.product.update({ where: { id: bad }, data: { name: 'POISON now' } });
      setEmbeddingProviderForTests(
        poisonProvider(() => new EmbeddingError('input', 'rejected', { retryable: false })).provider
      );
      await asApp(() =>
        handleSearchProductIndex({ event: { data: { storeId: s } }, step: fakeStep(), attempt: 0 })
      );
      expect(await failureRow(bad)).toBeDefined();
      expect(await embeddingRow(bad)).toBeUndefined();
    });

    it('PR3 minor 5: a quarantined product that becomes unindexable loses its quarantine row', async () => {
      const { s, bad } = await poisonStore('m5q');
      await quarantineAs(bad, EMBED_MODEL);
      expect(await failureRow(bad)).toBeDefined();
      await prisma.product.update({ where: { id: bad }, data: { status: 'archived' } });
      setEmbeddingProviderForTests(fakeProvider().provider);
      await runInStoreScope(s, () => indexStore(s));
      expect(await failureRow(bad)).toBeUndefined();
    });

    it('review N-M2: a quarantine recorded under another model does not block the product', async () => {
      const { s, bad } = await poisonStore('nm2');
      setEmbeddingProviderForTests(fakeProvider().provider);
      await quarantineAs(bad, EMBED_MODEL);
      const stale = await runInStoreScope(s, () => findStaleProducts(s, 10));
      expect(stale.map(r => r.id)).not.toContain(bad);
      await prisma.$executeRaw`UPDATE product_embed_failures SET model = 'old-model' WHERE product_id = ${bad}`;
      const after = await runInStoreScope(s, () => findStaleProducts(s, 10));
      expect(after.map(r => r.id)).toContain(bad);
    });

    it('PR3 minor 7: an outage quarantines nothing and raises ONE platform alert per window, not one per store', async () => {
      const { redis } = await import('../../apps/api/src/services/redis.service');
      const { OUTAGE_ALERT_KEY } = await import('../../apps/api/src/lib/search/embed-budget');
      await redis.getClient()!.del(OUTAGE_ALERT_KEY);
      const one = await poisonStore('i2c');
      const two = await poisonStore('i2c2');
      setEmbeddingProviderForTests({
        model: EMBED_MODEL,
        async embed() {
          throw new EmbeddingError('timeout', 'down');
        },
      });
      alerts.length = 0;
      for (const st of [one, two]) {
        const r = await asApp(() =>
          handleSearchProductIndex({
            event: { data: { storeId: st.s } },
            step: fakeStep(),
            attempt: INDEX_RETRIES,
          })
        );
        expect(r).toMatchObject({ outage: true });
        expect(await failureRow(st.bad)).toBeUndefined();
        expect(await failureRow(st.good1)).toBeUndefined();
      }
      expect(alerts.filter(a => a.source === 'search-index.outage')).toHaveLength(1);
      await redis.getClient()!.del(OUTAGE_ALERT_KEY);
    });
  });

  it('review M6: a price/stock-only edit that still enqueues makes no AI call and no write step', async () => {
    const owner = await mkUser('m6');
    ownerIds.push(owner.id);
    const s = (await mkStore(owner.id, 'm6')).id;
    storeIds.push(s);
    const p = await mkProduct(s, { name: 'Priced' });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(s, () => indexStore(s));
    const calls = f.calls.length;
    await prisma.product.update({ where: { id: p }, data: { price: 250, inventory: 7 } });
    const steps: string[] = [];
    const step = fakeStep();
    const run = step.run;
    step.run = async (name: string, fn: () => Promise<unknown>) => {
      steps.push(name);
      return run(name, fn);
    };
    const r = await asApp(() =>
      handleSearchProductIndex({
        event: {
          data: { storeId: s, productId: p, op: 'update', changedFields: ['price', 'inventory'] },
        },
        step,
      })
    );
    expect(r).toMatchObject({ embedded: 0, done: true });
    // the backend lookup is its own durable step now (jobs-workflow-safety); still no AI call and no write step
    expect(steps).toEqual(['is-do-store', 'plan-0']);
    expect(f.calls.length).toBe(calls);
  });

  it('review M7: inside a non-request tenant transaction the reindex event waits for COMMIT; a rollback sends nothing', async () => {
    setEmbeddingProviderForTests(fakeProvider().provider);
    sent.length = 0;
    let insideTx = -1;
    await asApp(() =>
      runInTenantContext(storeId, async () => {
        await prisma.product.update({ where: { id: pid, storeId }, data: { searchTerms: 'm7' } });
        await requestStoreReindex(storeId, 'm7');
        insideTx = sent.length;
      })
    );
    expect(insideTx).toBe(0);
    expect(sent.filter(e => e.data.reason === 'm7')).toHaveLength(1);

    sent.length = 0;
    await expect(
      asApp(() =>
        runInTenantContext(storeId, async () => {
          await requestStoreReindex(storeId, 'm7-rollback');
          throw new Error('rollback');
        })
      )
    ).rejects.toThrow('rollback');
    expect(sent).toHaveLength(0);
  });

  it('PR3 minor 2: SEARCH_EMBED_GLOBAL_DAILY_CAP counts provider calls across stores in Redis', async () => {
    const { embedCallBudgetKey } = await import('../../apps/api/src/lib/search/embed-budget');
    const { redis } = await import('../../apps/api/src/services/redis.service');
    await redis.connect();
    const client = redis.getClient();
    expect(client && redis.isAvailable()).toBeTruthy();
    await client!.del(embedCallBudgetKey(new Date()));
    const owner = await mkUser('gcap');
    ownerIds.push(owner.id);
    const a = (await mkStore(owner.id, 'gcap-a')).id;
    const b = (await mkStore(owner.id, 'gcap-b')).id;
    storeIds.push(a, b);
    await mkProduct(a, { name: 'A one' });
    await mkProduct(a, { name: 'A two' });
    await mkProduct(b, { name: 'B one' });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP = '2';
    try {
      // Store a: one call per product (batchSize 1) → both calls fit the global budget of 2.
      expect(await runInStoreScope(a, () => indexStore(a, { batchSize: 1 }))).toMatchObject({
        embedded: 2,
      });
      // Store b: the account-wide budget is spent → capped, no provider call (handler path).
      const r = await asApp(() =>
        handleSearchProductIndex({ event: { data: { storeId: b } }, step: fakeStep() })
      );
      expect(r).toMatchObject({ embedded: 0, capped: 'global' });
      expect(f.calls).toHaveLength(2);
      expect(Number(await client!.get(embedCallBudgetKey(new Date())))).toBeGreaterThanOrEqual(3);
    } finally {
      delete process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP;
      await client!.del(embedCallBudgetKey(new Date()));
    }
  });

  it('PR3 minor 3: ProductService.update sends product.upserted only after its transaction commits', async () => {
    const { ProductService } = await import('../../apps/api/src/services/product.service');
    const owner = await mkUser('m3');
    ownerIds.push(owner.id);
    const s = (await mkStore(owner.id, 'm3')).id;
    storeIds.push(s);
    const p = await mkProduct(s, { name: 'Before commit' });
    sent.length = 0;
    let insideTx = -1;
    await asApp(() =>
      runInTenantContext(s, async () => {
        await ProductService.update(s, p, { name: 'After commit' });
        insideTx = sent.filter(e => e.name === 'product.upserted').length;
      })
    );
    expect(insideTx).toBe(0);
    expect(sent.filter(e => e.name === 'product.upserted' && e.data.productId === p)).toHaveLength(
      1
    );

    sent.length = 0;
    await expect(
      asApp(() =>
        runInTenantContext(s, async () => {
          await ProductService.update(s, p, { name: 'Rolled back' });
          throw new Error('rollback');
        })
      )
    ).rejects.toThrow('rollback');
    expect(sent.filter(e => e.name === 'product.upserted')).toHaveLength(0);
  });

  it('PR3 minor 4: a product unpublished between read and write gets no vector', async () => {
    const owner = await mkUser('m4');
    ownerIds.push(owner.id);
    const s = (await mkStore(owner.id, 'm4')).id;
    storeIds.push(s);
    const p = await mkProduct(s, { name: 'Soon draft' });
    const f = fakeProvider();
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      async embed(texts) {
        await prisma.product.update({ where: { id: p }, data: { status: 'draft' } });
        return f.provider.embed(texts);
      },
    });
    const r = await runInStoreScope(s, () => indexStore(s, { maxDocs: 1 }));
    expect(r.embedded).toBe(0);
    expect(await embeddingRow(p)).toBeUndefined();
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

describe.skipIf(!hasDb)('SEARCH-T13-7: a second vector for the AI search words', () => {
  const owners: string[] = [];
  const stores: string[] = [];
  const store = async (tag: string) => {
    const o = await mkUser(tag);
    owners.push(o.id);
    const s = (await mkStore(o.id, tag)).id;
    stores.push(s);
    return s;
  };
  const row = async (productId: string) =>
    (
      await prisma.$queryRaw<
        Array<{ content_hash: string; terms_hash: string | null; has_terms: boolean }>
      >`SELECT content_hash, terms_hash, terms_embedding IS NOT NULL AS has_terms
          FROM product_embeddings WHERE product_id = ${productId}`
    )[0];
  const md5 = (t: string) => crypto.createHash('md5').update(t).digest('hex');

  beforeAll(async () => {
    const { redis } = await import('../../apps/api/src/services/redis.service');
    await redis.connect();
    const { embedCallBudgetKey } = await import('../../apps/api/src/lib/search/embed-budget');
    await redis.getClient()?.del(embedCallBudgetKey(new Date()));
  });
  afterEach(() => setEmbeddingProviderForTests(undefined));
  afterAll(async () => {
    for (const id of stores) {
      await prisma.product.deleteMany({ where: { storeId: id } });
      await prisma.store.deleteMany({ where: { id } });
    }
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
  });

  it('the words get their own vector in the SAME provider call; no words → NULL and no extra text', async () => {
    const s = await store('w1');
    const withWords = await mkProduct(s, {
      name: 'Kettle',
      nameAr: 'غلاية',
      searchTerms: ' kettle, katel ',
    });
    const without = await mkProduct(s, { name: 'Pot', nameAr: 'حلة' });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(s, () => indexStore(s));
    expect(f.calls).toHaveLength(1);
    expect([...f.calls[0]].sort()).toEqual(['kettle, katel', 'حلة\nPot', 'غلاية\nKettle'].sort());
    expect(await row(withWords)).toMatchObject({
      terms_hash: md5('kettle, katel'),
      has_terms: true,
    });
    expect(await row(without)).toMatchObject({ terms_hash: null, has_terms: false });
  });

  it('a words-only edit re-embeds ONLY the words vector', async () => {
    const s = await store('w2');
    const p = await mkProduct(s, { name: 'Mug', nameAr: 'مج', searchTerms: 'mug' });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(s, () => indexStore(s));
    const before = await row(p);
    f.calls.length = 0;
    await prisma.product.update({ where: { id: p }, data: { searchTerms: 'mug, kobaya' } });
    const stale = await runInStoreScope(s, () => findStaleProducts(s, 10));
    expect(stale).toMatchObject([{ id: p, needDoc: false, needWords: true }]);
    await runInStoreScope(s, () => indexStore(s));
    expect(f.calls).toEqual([['mug, kobaya']]);
    const after = await row(p);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.terms_hash).toBe(md5('mug, kobaya'));
  });

  it('words emptied: the words vector is cleared without a provider call', async () => {
    const s = await store('w3');
    const p = await mkProduct(s, { name: 'Tea', nameAr: 'شاي', searchTerms: 'shay' });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(s, () => indexStore(s));
    f.calls.length = 0;
    await prisma.product.update({ where: { id: p }, data: { searchTerms: '   ' } });
    expect(await runInStoreScope(s, () => hasStaleProducts(s))).toBe(true);
    await runInStoreScope(s, () => indexStore(s));
    expect(f.calls).toEqual([]);
    expect(await row(p)).toMatchObject({ terms_hash: null, has_terms: false });
    expect(await runInStoreScope(s, () => hasStaleProducts(s))).toBe(false);
  });

  it('a product that becomes unindexable loses both vectors (one row)', async () => {
    const s = await store('w4');
    const p = await mkProduct(s, { name: 'Ring', nameAr: 'خاتم', searchTerms: '5atem' });
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(s, () => indexStore(s));
    expect(await row(p)).toMatchObject({ has_terms: true });
    await prisma.product.update({ where: { id: p }, data: { status: 'draft' } });
    await runInStoreScope(s, () => indexStore(s));
    expect(await row(p)).toBeUndefined();
  });

  it('status: a product is ready when its doc vector is current; the words vector is optional', async () => {
    const s = await store('w5');
    const p = await mkProduct(s, { name: 'Sock', nameAr: 'شراب', searchTerms: 'shrab' });
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(s, () => indexStore(s));
    await prisma.product.update({ where: { id: p }, data: { searchTerms: 'shrab, sharab' } });
    expect(await runInStoreScope(s, () => storeIndexStatus(s))).toEqual({
      products: 1,
      indexed: 1,
      stale: 0,
      failed: 0,
    });
  });

  it('a words text the model rejects quarantines the product until its words change', async () => {
    const s = await store('w6');
    const p = await mkProduct(s, { name: 'Bag', nameAr: 'شنطة', searchTerms: 'POISON words' });
    const f = fakeProvider();
    setEmbeddingProviderForTests({
      model: EMBED_MODEL,
      async embed(texts: string[]) {
        if (texts.some(t => t.includes('POISON')))
          throw new EmbeddingError('input', 'rejected', { retryable: false });
        return f.provider.embed(texts);
      },
    });
    await runInStoreScope(s, () => indexStore(s, { retryBackoffMs: 0 }));
    expect(await runInStoreScope(s, () => findStaleProducts(s, 10))).toEqual([]);
    expect(await row(p)).toBeUndefined();
    await prisma.product.update({ where: { id: p }, data: { searchTerms: 'shanta' } });
    expect((await runInStoreScope(s, () => findStaleProducts(s, 10))).map(x => x.id)).toEqual([p]);
    await runInStoreScope(s, () => indexStore(s, { retryBackoffMs: 0 }));
    expect(await row(p)).toMatchObject({ terms_hash: md5('shanta'), has_terms: true });
  });

  it('re-review M-R1: a doc-only edit (name) re-embeds ONLY the doc; the words vector is kept', async () => {
    const s = await store('w8');
    const p = await mkProduct(s, { name: 'Cup', nameAr: 'كوب', searchTerms: 'kobaya' });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(s, () => indexStore(s));
    const before = await row(p);
    f.calls.length = 0;
    await prisma.product.update({ where: { id: p }, data: { name: 'Big cup' } });
    expect(await runInStoreScope(s, () => findStaleProducts(s, 10))).toMatchObject([
      { id: p, needDoc: true, needWords: false },
    ]);
    await runInStoreScope(s, () => indexStore(s));
    expect(f.calls).toEqual([['كوب\nBig cup']]);
    const after = await row(p);
    expect(after.content_hash).not.toBe(before.content_hash);
    expect(after).toMatchObject({ terms_hash: before.terms_hash, has_terms: true });
  });

  it('re-review M-R1: a model change re-embeds BOTH vectors in one call', async () => {
    const s = await store('w9');
    const p = await mkProduct(s, { name: 'Lamp', nameAr: 'أباجورة', searchTerms: 'abajora' });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    await runInStoreScope(s, () => indexStore(s));
    f.calls.length = 0;
    await prisma.$executeRaw`UPDATE product_embeddings SET model = 'old-model' WHERE product_id = ${p}`;
    expect(await runInStoreScope(s, () => findStaleProducts(s, 10))).toMatchObject([
      { id: p, needDoc: true, needWords: true },
    ]);
    await runInStoreScope(s, () => indexStore(s));
    expect(f.calls).toEqual([['أباجورة\nLamp', 'abajora']]);
    expect(await row(p)).toMatchObject({ terms_hash: md5('abajora'), has_terms: true });
    expect((await embeddingRow(p)).model).toBe(EMBED_MODEL);
  });

  it("re-review M-R3: a doc write under a NEW model drops the old model's words vector; the same model keeps it", async () => {
    const s = await store('w10');
    const p = await mkProduct(s, { name: 'Fan', nameAr: 'مروحة', searchTerms: 'marwa7a' });
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(s, () => indexStore(s));
    const [{ hash }] = await prisma.$queryRaw<Array<{ hash: string }>>`
      SELECT md5(public.ebda_product_embed_doc(name, name_ar, description, description_ar)) AS hash
        FROM products WHERE id = ${p}`;
    const lit = `[${new Array(1024).fill(0.02).join(',')}]`;
    // same model: a doc-only write keeps the words vector
    await runInStoreScope(s, () =>
      writeEmbeddings(s, [{ id: p, hash, wordsHash: null, doc: lit }])
    );
    expect(await row(p)).toMatchObject({ has_terms: true, terms_hash: md5('marwa7a') });
    // the row was built by another model: the doc write must not leave that model's words vector
    await prisma.$executeRaw`UPDATE product_embeddings SET model = 'old-model' WHERE product_id = ${p}`;
    await runInStoreScope(s, () =>
      writeEmbeddings(s, [{ id: p, hash, wordsHash: null, doc: lit }])
    );
    expect(await row(p)).toMatchObject({ has_terms: false, terms_hash: null });
    expect((await embeddingRow(p)).model).toBe(EMBED_MODEL);
  });

  it('budget: one provider call (charged once) carries both texts of a whole batch', async () => {
    const s = await store('w7');
    for (let i = 0; i < 10; i++)
      await mkProduct(s, { name: `Item ${i}`, searchTerms: `word ${i}` });
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    const { redis } = await import('../../apps/api/src/services/redis.service');
    const { embedCallBudgetKey } = await import('../../apps/api/src/lib/search/embed-budget');
    const k = embedCallBudgetKey(new Date());
    const before = Number((await redis.getClient()?.get(k)) ?? 0);
    await runInStoreScope(s, () => indexStore(s, { batchSize: 25 }));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toHaveLength(20);
    expect(Number((await redis.getClient()?.get(k)) ?? 0) - before).toBe(1);
  });
});
