# Checkout Concurrency Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the storefront survive ecommerce-scale write concurrency (flash sales / many shoppers buying the same SKU at once) without connection-pool timeouts or oversell.

**Architecture:** Three independent levers. (1) Stop the high-frequency add-to-cart path from causing _spurious_ Serializable conflicts — its inventory check is advisory (the authoritative lock is at order time), so it drops to Read Committed. (2) Replace the order-placement `SELECT … FOR UPDATE` + late `decrement` with a single atomic conditional `UPDATE … WHERE inventory >= qty RETURNING`, shrinking the hot-row lock window to one statement near commit. (3) Add Railway horizontal replicas so the connection pool scales beyond a single instance's 5. Prove it with a single-SKU k6 checkout storm and an oversell-invariant integration test.

**Tech Stack:** Express + Prisma (Read Committed default), Neon Postgres (pgbouncer pooled, `connection_limit=5` / `pool_timeout=10s` per instance), Railway (Dockerfile deploy), vitest (`tests/integration`), k6 (`loadtests/scenarios`).

---

## Current State (verified 2026-06-05)

- **Pool:** `packages/database/src/index.ts` → `appendPoolParams` sets `connection_limit=5`, `pool_timeout=10`, `connect_timeout=10`, `pgbouncer=true`. **Per instance.** `railway.json` has no replica config → **1 instance → pool = 5 total.**
- **Cart add:** `apps/api/src/services/cart.service.ts` `addItem` (lines ~108–186) and `addItems` (lines ~235–294) each wrap an advisory inventory check + own-cart-row write in `prisma.$transaction(..., { isolationLevel: Serializable })` inside `retryOnWriteConflict`. The header comment states the real lock is at order time. Concurrent adds of the same product all read the same `product.inventory` row → Serializable read-write dependency → P2034 storm (the "30/50 hot-product adds returned 500" incident).
- **Order placement:** `apps/api/src/services/order.service.ts` (≈line 271) `withMoneyTx(prisma, …)` (= Read Committed, `maxWait 10s`, `timeout 30s`). Inside: a loop does `SELECT inventory … FOR UPDATE` per item _first_ (≈lines 284–342), then coupon reserve + order create + orderItems, then `tx.product.update({ inventory: { decrement } })` + `inventoryHistory.create` (≈lines 410–446). The `FOR UPDATE` row lock is held from the early SELECT until commit — the genuine hot-SKU contention.
- **Inventory model:** `Product.inventory` (Int), `ProductVariant.inventory` (Int), `trackInventory`, `allowBackorder`; ledger `InventoryHistory { quantity, previousStock, newStock }` (schema lines ~612, ~847).
- **db-retry:** `apps/api/src/lib/db-retry.ts` `retryOnWriteConflict` (4 retries, exp backoff+jitter, only P2034). At Read Committed P2034 won't occur, so the wrapper becomes a harmless no-op — keep it as a safety net.
- **Load harness:** `loadtests/scenarios/multi-store-checkout-storm.js` (`STORM_MAX_VUS` default 50), runner `loadtests/run.sh`, seed `packages/database/prisma/seed-loadtest-stores.ts`.
- **Tests:** vitest. Integration tests run via `npm run test:integration` (`vitest run tests/integration`).

## File Structure

- Modify `apps/api/src/services/cart.service.ts` — both Serializable options → Read Committed.
- Modify `apps/api/src/services/order.service.ts` — replace FOR-UPDATE-then-decrement with atomic conditional decrement helper.
- Create `apps/api/src/services/inventory-decrement.ts` — single-responsibility atomic decrement (product + variant), returns `{ ok, previousStock, newStock }`; keeps order.service focused.
- Create `tests/integration/order-oversell.int.test.ts` — the oversell invariant under concurrency.
- Modify `railway.json` — `deploy.numReplicas`.
- Create `loadtests/scenarios/hot-sku-checkout-storm.js` — single-SKU storm.
- Modify `DEPLOYMENT.md` — connection math + replica/Neon-pooler ceiling + load-test ceiling.

---

### Task 1: Cart add paths → Read Committed (kill spurious P2034)

**Files:**

- Modify: `apps/api/src/services/cart.service.ts` (the two `isolationLevel: Prisma.TransactionIsolationLevel.Serializable` options, ≈lines 182 and 291)
- Test: `tests/integration/cart-concurrent-add.int.test.ts`

- [ ] **Step 1: Write the failing test** — 20 concurrent adds of the same product must all resolve (no P2034 surfaced), final quantity correct.

Create `tests/integration/cart-concurrent-add.int.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { CartService } from '../../apps/api/src/services/cart.service';
import { makeStore, makeProduct } from './helpers/factories'; // existing integration factories

describe('cart add — concurrent same-product (no spurious P2034)', () => {
  let storeId: string, productId: string;
  beforeAll(async () => {
    const store = await makeStore();
    storeId = store.id;
    const product = await makeProduct(storeId, { inventory: 1000, trackInventory: true });
    productId = product.id;
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE cart_items, carts RESTART IDENTITY CASCADE');
  });

  it('20 concurrent adds to 20 distinct carts all succeed without P2034', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_v, i) => CartService.addItem(storeId, `sess-${i}`, productId, 1))
    );
    const rejected = results.filter(r => r.status === 'rejected');
    // No transaction-conflict errors should surface to the caller.
    for (const r of rejected) {
      const code = (r as PromiseRejectedResult).reason?.code;
      expect(code).not.toBe('P2034');
    }
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or is flaky) on current Serializable**

Run: `npm run test:integration -- cart-concurrent-add`
Expected: with `Serializable`, concurrent adds can surface P2034 before retries exhaust under load, or the test is flaky. (If green by luck, proceed — Step 3 makes it deterministically green.)

- [ ] **Step 3: Change both cart transactions to Read Committed**

In `apps/api/src/services/cart.service.ts`, change the `addItem` transaction options (≈line 181-183):

```ts
          {
            // Advisory cart-level check only — the authoritative inventory lock
            // is the FOR UPDATE / atomic decrement at order creation (order.service).
            // Read Committed avoids the spurious P2034 storm where concurrent adds
            // of the SAME product (each writing its OWN cart row) conflict purely
            // because they read the same product.inventory row under Serializable.
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          }
```

And the `addItems` transaction options (≈line 291):

```ts
{
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted;
}
```

Leave the `retryOnWriteConflict` wrappers in place (no-op at Read Committed; safety net if isolation ever changes).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:integration -- cart-concurrent-add`
Expected: PASS — 20/20 fulfilled, zero P2034.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run db:generate && npm run typecheck
git add apps/api/src/services/cart.service.ts tests/integration/cart-concurrent-add.int.test.ts
git commit -m "perf(api): cart add uses read committed (advisory check, not serializable)"
```

---

### Task 2: Order placement → atomic conditional decrement

**Files:**

- Create: `apps/api/src/services/inventory-decrement.ts`
- Modify: `apps/api/src/services/order.service.ts` (remove FOR-UPDATE loop ≈284-342; replace decrement block ≈410-446)
- Test: `tests/integration/order-oversell.int.test.ts`

- [ ] **Step 1: Write the failing oversell test** — inventory=1, 10 concurrent orders, exactly one wins, inventory never goes negative.

Create `tests/integration/order-oversell.int.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import { placeOrderViaApi, seedStoreProductCart } from './helpers/order-flow'; // existing/created helper

describe('order placement — no oversell under concurrency', () => {
  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE inventory_history, order_items, orders, cart_items, carts, product_variants, products RESTART IDENTITY CASCADE'
    );
  });

  it('inventory=1, 10 concurrent checkouts → exactly 1 success, inventory ends at 0', async () => {
    const { storeId, productId } = await seedStoreProductCart({
      inventory: 1,
      trackInventory: true,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => placeOrderViaApi(storeId, productId, 1))
    );
    const ok = results.filter(r => r.status === 'fulfilled' && r.value.status === 201);
    const insufficient = results.filter(
      r => r.status === 'fulfilled' && r.value.body?.error?.code === 'INSUFFICIENT_INVENTORY'
    );

    expect(ok.length).toBe(1);
    expect(insufficient.length).toBe(9);

    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(product!.inventory).toBe(0); // never negative, never oversold
  });
});
```

> If `seedStoreProductCart`/`placeOrderViaApi` helpers don't exist, create them in `tests/integration/helpers/order-flow.ts` wrapping the existing order endpoint (`apps/api/src/routes/public.routes.ts`) with supertest; reuse store/product factories already used by other integration tests.

- [ ] **Step 2: Run test to verify it fails or is unsafe on current code**

Run: `npm run test:integration -- order-oversell`
Expected: PASS on current FOR-UPDATE code (it is already correct) — this test is the **regression guard** that must STAY green after the refactor. Record the baseline as green.

- [ ] **Step 3: Create the atomic decrement helper**

Create `apps/api/src/services/inventory-decrement.ts`:

```ts
import type { Prisma } from '@prisma/client';

export interface DecrementResult {
  ok: boolean; // true = decremented within stock; false = would go below 0
  previousStock: number;
  newStock: number;
}

/**
 * Atomically decrement product inventory by `qty` ONLY if enough stock exists.
 * Single statement: the row write-lock is held for microseconds (until tx commit),
 * not across an early SELECT … FOR UPDATE + the rest of the order transaction.
 * Returns ok=false (no mutation) when stock would go negative — caller decides
 * backorder vs reject.
 */
export async function decrementProductInventory(
  tx: Prisma.TransactionClient,
  productId: string,
  qty: number
): Promise<DecrementResult> {
  const rows = await tx.$queryRaw<Array<{ inventory: number }>>`
    UPDATE public.products
    SET inventory = inventory - ${qty}
    WHERE id = ${productId} AND inventory >= ${qty}
    RETURNING inventory
  `;
  if (rows.length === 1) {
    return { ok: true, previousStock: rows[0].inventory + qty, newStock: rows[0].inventory };
  }
  const [cur] = await tx.$queryRaw<Array<{ inventory: number }>>`
    SELECT inventory FROM public.products WHERE id = ${productId}
  `;
  return { ok: false, previousStock: cur?.inventory ?? 0, newStock: cur?.inventory ?? 0 };
}

/** Unconditional decrement (allows negative) — backorder path only. */
export async function forceDecrementProductInventory(
  tx: Prisma.TransactionClient,
  productId: string,
  qty: number
): Promise<DecrementResult> {
  const [row] = await tx.$queryRaw<Array<{ inventory: number }>>`
    UPDATE public.products SET inventory = inventory - ${qty}
    WHERE id = ${productId} RETURNING inventory
  `;
  return { ok: true, previousStock: row.inventory + qty, newStock: row.inventory };
}

export async function decrementVariantInventory(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number
): Promise<DecrementResult> {
  const rows = await tx.$queryRaw<Array<{ inventory: number }>>`
    UPDATE public.product_variants
    SET inventory = inventory - ${qty}
    WHERE id = ${variantId} AND inventory >= ${qty}
    RETURNING inventory
  `;
  if (rows.length === 1) {
    return { ok: true, previousStock: rows[0].inventory + qty, newStock: rows[0].inventory };
  }
  const [cur] = await tx.$queryRaw<Array<{ inventory: number }>>`
    SELECT inventory FROM public.product_variants WHERE id = ${variantId}
  `;
  return { ok: false, previousStock: cur?.inventory ?? 0, newStock: cur?.inventory ?? 0 };
}

export async function forceDecrementVariantInventory(
  tx: Prisma.TransactionClient,
  variantId: string,
  qty: number
): Promise<DecrementResult> {
  const [row] = await tx.$queryRaw<Array<{ inventory: number }>>`
    UPDATE public.product_variants SET inventory = inventory - ${qty}
    WHERE id = ${variantId} RETURNING inventory
  `;
  return { ok: true, previousStock: row.inventory + qty, newStock: row.inventory };
}
```

- [ ] **Step 4: Rewire order.service to use the helper**

In `apps/api/src/services/order.service.ts`:

1. Import: `import { decrementProductInventory, forceDecrementProductInventory, decrementVariantInventory, forceDecrementVariantInventory } from './inventory-decrement';`
2. **Delete** the early FOR-UPDATE validation loop (≈lines 284–342) — the atomic decrement is now the authoritative check.
3. **Replace** the decrement block (≈lines 410–446) so that, for each tracked item, _as late as possible in the transaction_, it does:

```ts
for (const item of cart.items) {
  if (!item.product.trackInventory) continue;
  const qty = item.quantity;
  const variantId = (item as { variantId?: string }).variantId;

  // Try the safe atomic decrement first.
  let res = variantId
    ? await decrementVariantInventory(tx, variantId, qty)
    : await decrementProductInventory(tx, item.productId, qty);

  if (!res.ok) {
    // Insufficient stock — accept only when backorder is allowed (store
    // feature flag AND per-product/variant flag), else reject the order.
    const allowBackorder =
      backorderFeatureEnabled &&
      (variantId
        ? (
            await tx.productVariant.findUnique({
              where: { id: variantId },
              select: { allowBackorder: true },
            })
          )?.allowBackorder
        : item.product.allowBackorder);
    if (!allowBackorder) {
      throw new AppError(
        400,
        'INSUFFICIENT_INVENTORY',
        `Not enough inventory for ${item.product.name}${variantId ? ' (variant)' : ''}`
      );
    }
    res = variantId
      ? await forceDecrementVariantInventory(tx, variantId, qty)
      : await forceDecrementProductInventory(tx, item.productId, qty);
    backorderedItems.push({ productId: item.productId, variantId, quantity: qty });
  }

  // Keep product.inventory in sync when a variant was decremented, and
  // record the ledger row atomically (DB-010).
  await tx.inventoryHistory.create({
    data: {
      productId: item.productId,
      quantity: -qty,
      previousStock: res.previousStock,
      newStock: res.newStock,
      reason: 'sale',
    },
  });
}
```

> Confirm the exact `InventoryHistory.create` field names + `reason` enum value against the current schema (≈line 722) and match the existing call at ≈line 431 — do not invent fields. Keep `backorderedItems` and its downstream `BackorderLine` creation exactly as-is.

- [ ] **Step 5: Run the oversell test + full integration suite**

Run: `npm run test:integration -- order-oversell` then `npm run test:integration`
Expected: PASS — exactly 1 success, inventory 0, no negative; all pre-existing order/inventory integration tests still green.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run db:generate && npm run typecheck
git add apps/api/src/services/inventory-decrement.ts apps/api/src/services/order.service.ts tests/integration/order-oversell.int.test.ts tests/integration/helpers/order-flow.ts
git commit -m "perf(api): atomic conditional inventory decrement at order placement (shrink hot-row lock)"
```

---

### Task 3: Horizontal scaling — Railway replicas + connection math

**Files:**

- Modify: `railway.json` (`deploy.numReplicas`)
- Modify: `DEPLOYMENT.md` (connection math + ceilings)

- [ ] **Step 1: Add replicas to railway.json**

In `railway.json`, add to the `deploy` block:

```json
  "deploy": {
    "numReplicas": 2,
    "preDeployCommand": "npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma",
    "startCommand": "node apps/api/dist/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 120,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
```

- [ ] **Step 2: Document the connection math in DEPLOYMENT.md**

Add a "Database connection capacity" section:

```markdown
## Database connection capacity (concurrency ceiling)

- Per API instance: Prisma `connection_limit=5`, `pool_timeout=10s` (packages/database/src/index.ts).
- Total client connections = 5 × `numReplicas`. With `numReplicas=2` → 10.
- Neon pgbouncer pooler multiplexes these over a small server-side pool; verify the
  account's pooler max in the Neon dashboard (Settings → Compute) before raising replicas
  or `connection_limit` — exceeding it returns "sorry, too many clients already".
- Scale order: shorten connection hold (cache reads, tight tx) → add replicas → only then
  raise per-instance `connection_limit`. Load-test ceiling recorded below.
```

- [ ] **Step 3: Commit (config + doc only — no code)**

```bash
git add railway.json DEPLOYMENT.md
git commit -m "chore(infra): railway numReplicas=2 + document db connection capacity"
```

> Verify the Neon pooler max client connections in the dashboard before merging; if it's below 5×replicas, lower `connection_limit` or coordinate the replica count. Final replica count is Ahmad's call (cost vs ceiling).

---

### Task 4: k6 single-SKU checkout storm (the proof + gate)

**Files:**

- Create: `loadtests/scenarios/hot-sku-checkout-storm.js`
- Modify: `DEPLOYMENT.md` (record the before/after ceiling)

- [ ] **Step 1: Write the single-SKU storm scenario** (model on `multi-store-checkout-storm.js`)

Create `loadtests/scenarios/hot-sku-checkout-storm.js`:

```js
// Hammer ONE product's checkout to surface hot-row contention.
// ENV: BASE_URL, STORE_ID, PRODUCT_ID, STORM_MAX_VUS (default 50), STORM_HOLD (default 2m).
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL;
const STORE_ID = __ENV.STORE_ID;
const PRODUCT_ID = __ENV.PRODUCT_ID;
const MAX_VUS = parseInt(__ENV.STORM_MAX_VUS || '50', 10);

export const options = {
  scenarios: {
    hot_sku: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: MAX_VUS },
        { duration: __ENV.STORM_HOLD || '2m', target: MAX_VUS },
        { duration: '20s', target: 0 },
      ],
    },
  },
  thresholds: {
    // The gate: no pool-timeout 500s, p95 under 2s even on one row.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const sess = `k6-${__VU}-${__ITER}`;
  const headers = { 'Content-Type': 'application/json', 'X-Session-ID': sess };
  http.post(
    `${BASE_URL}/public/${STORE_ID}/cart/items`,
    JSON.stringify({ productId: PRODUCT_ID, quantity: 1 }),
    { headers }
  );
  const res = http.post(
    `${BASE_URL}/public/${STORE_ID}/orders`,
    JSON.stringify({ paymentMethod: 'cod', shipping: { area: 'test' } }),
    { headers }
  );
  // 201 (won the unit) OR 400 INSUFFICIENT_INVENTORY are BOTH success — 500/timeout is not.
  check(res, { 'no server error': r => r.status !== 0 && r.status < 500 });
}
```

> Confirm the cart + order endpoint paths and the order request body against `apps/api/src/routes/public.routes.ts` before running (the storefront uses `api.addToCart()` / the `/public` prefix — see the buy-flow memory). Adjust the JSON to the real order schema.

- [ ] **Step 2: Seed a disposable store + a high-inventory SKU and capture IDs**

Run: `npm run db:generate && npx tsx packages/database/prisma/seed-loadtest-stores.ts` (or the existing seed) and note one `STORE_ID` + `PRODUCT_ID` with large inventory (e.g. 100000 so the storm measures contention, not stock-out).

- [ ] **Step 3: Run BEFORE on current prod/staging to capture the baseline ceiling**

Run: `BASE_URL=<staging-api> STORE_ID=<id> PRODUCT_ID=<id> STORM_MAX_VUS=50 k6 run loadtests/scenarios/hot-sku-checkout-storm.js`
Expected (pre-fix): http_req_failed climbs / p95 approaches 10s as VUs rise (pool-timeout signature). Record numbers.

- [ ] **Step 4: After Tasks 1–3 are deployed, re-run at 50 / 100 / 200 VUs**

Run the same command with `STORM_MAX_VUS=50`, then `100`, then `200`.
Expected (post-fix): `http_req_failed rate<0.01`, `p95<2000ms`; find the VU level where p95 first crosses 2s — that's the new ceiling.

- [ ] **Step 5: Record the ceiling in DEPLOYMENT.md + commit**

Append the before/after table (VUs → rps → p95 → error rate) under the "Database connection capacity" section.

```bash
git add loadtests/scenarios/hot-sku-checkout-storm.js DEPLOYMENT.md
git commit -m "test(loadtest): single-sku checkout storm + recorded concurrency ceiling"
```

---

## Self-Review

**Spec coverage:**

- Pool-exhaustion timeouts under concurrency → Task 1 (remove spurious P2034 on the most frequent write) + Task 3 (more pool via replicas) + Task 2 (shorter hot-row lock). ✓
- Oversell safety preserved → Task 2 atomic conditional decrement + Task 2 oversell integration test (the invariant: inventory never negative, exactly-one-wins). ✓
- Backorder behavior preserved → Task 2 keeps the dual-flag check + `backorderedItems` / BackorderLine path. ✓
- Proof / regression gate → Task 4 k6 storm + Task 1/2 integration tests. ✓

**Placeholder scan:** Test helper wiring (`makeStore`/`makeProduct`/`seedStoreProductCart`/`placeOrderViaApi`) is flagged to reuse existing integration factories or create thin wrappers — not a code placeholder but a real dependency to confirm at execution. Endpoint paths/bodies in Tasks 2 & 4 are flagged to verify against `public.routes.ts` (the `/public` prefix + real order schema) — do this before running, do not guess.

**Type consistency:** `DecrementResult { ok, previousStock, newStock }` is produced by all four helpers and consumed identically in order.service. `InventoryHistory.create` fields must match schema (≈line 722) + the existing call (≈line 431) — verify, don't invent.

**Risk notes:**

- Task 1 widens the cart-level TOCTOU window — acceptable and intended (authoritative lock is at order time; oversell-at-cart was already explicitly tolerated).
- Task 2 is money-critical: do NOT merge without the oversell integration test green and the full integration suite green.
- Task 2's atomic decrement still holds the row write-lock until tx commit (Postgres semantics) — the win is removing the early FOR-UPDATE window + N SELECT round-trips and decrementing late. For extreme single-SKU scale beyond what Task 4 shows, a follow-up reservation pattern (decrement in a separate fast committed tx before order creation, with compensation on failure) is the next lever — out of scope here, note it if the ceiling is still too low.
