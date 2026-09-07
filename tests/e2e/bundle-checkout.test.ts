/**
 * Bundle storefront rendering — the defining rule under test: a customer
 * sees ONE row per box, and the per-component allocated prices (which exist
 * only for the merchant's own P&L) never reach a customer-facing surface.
 *
 * FIX-ROUND-1 (RULING T8-a): the original version of this file was a real
 * `@playwright/test` browser spec at `tests/e2e/bundle-checkout.spec.ts`,
 * excluded from `vitest run tests/e2e` via a `vitest.config.ts` change, and
 * not covered by any Playwright project either (`playwright.config.ts`'s
 * only `testDir` is `tests/smoke`, targeting live production with no seeded
 * fixtures). That combination made the file invisible rather than merely
 * unrun — vitest's universe no longer contained it, so no "0 tests
 * collected" ever surfaced. The exclude has been reverted and the spec file
 * deleted; this file replaces it, written the way every neighbour in this
 * directory is (`checkout.test.ts`, `order.test.ts`) — real Postgres, no
 * mocks, gated on `hasDb` — using the fixture helpers `tests/helpers/
 * bundle-fixtures.ts` already built for exactly this ("extended rather than
 * duplicated ... by ... Task 8 storefront rendering").
 *
 * What's asserted here, and at which real layer:
 *   - the cart response never carries a per-component breakdown at all
 *     (CartBundleView has no such field) — asserted on the raw HTTP JSON.
 *   - grouping an order's items via `groupOrderLinesForDisplay` (the same
 *     function every storefront render site — cart, checkout, confirmation,
 *     orders list, order detail, returns form — calls) collapses a box to
 *     ONE row, and two boxes to TWO rows.
 *   - the printable/emailed invoice HTML (`InvoiceService.generateInvoice`)
 *     — a real server-rendered string, not something the browser groups —
 *     never contains an allocated share, and does contain the bundle name
 *     and price.
 *   - the emailed order-confirmation HTML (`orderConfirmationTemplate`) —
 *     built from the EXACT grouping transformation `order-created.ts` uses
 *     — never contains an allocated share either.
 *   - a bundle renamed after the order shipped still renders the
 *     snapshotted name, from a FRESH read of the order (not the original
 *     in-memory object).
 *
 * What is NOT asserted here, on purpose: whether the raw
 * `GET /public/orders/:id` JSON payload itself contains the per-component
 * `OrderItem.price` values. It does — `OrderService.getById` returns the
 * same full item rows to both the admin surface and the public customer
 * route (Prisma `include`, no field-level redaction), and the storefront
 * groups them CLIENT-SIDE via `groupOrderLinesForDisplay` before rendering.
 * That is the existing, pre-Task-8 architecture (Task 6 already put
 * `bundleId`/`bundleGroupId`/`price`/`total` on every component OrderItem;
 * Task 8's brief is explicitly to make the storefront RENDER the group as
 * one row, not to redact the transport payload). A customer's browser
 * network tab can see the raw numbers; the rendered page cannot. If that
 * transport-level exposure is unacceptable, it is a NEW finding — API-side
 * field redaction on the public order route — not a Task 8 rendering bug,
 * and is called out explicitly in the fix-round-1 report rather than
 * silently asserted around.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { withRlsBypass, runInTenantContext } from '@force/database';
import { groupOrderLinesForDisplay } from '@force/shared';
import { InvoiceService } from '@api/services/invoice.service';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import type { OrderEmailData } from '@api/services/email.service';
import { restrictPlatformOnlyOrigins } from '@api/middleware/security';
import publicRoutes from '@api/routes/public.routes';
import { errorHandler } from '@api/middleware/error-handler';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  seedBundle,
  seedCustomer,
  checkoutBundleFor,
  groupsOf,
  buildBundleTestApp,
  cartClientFor,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

/**
 * Real production mount shape: `restrictPlatformOnlyOrigins` runs on the
 * bare `app` (index.ts) BEFORE `app.use('/api/v1', routes)`, so it sees the
 * full `/api/v1/...` path — its deny/allow regexes are anchored on that
 * prefix. Mounting `publicRoutes` at `/api/v1/public` here (not the bare
 * `/public` `buildBundleTestApp()`/`cartClientFor` use elsewhere in this
 * file) is required for the origin gate under test to see the same path
 * shape it does in production; those other helpers don't exercise this
 * middleware at all.
 */
function buildPublicOriginApp() {
  const app = express();
  app.use(express.json());
  app.use(restrictPlatformOnlyOrigins);
  app.use('/api/v1/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

/** A merchant's own storefront custom domain — exactly the origin
 *  `restrictPlatformOnlyOrigins` was blocking on `/stores/:storeId/cart/
 *  bundles` before fix-round-1 moved these routes to `/public/cart/bundles`. */
const MERCHANT_STOREFRONT_ORIGIN = 'https://merchant-owned-shop.example';

describe.skipIf(!hasDb)('bundle storefront rendering — one row, never the split', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let store: FixtureStore;
  let customerId: string;

  beforeAll(async () => {
    store = await seedBundleStore(suffix);
    customerId = await seedCustomer(suffix);
  });

  /** The design doc's worked example: Dates x1 (4.500), Honey x1 (6.000),
   *  Nuts x2 (2.000 each) — componentSum 14.500, fixed_price 12.000. */
  async function seedRamadanBox(tag: string, name = 'Ramadan Box') {
    const dates = await seedProduct(store.storeId, `${suffix}-${tag}-dates`, {
      price: 4500,
      inventory: 100,
    });
    const honey = await seedProduct(store.storeId, `${suffix}-${tag}-honey`, {
      price: 6000,
      inventory: 100,
    });
    const nuts = await seedProduct(store.storeId, `${suffix}-${tag}-nuts`, {
      price: 2000,
      inventory: 100,
    });
    const ramadanBox = await seedBundle(store.storeId, `${suffix}-${tag}-ramadan`, {
      name,
      pricingType: 'fixed_price',
      pricingValue: 12000,
      items: [
        { productId: dates, quantity: 1 },
        { productId: honey, quantity: 1 },
        { productId: nuts, quantity: 2 },
      ],
    });
    return { dates, honey, nuts, ramadanBox };
  }

  it('cart response returns ONE bundle entry, never expanded into cart_items, with no per-component breakdown at all', async () => {
    const { ramadanBox } = await seedRamadanBox('t1-cart');
    const app = buildBundleTestApp();
    const sessionId = `bundle-e2e-cart-${suffix}`;
    const client = cartClientFor(app, store.storeId, sessionId);

    const res = await client.addBundleToCart({ bundleId: ramadanBox, quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.cart.items).toHaveLength(0);
    expect(res.body.data.cart.bundles).toHaveLength(1);
    expect(res.body.data.cart.bundles[0]).toMatchObject({
      bundleId: ramadanBox,
      quantity: 1,
      total: 12000,
    });

    // CartBundleView (cart.service.ts) has no `lines`/component breakdown
    // field at all — assert that on the RAW response body, not just the
    // TS type, so a future change that widens the shape is caught here.
    const raw = JSON.stringify(res.body);
    for (const forbidden of ['unitAllocated', 'totalAllocated', 'componentSum', '"lines"']) {
      expect(raw.includes(forbidden)).toBe(false);
    }
  });

  it('an order from ONE box groups into exactly one display row via groupOrderLinesForDisplay', async () => {
    const { ramadanBox } = await seedRamadanBox('t2-onebox');
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });

    const rows = groupOrderLinesForDisplay(order.items);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('bundle');
    if (rows[0].kind === 'bundle') {
      expect(rows[0].total).toBe(12000);
      expect(rows[0].quantity).toBe(1);
      expect(rows[0].name).toBe('Ramadan Box');
    }
  });

  it('two boxes of the same bundle produce TWO display rows, not one row with quantity 2', async () => {
    const { ramadanBox } = await seedRamadanBox('t3-twobox');
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 2, { customerId });

    expect(groupsOf(order)).toHaveLength(2);
    const rows = groupOrderLinesForDisplay(order.items);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.kind === 'bundle')).toBe(true);
  });

  it('the invoice HTML never contains an allocated per-component share, and does contain the bundle name + price', async () => {
    const { ramadanBox } = await seedRamadanBox('t4-invoice');
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });

    // The exact allocated shares this box produced, read back from the real
    // rows rather than hardcoded — these are the numbers that must NEVER
    // appear in the rendered invoice.
    const group = order.items.filter(i => i.bundleGroupId);
    expect(group).toHaveLength(3);
    const allocatedShares = group.map(i => (i.total / 1000).toFixed(3));

    const html = await runInTenantContext(store.storeId, () =>
      InvoiceService.generateInvoice(store.storeId, order.id, 'en')
    );

    for (const share of allocatedShares) {
      expect(html.includes(share)).toBe(false);
    }
    expect(html.includes('Ramadan Box')).toBe(true);
    expect(html.includes('12.000')).toBe(true);
  });

  it('the emailed order-confirmation HTML never contains an allocated per-component share', async () => {
    const { ramadanBox } = await seedRamadanBox('t5-email');
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });

    const group = order.items.filter(i => i.bundleGroupId);
    const allocatedShares = group.map(i => (i.total / 1000).toFixed(3));

    // Mirrors order-created.ts's `emailData.items` construction EXACTLY —
    // the same `groupOrderLinesForDisplay(...).map(...)` this fix-round
    // added there — then feeds it through the REAL template function
    // (server-rendered HTML, no client grouping involved) so this is the
    // actual serialized email body, not a stand-in for it.
    const items: OrderEmailData['items'] = groupOrderLinesForDisplay(order.items).map(row =>
      row.kind === 'bundle'
        ? {
            name: row.name,
            nameAr: row.nameAr ?? undefined,
            quantity: row.quantity,
            price: row.total,
          }
        : { name: row.item.productName, quantity: row.item.quantity, price: row.item.price }
    );
    const emailData: OrderEmailData = {
      orderNumber: order.orderNumber,
      customerName: 'Bundle Customer',
      customerEmail: 'bundle-buyer@example.com',
      items,
      subtotal: order.subtotal,
      tax: order.tax,
      shipping: order.shipping,
      total: order.total,
      shippingAddress: {
        firstName: 'Bundle',
        lastName: 'Buyer',
        address1: 'Block 1, Street 1',
        city: 'Kuwait City',
        state: 'Capital',
        postalCode: '00000',
        country: 'KW',
      },
    };

    const html = orderConfirmationTemplate.en(emailData, 'Bundle Fixture Store');
    for (const share of allocatedShares) {
      expect(html.includes(share)).toBe(false);
    }
    expect(html.includes('Ramadan Box')).toBe(true);
  });

  it('a bundle renamed AFTER the order still renders the snapshotted name on a FRESH read', async () => {
    const { ramadanBox } = await seedRamadanBox('t6-rename', 'Ramadan Box');
    const order = await checkoutBundleFor(store.storeId, ramadanBox, 1, { customerId });
    expect(groupOrderLinesForDisplay(order.items)[0]).toMatchObject({ name: 'Ramadan Box' });

    // Rename the LIVE bundle — bundleName on the already-written OrderItem
    // rows is a snapshot (like productName/costPrice), never a join.
    await withRlsBypass(tx =>
      tx.bundle.update({ where: { id: ramadanBox }, data: { name: 'Renamed After Order' } })
    );

    // Re-fetch the order FRESH from the DB — not the in-memory object from
    // checkout — so this proves the snapshot survived a real round-trip,
    // not just that the original JS object was never mutated.
    const freshItems = await withRlsBypass(tx =>
      tx.orderItem.findMany({ where: { orderId: order.id } })
    );
    const rows = groupOrderLinesForDisplay(freshItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'bundle', name: 'Ramadan Box' });
    expect(JSON.stringify(rows).includes('Renamed After Order')).toBe(false);
  });

  // ==========================================
  // Fix-round-2, Finding 1 — HTTP-level coverage of the routes a real
  // customer's browser actually calls (/public/cart/bundles[/:id]), from a
  // merchant storefront origin — the exact case `restrictPlatformOnlyOrigins`
  // was blocking on the OLD `/stores/:storeId/cart/bundles` path before
  // fix-round-1. Every other bundle-cart test in this repo either hits that
  // old store-scoped path directly (bundle-fixtures.ts's `cartClientFor`/
  // `buildBundleTestApp`, used elsewhere in THIS file above) or calls
  // `CartService` in-process — none of them would have caught the origin
  // bug fix-round-1 found, because none of them route through
  // `restrictPlatformOnlyOrigins` at all. These do.
  //
  // No pre-existing `/public/cart/items` HTTP test was found to mirror
  // (grepped `tests/**` for `public/cart` — the only hits are the origin
  // gate's own unit tests, which construct a bare req/res, not a real
  // Express app). This app is built to match production's exact mount
  // order/prefix instead (see `buildPublicOriginApp`'s docstring).
  describe('POST/DELETE /public/cart/bundles — the routes a real storefront browser calls', () => {
    it('POST /public/cart/bundles adds a bundle and returns 201, from a merchant storefront origin', async () => {
      const { ramadanBox } = await seedRamadanBox('t7-public-add');
      const app = buildPublicOriginApp();
      const sessionId = `bundle-e2e-public-add-${suffix}`;

      const res = await request(app)
        .post('/api/v1/public/cart/bundles')
        .set('origin', MERCHANT_STOREFRONT_ORIGIN)
        .set('x-session-id', sessionId)
        .set('x-store-id', store.storeId)
        .send({ bundleId: ramadanBox, quantity: 1 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.cart.bundles).toHaveLength(1);
      expect(res.body.data.cart.bundles[0]).toMatchObject({ bundleId: ramadanBox, total: 12000 });
    });

    it('DELETE /public/cart/bundles/:id removes it, from a merchant storefront origin', async () => {
      const { ramadanBox } = await seedRamadanBox('t8-public-remove');
      const app = buildPublicOriginApp();
      const sessionId = `bundle-e2e-public-remove-${suffix}`;

      const added = await request(app)
        .post('/api/v1/public/cart/bundles')
        .set('origin', MERCHANT_STOREFRONT_ORIGIN)
        .set('x-session-id', sessionId)
        .set('x-store-id', store.storeId)
        .send({ bundleId: ramadanBox, quantity: 1 });
      expect(added.status).toBe(201);
      const cartBundleId = added.body.data.cart.bundles[0].id;

      const res = await request(app)
        .delete(`/api/v1/public/cart/bundles/${cartBundleId}`)
        .set('origin', MERCHANT_STOREFRONT_ORIGIN)
        .set('x-session-id', sessionId)
        .set('x-store-id', store.storeId);

      expect(res.status).toBe(200);
      expect(res.body.data.cart.bundles).toHaveLength(0);
    });

    it('a bundle from ANOTHER store 404s on the public route too, from a merchant storefront origin', async () => {
      const otherStore = await seedBundleStore(`${suffix}-other`);
      const dates = await seedProduct(otherStore.storeId, `${suffix}-other-dates`, {
        price: 4500,
        inventory: 10,
      });
      const otherBundle = await seedBundle(otherStore.storeId, `${suffix}-other-bundle`, {
        name: 'Other Store Box',
        pricingType: 'fixed_price',
        pricingValue: 4500,
        items: [{ productId: dates, quantity: 1 }],
      });

      const app = buildPublicOriginApp();
      const res = await request(app)
        .post('/api/v1/public/cart/bundles')
        .set('origin', MERCHANT_STOREFRONT_ORIGIN)
        .set('x-session-id', `bundle-e2e-cross-tenant-${suffix}`)
        // Resolving as THIS suite's store, while the bundle belongs to
        // `otherStore` — the cross-tenant case `resolveBundle` guards.
        .set('x-store-id', store.storeId)
        .send({ bundleId: otherBundle, quantity: 1 });

      expect(res.status).toBe(404);
    });
  });
});
