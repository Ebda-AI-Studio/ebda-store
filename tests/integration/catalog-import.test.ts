/**
 * Catalogue import end to end on a real Postgres: the real router under tenantContext, a
 * store_admin token, the real job handlers with a recorded-reply extractor (no network, no key), an
 * in-memory private bucket. Covers upload checks, fail-fast enqueue, tenant isolation, extraction ->
 * staged items, review edits (blocking flags), draft creation (idempotent, drafts only) and publish.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { prisma, withRlsBypass } from '@ebda/database';
import {
  hasDb,
  seedBundleStore,
  storeAdminAccessTokenFor,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

const { default: routes } = await import('../../apps/api/src/routes/catalog-import.routes');
const { tenantContext } = await import('../../apps/api/src/middleware/tenant-context');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { StorageService } = await import('../../apps/api/src/services/storage.service');
const { inngest } = await import('../../apps/api/src/lib/inngest/client');
const { catalogImportRun } =
  await import('../../apps/api/src/lib/inngest/functions/catalog-import-run');
const { catalogImportCreateDrafts } =
  await import('../../apps/api/src/lib/inngest/functions/catalog-import-create-drafts');
const { setCatalogueExtractorForTests } =
  await import('../../apps/api/src/lib/catalogue/gemini-vision-extractor');
const svc = await import('../../apps/api/src/services/catalog-import.service');

const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// Smallest valid-by-magic-bytes files (the sniffer reads bytes only).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Page>>endobj\n2 0 obj<</Type/Page>>endobj\n%%EOF'
);
const TEXT = Buffer.from('hello, not an image');
const EXE_AS_PNG = Buffer.from('MZ\x90\x00 definitely not a png');

const bucket = new Map<string, Buffer>();
const fakeStep = {
  run: async (_id: string, fn: () => unknown) => JSON.parse(JSON.stringify((await fn()) ?? null)),
  sleep: async () => undefined,
  sleepUntil: async () => undefined,
  sendEvent: async () => undefined,
};
const runHandler = (def: { handler: (c: never) => Promise<unknown> }, data: object) =>
  def.handler({ event: { name: 'x', data }, step: fakeStep, runId: 'r', attempt: 0 } as never);

const RAW = {
  items: [
    {
      name: 'Tea',
      nameAr: 'شاي',
      priceRaw: '١٥٠ ج.م',
      priceEgp: 150,
      confidence: 0.95,
      categoryName: 'Drinks',
    },
    {
      nameAr: 'قهوة',
      priceRaw: 'يبدأ من ٩٥ ج',
      priceEgp: 95,
      confidence: 0.9,
      description: 'call 01012345678',
    },
    {
      name: 'Sized tee',
      priceRaw: '200',
      priceEgp: 200,
      confidence: 0.9,
      variants: [
        { options: { size: 'S' }, priceRaw: '200' },
        { options: { size: 'M' }, priceRaw: '210' },
      ],
    },
  ],
};

describe.skipIf(!hasDb)('catalogue import', () => {
  let app: Express;
  let a: FixtureStore;
  let b: FixtureStore;
  let free: FixtureStore;
  const auth = (s: FixtureStore) => ({
    Authorization: `Bearer ${storeAdminAccessTokenFor(s.ownerId)}`,
  });
  const url = (s: FixtureStore, p = '') => `/api/v1/stores/${s.storeId}/catalog-import${p}`;
  let sends: ReturnType<typeof vi.spyOn<typeof inngest, 'send'>>;

  beforeAll(async () => {
    process.env.CATALOG_IMPORT_MIN_GAP_MS = '0';
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores', tenantContext, routes);
    app.use(errorHandler);
    a = await seedBundleStore(`${suffix}-a`);
    b = await seedBundleStore(`${suffix}-b`);
    free = await seedBundleStore(`${suffix}-f`);
    await withRlsBypass(async tx => {
      await tx.store.update({ where: { id: a.storeId }, data: { plan: 'enterprise' } });
      await tx.store.update({ where: { id: b.storeId }, data: { plan: 'enterprise' } });
      await tx.store.update({ where: { id: free.storeId }, data: { plan: 'free' } });
    });
  });

  // The repo's vitest config restores mocks after every test: install them per test.
  beforeEach(() => {
    sends = vi.spyOn(inngest, 'send');
    vi.spyOn(StorageService, 'putPrivate').mockImplementation(async (buf, args) => {
      const key = `stores/${args.storeId}/${args.folder}/${bucket.size}${args.ext}`;
      bucket.set(key, buf);
      return { key };
    });
    vi.spyOn(StorageService, 'getPrivate').mockImplementation(async key => {
      const body = bucket.get(key);
      if (!body) throw new Error('missing');
      return { body, contentType: null };
    });
    vi.spyOn(StorageService, 'deletePrivate').mockImplementation(async key => {
      bucket.delete(key);
    });
    sends.mockResolvedValue({ ids: [] });
  });

  afterAll(async () => {
    setCatalogueExtractorForTests(null);
    await withRlsBypass(async tx => {
      for (const s of [a, b, free]) {
        await tx.product.deleteMany({ where: { storeId: s.storeId } });
        await tx.category.deleteMany({ where: { storeId: s.storeId } });
        await tx.catalogImportJob.deleteMany({ where: { storeId: s.storeId } });
        await tx.aiUsage.deleteMany({ where: { storeId: s.storeId } });
      }
    });
  });

  const upload = (s: FixtureStore, files: Array<[Buffer, string]>) => {
    let r = request(app).post(url(s)).set(auth(s));
    for (const [buf, name] of files) r = r.attach('files', buf, name);
    return r;
  };

  it('refuses a mixed valid + invalid request and stores nothing', async () => {
    const before = bucket.size;
    const res = await upload(a, [
      [JPEG, 'menu.jpg'],
      [EXE_AS_PNG, 'evil.png'],
    ]);
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(bucket.size).toBe(before);
    expect(
      await withRlsBypass(tx => tx.catalogImportJob.count({ where: { storeId: a.storeId } }))
    ).toBe(0);
    expect((await upload(a, [[TEXT, 'x.jpg']])).status).toBe(415);
  });

  it('a free plan store is refused', async () => {
    const res = await upload(free, [[JPEG, 'menu.jpg']]);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FEATURE_NOT_AVAILABLE');
  });

  it('too many files, and a PDF over the page cap, are 400', async () => {
    const many = await upload(
      a,
      [1, 2, 3, 4, 5].map(i => [JPEG, `m${i}.jpg`] as [Buffer, string])
    );
    expect([400, 413]).toContain(many.status);
    const bigPdf = Buffer.from('%PDF-1.4\n' + '<</Type/Page>>'.repeat(40));
    const res = await upload(a, [[bigPdf, 'big.pdf']]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_PAGES');
  });

  it('enqueue failure marks the job failed (never queued) and deletes the originals', async () => {
    sends.mockRejectedValueOnce(new Error('queue down'));
    const res = await upload(a, [[JPEG, 'menu.jpg']]);
    expect(res.status).toBe(202);
    await vi.waitFor(async () => {
      const j = await withRlsBypass(tx =>
        tx.catalogImportJob.findUniqueOrThrow({ where: { id: res.body.data.jobId } })
      );
      expect(j.status).toBe('failed');
    });
    const job = await withRlsBypass(tx =>
      tx.catalogImportJob.findUniqueOrThrow({ where: { id: res.body.data.jobId } })
    );
    expect(job.errorCode).toBe('ENQUEUE_FAILED');
    expect([...bucket.keys()].some(k => k.includes(res.body.data.jobId))).toBe(false);
  });

  describe('a job from upload to published product', () => {
    let jobId: string;
    let items: Array<{
      id: string;
      name: string | null;
      nameAr: string | null;
      flags: string[];
      status: string;
    }>;

    it('upload stores originals privately, sniffed type, and enqueues once', async () => {
      sends.mockClear();
      const res = await upload(a, [
        [JPEG, 'menu.jpg'],
        [PDF, 'prices.pdf'],
      ]);
      expect(res.status).toBe(202);
      jobId = res.body.data.jobId;
      await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(1));
      expect(sends.mock.calls[0][0]).toMatchObject({
        name: 'catalog-import/started',
        data: { jobId, storeId: a.storeId },
      });
      const files = await withRlsBypass(tx => tx.catalogImportFile.findMany({ where: { jobId } }));
      expect(files.map(f => f.mime).sort()).toEqual(['application/pdf', 'image/jpeg']);
      expect(files.find(f => f.mime === 'application/pdf')!.pageCount).toBe(2);
      for (const f of files)
        expect(f.storageKey.startsWith(`stores/${a.storeId}/catalogimport-${jobId}/`)).toBe(true);
    });

    it('store B cannot see, fetch the source of, patch or delete it', async () => {
      const got = await request(app)
        .get(url(b, `/${jobId}`))
        .set(auth(b));
      expect(got.status).toBe(404);
      const cross = await request(app)
        .get(`/api/v1/stores/${a.storeId}/catalog-import/${jobId}`)
        .set(auth(b));
      expect([401, 403, 404]).toContain(cross.status);
      const file = await withRlsBypass(tx =>
        tx.catalogImportFile.findFirstOrThrow({ where: { jobId } })
      );
      expect(
        (
          await request(app)
            .get(url(b, `/${jobId}/files/${file.id}/source`))
            .set(auth(b))
        ).status
      ).toBe(404);
      expect(
        (
          await request(app)
            .delete(url(b, `/${jobId}`))
            .set(auth(b))
        ).status
      ).toBe(404);
    });

    it('extraction stages scored items; a model failure marks only that file failed', async () => {
      let n = 0;
      setCatalogueExtractorForTests({
        name: 'fake',
        extract: async input => {
          if (input.mime === 'application/pdf')
            throw Object.assign(new Error('boom'), { statusCode: 502, code: 'AI_UPSTREAM_ERROR' });
          n++;
          return {
            raw: RAW,
            inputTokens: 100,
            outputTokens: 50,
            model: 'gemini-flash-lite-latest',
          };
        },
      });
      await runHandler(catalogImportRun, { jobId, storeId: a.storeId });
      expect(n).toBe(1);
      const res = await request(app)
        .get(url(a, `/${jobId}`))
        .set(auth(a));
      expect(res.body.data.status).toBe('review');
      expect(res.body.data.files.map((f: { status: string }) => f.status).sort()).toEqual([
        'done',
        'failed',
      ]);
      const list = await request(app)
        .get(url(a, `/${jobId}/items`))
        .set(auth(a));
      items = list.body.data.items;
      expect(items).toHaveLength(3);
      const coffee = items.find(i => i.nameAr === 'قهوة')!;
      expect(coffee.flags).toEqual(expect.arrayContaining(['price_from', 'phone_removed']));
      // No PII or provider text anywhere in the staged rows.
      expect(JSON.stringify(list.body)).not.toMatch(/0101|gemini/i);
    });

    it('a blocking flag needs acknowledgement; bulk accept skips flagged items', async () => {
      const coffee = items.find(i => i.nameAr === 'قهوة')!;
      const blocked = await request(app)
        .patch(url(a, `/${jobId}/items/${coffee.id}`))
        .set(auth(a))
        .send({ status: 'accepted' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('BLOCKING_FLAG');
      const bulk = await request(app)
        .post(url(a, `/${jobId}/items/bulk-accept`))
        .set(auth(a));
      expect(bulk.body.data.accepted).toBeGreaterThanOrEqual(0);
      const still = await prisma.catalogImportItem.findFirstOrThrow({ where: { id: coffee.id } });
      expect(still.status).toBe('pending');
      const ok = await request(app)
        .patch(url(a, `/${jobId}/items/${coffee.id}`))
        .set(auth(a))
        .send({
          acknowledge: ['price_from'],
          priceMinor: 9500,
          status: 'accepted',
          description: 'ring 0101 234 5678',
        });
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('accepted');
      expect(ok.body.data.description ?? '').not.toMatch(/0101/);
      expect(ok.body.data.editedFields).toEqual(
        expect.arrayContaining(['priceMinor', 'description'])
      );
      // hostile bodies are rejected by the schema
      expect(
        (
          await request(app)
            .patch(url(a, `/${jobId}/items/${coffee.id}`))
            .set(auth(a))
            .send({ priceMinor: -5 })
        ).status
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await request(app)
            .patch(url(a, `/${jobId}/items/${coffee.id}`))
            .set(auth(a))
            .send({ productId: 'x' })
        ).status
      ).toBeGreaterThanOrEqual(400);
    });

    it('creates DRAFT products only, idempotently, with variants; the failed file is retryable', async () => {
      for (const i of items) {
        if (i.nameAr === 'قهوة') continue;
        await request(app)
          .patch(url(a, `/${jobId}/items/${i.id}`))
          .set(auth(a))
          .send({ status: 'accepted' });
      }
      const go = await request(app)
        .post(url(a, `/${jobId}/create-drafts`))
        .set(auth(a))
        .send({});
      expect(go.status).toBe(202);
      await runHandler(catalogImportCreateDrafts, { jobId, storeId: a.storeId });
      await runHandler(catalogImportCreateDrafts, { jobId, storeId: a.storeId }); // replay
      const products = await prisma.product.findMany({
        where: { storeId: a.storeId },
        include: { variants: true },
      });
      expect(products).toHaveLength(3);
      expect(products.every(p => p.status === 'draft')).toBe(true);
      expect(products.find(p => p.name === 'Sized tee')!.variants).toHaveLength(2);
      const job = await request(app)
        .get(url(a, `/${jobId}`))
        .set(auth(a));
      expect(job.body.data.draftsCreated).toBe(3);

      const failedFile = job.body.data.files.find((f: { status: string }) => f.status === 'failed');
      const retry = await request(app)
        .post(url(a, `/${jobId}/files/${failedFile.id}/retry`))
        .set(auth(a));
      expect(retry.status).toBe(202);
    });

    it('publish is explicit and per selection; a zero-price draft is refused', async () => {
      await prisma.product.updateMany({
        where: { storeId: a.storeId, name: 'Tea' },
        data: { price: 0 },
      });
      const created = await prisma.catalogImportItem.findMany({
        where: { jobId, status: 'created' },
      });
      const res = await request(app)
        .post(url(a, `/${jobId}/publish`))
        .set(auth(a))
        .send({ itemIds: created.map(c => c.id) });
      expect(res.status).toBe(200);
      expect(res.body.data.refused.map((r: { code: string }) => r.code)).toContain('PRICE_MISSING');
      expect(res.body.data.published).toBe(2);
      expect(res.body.data.warnings.map((w: { code: string }) => w.code)).toContain('NO_IMAGE');
      const statuses = await prisma.product.findMany({
        where: { storeId: a.storeId },
        select: { name: true, status: true },
      });
      expect(statuses.find(s => s.name === 'Tea')!.status).toBe('draft');
      expect(statuses.filter(s => s.status === 'active')).toHaveLength(2);
      expect(
        (
          await request(app)
            .post(url(a, `/${jobId}/publish`))
            .set(auth(a))
            .send({ itemIds: [] })
        ).status
      ).toBe(400);
    });

    it('the source endpoint serves bytes with the SNIFFED type and hardening headers', async () => {
      const file = await withRlsBypass(tx =>
        tx.catalogImportFile.findFirstOrThrow({ where: { jobId, mime: 'image/jpeg' } })
      );
      await withRlsBypass(tx =>
        tx.catalogImportFile.update({ where: { id: file.id }, data: { mime: 'text/html' } })
      );
      const res = await request(app)
        .get(url(a, `/${jobId}/files/${file.id}/source`))
        .set(auth(a));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/jpeg/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe('sandbox');
    });
  });

  it('deleting a job removes its rows and originals', async () => {
    const res = await upload(a, [[JPEG, 'x.jpg']]);
    const id = res.body.data.jobId;
    expect(
      (
        await request(app)
          .delete(url(a, `/${id}`))
          .set(auth(a))
      ).status
    ).toBe(200);
    expect([...bucket.keys()].some(k => k.includes(id))).toBe(false);
    expect(await prisma.catalogImportJob.count({ where: { id } })).toBe(0);
  });

  it('a job the worker never started is failed on read, never left queued', async () => {
    const res = await upload(a, [[JPEG, 'x.jpg']]);
    const id = res.body.data.jobId;
    await withRlsBypass(tx =>
      tx.catalogImportJob.update({
        where: { id },
        data: { updatedAt: new Date(Date.now() - 3_600_000) },
      })
    );
    const got = await request(app)
      .get(url(a, `/${id}`))
      .set(auth(a));
    expect(got.body.data.status).toBe('failed');
    expect(got.body.data.errorCode).toBe('NOT_STARTED');
    await svc.deleteJob(a.storeId, id).catch(() => undefined);
  });
});
