/**
 * Merchant #1 end to end: import the (synthetic) Amelia Aurum Shopify CSV the
 * way the Inngest bulk-import job does, then read the PUBLIC storefront API as
 * the storefront does — naming the store by host (`x-store-domain`, which is
 * where apps/web forwards the visitor's Host) — and prove tenancy:
 * `amelia.ebda.app` sees the catalogue, `rival.ebda.app` does not.
 *
 * Real Postgres (+ Redis for the public cache), gated on `hasDb`. Retry-safe:
 * the two fixed-slug stores are removed at the start AND the end, so a retry
 * (or a stale run) never sees the previous attempt's rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma, runInStoreScope } from '@force/database';
import publicRoutes from '@api/routes/public.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { BulkService } from '@api/services/bulk.service';
import { importCsvToPlatformCsv, decodeCsvBytes } from '@api/services/csv-import';
import { invalidateStoreProductCaches } from '@api/lib/public-cache';
import { hasDb } from '../helpers/bundle-fixtures';

const SLUGS = ['amelia', 'rival'];
const OWNER_EMAILS = SLUGS.map(s => `${s}-catalogue-it@test.local`);
const FIXTURE = resolve(__dirname, '../fixtures/amelia-aurum-catalogue.csv');

function buildPublicApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

async function wipe() {
  await prisma.store.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.user.deleteMany({ where: { email: { in: OWNER_EMAILS } } });
}

async function makeStore(slug: string, name: string) {
  const owner = await prisma.user.create({
    data: {
      email: `${slug}-catalogue-it@test.local`,
      passwordHash: 'x',
      firstName: slug,
      lastName: 'Owner',
      role: 'store_admin',
      emailVerified: true,
    },
  });
  return prisma.store.create({
    data: { name, slug, ownerId: owner.id, plan: 'enterprise', status: 'active', currency: 'EGP' },
  });
}

describe.skipIf(!hasDb)('Amelia Aurum catalogue import → public storefront by host', () => {
  let app: Express;
  let ameliaId: string;
  let rivalId: string;
  let importResult: Awaited<ReturnType<typeof BulkService.importProducts>>;

  const list = (host: string, query = '') =>
    request(app).get(`/api/v1/public/products?limit=50${query}`).set('x-store-domain', host);

  beforeAll(async () => {
    app = buildPublicApp();
    await wipe();
    const amelia = await makeStore('amelia', 'Amelia Aurum');
    const rival = await makeStore('rival', 'Rival Jewellers');
    ameliaId = amelia.id;
    rivalId = rival.id;

    const converted = importCsvToPlatformCsv(decodeCsvBytes(readFileSync(FIXTURE)));
    // Same invocation as inngest/functions/bulk-import.ts.
    importResult = await runInStoreScope(ameliaId, () =>
      BulkService.importProducts(ameliaId, converted.csv, { updateExisting: true }, amelia.ownerId)
    );
    await invalidateStoreProductCaches(ameliaId);
    await invalidateStoreProductCaches(rivalId);
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it('imports the whole fixture: 13 products, 20 variants, no row errors', () => {
    expect(importResult.errors).toEqual([]);
    expect(importResult).toMatchObject({ created: 13, variantsCreated: 20, failed: 0 });
  });

  it('amelia.ebda.app lists the 12 ACTIVE products (the draft bracelet stays hidden)', async () => {
    const res = await list('amelia.ebda.app');
    expect(res.status).toBe(200);
    const products = res.body.data.products as Array<{ slug: string; name: string }>;
    expect(products).toHaveLength(12);
    const slugs = products.map(p => p.slug);
    expect(slugs).toContain('hoop-earrings-18k');
    expect(slugs).not.toContain('silver-chain-bracelet');
  });

  it('serves EGP piastres and Arabic names untouched', async () => {
    const res = await list('amelia.ebda.app', '&search=hoop');
    const hoop = res.body.data.products.find(
      (p: { slug: string }) => p.slug === 'hoop-earrings-18k'
    );
    expect(hoop.price).toBe(485000); // 4,850.00 EGP
    expect(hoop.nameAr).toBe('حلق دائري ذهب عيار 18');
    expect(hoop.name).toBe('Hoop Earrings 18K Gold');
  });

  it('serves a variant product with its size options through the product detail route', async () => {
    const res = await request(app)
      .get('/api/v1/public/products/solitaire-ring-18k')
      .set('x-store-domain', 'amelia.ebda.app');
    expect(res.status).toBe(200);
    const product = res.body.data.product ?? res.body.data;
    expect(product.variants.map((v: { sku: string }) => v.sku).sort()).toEqual([
      'AA-SOL18-6',
      'AA-SOL18-7',
      'AA-SOL18-8',
      'AA-SOL18-9',
    ]);
    expect(product.options[0].name).toBe('Size');
    expect(product.images.length).toBeGreaterThanOrEqual(2);
    expect(product.images[0].url).toMatch(/^https:\/\/cdn\.example-amelia-aurum\.test\//);
  });

  it('rival.ebda.app does NOT see the catalogue — list is empty and the detail is a 404', async () => {
    const res = await list('rival.ebda.app');
    expect(res.status).toBe(200);
    expect(res.body.data.products).toEqual([]);

    const detail = await request(app)
      .get('/api/v1/public/products/solitaire-ring-18k')
      .set('x-store-domain', 'rival.ebda.app');
    expect(detail.status).toBe(404);
  });

  it('a host that names no store resolves to nothing, never to a default store', async () => {
    const res = await list('nobody-here.ebda.app');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('STORE_NOT_RESOLVED');
  });

  it('re-importing the same file updates in place (no duplicates)', async () => {
    const converted = importCsvToPlatformCsv(readFileSync(FIXTURE, 'utf8'));
    const again = await runInStoreScope(ameliaId, () =>
      BulkService.importProducts(ameliaId, converted.csv, { updateExisting: true })
    );
    expect(again).toMatchObject({ created: 0, updated: 13, failed: 0 });
    expect(await prisma.product.count({ where: { storeId: ameliaId } })).toBe(13);
  });
});
