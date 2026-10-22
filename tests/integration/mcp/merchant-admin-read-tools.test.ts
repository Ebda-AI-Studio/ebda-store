/**
 * Merchant-admin MCP read tools added 2026-09-30 (accounting/MCP audit §7):
 * admin_list_coupons, admin_list_customers, admin_get_customer,
 * admin_get_funnel, admin_list_reviews — plus the delivery detail on
 * admin_list_orders / admin_get_order.
 *
 * End to end through the real router + Streamable HTTP transport, against a
 * real Postgres (gated on `hasDb`; run against a scratch database, never
 * production). For every tool:
 *
 *  - TENANT ISOLATION: store A's key never returns a byte of store B's rows,
 *    and a store-B reference passed to a store-A tool is refused;
 *  - MASKING: contact details leave masked, street addresses not at all;
 *  - PAGINATION: `limit` / `page` bound the page and report the total;
 *  - DENIAL: with `merchant_mcp` OFF the call is the surface's standard 404,
 *    and a key without `merchant:read` is FORBIDDEN.
 *
 * Note: the scratch role is a superuser, so RLS is bypassed here — isolation
 * asserted below is the tools' own store scoping, which is exactly the layer
 * these tools add.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { withRlsBypass } from '@ebda/database';
import mcpAdminRoutes from '@api/routes/mcp-admin.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { generateMerchantKey, MERCHANT_SCOPES, MERCHANT_KEY_HEADER } from '@api/mcp/merchant-auth';
import { rfmKeyFor } from '@api/lib/customer-key';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mcp/admin', mcpAdminRoutes);
  app.use(errorHandler);
  return app;
}

interface Fixture {
  storeId: string;
  slug: string;
  productId: string;
  readKey: string;
  noScopeKey: string;
  /** Marker strings unique to this store — must never appear on the other store. */
  couponCodes: string[];
  guestEmail: string;
  guestPhone: string;
  street: string;
  orderId: string;
  registeredEmail: string;
}

async function seedStore(tag: string, withFeature: boolean): Promise<Fixture> {
  const suffix = `${tag}-${uid()}`;
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `mcp-read-owner-${suffix}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'store_admin',
        firstName: 'Owner',
        lastName: tag,
      },
    });
    const store = await tx.store.create({
      data: {
        name: `mcp-read ${suffix}`,
        slug: `mcp-read-${suffix}`,
        template: 'modern',
        currency: 'EGP',
        ownerId: owner.id,
        status: 'active',
      },
    });
    if (withFeature) {
      await tx.storeFeature.create({
        data: { storeId: store.id, featureKey: 'merchant_mcp', enabled: true },
      });
    }
    const product = await tx.product.create({
      data: {
        storeId: store.id,
        name: `mcp-read-prod-${suffix}`,
        slug: `mcp-read-prod-${suffix}`,
        price: 10_000,
        inventory: 5,
        status: 'active',
      },
    });

    const couponCodes = [1, 2, 3].map(i => `${tag.toUpperCase()}CODE${i}${suffix.slice(-6)}`);
    await tx.coupon.createMany({
      data: couponCodes.map((code, i) => ({
        storeId: store.id,
        code,
        name: `coupon ${code}`,
        type: i === 0 ? ('fixed' as const) : ('percentage' as const),
        value: i === 0 ? 2_000 : 10,
        usageLimit: 10,
        usageCount: i,
      })),
    });

    const registeredEmail = `mcp-read-reg-${suffix}@example.com`;
    const shopper = await tx.user.create({
      data: {
        email: registeredEmail,
        passwordHash: 'not-a-real-hash',
        role: 'customer',
        storeId: store.id,
        firstName: 'Reg',
        lastName: 'Shopper',
        phone: '+96560007777',
      },
    });

    const guestEmail = `Guest.${tag}.${suffix}@Example.com`;
    const guestPhone = tag === 'a' ? '+96550001234' : '+96550009876';
    const street = `Block 4 Street ${tag}${suffix.slice(-4)} House 7`;
    const addr = (email: string | undefined, phone: string) => ({
      firstName: 'Guest',
      lastName: tag,
      address1: street,
      block: '4',
      area: 'Salmiya',
      governorate: 'Hawally',
      country: 'EG',
      phone,
      ...(email ? { email } : {}),
    });

    const mkOrder = (n: number, data: Record<string, unknown>) =>
      tx.order.create({
        data: {
          storeId: store.id,
          orderNumber: `MR-${suffix}-${n}`,
          status: 'delivered',
          paymentStatus: 'paid',
          subtotal: 10_000,
          total: 10_000,
          billingAddress: {},
          ...data,
        } as any,
      });

    // Two guest orders under one (mixed-case) email → ONE customer row.
    const g1 = await mkOrder(1, {
      shippingAddress: addr(guestEmail, guestPhone),
      shipping: 1_000,
      // Shopper free text — the directions + callback number shape (issue 2244).
      notes: `Behind the mosque, call 9999 8${tag === 'a' ? '421' : '777'} or ${guestEmail}`,
      customerNotes: 'Leave at the door please',
      shippedAt: new Date('2026-09-20T10:00:00Z'),
      deliveredAt: new Date('2026-09-21T10:00:00Z'),
    });
    await mkOrder(2, { shippingAddress: addr(guestEmail, '+96550002222') });
    // A registered shopper's order.
    const r1 = await mkOrder(3, { customerId: shopper.id, shippingAddress: addr(undefined, '1') });

    await tx.shipment.create({
      data: {
        storeId: store.id,
        orderId: g1.id,
        carrier: 'armada',
        status: 'delivered',
        trackingNumber: `TRK-${suffix}`,
        pickupAddress: {},
        deliveryAddress: {},
      },
    });
    await tx.orderEvent.createMany({
      data: [
        { storeId: store.id, orderId: g1.id, fromStatus: 'pending', toStatus: 'shipped' },
        { storeId: store.id, orderId: g1.id, fromStatus: 'shipped', toStatus: 'delivered' },
      ],
    });

    await tx.review.create({
      data: {
        storeId: store.id,
        productId: product.id,
        orderId: r1.id,
        customerId: shopper.id,
        rating: 4,
        title: `review title ${tag}`,
        body: `review body ${suffix}`,
        status: 'published',
      },
    });

    const day = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    await tx.funnelSnapshot.createMany({
      data: [1, 2].map(d => ({
        storeId: store.id,
        periodDate: day(d),
        productViews: tag === 'a' ? 100 : 99_999,
        cartsCreated: tag === 'a' ? 10 : 88_888,
        cartItemsAdded: 12,
        checkoutsStarted: 0,
        ordersCompleted: tag === 'a' ? 2 : 77_777,
        ordersAbandoned: 0,
        revenueFils: 20_000,
      })),
    });

    const read = generateMerchantKey();
    const none = generateMerchantKey();
    await tx.merchantApiKey.createMany({
      data: [
        {
          storeId: store.id,
          userId: owner.id,
          name: 'read',
          keyHash: read.hash,
          prefix: read.prefix,
          scopes: [MERCHANT_SCOPES.read],
        },
        {
          storeId: store.id,
          userId: owner.id,
          name: 'none',
          keyHash: none.hash,
          prefix: none.prefix,
          scopes: [],
        },
      ],
    });

    return {
      storeId: store.id,
      slug: store.slug,
      productId: product.id,
      readKey: read.plaintext,
      noScopeKey: none.plaintext,
      couponCodes,
      guestEmail,
      guestPhone,
      street,
      orderId: g1.id,
      registeredEmail,
    };
  });
}

const NEW_TOOLS = [
  'admin_list_coupons',
  'admin_list_customers',
  'admin_get_customer',
  'admin_get_funnel',
  'admin_list_reviews',
] as const;

describe.skipIf(!hasDb)(
  'merchant-admin MCP read tools (customers, coupons, funnel, reviews)',
  () => {
    let app: Express;
    let A: Fixture;
    let B: Fixture;
    let gated: Fixture;
    const storeIds: string[] = [];

    beforeAll(async () => {
      app = buildApp();
      A = await seedStore('a', true);
      B = await seedStore('b', true);
      gated = await seedStore('g', false);
      storeIds.push(A.storeId, B.storeId, gated.storeId);
    });

    afterAll(async () => {
      await withRlsBypass(async tx => {
        // reviews → orders are RESTRICT, orders → store is RESTRICT.
        await tx.review.deleteMany({ where: { storeId: { in: storeIds } } });
        await tx.order.deleteMany({ where: { storeId: { in: storeIds } } });
        await tx.user.deleteMany({ where: { storeId: { in: storeIds } } });
        await tx.store.deleteMany({ where: { id: { in: storeIds } } });
      });
    });

    function rpc(slug: string, body: unknown, key?: string) {
      const r = request(app)
        .post(`/api/v1/mcp/admin/${slug}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json');
      if (key) r.set(MERCHANT_KEY_HEADER, key);
      return r.send(body as object);
    }
    const call = (slug: string, name: string, args: unknown, key?: string) =>
      rpc(
        slug,
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } },
        key
      );
    /** Parse the tool's JSON payload out of the JSON-RPC envelope. */
    function payload(res: request.Response): any {
      const env = JSON.parse(res.text.slice(res.text.indexOf('{')));
      expect(env.result?.isError, env.result?.content?.[0]?.text).not.toBe(true);
      return JSON.parse(env.result.content[0].text);
    }
    const isToolError = (res: request.Response) => {
      const env = JSON.parse(res.text.slice(res.text.indexOf('{')));
      return env.result?.isError === true;
    };

    /** Every string that belongs to store B and must never reach store A's key. */
    const bMarkers = () => [
      ...B.couponCodes,
      B.guestEmail.toLowerCase(),
      B.registeredEmail,
      B.street,
      B.productId,
      B.orderId,
      '99999',
      '88888',
      '77777',
    ];

    it('tools/list advertises every new tool to a key holder', async () => {
      const res = await rpc(
        A.slug,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        A.readKey
      );
      expect(res.status).toBe(200);
      for (const t of NEW_TOOLS) expect(res.text).toContain(`"${t}"`);
    });

    describe('denial', () => {
      it.each(NEW_TOOLS)('%s is a 404 when merchant_mcp is OFF', async tool => {
        const res = await call(gated.slug, tool, { customerRef: 'x' }, gated.readKey);
        expect(res.status).toBe(404);
        expect(res.text).not.toContain(tool);
      });

      it.each(NEW_TOOLS)('%s refuses a key without merchant:read', async tool => {
        const res = await call(A.slug, tool, { customerRef: 'x' }, A.noScopeKey);
        expect(res.text).toContain('FORBIDDEN');
        expect(res.text).toContain('merchant:read');
      });

      it.each(NEW_TOOLS)("%s refuses store B's key on store A", async tool => {
        const res = await call(A.slug, tool, { customerRef: 'x' }, B.readKey);
        expect(res.status).toBe(404);
      });
    });

    describe('admin_list_coupons', () => {
      it("returns only this store's coupons, with state and usage", async () => {
        const res = await call(A.slug, 'admin_list_coupons', {}, A.readKey);
        const p = payload(res);
        expect(p.coupons.map((c: any) => c.code).sort()).toEqual([...A.couponCodes].sort());
        expect(p.coupons.every((c: any) => c.state === 'active')).toBe(true);
        expect(p.coupons.some((c: any) => c.type === 'fixed' && c.value === 2000)).toBe(true);
        for (const m of bMarkers()) expect(res.text).not.toContain(m);
      });

      it('paginates', async () => {
        const p1 = payload(await call(A.slug, 'admin_list_coupons', { limit: 2 }, A.readKey));
        const p2 = payload(
          await call(A.slug, 'admin_list_coupons', { limit: 2, page: 2 }, A.readKey)
        );
        expect(p1.coupons).toHaveLength(2);
        expect(p2.coupons).toHaveLength(1);
        expect(p1.pagination).toMatchObject({ total: 3, totalPages: 2, limit: 2 });
        const codes = new Set([...p1.coupons, ...p2.coupons].map((c: any) => c.code));
        expect(codes.size).toBe(3);
      });

      it('rejects an out-of-range limit (Zod at the edge)', async () => {
        const res = await call(A.slug, 'admin_list_coupons', { limit: 5000 }, A.readKey);
        expect(isToolError(res) || res.text.includes('error')).toBe(true);
      });
    });

    describe('admin_list_customers / admin_get_customer', () => {
      it('groups guests like the Customers page and masks contact', async () => {
        const res = await call(A.slug, 'admin_list_customers', { limit: 100 }, A.readKey);
        const p = payload(res);
        // One guest (two orders, one email) + one registered shopper.
        expect(p.pagination.total).toBe(2);
        const guest = p.customers.find((c: any) => c.isGuest);
        expect(guest.orderCount).toBe(2);
        expect(guest.email).toMatch(/^g\*\*\*@example\.com$/i);
        // The newest order's contact wins, as on the Customers page.
        expect(guest.phone).toBe('+965 ****2222');
        expect(guest.customerRef).toBe(rfmKeyFor(A.guestEmail.toLowerCase(), true));
        // Nothing unmasked, no street, nothing from B.
        expect(res.text).not.toContain(A.guestEmail.toLowerCase());
        expect(res.text).not.toContain(A.guestEmail);
        expect(res.text).not.toContain('50001234');
        expect(res.text).not.toContain('50002222');
        expect(res.text).not.toContain(A.registeredEmail);
        expect(res.text).not.toContain(A.street);
        for (const m of bMarkers()) expect(res.text).not.toContain(m);
      });

      it('search is the SQL match: finds by email and by guest email, never another store', async () => {
        // search P2: same match as the Customers page (names, any phone form, email), run in SQL
        const reg = payload(
          await call(A.slug, 'admin_list_customers', { search: A.registeredEmail }, A.readKey)
        );
        expect(reg.pagination.total).toBe(1);
        expect(reg.customers[0].isGuest).toBe(false);
        const guest = payload(
          await call(A.slug, 'admin_list_customers', { search: A.guestEmail }, A.readKey)
        );
        expect(guest.pagination.total).toBe(1);
        expect(guest.customers[0].isGuest).toBe(true);
        // the other store's customer is not found through this store's key
        const other = payload(
          await call(A.slug, 'admin_list_customers', { search: B.registeredEmail }, A.readKey)
        );
        expect(other.pagination.total).toBe(0);
        // the summary stays store-wide whatever the search
        expect(other.summary.customers).toBe(2);
      });

      it('paginates', async () => {
        const p1 = payload(await call(A.slug, 'admin_list_customers', { limit: 1 }, A.readKey));
        const p2 = payload(
          await call(A.slug, 'admin_list_customers', { limit: 1, page: 2 }, A.readKey)
        );
        expect(p1.customers).toHaveLength(1);
        expect(p2.customers).toHaveLength(1);
        expect(p1.customers[0].customerRef).not.toBe(p2.customers[0].customerRef);
        expect(p1.pagination).toMatchObject({ total: 2, totalPages: 2 });
      });

      it('filters to guests', async () => {
        const p = payload(
          await call(A.slug, 'admin_list_customers', { segment: 'guest' }, A.readKey)
        );
        expect(p.customers).toHaveLength(1);
        expect(p.customers[0].isGuest).toBe(true);
      });

      it('admin_get_customer resolves a guest ref to their masked profile and orders', async () => {
        const ref = rfmKeyFor(A.guestEmail.toLowerCase(), true);
        const res = await call(A.slug, 'admin_get_customer', { customerRef: ref }, A.readKey);
        const p = payload(res);
        expect(p.orderCount).toBe(2);
        expect(p.orders).toHaveLength(2);
        expect(p.email).toMatch(/^g\*\*\*@example\.com$/i);
        expect(res.text).not.toContain(A.guestEmail.toLowerCase());
        expect(res.text).not.toContain(A.street);
        expect(res.text).not.toContain('50001234');
        expect(res.text).not.toContain('50002222');
      });

      it("admin_get_customer refuses store B's customer ref on store A", async () => {
        const bRef = rfmKeyFor(B.guestEmail.toLowerCase(), true);
        const res = await call(A.slug, 'admin_get_customer', { customerRef: bRef }, A.readKey);
        expect(isToolError(res)).toBe(true);
        for (const m of bMarkers()) expect(res.text).not.toContain(m);
      });

      it('admin_get_customer refuses a raw email as a ref (no contact-based lookup)', async () => {
        const res = await call(
          A.slug,
          'admin_get_customer',
          { customerRef: A.guestEmail.toLowerCase() },
          A.readKey
        );
        expect(isToolError(res)).toBe(true);
      });
    });

    describe('admin_get_funnel', () => {
      it('views → carts → orders, guest-blind stages null with a reason (AUD-2)', async () => {
        const res = await call(A.slug, 'admin_get_funnel', { days: 7 }, A.readKey);
        const p = payload(res);
        expect(p.daysCovered).toBe(2);
        expect(p.stages).toMatchObject({
          productViews: 200,
          cartsCreated: 20,
          ordersCompleted: 4,
          checkoutsStarted: null,
        });
        expect(p.rates.cartToOrder).toBe(0.2);
        expect(p.unavailable.map((u: any) => u.stage)).toContain('checkoutsStarted');
        expect(p.days.every((d: any) => d.checkoutsStarted === null)).toBe(true);
        for (const m of bMarkers()) expect(res.text).not.toContain(m);
      });

      it('rejects a window other than 7/30/90', async () => {
        const res = await call(A.slug, 'admin_get_funnel', { days: 45 }, A.readKey);
        expect(isToolError(res) || res.text.includes('error')).toBe(true);
      });
    });

    describe('admin_list_reviews', () => {
      it("lists this store's reviews with the reviewer's email masked", async () => {
        const res = await call(A.slug, 'admin_list_reviews', {}, A.readKey);
        const p = payload(res);
        expect(p.reviews).toHaveLength(1);
        expect(p.reviews[0]).toMatchObject({ rating: 4, status: 'published' });
        expect(p.reviews[0].product.id).toBe(A.productId);
        expect(p.reviews[0].reviewer.name).toBe('Reg Shopper');
        expect(p.reviews[0].reviewer.email).toMatch(/^m\*\*\*@example\.com$/);
        expect(res.text).not.toContain(A.registeredEmail);
        for (const m of bMarkers()) expect(res.text).not.toContain(m);
      });

      it("returns nothing for store B's product id", async () => {
        const p = payload(
          await call(A.slug, 'admin_list_reviews', { productId: B.productId }, A.readKey)
        );
        expect(p.reviews).toHaveLength(0);
      });

      it('paginates', async () => {
        const p = payload(await call(A.slug, 'admin_list_reviews', { limit: 1 }, A.readKey));
        expect(p.pagination).toMatchObject({ total: 1, limit: 1 });
      });
    });

    describe('order delivery detail', () => {
      it('admin_list_orders carries carrier, area and timestamps — no street, masked names', async () => {
        const res = await call(A.slug, 'admin_list_orders', { limit: 100 }, A.readKey);
        const p = payload(res);
        const o = p.orders.find((x: any) => x.id === A.orderId);
        expect(o.delivery).toMatchObject({
          method: 'armada',
          shipmentStatus: 'delivered',
          area: 'Salmiya',
          governorate: 'Hawally',
          slot: null,
          shippingFee: 1000,
        });
        expect(o.delivery.shippedAt).toBeTruthy();
        expect(o.delivery.deliveredAt).toBeTruthy();
        expect(p.deliveryNote).toContain('slot');
        expect(res.text).not.toContain(A.street);
        expect(res.text).not.toContain('50001234');
        for (const m of bMarkers()) expect(res.text).not.toContain(m);
      });

      it('admin_get_order masks the address and adds the status history', async () => {
        const res = await call(A.slug, 'admin_get_order', { orderId: A.orderId }, A.readKey);
        const p = payload(res);
        expect(p.shippingAddress).toMatchObject({ area: 'Salmiya', phone: '+965 ****1234' });
        expect(p.shippingAddress.address1).toBeUndefined();
        expect(p.statusHistory.map((e: any) => e.to)).toEqual(['shipped', 'delivered']);
        expect(p.delivery.method).toBe('armada');
        expect(res.text).not.toContain(A.street);
        expect(res.text).not.toContain(A.guestEmail.toLowerCase());
        expect(res.text).not.toContain(A.guestEmail);
        // Issue 2244: free-text notes keep their words, lose the contact.
        expect(p.notes).toBe('Behind the mosque, call [phone] or [email]');
        expect(p.customerNotes).toBe('Leave at the door please');
        expect(res.text).not.toContain('9999 8421');
        // An allowlist, not a spread: internal columns do not ride out, and
        // no payment carries a payable hosted-checkout link (PR 2301 audit).
        expect(p.idempotencyKey).toBeUndefined();
        for (const pay of p.payments ?? []) expect(pay).not.toHaveProperty('paymentUrl');
        expect(p.storeId).toBeUndefined();
      });

      it("admin_get_order still refuses store B's order id", async () => {
        const res = await call(A.slug, 'admin_get_order', { orderId: B.orderId }, A.readKey);
        expect(isToolError(res)).toBe(true);
        expect(res.text).not.toContain(B.street);
      });
    });
  }
);
