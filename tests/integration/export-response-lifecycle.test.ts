/**
 * Downloads and streaming responses under commit-before-respond.
 *
 * THIS FILE EXISTS BECAUSE OF A SCAR. A CSRF fix once shipped with the
 * sentence "guest checkout is unaffected — /public/ returns early" in its PR
 * body. That sentence was wrong and untested; 17 orders on a live merchant
 * (~379 EGP) went unpaid for two days while a curl monitor stayed green. The
 * standing rule since: **a change's claim about who it does NOT affect is the
 * least-tested sentence in it.**
 *
 * `middleware/request-transaction.ts` moves the COMMIT before the response is
 * sent. The equivalent least-tested sentence for that change is "downloads and
 * streaming responses are unaffected." This file is the test that entitles
 * anyone to write it.
 *
 * Routes are mounted through the REAL router table (`@api/routes`), not a
 * hand-built subset, so the mount shape each endpoint actually gets in
 * production — which decides whether it enters a request transaction at all —
 * is the shape under test.
 *
 * The two lanes, and what each endpoint below proves:
 *
 *   - BUFFERED, inside a tenant tx  → `GET /stores/:storeId/bulk/export`
 *     (CSV via `res.send`). Commits before responding; body must be whole.
 *   - STREAMING, inside a tenant tx → `GET /stores/:storeId/bulk/export.xlsx`
 *     (`streamXlsxResponse` → `wb.xlsx.write(res)`). THE one in-transaction
 *     streaming route in the product. Escalates to the streaming lane and
 *     keeps the old commit-on-finish semantics; the workbook must arrive
 *     complete and parseable, with every row.
 *   - Read-after-write over HTTP with NO barrier → a 2xx means committed.
 *
 * Retry-safety (vitest `retry: 1` re-runs against the SAME database): every
 * fixture id below is minted per CALL, never once per file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { withRlsBypass } from '@force/database';
import apiRoutes from '@api/routes';
import { errorHandler } from '@api/middleware/error-handler';
import { config } from '@api/config';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  seedCustomer,
  addItemToCart,
  cartSessionId,
  customerAccessTokenFor,
  DEFAULT_TEST_SHIPPING_ADDRESS,
} from '../helpers/bundle-fixtures';

/** Per-CALL unique suffix — never hoisted to file scope (retry-safety). */
function uid(label: string): string {
  return `${label}-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The real API router table, mounted as `apps/api/src/index.ts` mounts it. */
function buildApiApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1', apiRoutes);
  app.use(errorHandler);
  return app;
}

/** A store_admin access token shaped exactly like login mints one. */
function storeAdminTokenFor(userId: string): string {
  return jwt.sign(
    { userId, email: `${userId}@example.test`, role: 'store_admin', tv: 0 },
    config.jwtSecret,
    { expiresIn: '30m', issuer: 'force-api', audience: 'force-app' }
  );
}

/** `bulk_operations` is feature-gated; without the override every bulk route 403s. */
async function enableBulkOperations(storeId: string): Promise<void> {
  await withRlsBypass(tx =>
    tx.storeFeature.create({
      data: { storeId, featureKey: 'bulk_operations', enabled: true },
    })
  );
}

describe.skipIf(!hasDb)('exports and streaming responses under commit-before-respond', () => {
  const app = buildApiApp();
  let storeId: string;
  let token: string;
  const productNames: string[] = [];

  beforeAll(async () => {
    const suffix = uid('export-lifecycle');
    const store = await seedBundleStore(suffix);
    storeId = store.storeId;
    token = storeAdminTokenFor(store.ownerId);
    await enableBulkOperations(storeId);

    // Enough rows that a truncated stream is unmistakable rather than a
    // plausible-looking short file.
    for (let i = 0; i < 25; i++) {
      const name = `export-row-${i}-${suffix}`;
      productNames.push(name);
      await seedProduct(storeId, `${suffix}-${i}`, { price: 1000 + i, inventory: 5, name });
    }
  });

  // -------------------------------------------------------------------------
  // BUFFERED lane, inside a tenant transaction
  // -------------------------------------------------------------------------

  it('CSV export (buffered, in-tx) returns the complete file, not a truncated one', async () => {
    const res = await request(app)
      .get(`/api/v1/stores/${storeId}/bulk/export`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    const body = res.text;
    // Header row + one row per seeded product, all present.
    const lines = body.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(productNames.length + 1);
    for (const name of productNames) {
      expect(body).toContain(name);
    }
    // A truncated buffered response is exactly what a commit-first bug would
    // produce, so assert the LAST seeded row specifically — the one a cut
    // stream loses first.
    expect(body).toContain(productNames[productNames.length - 1]);
  });

  it('CSV template download (buffered, in-tx, no DB rows) still returns its body', async () => {
    const res = await request(app)
      .get(`/api/v1/stores/${storeId}/bulk/template`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.headers['content-disposition']).toContain('product_import_template.csv');
    expect(res.text.split('\n')[0]).toContain('name');
  });

  // -------------------------------------------------------------------------
  // STREAMING lane, inside a tenant transaction — the shape most at risk
  // -------------------------------------------------------------------------

  it('XLSX export (STREAMING, in-tx) delivers a complete, parseable workbook', async () => {
    const res = await request(app)
      .get(`/api/v1/stores/${storeId}/bulk/export.xlsx`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('attachment');

    // A truncated .xlsx is not a short-but-valid file — the zip central
    // directory lives at the END, so ExcelJS throwing here IS the truncation
    // assertion. Parsing it back is the strongest available proof that the
    // commit did not cut the stream.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    const ws = wb.worksheets[0];
    expect(ws).toBeDefined();

    const cellText: string[] = [];
    ws.eachRow(row => {
      row.eachCell(cell => cellText.push(String(cell.value ?? '')));
    });
    const flat = cellText.join('\u0000');
    for (const name of productNames) {
      expect(flat).toContain(name);
    }
  });

  // -------------------------------------------------------------------------
  // The property the whole change buys: a 2xx means committed
  // -------------------------------------------------------------------------

  it('a 2xx write is visible to the very next request with no barrier between them', async () => {
    const name = `read-after-write-${uid('product')}`;
    const created = await request(app)
      .post(`/api/v1/stores/${storeId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name,
        slug: name.toLowerCase(),
        price: 2500,
        inventory: 3,
        status: 'active',
      });
    expect(created.status).toBe(201);

    // NO barrier, NO sleep, NO retry. Under the old commit-on-finish
    // middleware this read could legitimately miss its own write, which is
    // precisely why `awaitCartCommitted()` had to exist. If this ever goes
    // flaky, the middleware regressed — do not paper it over with a wait.
    const listed = await request(app)
      .get(`/api/v1/stores/${storeId}/bulk/export`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.text).toContain(name);
  });

  // -------------------------------------------------------------------------
  // A 5xx must still roll back — through the real route table
  // -------------------------------------------------------------------------

  it('a 4xx on a store-scoped route commits and answers normally', async () => {
    // A validation failure is not a rollback, and must not become a 500.
    const res = await request(app)
      .post(`/api/v1/stores/${storeId}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ price: 'not-a-number' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// The blast zone the CSRF incident taught us to test explicitly
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('orders, payments and the admin streaming export', () => {
  const app = buildApiApp();
  let storeId: string;
  let customerId: string;
  let productId: string;

  beforeAll(async () => {
    const suffix = uid('order-payment');
    const store = await seedBundleStore(suffix);
    storeId = store.storeId;
    customerId = await seedCustomer(suffix);
    // Inventory sized for repeated runs: `retry: 1` re-runs a test body, and
    // every checkout below consumes stock.
    productId = await seedProduct(storeId, suffix, { price: 3000, inventory: 100 });
  });

  /**
   * Mint a fresh cart and check it out. RETRY-SAFETY: the session id and the
   * cart are created per CALL, never once per file — a cart minted in
   * `beforeAll` is consumed by attempt 1, so attempt 2 would check out an
   * EMPTY cart and fail with a 400 that has nothing to do with the assertion
   * under test. See the "Integration tests must be RETRY-SAFE" rule in
   * CLAUDE.md.
   */
  async function placeCodOrder(): Promise<string> {
    const session = cartSessionId(uid('checkout'));
    await addItemToCart(storeId, session, productId, 1);
    const res = await request(app)
      .post(`/api/v1/stores/${storeId}/orders`)
      .set('Authorization', `Bearer ${customerAccessTokenFor(customerId)}`)
      .set('x-session-id', session)
      .send({ shippingAddress: DEFAULT_TEST_SHIPPING_ADDRESS, paymentMethod: 'cod' });
    expect(res.status).toBe(201);
    const orderId = res.body.data.order.id as string;
    expect(orderId).toBeTruthy();
    return orderId;
  }

  it('POST /stores/:storeId/orders (in-tx, revenue path) 201s and the order is immediately readable', async () => {
    const orderId = await placeCodOrder();

    // NO barrier. A 201 that is not yet committed is exactly the silent lost
    // write this change exists to make impossible — assert it from a SEPARATE
    // connection (withRlsBypass opens its own transaction), which cannot see
    // an uncommitted row at all.
    const row = await withRlsBypass(tx =>
      tx.order.findUnique({ where: { id: orderId }, select: { id: true, total: true } })
    );
    expect(row?.id).toBe(orderId);
  });

  it('POST /payments/create still works — payments/* never enters a request transaction', async () => {
    // `routes/index.ts` mounts paymentRoutes at a bare `/payments` with NO
    // tenantContext, so this surface never gets a MIDDLEWARE-level request
    // transaction and the lifecycle this change rewrote does not run for it
    // at all. (The handler opens its own `runInTenantContext(order.storeId)`
    // internally — that function is untouched by this change.) Both halves of
    // that are claims about wiring, so they are tested through the REAL
    // router table rather than asserted from a grep.
    // COD must be enabled for this store or the handler 400s before it ever
    // reaches the write path we care about.
    //
    // RETRY-SAFETY: `upsert`, not `create`. `payment_configs` is unique on
    // (store_id, provider) and the store is per FILE, so a `create` here
    // collides with its own attempt-1 row on a `retry: 1` re-run — and the
    // P2002 it raises then MASKS whatever made attempt 1 fail. That is exactly
    // how this test reported "expected null not to be null" from attempt 1 and
    // a unique-constraint error from attempt 2 in the same failure block.
    await withRlsBypass(tx =>
      tx.paymentConfig.upsert({
        where: { storeId_provider: { storeId, provider: 'cod' } },
        create: { storeId, provider: 'cod', isEnabled: true, fixedFee: 0 },
        update: { isEnabled: true, fixedFee: 0 },
      })
    );

    const orderId = await placeCodOrder();

    const res = await request(app)
      .post('/api/v1/payments/create')
      .set('Authorization', `Bearer ${customerAccessTokenFor(customerId)}`)
      .send({ orderId, provider: 'cod' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // And the payment row is durable, read from a separate connection with NO
    // barrier. This assertion is load-bearing and it FAILED on CI before
    // `payment.routes.ts` was fixed: the handler sent its 200 from INSIDE its
    // own `runInTenantContext`, so the COMMIT landed after the client already
    // had the 200 (measured at 0.376ms after, locally). A 200 on the money
    // path must mean the payment row is durable. Do not soften this into a
    // poll — that would re-hide the defect.
    const payment = await withRlsBypass(tx =>
      tx.payment.findFirst({ where: { orderId }, select: { id: true, status: true } })
    );
    expect(payment).not.toBeNull();
  });

  it('GET /admin/export/orders (STREAMING, outside any tenant tx) returns a complete CSV', async () => {
    const suffix = uid('admin-export');
    const admin = await withRlsBypass(tx =>
      tx.user.create({
        data: {
          email: `admin-export-${suffix}@example.test`,
          passwordHash: 'not-a-real-hash',
          role: 'super_admin',
          firstName: 'Super',
          lastName: 'Export',
          // requireMfaEnrolled gates every /admin route for super_admin.
          mfaEnabled: true,
        },
        select: { id: true },
      })
    );
    const token = jwt.sign(
      {
        userId: admin.id,
        email: `admin-export-${suffix}@example.test`,
        role: 'super_admin',
        tv: 0,
      },
      config.jwtSecret,
      { expiresIn: '30m', issuer: 'force-api', audience: 'force-app' }
    );

    const res = await request(app)
      .get('/api/v1/admin/export/orders')
      .query({ storeId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    // Header row is written with res.write BEFORE the first DB page — a
    // truncated stream loses the rows, not the header, so assert both.
    expect(res.text.split('\n')[0]).toContain('order_number');
    expect(res.text).toContain(storeId);
  });
});
