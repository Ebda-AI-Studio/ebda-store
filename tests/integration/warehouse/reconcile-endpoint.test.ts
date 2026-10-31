/**
 * Warehouse Reconcile Endpoint — Integration Tests (Task 5, item 5
 * data-integrity)
 *
 * HTTP integration against a live API server at localhost:4000 — same
 * pattern as tests/integration/feature-flag-enforcement.test.ts. The CI
 * `integration-tests` job builds + starts the API against the ephemeral
 * Postgres service container before running `tests/integration` (see
 * .github/workflows/ci.yml, "Start API server" step). Locally: bring up a
 * docker ephemeral Postgres (recipe in .superpowers/sdd/task-1-report.md),
 * migrate + seed, `npm run build -w apps/api`, then
 * `node apps/api/dist/index.js` with matching env, THEN run this suite.
 *
 * Covers (per task-5-brief.md Step 1, updated 2026-07-23 for the "Important"
 * async-reconcile fix):
 *  1. A store WITH a warehouse + a DRIFTED SKU (SUM(WarehouseStock) !=
 *     Product.inventory) → POST .../warehouses/reconcile-all now returns
 *     `202 {success:true, accepted:true}` immediately (it no longer runs
 *     `backfillReconcileAll` synchronously inside the request's
 *     tenant-context transaction — see warehouse.routes.ts). The reconcile
 *     itself is proven via the async path: invoking
 *     `reconcileOneStoreOnDemand` directly (the exact function
 *     `warehouseReconcileOnDemand` runs in its Inngest step for the
 *     `warehouse/reconcile-requested` event this endpoint emits), mirroring
 *     how tests/unit/warehouse-reconcile-sweep.test.ts drives the on-demand
 *     handler.
 *  2. Tenant isolation: a store-B admin hitting store-A's reconcile URL →
 *     403 (requireStoreAccess, code FORBIDDEN) — middleware unchanged.
 *  3. Feature gate: a non-Enterprise store (no inventory.multi_warehouse,
 *     the default `starter` plan) → 403 FEATURE_DISABLED — middleware
 *     unchanged.
 *
 * Isolation: creates its own users/stores/warehouse/product per describe
 * block with a unique timestamp suffix; cleans up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { reconcileOneStoreOnDemand } from '@api/lib/inngest/functions/warehouse-reconcile-sweep';
import { API_BASE } from '../../helpers/api-base';
import { identityTokenFor } from '../../helpers/identity-session';

// Minimal Inngest step stub — mirrors the one used in
// tests/unit/warehouse-reconcile-sweep.test.ts. `reconcileOneStoreOnDemand`
// only calls `step.run(id, fn)` once, so `fn()` executed inline is
// equivalent for test purposes (no actual Inngest dispatch needed).
const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };

// One knob (TEST_API_URL) points the whole suite at one API, so a run cannot
// silently talk to whatever holds port 4000 — which on this machine was a
// different project's dev server for five days. See tests/helpers/api-base.ts.
const API_URL = API_BASE;

function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

interface SeededAdmin {
  userId: string;
  storeId: string;
  token: string;
}

async function createStoreAdmin(tag: string, plan: 'starter' | 'enterprise'): Promise<SeededAdmin> {
  const email = `wh-reconcile-ep-${tag}-${Date.now()}@example.test`;
  const password = 'TestAdmin!1';
  const hashed = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashed,
      firstName: 'WH',
      lastName: `ReconcileEp${tag}`,
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });

  const store = await prisma.store.create({
    data: {
      name: `WH Reconcile Endpoint Store ${tag} ${Date.now()}`,
      slug: `wh-reconcile-ep-${tag}-${Date.now()}`,
      ownerId: user.id,
      plan,
      status: 'active',
    },
  });

  // Store admins sign in at the identity service; the stand-in mints its token.
  const token = await identityTokenFor(user.id);

  return { userId: user.id, storeId: store.id, token };
}

async function cleanupAdmin(s: SeededAdmin): Promise<void> {
  await prisma.warehouseStock.deleteMany({ where: { storeId: s.storeId } });
  await prisma.inventoryHistory.deleteMany({ where: { storeId: s.storeId } });
  await prisma.warehouse.deleteMany({ where: { storeId: s.storeId } });
  await prisma.product.deleteMany({ where: { storeId: s.storeId } });
  await prisma.store.deleteMany({ where: { id: s.storeId } });
  await prisma.user.deleteMany({ where: { id: s.userId } });
}

describe('POST /stores/:storeId/warehouses/reconcile-all', () => {
  let storeA: SeededAdmin; // enterprise, has the drifted SKU under test
  let storeB: SeededAdmin; // enterprise, used only to attack store A's URL
  let storeC: SeededAdmin; // default `starter` plan — no multi_warehouse
  let warehouseId: string;
  let driftedProductId: string;

  beforeAll(async () => {
    storeA = await createStoreAdmin('a', 'enterprise');
    storeB = await createStoreAdmin('b', 'enterprise');
    storeC = await createStoreAdmin('c', 'starter');

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId: storeA.storeId,
        name: 'Reconcile Endpoint WH',
        code: `RECON-EP-${Date.now()}`,
        isDefault: true,
        priority: 100,
        isActive: true,
      },
    });
    warehouseId = warehouse.id;

    const product = await prisma.product.create({
      data: {
        storeId: storeA.storeId,
        name: 'Reconcile Endpoint SKU',
        slug: `wh-reconcile-ep-sku-${Date.now()}`,
        price: 5000,
        inventory: 7, // authoritative aggregate
        status: 'active',
        trackInventory: true,
      },
    });
    driftedProductId = product.id;

    // Drift: WarehouseStock shadow says 10, authoritative Product.inventory
    // says 7 — simulates some OTHER writer moving the aggregate directly
    // (order sale, bulk adjust, etc.) without touching WarehouseStock, the
    // exact bug reconcileWarehouseStockToAggregate exists to fix.
    await prisma.warehouseStock.create({
      data: {
        warehouseId,
        productId: driftedProductId,
        variantId: null,
        quantity: 10,
        storeId: storeA.storeId,
      },
    });
  });

  afterAll(async () => {
    await cleanupAdmin(storeA);
    await cleanupAdmin(storeB);
    await cleanupAdmin(storeC);
  });

  it('returns 202 accepted immediately (no longer runs the backfill synchronously)', async () => {
    const res = await fetch(`${API_URL}/stores/${storeA.storeId}/warehouses/reconcile-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(storeA.token) },
    });
    const json = await res.json();

    expect(res.status, JSON.stringify(json)).toBe(202);
    expect(json.success).toBe(true);
    expect(json.accepted).toBe(true);

    // The endpoint only enqueues the event — it must NOT have reconciled
    // the drift itself. Confirms the sync backfill really is gone from the
    // request path (the drift from beforeAll is still present here).
    const stockAfterHttp = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId: driftedProductId, variantId: null },
    });
    expect(stockAfterHttp?.quantity).toBe(10);
  });

  it('reconcile-via-async-handler: invoking the on-demand Inngest handler directly reconciles the drifted SKU, invariant holds afterward', async () => {
    // Proves the reconcile still happens, just via the async path —
    // `reconcileOneStoreOnDemand` is the exact function the
    // `warehouseReconcileOnDemand` Inngest function (triggered by the
    // `warehouse/reconcile-requested` event the endpoint above emits) runs
    // inside its `step.run`.
    const result = await reconcileOneStoreOnDemand(storeA.storeId, undefined, stepStub);

    expect(result.skusReconciled).toBeGreaterThanOrEqual(1);
    expect(result.skusFailed).toBe(0);

    const stock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId: driftedProductId, variantId: null },
    });
    const product = await prisma.product.findUnique({ where: { id: driftedProductId } });

    // Invariant restored: SUM(WarehouseStock) === Product.inventory.
    expect(stock?.quantity).toBe(product?.inventory);
    // Authoritative value itself is untouched by reconcile.
    expect(product?.inventory).toBe(7);
  });

  it('tenant isolation: store-B admin hitting store-A reconcile URL → 403 FORBIDDEN', async () => {
    const res = await fetch(`${API_URL}/stores/${storeA.storeId}/warehouses/reconcile-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(storeB.token) },
    });
    const json = await res.json();

    expect(res.status, JSON.stringify(json)).toBe(403);
    expect(json.error?.code).toBe('FORBIDDEN');
  });

  it('feature gate: non-Enterprise store (no inventory.multi_warehouse) → 403 FEATURE_DISABLED', async () => {
    const res = await fetch(`${API_URL}/stores/${storeC.storeId}/warehouses/reconcile-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(storeC.token) },
    });
    const json = await res.json();

    expect(res.status, JSON.stringify(json)).toBe(403);
    expect(json.code ?? json.error).toBe('FEATURE_DISABLED');
  });
});
