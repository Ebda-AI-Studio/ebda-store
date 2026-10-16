/**
 * Merchant-editable search words (products.search_terms), search program Task 4.
 * Every writer that can set the column goes through the same clean + cap
 * (cleanSearchTerms, SEARCH_TERMS_MAX_LENGTH = 500 = the DB CHECK): product
 * create/update (Zod in product.routes.ts, also used by the MCP admin tools) and
 * bulk CSV/XLSX import (BulkService.importProducts). Over-long input must be a
 * 400 / row error, NEVER the DB CHECK's 500.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { prisma, runInTenantContext } from '@ebda/database';
import { SEARCH_TERMS_MAX_LENGTH } from '@ebda/shared';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { searchProductIds } = await import('../../apps/api/src/services/product-search.service');
const { ProductService } = await import('../../apps/api/src/services/product.service');
const { BulkService } = await import('../../apps/api/src/services/bulk.service');
const { createProductSchemaChecked, updateProductSchema } =
  await import('../../apps/api/src/routes/product.routes');

vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: 'admin-1', role: 'store_admin' };
      next();
    },
    authorize:
      (..._roles: string[]) =>
      (_req: any, _res: any, next: any) =>
        next(),
  };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

const run = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
let storeId: string;
let ownerId: string;
const inStore = <T>(fn: () => Promise<T>) => runInTenantContext(storeId, fn);
const q = (raw: string) =>
  inStore(() => searchProductIds(storeId, raw, { scope: 'admin' as const }));
const termsOf = (id: string) =>
  prisma.product.findUnique({ where: { id }, select: { searchTerms: true } });

describe('search terms: pure schema contract (no database)', () => {
  const base = { name: 'X', price: 1000 };
  it('create: cleans to the canonical form', () => {
    const r = createProductSchemaChecked.parse({
      ...base,
      searchTerms: 'كوتشي، كوتشى , sneakers',
    });
    expect(r.searchTerms).toBe('كوتشي, sneakers');
  });
  it('create + update: 501 raw characters is a validation error (400), 500 passes', () => {
    const over = 'ع'.repeat(SEARCH_TERMS_MAX_LENGTH + 1);
    expect(createProductSchemaChecked.safeParse({ ...base, searchTerms: over }).success).toBe(
      false
    );
    expect(updateProductSchema.safeParse({ searchTerms: over }).success).toBe(false);
    const ok = updateProductSchema.safeParse({ searchTerms: 'ع'.repeat(500) });
    expect(ok.success).toBe(true);
  });
  it('update: null/blank clears (null), omitted leaves alone (undefined)', () => {
    expect(updateProductSchema.parse({ searchTerms: null }).searchTerms).toBeNull();
    expect(updateProductSchema.parse({ searchTerms: ' , ، ' }).searchTerms).toBeNull();
    expect(updateProductSchema.parse({}).searchTerms).toBeUndefined();
  });
  it('a 500-char input that ", " would widen past 500 still yields <= 500 (no DB CHECK 500)', () => {
    const raw = Array.from(
      { length: 31 },
      (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(13)}`
    )
      .join(',')
      .slice(0, SEARCH_TERMS_MAX_LENGTH);
    const out = updateProductSchema.parse({ searchTerms: raw }).searchTerms!;
    expect(out.length).toBeLessThanOrEqual(SEARCH_TERMS_MAX_LENGTH);
  });
});

describe.skipIf(!hasDb)('search terms: stored, searchable, every writer capped', () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `st-${run}@t.local`,
        passwordHash: 'x',
        firstName: 'St',
        lastName: 'Owner',
        role: 'store_admin',
      },
    });
    ownerId = owner.id;
    storeId = (
      await prisma.store.create({ data: { name: `st-${run}`, slug: `st-${run}`, ownerId } })
    ).id;
  });
  afterAll(async () => {
    await prisma.product.deleteMany({ where: { storeId } });
    await prisma.store.deleteMany({ where: { id: storeId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  });

  it('create stores the cleaned terms and they are searchable', async () => {
    const body = createProductSchemaChecked.parse({
      name: 'Plain thing',
      price: 1000,
      status: 'active',
      searchTerms: 'كوتشي، كوتشى , sneakers',
    });
    const p = await inStore(() => ProductService.create(storeId, body));
    expect((await termsOf(p.id))!.searchTerms).toBe('كوتشي, sneakers');
    expect(await q('sneakers')).toEqual([p.id]);
    // admin getById returns it (the edit form loads from here)
    const got = await inStore(() => ProductService.getById(storeId, p.id));
    expect((got as { searchTerms?: string | null }).searchTerms).toBe('كوتشي, sneakers');
  });

  it('update: set, leave alone when omitted, clear with null', async () => {
    const p = await inStore(() =>
      ProductService.create(storeId, createProductSchemaChecked.parse({ name: 'Upd', price: 1000 }))
    );
    await inStore(() =>
      ProductService.update(
        storeId,
        p.id,
        updateProductSchema.parse({ searchTerms: 'جزمه, 3abaya' })
      )
    );
    expect((await termsOf(p.id))!.searchTerms).toBe('جزمه, 3abaya');
    await inStore(() =>
      ProductService.update(storeId, p.id, updateProductSchema.parse({ name: 'Upd2' }))
    );
    expect((await termsOf(p.id))!.searchTerms).toBe('جزمه, 3abaya');
    await inStore(() =>
      ProductService.update(storeId, p.id, updateProductSchema.parse({ searchTerms: null }))
    );
    expect((await termsOf(p.id))!.searchTerms).toBeNull();
  });

  it('service re-caps even if a caller bypasses Zod (MCP/AI-fill defence in depth)', async () => {
    const p = await inStore(() =>
      ProductService.create(storeId, createProductSchemaChecked.parse({ name: 'Raw', price: 1000 }))
    );
    const raw = Array.from({ length: 60 }, (_, i) => `w${i}${'y'.repeat(12)}`).join(',');
    await inStore(() => ProductService.update(storeId, p.id, { searchTerms: raw }));
    const stored = (await termsOf(p.id))!.searchTerms!;
    expect(stored.length).toBeLessThanOrEqual(SEARCH_TERMS_MAX_LENGTH);
  });

  describe('bulk import (CSV / XLSX converter output)', () => {
    const header =
      'name,nameAr,slug,description,descriptionAr,price,compareAtPrice,costPrice,sku,barcode,inventory,lowStockThreshold,trackInventory,weight,status,featured,isNew,categories,tags,images,metaTitle,metaTitleAr,metaDescription,metaDescriptionAr,searchTerms';
    const row = (name: string, slug: string, sku: string, terms: string) =>
      `${name},,${slug},,,1000,,,${sku},,5,,true,,active,false,false,,,,,,,,"${terms}"`;

    it('cleans the column, rejects an over-cap row as a row error, never a DB error', async () => {
      const over = 'ع'.repeat(SEARCH_TERMS_MAX_LENGTH + 1);
      const csv = [
        header,
        row('Bulk A', `bulk-a-${run}`, `BA-${run}`, 'كوتشي، كوتشى ,sneakers'),
        row('Bulk B', `bulk-b-${run}`, `BB-${run}`, over),
      ].join('\n');
      const res = await inStore(() =>
        BulkService.importProducts(storeId, csv, { updateExisting: true })
      );
      expect(res.created).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.errors[0].error).toMatch(/500/);
      const a = await prisma.product.findFirst({ where: { storeId, slug: `bulk-a-${run}` } });
      expect(a!.searchTerms).toBe('كوتشي, sneakers');
      expect(await prisma.product.count({ where: { storeId, slug: `bulk-b-${run}` } })).toBe(0);
    });

    it('re-import with a blank column leaves curated words alone; exports round-trip them', async () => {
      const csv = [header, row('Bulk A', `bulk-a-${run}`, `BA-${run}`, '')].join('\n');
      const res = await inStore(() =>
        BulkService.importProducts(storeId, csv, { updateExisting: true })
      );
      expect(res.updated).toBe(1);
      const a = await prisma.product.findFirst({ where: { storeId, slug: `bulk-a-${run}` } });
      expect(a!.searchTerms).toBe('كوتشي, sneakers');
      const exported = await inStore(() => BulkService.exportProducts(storeId));
      expect(exported.split('\n')[0]).toContain('searchTerms');
      expect(exported).toContain('كوتشي');
    });

    // Search program P1 (Task 8): the autopilot now writes search words, so an import is a
    // merchant edit and must stamp 'human' or the next AI refresh would replace it.
    const rowAr = (name: string, nameAr: string, slug: string, sku: string, terms: string) =>
      `${name},${nameAr},${slug},,,1000,,,${sku},,5,,true,,active,false,false,,,,,,,,"${terms}"`;
    const sourcesOf = async (slug: string) =>
      ((await prisma.product.findFirst({ where: { storeId, slug } }))!.aiFieldSources ??
        {}) as Record<string, string>;

    it("create: imported words and names are the merchant's (human), empty fields stay fillable", async () => {
      const slug = `bulk-own-${run}`;
      const csv = [header, rowAr('Bulk Own', 'كوتشي', slug, `BO-${run}`, 'kotshy, كوتشي')].join(
        '\n'
      );
      await inStore(() => BulkService.importProducts(storeId, csv, { updateExisting: true }));
      const s = await sourcesOf(slug);
      expect(s.searchTerms).toBe('human');
      expect(s.name).toBe('human');
      expect(s.nameAr).toBe('human');
      expect(s.descriptionAr).toBeUndefined(); // empty → the autopilot may still fill it
    });

    it('update: changed words over AI-owned words become human; identical words stay ai', async () => {
      const slug = `bulk-ai-${run}`;
      const sku = `BAI-${run}`;
      const created = await inStore(() =>
        BulkService.importProducts(
          storeId,
          [header, rowAr('Bulk AI', 'جزمة', slug, sku, '')].join('\n'),
          { updateExisting: true }
        )
      );
      expect(created.created).toBe(1);
      // What the autopilot would have written.
      await prisma.product.updateMany({
        where: { storeId, slug },
        data: {
          searchTerms: 'gazma, جزمه',
          aiFieldSources: { searchTerms: 'ai', nameAr: 'ai', name: 'human' },
        },
      });

      // Re-export round trip: same words, same name → ownership unchanged.
      await inStore(() =>
        BulkService.importProducts(
          storeId,
          [header, rowAr('Bulk AI', 'جزمة', slug, sku, 'gazma, جزمه')].join('\n'),
          { updateExisting: true }
        )
      );
      expect((await sourcesOf(slug)).searchTerms).toBe('ai');
      expect((await sourcesOf(slug)).nameAr).toBe('ai');

      // A blank Arabic name is the documented import clear: it keeps the ai stamp (fillable).
      await inStore(() =>
        BulkService.importProducts(
          storeId,
          [header, rowAr('Bulk AI', '', slug, sku, 'gazma, gezma, جزمه')].join('\n'),
          { updateExisting: true }
        )
      );
      const s = await sourcesOf(slug);
      expect(s.searchTerms).toBe('human');
      expect(s.nameAr).toBe('ai');
      expect(
        (await termsOf((await prisma.product.findFirst({ where: { storeId, slug } }))!.id))!
          .searchTerms
      ).toBe('gazma, gezma, جزمه');
    });
  });

  describe('HTTP: ZodError on searchTerms is a 400, never the DB CHECK 500', () => {
    it('PUT/POST with 501 chars -> 400; 500 chars -> 200 and stored <= 500', async () => {
      const { default: productRoutes } = await import('@api/routes/product.routes');
      const { errorHandler } = await import('@api/middleware/error-handler');
      const app = express();
      app.use(express.json());
      app.use('/api/v1/stores/:storeId/products', productRoutes);
      app.use((err: unknown, req: Request, res: Response, next: NextFunction) =>
        errorHandler(err as any, req, res, next)
      );
      const created = await request(app)
        .post(`/api/v1/stores/${storeId}/products`)
        .send({ name: 'Http', price: 1000, searchTerms: 'ع'.repeat(501) });
      expect(created.status).toBe(400);
      const p = await inStore(() =>
        ProductService.create(
          storeId,
          createProductSchemaChecked.parse({ name: 'Http2', price: 1000 })
        )
      );
      const over = await request(app)
        .put(`/api/v1/stores/${storeId}/products/${p.id}`)
        .send({ searchTerms: 'ع'.repeat(501) });
      expect(over.status).toBe(400);
      const ok = await request(app)
        .put(`/api/v1/stores/${storeId}/products/${p.id}`)
        .send({ searchTerms: 'ع'.repeat(500) });
      expect(ok.status).toBe(200);
      expect((await termsOf(p.id))!.searchTerms!.length).toBeLessThanOrEqual(
        SEARCH_TERMS_MAX_LENGTH
      );
    });
  });
});
