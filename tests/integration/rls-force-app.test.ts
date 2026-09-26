/**
 * force_app REAL-LOGIN cross-tenant RLS proof (RLS cutover Phase 1c).
 *
 * Unlike `tenant-isolation.test.ts` / `rls-async-context.test.ts` (which run
 * against a superuser DATABASE_URL and use `SET LOCAL ROLE force_app` to
 * emulate the app role for individual queries), THIS file runs in its own CI
 * job (`.github/workflows/ci.yml` job `test-rls-force-app`) whose
 * DATABASE_URL / DIRECT_URL themselves authenticate as the real `force_app`
 * login role. Every `prisma.*` call in this file is a literal
 * force_app-authenticated query — the closest CI gets to production's
 * post-cutover connection (Phase 3: `DATABASE_URL` flips to `force_app` and
 * `ALLOW_BYPASSRLS_ROLE` is removed).
 *
 * Prerequisites the CI job sets up before this file runs (not this file's
 * job): migrations applied (which idempotently create `force_app` with DML
 * grants — 20260404000000_add_rls_policies — and the tenant/user-scoped
 * policies — 20260609000000_complete_force_rls_coverage +
 * 20260702170000_rls_close_denyall_tables), a CI-only password set on
 * `force_app` so it can log in over TCP, and a CI-only TRUNCATE grant so the
 * shared `tests/setup-e2e.ts` fixture reset doesn't 42501 (prod force_app has
 * no TRUNCATE and doesn't need it — see the CI job's comments).
 *
 * THE GATE (docs/plans/2026-07-02-rls-cutover.md Phase 1c): if any predicate
 * here is wrong, or a table is still deny-all for force_app, this file fails
 * — not prod.
 *
 * Coverage:
 *  - `products`     — direct store_id, representative store-scoped table.
 *  - `addresses`    — user-scoped (Phase 1b, NEW policy this PR adds):
 *                     current_user_id() / app.current_user_id GUC.
 *  - `payments`     — child-via-order (already policied by 20260609, proven
 *                     here under a REAL force_app login for the first time).
 *  - `return_items` — child-via-return (same as payments).
 *  - `system_settings` — platform-global, intentionally permissive.
 *  - RLS-3 (this PR): `userContext` middleware call surface — proves
 *    `runInTenantContext(undefined, fn, userId)` (addresses, no store) and
 *    `runInTenantContext(storeId, fn, userId)` from a header-derived storeId
 *    (wishlist) behave identically to the raw-SQL / direct-storeId
 *    equivalents above, under a REAL force_app login — see
 *    apps/api/src/middleware/tenant-context.ts `userContext` +
 *    apps/api/src/routes/address.routes.ts / wishlist.routes.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  withRlsBypass,
  runInTenantContext,
  runInStoreScope,
  withMoneyTx,
  setTenantGucs,
} from '@force/database';

const TEST_PREFIX = 'fatest-';

let storeA = '';
let storeB = '';
let userA = '';
let userB = '';
let productB = '';
let paymentB = '';
let returnItemB = '';
let addressA = '';
let addressB = '';
let wishlistItemB = '';
let faqA = '';
let faqB = '';

async function makeStoreWithOwner(slug: string): Promise<{ storeId: string; userId: string }> {
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `${TEST_PREFIX}${slug}-${Date.now()}@test.com`,
        passwordHash: 'hashed',
        firstName: 'Force',
        lastName: 'App',
        role: 'store_admin',
      },
    });
    const store = await tx.store.create({
      data: { slug, name: `Force App Test ${slug}`, ownerId: owner.id },
    });
    return { storeId: store.id, userId: owner.id };
  });
}

async function cleanup(): Promise<void> {
  // Every write here runs with app.bypass_rls='true' so cleanup itself is
  // never filtered by the policies under test.
  await withRlsBypass(async tx => {
    await tx.$executeRawUnsafe(
      `DELETE FROM public.return_items WHERE return_id IN (SELECT id FROM public.returns WHERE return_number LIKE '${TEST_PREFIX}%')`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.returns WHERE return_number LIKE '${TEST_PREFIX}%'`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.payments WHERE order_id IN (SELECT id FROM public.orders WHERE order_number LIKE '${TEST_PREFIX}%')`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE order_number LIKE '${TEST_PREFIX}%')`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.orders WHERE order_number LIKE '${TEST_PREFIX}%'`
    );
    await tx.$executeRawUnsafe(`DELETE FROM public.products WHERE slug LIKE '${TEST_PREFIX}%'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM public.addresses WHERE address1 LIKE '${TEST_PREFIX}%'`
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM public.wishlist_items WHERE wishlist_id IN (SELECT id FROM public.wishlists WHERE name LIKE '${TEST_PREFIX}%')`
    );
    await tx.$executeRawUnsafe(`DELETE FROM public.wishlists WHERE name LIKE '${TEST_PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${TEST_PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${TEST_PREFIX}%'`);
  });
}

beforeAll(async () => {
  await cleanup();

  const a = await makeStoreWithOwner(`${TEST_PREFIX}a`);
  const b = await makeStoreWithOwner(`${TEST_PREFIX}b`);
  storeA = a.storeId;
  storeB = b.storeId;
  userA = a.userId;
  userB = b.userId;

  await withRlsBypass(async tx => {
    // ── products: direct store_id sample ──
    await tx.product.create({
      data: {
        storeId: storeA,
        name: `${TEST_PREFIX}prod-a`,
        slug: `${TEST_PREFIX}prod-a-${Date.now()}`,
        price: 1000,
      },
    });
    const prodB = await tx.product.create({
      data: {
        storeId: storeB,
        name: `${TEST_PREFIX}prod-b`,
        slug: `${TEST_PREFIX}prod-b-${Date.now()}`,
        price: 1000,
      },
    });
    productB = prodB.id;

    // ── addresses: user-scoped sample (Phase 1b) ──
    const addrA = await tx.address.create({
      data: {
        userId: userA,
        firstName: 'A',
        lastName: 'User',
        address1: `${TEST_PREFIX}addr-a`,
        city: 'Kuwait City',
        state: 'Kuwait',
      },
    });
    addressA = addrA.id;
    const addrB = await tx.address.create({
      data: {
        userId: userB,
        firstName: 'B',
        lastName: 'User',
        address1: `${TEST_PREFIX}addr-b`,
        city: 'Kuwait City',
        state: 'Kuwait',
      },
    });
    addressB = addrB.id;

    // ── orders/payments/returns chain on store B (child-via-order sample) ──
    const order = await tx.order.create({
      data: {
        storeId: storeB,
        orderNumber: `${TEST_PREFIX}order-${Date.now()}`,
        subtotal: 10,
        total: 10,
        shippingAddress: {},
        billingAddress: {},
      },
    });

    const payment = await tx.payment.create({
      data: { orderId: order.id, amount: 10, currency: 'KWD', provider: 'cod', status: 'pending' },
    });
    paymentB = payment.id;

    const orderItem = await tx.orderItem.create({
      data: {
        orderId: order.id,
        productId: prodB.id,
        productName: `${TEST_PREFIX}item`,
        quantity: 1,
        price: 10,
        total: 10,
      },
    });

    const ret = await tx.return.create({
      data: {
        storeId: storeB,
        orderId: order.id,
        customerId: userB,
        returnNumber: `${TEST_PREFIX}ret-${Date.now()}`,
        reason: 'rls-force-app-test',
      },
    });

    const retItem = await tx.returnItem.create({
      data: {
        returnId: ret.id,
        orderItemId: orderItem.id,
        productId: prodB.id,
        productName: `${TEST_PREFIX}item`,
        quantity: 1,
      },
    });
    returnItemB = retItem.id;

    // ── wishlist: store-scoped sample (RLS-3, userContext middleware path) ──
    // wishlists/wishlist_items already carry a STORE-scoped policy from
    // 20260404000000/20260609000000 — this proves the header-derived
    // storeId `userContext` passes through `runInTenantContext` sees the
    // same enforcement as the direct-storeId calls used above.
    const wishlistB = await tx.wishlist.create({
      data: { userId: userB, storeId: storeB, name: `${TEST_PREFIX}wishlist-b` },
    });
    const wishlistItem = await tx.wishlistItem.create({
      data: { wishlistId: wishlistB.id, productId: prodB.id },
    });
    wishlistItemB = wishlistItem.id;

    // ── store_faqs / store_howtos: STRICT policy sample ──
    faqA = (await tx.storeFaq.create({ data: { storeId: storeA, question: 'qa', answer: 'a' } }))
      .id;
    faqB = (await tx.storeFaq.create({ data: { storeId: storeB, question: 'qb', answer: 'b' } }))
      .id;
    await tx.storeHowto.create({
      data: { storeId: storeB, title: 'hb', description: 'd', steps: [] },
    });
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('force_app real-login: store-scoped table (products)', () => {
  it('store A context cannot see store B product', async () => {
    const row = await runInTenantContext(storeA, () =>
      prisma.product.findUnique({ where: { id: productB } })
    );
    expect(row).toBeNull();
  });

  it('store B context CAN see its own product (control)', async () => {
    const row = await runInTenantContext(storeB, () =>
      prisma.product.findUnique({ where: { id: productB } })
    );
    expect(row?.id).toBe(productB);
  });
});

describe('force_app real-login: addresses (user-scoped, Phase 1b policy)', () => {
  it('user A context cannot see user B address', async () => {
    // No store-scoped route exists for /addresses today (see
    // apps/api/src/routes/address.routes.ts — mounted bare, no :storeId), so
    // exercise the user-context GUC directly the same way runInTenantContext
    // does, via a raw SET LOCAL against the force_app connection.
    const row = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${userA}'`);
      return tx.address.findUnique({ where: { id: addressB } });
    });
    expect(row).toBeNull();
  });

  it('user A context CAN see their own address (control)', async () => {
    const row = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${userA}'`);
      return tx.address.findUnique({ where: { id: addressA } });
    });
    expect(row?.id).toBe(addressA);
  });

  it("no user context set — allow-contextless (matches today's unrestricted behavior)", async () => {
    const row = await prisma.address.findUnique({ where: { id: addressB } });
    expect(row?.id).toBe(addressB);
  });

  it('bypass sees any address regardless of user context', async () => {
    const row = await withRlsBypass(tx => tx.address.findUnique({ where: { id: addressB } }));
    expect(row?.id).toBe(addressB);
  });
});

describe('force_app real-login: payments (child via orders.store_id)', () => {
  it('store A context cannot see store B payment', async () => {
    const row = await runInTenantContext(storeA, () =>
      prisma.payment.findUnique({ where: { id: paymentB } })
    );
    expect(row).toBeNull();
  });

  it('store B context CAN see its own payment (control)', async () => {
    const row = await runInTenantContext(storeB, () =>
      prisma.payment.findUnique({ where: { id: paymentB } })
    );
    expect(row?.id).toBe(paymentB);
  });

  it('contextless read (payment webhook path) still sees the payment — NOT 0-rowed', async () => {
    const row = await prisma.payment.findUnique({ where: { id: paymentB } });
    expect(row?.id).toBe(paymentB);
  });
});

describe('force_app real-login: return_items (child via returns.store_id)', () => {
  it('store A context cannot see store B return item', async () => {
    const row = await runInTenantContext(storeA, () =>
      prisma.returnItem.findUnique({ where: { id: returnItemB } })
    );
    expect(row).toBeNull();
  });

  it('store B context CAN see its own return item (control)', async () => {
    const row = await runInTenantContext(storeB, () =>
      prisma.returnItem.findUnique({ where: { id: returnItemB } })
    );
    expect(row?.id).toBe(returnItemB);
  });
});

describe('force_app real-login: system_settings (platform-global, intentionally permissive)', () => {
  const key = `${TEST_PREFIX}setting-${Date.now()}`;

  afterAll(async () => {
    await prisma.systemSetting.deleteMany({ where: { key } });
  });

  it('is readable/writable under force_app with no tenant context (not deny-all)', async () => {
    const created = await prisma.systemSetting.create({
      data: { key, value: { ok: true }, category: 'test' },
    });
    expect(created.key).toBe(key);

    const found = await prisma.systemSetting.findUnique({ where: { key } });
    expect(found?.key).toBe(key);
  });

  it('is also readable under an active store context (USING(true) never restricts)', async () => {
    const row = await runInTenantContext(storeA, () =>
      prisma.systemSetting.findUnique({ where: { key } })
    );
    expect(row?.key).toBe(key);
  });
});

describe('RLS-3: userContext middleware call surface — addresses (storeId undefined)', () => {
  // address.routes.ts has no store in scope at all, so `userContext` calls
  // `runInTenantContext(undefined, fn, userId)`. This proves that exact call
  // shape — not the raw `SET LOCAL` used in the "addresses" describe block
  // above — behaves identically under a REAL force_app login: storeId
  // undefined means `app.current_store_id` is simply never SET LOCAL'd (no
  // store column exists on `addresses` to filter by anyway), while
  // `app.current_user_id` IS set and the `rls_addresses_user` policy
  // enforces on it.
  it('runInTenantContext(undefined, fn, userA) cannot see user B address', async () => {
    const row = await runInTenantContext(
      undefined,
      () => prisma.address.findUnique({ where: { id: addressB } }),
      userA
    );
    expect(row).toBeNull();
  });

  it('runInTenantContext(undefined, fn, userA) CAN see user A own address (control)', async () => {
    const row = await runInTenantContext(
      undefined,
      () => prisma.address.findUnique({ where: { id: addressA } }),
      userA
    );
    expect(row?.id).toBe(addressA);
  });

  it('runInTenantContext(undefined, fn) with no userId — allow-contextless (matches today)', async () => {
    const row = await runInTenantContext(undefined, () =>
      prisma.address.findUnique({ where: { id: addressB } })
    );
    expect(row?.id).toBe(addressB);
  });
});

describe('RLS-3: userContext middleware call surface — wishlist (header-derived storeId)', () => {
  // wishlist.routes.ts derives storeId from the `x-store-id` header (not the
  // URL) and passes it straight through to `runInTenantContext(storeId, fn,
  // userId)` — identical call shape to the store-scoped routers, just with
  // the storeId sourced differently. Proves the existing STORE-scoped
  // `rls_wishlists_tenant` / `rls_wishlist_items_tenant` policies (there is
  // no user_id predicate on these tables) enforce correctly through that
  // path under a REAL force_app login.
  it('store A context cannot see store B wishlist item', async () => {
    const row = await runInTenantContext(
      storeA,
      () => prisma.wishlistItem.findUnique({ where: { id: wishlistItemB } }),
      userA
    );
    expect(row).toBeNull();
  });

  it('store B context CAN see its own wishlist item (control)', async () => {
    const row = await runInTenantContext(
      storeB,
      () => prisma.wishlistItem.findUnique({ where: { id: wishlistItemB } }),
      userB
    );
    expect(row?.id).toBe(wishlistItemB);
  });

  it('no store context (header omitted) — allow-contextless (matches today, the documented known gap)', async () => {
    // Mirrors the "known gap" comment in wishlist.routes.ts: DELETE
    // /product/:productId and DELETE /:itemId don't read the store header,
    // so storeId stays undefined and app.current_store_id is never set —
    // identical to calling runInTenantContext(undefined, fn, userId) or,
    // as here, not opening a tenant context at all.
    const row = await prisma.wishlistItem.findUnique({ where: { id: wishlistItemB } });
    expect(row?.id).toBe(wishlistItemB);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// STRICT policies (2026-09-25 cutover rollback).
//
// Most tables allow a query that sets no context (`current_store_id() IS
// NULL OR …`). 24 do not: a contextless read returns ZERO rows and a
// contextless write is rejected. The public store payloads read
// store_faqs/store_howtos with no context and shipped `faqs: []` to every
// storefront the moment production switched to force_app.
// ─────────────────────────────────────────────────────────────────────────
describe('force_app real-login: store_faqs (STRICT policy)', () => {
  it('a contextless read sees NOTHING — the reason every reader must set context', async () => {
    expect(await prisma.storeFaq.count({ where: { id: { in: [faqA, faqB] } } })).toBe(0);
  });

  it('store B context sees its own FAQ and not store A (control + isolation)', async () => {
    const ids = await runInTenantContext(storeB, () =>
      prisma.storeFaq.findMany({ where: { id: { in: [faqA, faqB] } }, select: { id: true } })
    );
    expect(ids.map(r => r.id)).toEqual([faqB]);
  });

  it('a nested store.faqs select outside context comes back empty (the exact shipped bug)', async () => {
    const store = await prisma.store.findUnique({
      where: { id: storeB },
      select: { faqs: { select: { id: true } }, howtos: { select: { id: true } } },
    });
    expect(store?.faqs).toEqual([]);
    expect(store?.howtos).toEqual([]);
  });
});

describe('force_app real-login: a transaction opened inside a context inherits it', () => {
  // `$transaction` is never routed to the ambient tenant transaction, so it
  // opens a new one on another connection. Before 2026-09-25 that connection
  // carried no RLS settings: a strict table read as empty inside it.
  it('withMoneyTx inside runInTenantContext sees the strict rows', async () => {
    const n = await runInTenantContext(storeB, () =>
      withMoneyTx(prisma, tx => tx.storeFaq.count({ where: { id: faqB } }))
    );
    expect(n).toBe(1);
  });

  it('batch $transaction([...]) inside runInTenantContext sees the strict rows', async () => {
    const [n] = await runInTenantContext(storeB, () =>
      prisma.$transaction([prisma.storeFaq.count({ where: { id: faqB } })])
    );
    expect(n).toBe(1);
  });

  it('the inherited context is still scoped — store A cannot see store B inside it', async () => {
    const n = await runInTenantContext(storeA, () =>
      withMoneyTx(prisma, tx => tx.storeFaq.count({ where: { id: faqB } }))
    );
    expect(n).toBe(0);
  });

  it('setTenantGucs scopes a contextless caller-opened transaction (public checkout shape)', async () => {
    const n = await withMoneyTx(prisma, async tx => {
      await setTenantGucs(tx, { storeId: storeB });
      return tx.storeFaq.count({ where: { id: faqB } });
    });
    expect(n).toBe(1);
  });
});

describe('force_app real-login: runInStoreScope (long jobs, no long transaction)', () => {
  it('model reads, raw queries, fn- and batch-transactions all see the store', async () => {
    const r = await runInStoreScope(storeB, async () => ({
      count: await prisma.storeFaq.count({ where: { id: faqB } }),
      raw: await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM store_faqs WHERE id = ${faqB}`,
      fnTx: await prisma.$transaction(tx => tx.storeFaq.count({ where: { id: faqB } })),
      batch: await prisma.$transaction([prisma.storeFaq.count({ where: { id: faqB } })]),
      money: await withMoneyTx(prisma, tx => tx.storeFaq.count({ where: { id: faqB } })),
    }));
    expect(r).toEqual({ count: 1, raw: [{ n: 1 }], fnTx: 1, batch: [1], money: 1 });
  });

  it('writes land and stay scoped', async () => {
    const updated = await runInStoreScope(storeB, () =>
      prisma.storeFaq.update({ where: { id: faqB }, data: { orderIndex: 3 } })
    );
    expect(updated.orderIndex).toBe(3);
    const other = await runInStoreScope(storeB, () =>
      prisma.storeFaq.count({ where: { id: faqA } })
    );
    expect(other).toBe(0);
  });

  it('rejects a non-UUID store id', () => {
    expect(() => runInStoreScope('not-a-uuid', async () => 1)).toThrow('Invalid store ID format');
  });
});

/**
 * The STRICT set, pinned. A strict policy is a trap for every contextless
 * reader (public routes, Inngest jobs, `withMoneyTx`), so adding one — or
 * relaxing one — must be a deliberate change that updates this list AND
 * re-runs `scripts/rls-payload-parity.mjs`. See docs/plans/2026-07-02-rls-cutover.md.
 */
const STRICT_TABLES = [
  'accounts',
  'ai_recommendation',
  'ai_usage',
  'backorder_lines',
  'blog_posts',
  'bulk_ai_jobs',
  'customer_cohort_snapshots',
  'customer_rfm_snapshots',
  'deadstock_flags',
  'expenses',
  'funnel_snapshots',
  'journal_entries',
  'journal_lines',
  'profit_anomalies',
  'purchase_order_items',
  'purchase_orders',
  'reorder_rules',
  'reorder_suggestions',
  'sequences',
  'stock_adjustment_items',
  'stock_adjustments',
  'store_faqs',
  'store_howtos',
  'suppliers',
];

describe('RLS policy registry', () => {
  it('the set of STRICT-policy tables is exactly the pinned list', async () => {
    const rows = await prisma.$queryRaw<Array<{ table: string; qual: string | null }>>`
      SELECT c.relname AS table, pg_get_expr(p.polqual, p.polrelid) AS qual
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relrowsecurity
        AND p.polcmd IN ('*', 'r')
        AND (p.polroles = '{0}' OR (SELECT oid FROM pg_roles WHERE rolname = 'force_app') = ANY (p.polroles))`;
    const allowsContextless = new Set<string>();
    const policied = new Set<string>();
    for (const r of rows) {
      policied.add(r.table);
      const q = r.qual ?? '';
      if (/current_(store|user)_id\(\) IS NULL/.test(q) || q.trim() === 'true') {
        allowsContextless.add(r.table);
      }
    }
    const strict = [...policied].filter(t => !allowsContextless.has(t)).sort();
    expect(strict).toEqual(STRICT_TABLES);
  });
});
