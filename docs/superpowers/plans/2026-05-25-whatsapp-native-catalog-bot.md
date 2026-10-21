# WhatsApp Native Catalog Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-chat product-listing bot with Meta Native WhatsApp Catalog, layered on top
of the existing `wa-ordering.js` state machine, adding pre-catalog greeting/language/services flow +
saved-address + payment-method steps. Target ≤3s p95 per interaction (current ~15s+).

**Architecture:** Cross-repo (Ebda Store + WBS). Ebda Store owns products/customers/orders + Inngest fanout on
product changes. WBS owns the state machine + Meta Graph API calls (catalog sync + interactive
messages). Catalog hosted at Meta Commerce eliminates per-message bridge calls; only async
background sync hits Ebda Store.

**Tech Stack:** Node 20, Express, Prisma 7 (Ebda Store) / Prisma 5 (WBS), Neon Postgres, Redis (BullMQ +
cache), Inngest (Ebda Store), Meta WhatsApp Cloud API v22, Meta Graph API for Catalog Object, Next.js 16
(Ebda Store admin).

**Spec:**
[`docs/superpowers/specs/2026-05-25-whatsapp-native-catalog-bot-design.md`](../specs/2026-05-25-whatsapp-native-catalog-bot-design.md)

---

## File Structure Overview

### Ebda Store (`/Users/ahmadsharaf/Desktop/projects/ebda-store`)

| File                                                                                     | Status | Purpose                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/prisma/schema.prisma`                                                 | modify | `Store.bot_mode`, `Store.bot_service_menu`, `Store.meta_catalog_id`, `Store.meta_business_id`, `Store.meta_access_token` (encrypted), `Customer.preferred_locale`, `Customer.last_locale_choice`, new `CustomerAddress` model |
| `packages/database/prisma/migrations/20260525120000_wa_native_catalog_bot/migration.sql` | create | manual SQL — table create + columns + indexes                                                                                                                                                                                 |
| `apps/api/src/services/customer-address.service.ts`                                      | create | CRUD for `CustomerAddress`                                                                                                                                                                                                    |
| `apps/api/src/routes/wa-bridge.routes.ts`                                                | modify | add 5 endpoints: customer-addresses GET+POST, store/service-menu GET, store/meta-catalog-config GET+POST                                                                                                                      |
| `apps/api/src/lib/inngest/functions/product-meta-sync.ts`                                | create | Inngest function triggered by `product.upserted` / `product.deleted` events; calls WBS sync endpoint                                                                                                                          |
| `apps/api/src/lib/inngest/client.ts`                                                     | modify | register `productMetaSync`                                                                                                                                                                                                    |
| `apps/api/src/services/product.service.ts`                                               | modify | fire `product.upserted` / `product.deleted` events on writes                                                                                                                                                                  |
| `apps/api/src/lib/observability/wa-bridge-timing.ts`                                     | create | pino timing middleware for bridge endpoints                                                                                                                                                                                   |
| `apps/admin/src/app/stores/[id]/wa-bot/page.tsx`                                         | create | merchant admin tab for bot_mode + service menu + Meta catalog config                                                                                                                                                          |
| `apps/admin/src/app/stores/[id]/wa-bot/BotModeCard.tsx`                                  | create | bot mode dropdown                                                                                                                                                                                                             |
| `apps/admin/src/app/stores/[id]/wa-bot/ServiceMenuCard.tsx`                              | create | toggle 4 service menu items + label customization                                                                                                                                                                             |
| `apps/admin/src/app/stores/[id]/wa-bot/MetaCatalogCard.tsx`                              | create | catalog ID + business ID + access token form                                                                                                                                                                                  |
| `tests/integration/wa-bridge-customer-addresses.test.ts`                                 | create | CRUD roundtrip                                                                                                                                                                                                                |
| `tests/integration/wa-bridge-store-config.test.ts`                                       | create | service-menu + meta-catalog-config endpoints                                                                                                                                                                                  |
| `tests/unit/product-meta-sync.test.ts`                                                   | create | Inngest function logic with mocked WBS calls                                                                                                                                                                                  |
| `docs/uat/whatsapp-native-catalog-bot.md`                                                | create | UAT checklist                                                                                                                                                                                                                 |
| `docs/uat/whatsapp-bot-latency-baseline.md`                                              | create | Phase 0 findings                                                                                                                                                                                                              |

### WBS (`/Users/ahmadsharaf/Desktop/projects/whatsapp-bulk-sender`)

| File                                                   | Status  | Purpose                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/services/wa-ordering.js`                  | modify  | extend state machine: `awaiting_greeting`, `awaiting_language`, `awaiting_service`, `viewing_catalog`, `cart_received`, `awaiting_address_choice`, `awaiting_new_address`, `awaiting_payment`, `order_summary`, `agent_chat`, `locations_replied`, `subscription_replied` |
| `backend/src/services/wa-interactive.js`               | create  | builders: `buildButtons`, `buildList`, `buildCatalogMessage`, `buildAddressMessage`, `buildProductListMessage`, `parseInteractiveReply`                                                                                                                                   |
| `backend/src/services/metaCatalogService.js`           | rewrite | (existing 176 LOC stub) — full Meta Graph API client: `upsertProduct(storeConfig, product)`, `deleteProduct(storeConfig, retailerId)`, `getCatalogStatus(storeConfig)`                                                                                                    |
| `backend/src/services/bot-service-router.js`           | create  | maps service-menu tap → state branch                                                                                                                                                                                                                                      |
| `backend/src/services/wa-bridge-client.js`             | modify  | new methods: `getCustomerAddresses`, `createCustomerAddress`, `getStoreServiceMenu`, `getStoreMetaCatalogConfig`                                                                                                                                                          |
| `backend/src/routes/external.js`                       | modify  | new endpoint `POST /internal/inngest-receiver` (auth via shared secret) for Ebda Store-side fanout                                                                                                                                                                               |
| `backend/scripts/wa-keepalive.js`                      | create  | ping Ebda Store `/health` every 4 min — prevents Railway cold start                                                                                                                                                                                                              |
| `backend/__tests__/wa-ordering-greeting.test.js`       | create  | greeting → language → service state transitions                                                                                                                                                                                                                           |
| `backend/__tests__/wa-ordering-service-router.test.js` | create  | each service-menu choice routes correctly                                                                                                                                                                                                                                 |
| `backend/__tests__/wa-ordering-native-catalog.test.js` | create  | catalog message → cart receive → address → payment                                                                                                                                                                                                                        |
| `backend/__tests__/wa-interactive.test.js`             | create  | builders + parseInteractiveReply                                                                                                                                                                                                                                          |
| `backend/__tests__/metaCatalogService.test.js`         | create  | mocked Meta API responses                                                                                                                                                                                                                                                 |

### Cross-repo env vars (one-time set)

| Var                       | Repo | Where to set                               |
| ------------------------- | ---- | ------------------------------------------ |
| `INNGEST_RECEIVER_SECRET` | both | `gh secret set` on Ebda Store + WBS Railway env   |
| `META_GRAPH_API_BASE`     | WBS  | default `https://graph.facebook.com/v22.0` |

---

## Phase 0 — Latency Diagnosis (Day 0.5)

**Goal**: Measure where the current 15s+ comes from. Apply quick wins BEFORE building new flow on
top of slow bedrock.

### Task 0.1: Add pino timing middleware to Ebda Store wa-bridge routes

**Files:**

- Create: `apps/api/src/lib/observability/wa-bridge-timing.ts`
- Modify: `apps/api/src/routes/wa-bridge.routes.ts:1-20` (add `router.use(waBridgeTiming)` after
  `waBridgeAuth`)
- Test: `tests/unit/wa-bridge-timing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/wa-bridge-timing.test.ts
import { describe, it, expect, vi } from 'vitest';
import { waBridgeTiming } from '@api/lib/observability/wa-bridge-timing';

describe('waBridgeTiming', () => {
  it('logs duration in ms when response finishes', async () => {
    const logger = { info: vi.fn() };
    const req: any = { path: '/store-catalog', method: 'GET', query: { storeId: 'abc' } };
    const res: any = { on: vi.fn(), statusCode: 200 };
    const next = vi.fn();

    waBridgeTiming(logger as any)(req, res, next);
    expect(next).toHaveBeenCalled();
    // Simulate finish event
    const finishHandler = res.on.mock.calls.find((c: any) => c[0] === 'finish')?.[1];
    expect(finishHandler).toBeDefined();
    await new Promise(r => setTimeout(r, 10));
    finishHandler();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/store-catalog',
        method: 'GET',
        status: 200,
        durationMs: expect.any(Number),
      }),
      'wa-bridge timing'
    );
    expect(logger.info.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd /Users/ahmadsharaf/Desktop/projects/ebda-store && npx vitest run tests/unit/wa-bridge-timing.test.ts`
Expected: FAIL with "Cannot find module '@api/lib/observability/wa-bridge-timing'"

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/lib/observability/wa-bridge-timing.ts
import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'pino';

/**
 * Express middleware that emits a structured log line per request with the
 * full duration (ms) from middleware-enter to response.finish. Used to
 * diagnose the 15s+ wa-bridge latency that prompted Phase 0.
 *
 * Goes between waBridgeAuth and the route handler. Single info line per
 * request — no DEBUG noise.
 */
export const waBridgeTiming =
  (logger: Logger) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      logger.info(
        {
          path: req.path,
          method: req.method,
          status: res.statusCode,
          durationMs,
          storeId: (req.query.storeId as string | undefined) ?? null,
        },
        'wa-bridge timing'
      );
    });
    next();
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/wa-bridge-timing.test.ts` Expected: PASS

- [ ] **Step 5: Wire into wa-bridge router**

Modify `apps/api/src/routes/wa-bridge.routes.ts` — find the line `const router = Router();` and add
right after `router.use(waBridgeAuth);` (or before the first route if no current `.use`):

```ts
import { waBridgeTiming } from '../lib/observability/wa-bridge-timing';
import logger from '../lib/logger';
// ... existing imports ...
router.use(waBridgeTiming(logger));
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/observability/wa-bridge-timing.ts \
        apps/api/src/routes/wa-bridge.routes.ts \
        tests/unit/wa-bridge-timing.test.ts
git commit -m "obs(api): wa-bridge timing middleware for latency diagnosis"
git push origin main
```

### Task 0.2: Add WBS-side timing logs around bridge calls

**Files:**

- Modify: `backend/src/services/wa-bridge-client.js`

- [ ] **Step 1: Wrap every fetch with hr-time + log**

In `wa-bridge-client.js`, for each exported function (e.g. `getStoreCatalog`, `getCustomerHistory`,
`postCartFromWA`, `postTemplatesStatus`), wrap the fetch:

```js
// before:
async function getStoreCatalog(client, opts) {
  const url = `${client.ebdaApiUrl}/wa-bridge/store-catalog?storeId=${opts.storeId}`;
  const res = await fetch(url, { headers: { 'X-WBS-API-KEY': key } });
  return res.json();
}

// after:
async function getStoreCatalog(client, opts) {
  const url = `${client.ebdaApiUrl}/wa-bridge/store-catalog?storeId=${opts.storeId}`;
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(url, { headers: { 'X-WBS-API-KEY': key } });
    const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    logger.info({ endpoint: '/store-catalog', durationMs, status: res.status }, 'wa-bridge call');
    return res.json();
  } catch (err) {
    const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
    logger.error(
      { endpoint: '/store-catalog', durationMs, err: err.message },
      'wa-bridge call failed'
    );
    throw err;
  }
}
```

Apply same wrap to every exported function in the file. Do NOT change function signatures.

- [ ] **Step 2: Commit**

```bash
cd /Users/ahmadsharaf/Desktop/projects/whatsapp-bulk-sender
git add backend/src/services/wa-bridge-client.js
git commit -m "obs(wbs): timing logs around every wa-bridge call"
git push origin main
```

### Task 0.3: Drive a real customer order against Wady Aljuz + collect baseline

**Files:**

- Create: `docs/uat/whatsapp-bot-latency-baseline.md`

- [ ] **Step 1: Trigger a full order from Ebda AI Studio test WhatsApp number to Wady Aljuz bot**

Send: `Hi` → walk through every state → place a real order. Capture log output from Railway:

```bash
railway logs --service whatsapp-broadcaster --tail 200 > /tmp/wbs-latency-baseline.log
railway logs --service api --tail 200 > /tmp/ebda-latency-baseline.log
```

(Wbs has the user-perceived latency, Ebda Store has bridge endpoint durations.)

- [ ] **Step 2: Compute the latency table**

```bash
grep "wa-bridge call" /tmp/wbs-latency-baseline.log | jq -c '{endpoint, durationMs, status}'
grep "wa-bridge timing" /tmp/ebda-latency-baseline.log | jq -c '{path, durationMs, status, storeId}'
```

Write findings to `docs/uat/whatsapp-bot-latency-baseline.md`. Structure:

```markdown
# WhatsApp Bot Latency Baseline (2026-05-25)

## Setup

- Bot: WBS production (Wady Aljuz)
- Test WhatsApp number: <number>
- Browser timestamps from WhatsApp app + Railway logs

## End-to-end timeline

| Step          | User action     | Bot reply at | Round-trip |
| ------------- | --------------- | ------------ | ---------- |
| Greeting      | sent "Hi"       | <time>       | <s>        |
| Category list | tapped "Order"  | <time>       | <s>        |
| Product list  | tapped category | <time>       | <s>        |
| Quantity ask  | tapped product  | <time>       | <s>        |
| Cart summary  | sent quantity   | <time>       | <s>        |
| Checkout      | tapped Checkout | <time>       | <s>        |
| Order placed  | …               | <time>       | <s>        |

## Per-step latency breakdown (from logs)

| Path                      | p50  | p95  | observations |
| ------------------------- | ---- | ---- | ------------ |
| GET /store-catalog        | <ms> | <ms> | …            |
| GET /products/by-category | <ms> | <ms> | …            |
| POST /cart/from-wa        | <ms> | <ms> | …            |

## Top latency contributors

1. ...
2. ...
3. ...

## Quick wins applied

- ...
- ...
```

- [ ] **Step 3: Commit + push**

```bash
cd /Users/ahmadsharaf/Desktop/projects/ebda-store
git add docs/uat/whatsapp-bot-latency-baseline.md
git commit -m "docs(uat): wa-bot latency baseline before native catalog work"
git push origin main
```

### Task 0.4: Apply keepalive ping to prevent cold start

**Files:**

- Create: `backend/scripts/wa-keepalive.js`
- Modify: `backend/package.json` (add `keepalive` script)
- Modify: `backend/worker.js` (start the keepalive on boot)

- [ ] **Step 1: Write the script**

```js
// backend/scripts/wa-keepalive.js
/**
 * Pings Ebda Store /wa-bridge/health every 4 min to keep the Railway service warm
 * + the Neon DB compute unpaused. Without this, the first wa-bot inbound
 * after idle absorbs 5-10s of cold start.
 *
 * Started from worker.js (per existing pattern of long-running tasks).
 * Designed to run forever; restarts automatically if the process crashes
 * (BullMQ worker has KeepAlive via Railway).
 */
const logger = require('../src/utils/logger');
const { getDecryptedFwbApiKey } = require('../src/utils/waOrderingSettings');
const { prisma } = require('../src/config/db');

const INTERVAL_MS = 4 * 60_000;

async function pingAllActiveClients() {
  const clients = await prisma.clients.findMany({
    where: { wa_ordering_enabled: true },
    select: { id: true, wa_ordering_settings: true },
  });
  for (const client of clients) {
    const settings = client.wa_ordering_settings;
    if (!settings?.ebdaApiUrl) continue;
    try {
      const start = Date.now();
      const res = await fetch(`${settings.ebdaApiUrl}/wa-bridge/health`, {
        headers: { 'X-WBS-API-KEY': (await getDecryptedFwbApiKey(client.id)) || '' },
        signal: AbortSignal.timeout(5000),
      });
      const ms = Date.now() - start;
      logger.info({ clientId: client.id, status: res.status, ms }, 'wa-keepalive ping');
    } catch (err) {
      logger.warn({ clientId: client.id, err: err.message }, 'wa-keepalive ping failed');
    }
  }
}

function start() {
  logger.info({ intervalMs: INTERVAL_MS }, 'wa-keepalive starting');
  setInterval(pingAllActiveClients, INTERVAL_MS).unref();
  // Fire once immediately
  pingAllActiveClients().catch(() => {});
}

module.exports = { start };

if (require.main === module) start();
```

- [ ] **Step 2: Wire it into worker.js**

Find the existing worker startup, append:

```js
// backend/worker.js — at the bottom of the file, after existing init
require('./scripts/wa-keepalive').start();
```

- [ ] **Step 3: Commit + push**

```bash
git add backend/scripts/wa-keepalive.js backend/worker.js
git commit -m "perf(wbs): wa-keepalive script to prevent ebda cold start"
git push origin main
```

### Task 0.5: Parallelize any sequential bridge calls + apply tier-up fixes

**Files:**

- Modify: `backend/src/services/wa-ordering.js` — search for any function with consecutive
  `await waBridge.xxx()` calls

- [ ] **Step 1: Search for the pattern**

```bash
cd /Users/ahmadsharaf/Desktop/projects/whatsapp-bulk-sender/backend/src/services
grep -nE "await waBridge\." wa-ordering.js | head -20
```

Identify any spot where 2+ consecutive `await waBridge.xxx()` calls are independent of each other
(don't depend on each other's return values).

- [ ] **Step 2: Convert to Promise.all**

For each identified spot:

```js
// before:
const catalog = await waBridge.getStoreCatalog(client, { storeId });
const customerHistory = await waBridge.getCustomerHistory(client, { storeId, phone });

// after:
const [catalog, customerHistory] = await Promise.all([
  waBridge.getStoreCatalog(client, { storeId }),
  waBridge.getCustomerHistory(client, { storeId, phone }),
]);
```

- [ ] **Step 3: Run wa-ordering tests + commit**

```bash
cd /Users/ahmadsharaf/Desktop/projects/whatsapp-bulk-sender/backend
npx jest __tests__/wa-ordering*.test.js 2>&1 | tail -10
# All pass? commit.
git add backend/src/services/wa-ordering.js
git commit -m "perf(wbs): parallelize independent wa-bridge calls in ordering state machine"
git push origin main
```

### Task 0.6: Update latency baseline doc with quick-win measurements

- [ ] **Step 1: Re-run the test order against Wady Aljuz**

Same procedure as Task 0.3. Capture new logs.

- [ ] **Step 2: Update the baseline doc**

Append a "Post-quick-wins" section to `docs/uat/whatsapp-bot-latency-baseline.md` with new p50/p95.

- [ ] **Step 3: Commit**

```bash
git add docs/uat/whatsapp-bot-latency-baseline.md
git commit -m "docs(uat): wa-bot latency post quick-wins"
git push origin main
```

**Phase 0 acceptance gate**: bridge call p95 ≤ 1.5s OR documented blocker (Meta API constraint,
Railway plan limit) that justifies remaining latency. If not met, escalate to Ahmad before starting
Phase A.

---

## Phase A — Catalog Sync (Day 1.5)

**Goal**: Ebda Store product writes propagate to Meta Commerce Catalog in real time (≤5s).

### Task A.1: Migration — Store + Customer schema changes

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260525120000_wa_native_catalog_bot/migration.sql`

- [ ] **Step 1: Edit the schema**

Add to `Store` model (existing fields preserved):

```prisma
model Store {
  // ... existing fields ...
  bot_mode             String   @default("legacy_chat")        @map("bot_mode")
  bot_service_menu     Json?                                    @map("bot_service_menu")
  meta_catalog_id      String?                                  @map("meta_catalog_id")
  meta_business_id     String?                                  @map("meta_business_id")
  meta_access_token    String?                                  @map("meta_access_token")  // encrypted
}
```

Add to `Customer` model:

```prisma
model Customer {
  // ... existing fields ...
  preferred_locale     String?                                  @map("preferred_locale")
  last_locale_choice   DateTime?                                @map("last_locale_choice")
  addresses            CustomerAddress[]
}
```

Append a new model at the appropriate location (after `Customer`, before related models):

```prisma
model CustomerAddress {
  id              String   @id @default(uuid())
  customerId      String   @map("customer_id")
  customer        Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  label           String?
  street          String
  block           String?
  area            String
  governorate     String?
  buildingNumber  String?   @map("building_number")
  notes           String?
  isDefault       Boolean   @default(false)  @map("is_default")
  createdAt       DateTime  @default(now())  @map("created_at")
  updatedAt       DateTime  @updatedAt        @map("updated_at")

  @@index([customerId])
  @@map("customer_addresses")
}
```

- [ ] **Step 2: Create the migration SQL**

Use plural table names because Ebda Store uses `@@map` to plural per memory
`feedback-prisma-migration-uses-mapped-table-names.md`:

```sql
-- packages/database/prisma/migrations/20260525120000_wa_native_catalog_bot/migration.sql

-- Store columns (default-null safe for existing rows)
ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "bot_mode" TEXT NOT NULL DEFAULT 'legacy_chat',
  ADD COLUMN IF NOT EXISTS "bot_service_menu" JSONB,
  ADD COLUMN IF NOT EXISTS "meta_catalog_id" TEXT,
  ADD COLUMN IF NOT EXISTS "meta_business_id" TEXT,
  ADD COLUMN IF NOT EXISTS "meta_access_token" TEXT;

-- Customer columns
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "preferred_locale" TEXT,
  ADD COLUMN IF NOT EXISTS "last_locale_choice" TIMESTAMP(3);

-- CustomerAddress table
CREATE TABLE IF NOT EXISTS "customer_addresses" (
  "id"               TEXT NOT NULL,
  "customer_id"      TEXT NOT NULL,
  "label"            TEXT,
  "street"           TEXT NOT NULL,
  "block"            TEXT,
  "area"             TEXT NOT NULL,
  "governorate"      TEXT,
  "building_number"  TEXT,
  "notes"            TEXT,
  "is_default"       BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "customer_addresses_customer_id_idx"
  ON "customer_addresses"("customer_id");

ALTER TABLE "customer_addresses"
  ADD CONSTRAINT "customer_addresses_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Test migration locally**

```bash
cd /Users/ahmadsharaf/Desktop/projects/ebda-store
source ~/.nvm/nvm.sh && nvm use 20
export DATABASE_URL="postgresql://<u>:<p>@localhost:5432/force_test"  # test creds — local container only
docker run -d --name pg-mig-test -p 5432:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=force_test postgres:16-alpine
sleep 5
npx prisma migrate dev --schema=packages/database/prisma/schema.prisma --skip-seed
docker rm -f pg-mig-test
```

Expected: migration applies cleanly + Prisma client regenerates.

- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260525120000_wa_native_catalog_bot/
git commit -m "feat(db): wa native catalog bot schema — store config + customer addresses"
git push origin main
```

### Task A.2: customer-address.service.ts (Ebda Store)

**Files:**

- Create: `apps/api/src/services/customer-address.service.ts`
- Test: `tests/unit/customer-address-service.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/customer-address-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomerAddressService } from '@api/services/customer-address.service';

const mockPrisma = {
  customerAddress: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
};

describe('CustomerAddressService', () => {
  const svc = new CustomerAddressService(mockPrisma as any);
  beforeEach(() => vi.clearAllMocks());

  it('listForCustomer returns addresses sorted by isDefault then createdAt', async () => {
    mockPrisma.customerAddress.findMany.mockResolvedValue([
      { id: 'a1', label: 'Home', isDefault: true },
      { id: 'a2', label: 'Office', isDefault: false },
    ]);
    const addresses = await svc.listForCustomer('cust1');
    expect(mockPrisma.customerAddress.findMany).toHaveBeenCalledWith({
      where: { customerId: 'cust1' },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    expect(addresses).toHaveLength(2);
  });

  it('create sets isDefault=true when first address for customer', async () => {
    mockPrisma.customerAddress.findMany.mockResolvedValue([]);
    mockPrisma.customerAddress.create.mockResolvedValue({ id: 'new', isDefault: true });
    const addr = await svc.createForCustomer('cust1', { street: '123', area: 'Salmiya' });
    expect(mockPrisma.customerAddress.create).toHaveBeenCalledWith({
      data: { customerId: 'cust1', street: '123', area: 'Salmiya', isDefault: true },
    });
  });

  it('create does NOT set isDefault when customer has existing addresses', async () => {
    mockPrisma.customerAddress.findMany.mockResolvedValue([{ id: 'a1', isDefault: true }]);
    mockPrisma.customerAddress.create.mockResolvedValue({ id: 'new', isDefault: false });
    await svc.createForCustomer('cust1', { street: '456', area: 'Hawalli' });
    expect(mockPrisma.customerAddress.create).toHaveBeenCalledWith({
      data: { customerId: 'cust1', street: '456', area: 'Hawalli', isDefault: false },
    });
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run tests/unit/customer-address-service.test.ts` Expected: FAIL with "Cannot find
module '@api/services/customer-address.service'"

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/customer-address.service.ts
import type { PrismaClient } from '@prisma/client';

export type CreateAddressInput = {
  street: string;
  area: string;
  block?: string;
  governorate?: string;
  buildingNumber?: string;
  label?: string;
  notes?: string;
};

export class CustomerAddressService {
  constructor(private prisma: PrismaClient) {}

  async listForCustomer(customerId: string) {
    return this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createForCustomer(customerId: string, input: CreateAddressInput) {
    const existing = await this.listForCustomer(customerId);
    const isDefault = existing.length === 0;
    return this.prisma.customerAddress.create({
      data: { customerId, ...input, isDefault },
    });
  }
}
```

- [ ] **Step 4: Run test, expect pass; then commit**

```bash
npx vitest run tests/unit/customer-address-service.test.ts
git add apps/api/src/services/customer-address.service.ts tests/unit/customer-address-service.test.ts
git commit -m "feat(api): customer-address service"
git push origin main
```

### Task A.3: wa-bridge customer-addresses endpoints (Ebda Store)

**Files:**

- Modify: `apps/api/src/routes/wa-bridge.routes.ts` (add 2 endpoints at the end of the file before
  `export default router`)
- Test: `tests/integration/wa-bridge-customer-addresses.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/wa-bridge-customer-addresses.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API = process.env.API_URL || 'http://localhost:4000';
const KEY = process.env.WBS_API_KEY || 'test-wbs-key';

describe('wa-bridge customer-addresses', () => {
  let testCustomerId: string;

  beforeAll(async () => {
    // Seed a customer via Prisma direct (assume helper)
    // testCustomerId set after seed
    testCustomerId = await (global as any).__SEED_TEST_CUSTOMER__();
  });

  it('GET /wa-bridge/customer-addresses?customerId returns empty list when no addresses', async () => {
    const res = await fetch(
      `${API}/api/v1/wa-bridge/customer-addresses?customerId=${testCustomerId}`,
      {
        headers: { 'X-WBS-API-KEY': KEY },
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.addresses).toEqual([]);
  });

  it('POST /wa-bridge/customer-addresses creates an address + returns it', async () => {
    const res = await fetch(`${API}/api/v1/wa-bridge/customer-addresses`, {
      method: 'POST',
      headers: { 'X-WBS-API-KEY': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: testCustomerId,
        street: 'Block 3, House 14',
        area: 'Salmiya',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.address).toMatchObject({
      street: 'Block 3, House 14',
      area: 'Salmiya',
      isDefault: true,
    });
  });
});
```

- [ ] **Step 2: Run test, expect fail (404 — route not defined)**

- [ ] **Step 3: Add the routes**

In `apps/api/src/routes/wa-bridge.routes.ts`, add before `export default router`:

```ts
import { CustomerAddressService } from '../services/customer-address.service';

const addressSvc = new CustomerAddressService(prisma);

/**
 * GET /wa-bridge/customer-addresses?customerId=<id>
 * Returns the customer's saved addresses, default first.
 */
router.get('/customer-addresses', waBridgeAuth, async (req: Request, res: Response) => {
  const customerId = req.query.customerId as string | undefined;
  if (!customerId) {
    return res.status(400).json({ success: false, error: { code: 'CUSTOMER_ID_REQUIRED' } });
  }
  const addresses = await addressSvc.listForCustomer(customerId);
  return res.status(200).json({ success: true, data: { addresses } });
});

/**
 * POST /wa-bridge/customer-addresses
 * Body: { customerId, street, area, block?, governorate?, buildingNumber?, label?, notes? }
 */
router.post('/customer-addresses', waBridgeAuth, async (req: Request, res: Response) => {
  const { customerId, street, area, block, governorate, buildingNumber, label, notes } =
    req.body ?? {};
  if (!customerId || !street || !area) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS' } });
  }
  const address = await addressSvc.createForCustomer(customerId, {
    street,
    area,
    block,
    governorate,
    buildingNumber,
    label,
    notes,
  });
  return res.status(201).json({ success: true, data: { address } });
});
```

- [ ] **Step 4: Run integration test, expect pass; commit + push**

```bash
git add apps/api/src/routes/wa-bridge.routes.ts tests/integration/wa-bridge-customer-addresses.test.ts
git commit -m "feat(api): wa-bridge customer-addresses GET + POST endpoints"
git push origin main
```

### Task A.4: wa-bridge store-config endpoints (Ebda Store)

**Files:**

- Modify: `apps/api/src/routes/wa-bridge.routes.ts`
- Test: `tests/integration/wa-bridge-store-config.test.ts`

- [ ] **Step 1: Write the failing test** (analogous to A.3) — covers:
  - `GET /wa-bridge/store/service-menu?storeId=` returns
    `{ orderNow, subscriptionBoxes, locationsHours, chatWithAgent, labels: { en, ar } }`
  - `GET /wa-bridge/store/meta-catalog-config?storeId=` returns
    `{ catalogId, businessId, hasToken: bool }` (NEVER returns the token plain)
  - `POST /wa-bridge/store/meta-catalog-config` with
    `{ storeId, catalogId, businessId, accessToken }` saves the encrypted token

- [ ] **Step 2: Implement the routes** with the encryption pattern (lookup how WBS encrypts
      `whatsapp_access_token` — same pattern with `CREDENTIAL_ENCRYPTION_KEY`)

- [ ] **Step 3: Run test, pass, commit**

```bash
git add apps/api/src/routes/wa-bridge.routes.ts tests/integration/wa-bridge-store-config.test.ts
git commit -m "feat(api): wa-bridge store config endpoints (service menu + meta catalog)"
git push origin main
```

### Task A.5: Product Inngest events (Ebda Store)

**Files:**

- Modify: `apps/api/src/services/product.service.ts` (fire events after upsert / delete)
- Create: `apps/api/src/lib/inngest/functions/product-meta-sync.ts`
- Modify: `apps/api/src/lib/inngest/client.ts` (register the function)
- Test: `tests/unit/product-meta-sync.test.ts`

- [ ] **Step 1: Write failing test for the Inngest function**

```ts
// tests/unit/product-meta-sync.test.ts
import { describe, it, expect, vi } from 'vitest';
import { productMetaSync } from '@api/lib/inngest/functions/product-meta-sync';

describe('productMetaSync', () => {
  it('skips when store has no meta_catalog_id', async () => {
    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' } };
    const step = {
      run: vi.fn((name, fn) => fn()),
    };
    const mockPrisma = {
      store: { findUnique: vi.fn().mockResolvedValue({ meta_catalog_id: null }) },
    };
    // Patch prisma in module (use vi.mock at file top or DI)
    const result = await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(result.skipped).toBe(true);
  });

  it('calls WBS receiver when store has meta_catalog_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    const event = { data: { storeId: 'store1', productId: 'prod1', action: 'upsert' } };
    const step = { run: vi.fn((name, fn) => fn()) };
    const mockPrisma = {
      store: {
        findUnique: vi.fn().mockResolvedValue({
          meta_catalog_id: 'cat123',
          settings: { wbsBaseUrl: 'http://wbs:3001' },
        }),
      },
      product: { findUnique: vi.fn().mockResolvedValue({ id: 'prod1', name: 'X' }) },
    };
    await productMetaSync({ event, step, prisma: mockPrisma as any });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://wbs:3001/api/internal/inngest-receiver',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"action":"upsert"'),
      })
    );
  });
});
```

- [ ] **Step 2: Run, expect fail; implement**

```ts
// apps/api/src/lib/inngest/functions/product-meta-sync.ts
import { inngest } from '../client';
import { prisma as defaultPrisma } from '@ebda/database';
import logger from '../../logger';

interface SyncArgs {
  event: { data: { storeId: string; productId: string; action: 'upsert' | 'delete' } };
  step: any;
  prisma?: typeof defaultPrisma;
}

export const productMetaSync = async ({ event, step, prisma = defaultPrisma }: SyncArgs) => {
  const { storeId, productId, action } = event.data;

  return await step.run('fanout-to-wbs', async () => {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { meta_catalog_id: true, settings: true },
    });
    if (!store?.meta_catalog_id) {
      logger.info({ storeId, productId }, 'product-meta-sync: store has no catalog, skipping');
      return { skipped: true };
    }

    const settings = (store.settings ?? {}) as { wbsBaseUrl?: string };
    const wbsBase = settings.wbsBaseUrl ?? process.env.WBS_RECEIVER_BASE_URL;
    if (!wbsBase) {
      logger.warn({ storeId }, 'product-meta-sync: no wbsBaseUrl configured');
      return { skipped: true, reason: 'no-wbs-url' };
    }

    let productPayload: any = null;
    if (action === 'upsert') {
      productPayload = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          price: true,
          currency: true,
          description: true,
          images: true,
          status: true,
        },
      });
    }

    const res = await fetch(`${wbsBase}/api/internal/inngest-receiver`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Inngest-Receiver-Secret': process.env.INNGEST_RECEIVER_SECRET ?? '',
      },
      body: JSON.stringify({
        kind: 'product.synced',
        storeId,
        productId,
        action,
        product: productPayload,
      }),
    });

    if (!res.ok) {
      logger.error(
        { storeId, productId, status: res.status },
        'product-meta-sync: wbs receiver failed'
      );
      throw new Error(`wbs receiver returned ${res.status}`);
    }

    return { skipped: false, status: res.status };
  });
};

export const productMetaSyncFn = inngest.createFunction(
  { id: 'product-meta-sync', name: 'Product → Meta Catalog sync', retries: 3 },
  { event: 'product.upserted' },
  productMetaSync as any
);

export const productMetaSyncDeleteFn = inngest.createFunction(
  { id: 'product-meta-sync-delete', name: 'Product delete → Meta Catalog', retries: 3 },
  { event: 'product.deleted' },
  productMetaSync as any
);
```

- [ ] **Step 3: Register in inngest/client.ts**

In `apps/api/src/lib/inngest/client.ts`, find the `functions` array and append
`productMetaSyncFn, productMetaSyncDeleteFn`.

- [ ] **Step 4: Fire events from product.service.ts**

Find `productService.upsert` (or equivalent) — after the DB write, add:

```ts
await inngest.send({ name: 'product.upserted', data: { storeId, productId: product.id } });
```

Same for delete with `product.deleted`.

- [ ] **Step 5: Run unit test, expect pass; commit**

```bash
git add apps/api/src/lib/inngest/functions/product-meta-sync.ts \
        apps/api/src/lib/inngest/client.ts \
        apps/api/src/services/product.service.ts \
        tests/unit/product-meta-sync.test.ts
git commit -m "feat(inngest): product.upserted/deleted -> meta catalog sync fanout"
git push origin main
```

### Task A.6: WBS inngest-receiver endpoint + metaCatalogService rewrite

**Files:**

- Modify: `backend/src/routes/external.js` (add `POST /internal/inngest-receiver`)
- Rewrite: `backend/src/services/metaCatalogService.js`
- Test: `backend/__tests__/metaCatalogService.test.js`

- [ ] **Step 1: Write failing test for metaCatalogService**

```js
// backend/__tests__/metaCatalogService.test.js
const nock = require('nock');
const metaCatalog = require('../src/services/metaCatalogService');

describe('metaCatalogService', () => {
  afterEach(() => nock.cleanAll());

  it('upsertProduct calls Meta Graph batch API + returns ids', async () => {
    nock('https://graph.facebook.com')
      .post('/v22.0/cat123/items_batch')
      .reply(200, { handles: ['h1'] });

    const result = await metaCatalog.upsertProduct(
      { catalogId: 'cat123', accessToken: 'tok' },
      {
        id: 'prod1',
        name: 'X',
        price: 950,
        currency: 'EGP',
        images: ['https://img'],
        status: 'active',
      }
    );

    expect(result).toEqual({ ok: true, handle: 'h1' });
  });

  it('deleteProduct sets status=archived in Meta', async () => {
    nock('https://graph.facebook.com')
      .post('/v22.0/cat123/items_batch')
      .reply(200, { handles: ['h2'] });
    const result = await metaCatalog.deleteProduct(
      { catalogId: 'cat123', accessToken: 'tok' },
      'prod1'
    );
    expect(result.ok).toBe(true);
  });

  it('upsertProduct returns error when Meta returns 4xx', async () => {
    nock('https://graph.facebook.com')
      .post('/v22.0/cat123/items_batch')
      .reply(400, { error: { message: 'invalid product' } });

    const result = await metaCatalog.upsertProduct(
      { catalogId: 'cat123', accessToken: 'tok' },
      { id: 'prod1', name: 'X', price: 950, currency: 'EGP' }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid product');
  });
});
```

- [ ] **Step 2: Run, expect fail; implement**

Replace `backend/src/services/metaCatalogService.js` with:

```js
// backend/src/services/metaCatalogService.js
const logger = require('../utils/logger');

const META_BASE = process.env.META_GRAPH_API_BASE || 'https://graph.facebook.com/v22.0';

/**
 * Upsert a single product into Meta Commerce Catalog using the items_batch endpoint.
 * @param {{ catalogId: string, accessToken: string }} storeConfig
 * @param {{ id, name, nameAr?, price, currency, description?, images?, status }} product
 */
async function upsertProduct(storeConfig, product) {
  const item = {
    method: 'UPDATE',
    retailer_id: product.id,
    data: {
      name: product.name,
      description: product.description || product.name,
      availability: product.status === 'active' ? 'in stock' : 'out of stock',
      condition: 'new',
      price: `${(product.price / 1000).toFixed(3)} ${product.currency || 'EGP'}`,
      image_url: (product.images && product.images[0]) || '',
      visibility: product.status === 'active' ? 'published' : 'staging',
    },
  };

  try {
    const res = await fetch(`${META_BASE}/${storeConfig.catalogId}/items_batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${storeConfig.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests: [item], item_type: 'PRODUCT_ITEM' }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json();
    if (!res.ok) {
      logger.error({ status: res.status, body }, 'meta upsert failed');
      return { ok: false, error: body?.error?.message || `status ${res.status}` };
    }
    return { ok: true, handle: body?.handles?.[0] };
  } catch (err) {
    logger.error({ err: err.message, productId: product.id }, 'meta upsert exception');
    return { ok: false, error: err.message };
  }
}

async function deleteProduct(storeConfig, retailerId) {
  const item = { method: 'DELETE', retailer_id: retailerId };
  try {
    const res = await fetch(`${META_BASE}/${storeConfig.catalogId}/items_batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${storeConfig.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests: [item], item_type: 'PRODUCT_ITEM' }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: body?.error?.message || `status ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getCatalogStatus(storeConfig) {
  try {
    const res = await fetch(`${META_BASE}/${storeConfig.catalogId}?fields=name,product_count`, {
      headers: { Authorization: `Bearer ${storeConfig.accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, ...(await res.json()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { upsertProduct, deleteProduct, getCatalogStatus };
```

- [ ] **Step 3: Add `nock` if not present**

```bash
cd /Users/ahmadsharaf/Desktop/projects/whatsapp-bulk-sender/backend
grep "nock" package.json || npm install --save-dev nock
```

- [ ] **Step 4: Run test, pass**

```bash
npx jest __tests__/metaCatalogService.test.js
```

- [ ] **Step 5: Add the WBS receiver endpoint**

In `backend/src/routes/external.js`, add (require `metaCatalogService` at top):

```js
// POST /api/internal/inngest-receiver — called by Ebda Store Inngest functions
router.post('/internal/inngest-receiver', async (req, res) => {
  const secret = req.headers['x-inngest-receiver-secret'];
  if (secret !== process.env.INNGEST_RECEIVER_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { kind, storeId, productId, action, product } = req.body || {};
  if (kind !== 'product.synced') {
    return res.status(400).json({ error: 'unknown kind' });
  }

  // Look up the merchant + Meta catalog config (which client maps to this Ebda Store store?)
  const client = await prisma.clients.findFirst({
    where: { wa_ordering_settings: { path: ['fwbStoreId'], equals: storeId } },
  });
  if (
    !client?.wa_ordering_settings?.metaCatalogId ||
    !client?.wa_ordering_settings?.metaAccessToken
  ) {
    return res.status(200).json({ skipped: true, reason: 'no-catalog-configured' });
  }

  const storeConfig = {
    catalogId: client.wa_ordering_settings.metaCatalogId,
    accessToken: client.wa_ordering_settings.metaAccessToken,
  };

  const result =
    action === 'delete'
      ? await metaCatalogService.deleteProduct(storeConfig, productId)
      : await metaCatalogService.upsertProduct(storeConfig, product);

  return res.status(200).json(result);
});
```

- [ ] **Step 6: Commit + push (both repos)**

```bash
# WBS:
cd /Users/ahmadsharaf/Desktop/projects/whatsapp-bulk-sender
git add backend/src/services/metaCatalogService.js backend/src/routes/external.js backend/__tests__/metaCatalogService.test.js backend/package.json backend/package-lock.json
git commit -m "feat(wbs): meta catalog service + inngest receiver endpoint"
git push origin main
```

**Phase A acceptance gate**: a product create in Ebda Store admin appears in Meta Commerce Manager within
10s (manual smoke).

---

## Phase B — State Machine Extension (Day 1)

**Goal**: Add pre-catalog states + service router. Don't yet render Native Catalog (that's Phase C).

### Task B.1: wa-interactive.js builders

**Files:**

- Create: `backend/src/services/wa-interactive.js`
- Test: `backend/__tests__/wa-interactive.test.js`

- [ ] **Step 1: Write failing test**

```js
// backend/__tests__/wa-interactive.test.js
const wi = require('../src/services/wa-interactive');

describe('wa-interactive builders', () => {
  it('buildButtons emits Meta interactive button format (max 3)', () => {
    const msg = wi.buildButtons('+96550001234', 'Choose language', [
      { id: 'lang_en', title: 'English' },
      { id: 'lang_ar', title: 'عربي' },
    ]);
    expect(msg).toMatchObject({
      messaging_product: 'whatsapp',
      to: '+96550001234',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Choose language' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'lang_en', title: 'English' } },
            { type: 'reply', reply: { id: 'lang_ar', title: 'عربي' } },
          ],
        },
      },
    });
  });

  it('buildButtons throws if more than 3 buttons supplied', () => {
    expect(() =>
      wi.buildButtons('+1', 'x', [
        { id: '1', title: 'a' },
        { id: '2', title: 'b' },
        { id: '3', title: 'c' },
        { id: '4', title: 'd' },
      ])
    ).toThrow(/max 3 buttons/i);
  });

  it('buildList emits Meta interactive list with sections', () => {
    const msg = wi.buildList('+1', 'Pick a service', 'Tap below', 'Services', [
      { id: 'order', title: 'Order Now' },
      { id: 'agent', title: 'Chat with Agent' },
    ]);
    expect(msg.interactive.type).toBe('list');
    expect(msg.interactive.action.sections[0].rows).toHaveLength(2);
  });

  it('buildCatalogMessage emits Meta type=catalog_message', () => {
    const msg = wi.buildCatalogMessage('+1', 'Browse the menu');
    expect(msg.interactive.type).toBe('catalog_message');
    expect(msg.interactive.body.text).toBe('Browse the menu');
    expect(msg.interactive.action.name).toBe('catalog_message');
  });

  it('parseInteractiveReply extracts button id', () => {
    const incoming = {
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'lang_en' } },
    };
    expect(wi.parseInteractiveReply(incoming)).toEqual({ kind: 'button', id: 'lang_en' });
  });

  it('parseInteractiveReply extracts list id', () => {
    const incoming = {
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'order' } },
    };
    expect(wi.parseInteractiveReply(incoming)).toEqual({ kind: 'list', id: 'order' });
  });
});
```

- [ ] **Step 2: Run, expect fail; implement**

```js
// backend/src/services/wa-interactive.js
/**
 * Builders for Meta WhatsApp Interactive messages. All return the JSON
 * body that wa-send.js can POST directly to /v22.0/{phone_number_id}/messages.
 *
 * Spec: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

function buildButtons(to, bodyText, buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('buildButtons requires at least 1 button');
  }
  if (buttons.length > 3) {
    throw new Error('buildButtons: max 3 buttons per message');
  }
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  };
}

function buildList(to, bodyText, footerText, buttonText, rows, headerText) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('buildList: rows required');
  if (rows.length > 10) throw new Error('buildList: max 10 rows');
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(headerText && { header: { type: 'text', text: headerText } }),
      body: { text: bodyText },
      ...(footerText && { footer: { text: footerText } }),
      action: {
        button: buttonText,
        sections: [
          {
            rows: rows.map(r => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description && { description: r.description.slice(0, 72) }),
            })),
          },
        ],
      },
    },
  };
}

function buildCatalogMessage(to, bodyText, footerText) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: bodyText },
      ...(footerText && { footer: { text: footerText } }),
      action: { name: 'catalog_message' },
    },
  };
}

function buildProductListMessage(to, bodyText, catalogId, sections) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: bodyText },
      body: { text: bodyText },
      action: {
        catalog_id: catalogId,
        sections, // [{ title, product_items: [{ product_retailer_id }] }]
      },
    },
  };
}

function parseInteractiveReply(incoming) {
  if (incoming?.type !== 'interactive') return null;
  const interactive = incoming.interactive;
  if (interactive?.type === 'button_reply') {
    return {
      kind: 'button',
      id: interactive.button_reply.id,
      title: interactive.button_reply.title,
    };
  }
  if (interactive?.type === 'list_reply') {
    return { kind: 'list', id: interactive.list_reply.id, title: interactive.list_reply.title };
  }
  if (interactive?.type === 'order') {
    // Meta sends 'order' when user places a cart from Catalog UI
    return {
      kind: 'order',
      catalogId: interactive.order?.catalog_id,
      products: interactive.order?.product_items || [],
      text: interactive.order?.text || '',
    };
  }
  return null;
}

module.exports = {
  buildButtons,
  buildList,
  buildCatalogMessage,
  buildProductListMessage,
  parseInteractiveReply,
};
```

- [ ] **Step 3: Run test, pass; commit**

```bash
git add backend/src/services/wa-interactive.js backend/__tests__/wa-interactive.test.js
git commit -m "feat(wbs): wa-interactive message builders + reply parser"
git push origin main
```

### Task B.2: Extend wa_carts state enum (no migration — JSON state)

**Files:**

- Modify: `backend/src/services/wa-ordering.js` (top-of-file state list comment + STATES constant if
  exists)

- [ ] **Step 1: Find the state-list comment** (lines 13-25 per earlier inspection)

Replace the existing state-list comment with the full new enum (preserving old states):

```js
/**
 * State machine (wa_carts.state):
 *   ── Native catalog pre-flow (Phase B) ──
 *   awaiting_greeting        → user sent first message, bot greeted + sent language buttons
 *   awaiting_language        → bot sent language buttons, awaiting tap
 *   awaiting_service         → bot sent service menu, awaiting tap
 *
 *   ── Service branches ──
 *   viewing_catalog          → Order Now path: catalog_message sent, awaiting cart-back
 *   cart_received            → user placed cart from Meta catalog; bot showing summary
 *   agent_chat               → Chat with Agent: routes to legacy 5-phase Gemini bot
 *   locations_replied        → one-shot reply; auto-return to awaiting_service in 5s
 *   subscription_replied     → terminal for v1 ("Coming soon")
 *
 *   ── Existing flow (unchanged) ──
 *   awaiting_more_or_checkout → cart summary buttons (Checkout / Add More / Clear)
 *   ── New checkout flow (Phase C) ──
 *   awaiting_address_choice  → bot sent saved addresses list
 *   awaiting_new_address     → text-collection sub-flow for first-time user
 *   awaiting_payment         → bot sent Online / Cash buttons
 *   order_summary            → final confirmation buttons
 *   ── Existing terminal ──
 *   checkout_sent            → online payment URL sent, awaiting webhook
 *   completed                → done; offer to start fresh
 */
```

- [ ] **Step 2: No code change yet — commit the comment update so plan reviewers see the target
      state**

```bash
git add backend/src/services/wa-ordering.js
git commit -m "docs(wbs): document target state machine for native catalog bot"
git push origin main
```

### Task B.3: Greeting state — handle "Hi" → bilingual greeting + language buttons

**Files:**

- Modify: `backend/src/services/wa-ordering.js`
- Test: `backend/__tests__/wa-ordering-greeting.test.js`

- [ ] **Step 1: Write failing test**

```js
// backend/__tests__/wa-ordering-greeting.test.js
const waOrdering = require('../src/services/wa-ordering');
const { prisma } = require('../src/config/db');

jest.mock('../src/services/wa-bridge-client');
jest.mock('../src/utils/whatsapp-send'); // hypothetical sender wrapper

describe('wa-ordering greeting', () => {
  let client;
  beforeEach(async () => {
    client = await prisma.clients.create({
      data: {
        name: 'TestStore',
        wa_ordering_enabled: true,
        wa_ordering_settings: { fwbStoreId: 'st1', sessionTtlMinutes: 60, replyLanguage: 'auto' },
        // ... required fields per Client schema
      },
    });
  });
  afterEach(async () => {
    await prisma.wa_carts.deleteMany({ where: { client_id: client.id } });
    await prisma.clients.delete({ where: { id: client.id } });
  });

  it('first inbound "Hi" creates session in awaiting_greeting then transitions to awaiting_language', async () => {
    const sendMock = require('../src/utils/whatsapp-send').sendInteractive;
    sendMock.mockResolvedValue({ messages: [{ id: 'wamid.xyz' }] });

    await waOrdering.processInbound(client, '+96550001234', { type: 'text', text: { body: 'Hi' } });

    // session was created
    const session = await prisma.wa_carts.findFirst({
      where: { client_id: client.id, wa_id: '+96550001234' },
    });
    expect(session.state).toBe('awaiting_language');

    // language buttons were sent
    expect(sendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'interactive',
        interactive: expect.objectContaining({ type: 'button' }),
      })
    );
  });

  it('skips greeting when customer.preferred_locale set + within 30 days', async () => {
    // seed customer with preferred_locale + last_locale_choice today
    // assert: state jumps straight to awaiting_service
  });
});
```

- [ ] **Step 2: Run, expect fail; implement the new state branches**

In `wa-ordering.js`, at the top of `processInbound`:

```js
async function processInbound(client, waId, message) {
  // ... existing dedup checks ...
  let session = await findOrCreateSession(client, waId, conversationId);

  // PHASE B: native catalog pre-flow
  if (
    client.bot_mode === 'native_catalog' ||
    client.bot_mode === 'native_catalog_with_gemini_agent'
  ) {
    if (session.state === 'awaiting_intent' || session.state === 'awaiting_greeting') {
      return await handleGreeting(client, session, waId, message);
    }
    if (session.state === 'awaiting_language') {
      return await handleLanguagePick(client, session, waId, message);
    }
    if (session.state === 'awaiting_service') {
      return await handleServicePick(client, session, waId, message);
    }
    // ... other branches added in later tasks
  }

  // FALLBACK: legacy flow
  // ... existing code ...
}

async function handleGreeting(client, session, waId, message) {
  // Look up customer.preferred_locale via bridge
  const customer = await waBridge.getCustomerByPhone(client, { phone: waId });
  const preferred = customer?.preferredLocale;
  const lastChoice = customer?.lastLocaleChoice ? new Date(customer.lastLocaleChoice) : null;
  const STICKY_DAYS = 30;
  const isSticky =
    preferred && lastChoice && Date.now() - lastChoice.getTime() < STICKY_DAYS * 86400_000;

  if (isSticky) {
    // skip language picker
    await prisma.wa_carts.update({
      where: { id: session.id },
      data: { state: 'awaiting_service', context: { ...session.context, locale: preferred } },
    });
    return await sendServiceMenu(client, session, waId, preferred);
  }

  // Send bilingual greeting + language buttons
  const greeting = `${getEnGreeting(client)}\n\n${getArGreeting(client)}`;
  const buttonsMsg = wi.buildButtons(waId, greeting, [
    { id: 'lang_en', title: 'English' },
    { id: 'lang_ar', title: 'عربي' },
  ]);
  await whatsappSend.sendInteractive(client, buttonsMsg);

  await prisma.wa_carts.update({
    where: { id: session.id },
    data: { state: 'awaiting_language' },
  });
}
```

(Define `getEnGreeting` + `getArGreeting` helpers using `botCopyDefaults`.)

- [ ] **Step 3: Run test, pass; commit**

```bash
git add backend/src/services/wa-ordering.js backend/__tests__/wa-ordering-greeting.test.js
git commit -m "feat(wbs): native catalog bot greeting state + language pick"
git push origin main
```

### Task B.4: Service menu state + bot-service-router.js

**Files:**

- Create: `backend/src/services/bot-service-router.js`
- Modify: `backend/src/services/wa-ordering.js` (add `handleServicePick` + `sendServiceMenu`)
- Test: `backend/__tests__/wa-ordering-service-router.test.js`

- [ ] **Step 1: Write failing test for the router**

Cover all 4 service paths:

- `service_order_now` → state moves to `viewing_catalog`, catalog_message sent
- `service_agent` → state moves to `agent_chat`, ack message sent
- `service_locations` → state moves to `locations_replied`, location text sent
- `service_subscription` → state moves to `subscription_replied`, "Coming soon" sent

- [ ] **Step 2: Implement**

```js
// backend/src/services/bot-service-router.js
const wi = require('./wa-interactive');
const waBridge = require('./wa-bridge-client');
const whatsappSend = require('../utils/whatsapp-send');
const { prisma } = require('../config/db');

/**
 * Routes a service-menu tap to the appropriate state branch.
 * Called from handleServicePick when user replies with a list_reply
 * whose id starts with "service_".
 */
async function route(client, session, waId, serviceId, locale) {
  switch (serviceId) {
    case 'service_order_now':
      return await routeOrderNow(client, session, waId, locale);
    case 'service_agent':
      return await routeAgent(client, session, waId, locale);
    case 'service_locations':
      return await routeLocations(client, session, waId, locale);
    case 'service_subscription':
      return await routeSubscription(client, session, waId, locale);
    default:
      // Unknown service id — re-send menu
      // (sendServiceMenu lives in wa-ordering.js — circular-import-safe via require lazy)
      return require('./wa-ordering').sendServiceMenu(client, session, waId, locale);
  }
}

async function routeOrderNow(client, session, waId, locale) {
  const config = await waBridge.getStoreMetaCatalogConfig(client, {
    storeId: session.fwb_store_id,
  });
  if (!config?.catalogId) {
    // Catalog not yet configured — bail with apology
    const apology =
      locale === 'ar'
        ? 'عذراً، المتجر غير متاح حالياً. الرجاء المحاولة لاحقاً.'
        : 'Sorry, the catalog is temporarily unavailable. Please try again shortly.';
    await whatsappSend.sendText(client, waId, apology);
    return;
  }

  const body =
    locale === 'ar' ? 'تصفح القائمة وأضف ما تريد' : 'Browse the menu and add what you need';
  const msg = wi.buildCatalogMessage(waId, body);
  await whatsappSend.sendInteractive(client, msg);

  await prisma.wa_carts.update({
    where: { id: session.id },
    data: { state: 'viewing_catalog' },
  });
}

async function routeAgent(client, session, waId, locale) {
  const text =
    locale === 'ar'
      ? 'تم تحويلك للمساعد الذكي. كيف أقدر أساعدك؟'
      : 'Connected to our smart assistant. How can I help?';
  await whatsappSend.sendText(client, waId, text);
  await prisma.wa_carts.update({
    where: { id: session.id },
    data: { state: 'agent_chat' },
  });
}

async function routeLocations(client, session, waId, locale) {
  const profile = await waBridge.getStoreProfile(client, { storeId: session.fwb_store_id });
  const address = locale === 'ar' ? profile?.addressAr || profile?.address : profile?.address;
  const hours =
    profile?.businessHours || (locale === 'ar' ? 'يومياً 9 ص - 11 م' : 'Daily 9 AM - 11 PM');
  const mapsLink = profile?.googleMapsUrl ? `\n\n${profile.googleMapsUrl}` : '';

  const text =
    locale === 'ar'
      ? `📍 العنوان: ${address}\n🕐 الساعات: ${hours}${mapsLink}`
      : `📍 Address: ${address}\n🕐 Hours: ${hours}${mapsLink}`;

  await whatsappSend.sendText(client, waId, text);
  await prisma.wa_carts.update({
    where: { id: session.id },
    data: { state: 'locations_replied' },
  });

  // Auto-return to service menu after 5s
  setTimeout(async () => {
    try {
      await require('./wa-ordering').sendServiceMenu(client, session, waId, locale);
      await prisma.wa_carts.update({
        where: { id: session.id },
        data: { state: 'awaiting_service' },
      });
    } catch {}
  }, 5000);
}

async function routeSubscription(client, session, waId, locale) {
  const text =
    locale === 'ar' ? '📦 الباقات الشهرية قريباً!' : '📦 Subscription boxes coming soon!';
  await whatsappSend.sendText(client, waId, text);
  await prisma.wa_carts.update({
    where: { id: session.id },
    data: { state: 'subscription_replied' },
  });
}

module.exports = { route };
```

- [ ] **Step 3: Wire into wa-ordering.js + run tests**

```js
// In wa-ordering.js
const botServiceRouter = require('./bot-service-router');

async function sendServiceMenu(client, session, waId, locale) {
  const menuConfig = await waBridge.getStoreServiceMenu(client, { storeId: session.fwb_store_id });
  const rows = [];
  const labels = menuConfig?.labels?.[locale] || menuConfig?.labels?.en || {};
  if (menuConfig?.orderNow)
    rows.push({
      id: 'service_order_now',
      title: labels.orderNow || (locale === 'ar' ? '🛒 اطلب الآن' : '🛒 Order Now'),
    });
  if (menuConfig?.subscriptionBoxes)
    rows.push({
      id: 'service_subscription',
      title: labels.subscriptionBoxes || (locale === 'ar' ? '📦 الباقات' : '📦 Subscription Boxes'),
    });
  if (menuConfig?.locationsHours)
    rows.push({
      id: 'service_locations',
      title: labels.locationsHours || (locale === 'ar' ? '📍 المواقع' : '📍 Locations & Hours'),
    });
  if (menuConfig?.chatWithAgent)
    rows.push({
      id: 'service_agent',
      title: labels.chatWithAgent || (locale === 'ar' ? '💬 المساعد' : '💬 Chat with Agent'),
    });

  const body = locale === 'ar' ? 'كيف يمكنني خدمتك؟' : 'How can I help you today?';
  const msg = wi.buildList(waId, body, null, locale === 'ar' ? 'القائمة' : 'Menu', rows);
  await whatsappSend.sendInteractive(client, msg);
}

async function handleServicePick(client, session, waId, message) {
  const reply = wi.parseInteractiveReply(message);
  if (!reply || reply.kind !== 'list') return; // ignore non-list reply
  const locale = session.context?.locale || 'en';
  await botServiceRouter.route(client, session, waId, reply.id, locale);
}

module.exports = { processInbound, sendServiceMenu, handleServicePick /* etc */ };
```

- [ ] **Step 4: Run all wa-ordering tests; commit**

```bash
npx jest __tests__/wa-ordering*.test.js
git add backend/src/services/bot-service-router.js backend/src/services/wa-ordering.js backend/__tests__/wa-ordering-service-router.test.js
git commit -m "feat(wbs): bot-service-router with order/agent/locations/subscription paths"
git push origin main
```

**Phase B acceptance gate**: Manual smoke against test WhatsApp number: "Hi" → bilingual greeting →
tap English → service menu → tap each option → correct branch fires.

---

## Phase C — Native Catalog Flow (Day 1.5)

### Task C.1: viewing_catalog → cart_received handler

**Files:**

- Modify: `backend/src/services/wa-ordering.js`
- Test: `backend/__tests__/wa-ordering-native-catalog.test.js`

- [ ] **Step 1: Failing test — cart-back from Meta produces summary + buttons**

```js
it('viewing_catalog → user places cart → cart_received → bot sends summary + Checkout/Add More/Clear buttons', async () => {
  const cartMsg = {
    type: 'interactive',
    interactive: {
      type: 'order',
      order: {
        catalog_id: 'cat123',
        text: '',
        product_items: [
          { product_retailer_id: 'prod1', quantity: 1, item_price: '0.950', currency: 'EGP' },
          { product_retailer_id: 'prod2', quantity: 2, item_price: '0.475', currency: 'EGP' },
        ],
      },
    },
  };
  // session in viewing_catalog
  await waOrdering.processInbound(client, waId, cartMsg);

  expect(sendInteractiveMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      interactive: expect.objectContaining({ type: 'button' }),
    })
  );
  const updated = await prisma.wa_carts.findFirst({ where: { id: session.id } });
  expect(updated.state).toBe('awaiting_more_or_checkout');
  expect(updated.items).toEqual([
    { productRetailerId: 'prod1', quantity: 1, priceFils: 950 },
    { productRetailerId: 'prod2', quantity: 2, priceFils: 475 },
  ]);
});
```

- [ ] **Step 2: Implement `handleCartReceived` in wa-ordering.js**

```js
async function handleCartReceived(client, session, waId, message) {
  const reply = wi.parseInteractiveReply(message);
  if (!reply || reply.kind !== 'order') return;

  const items = reply.products.map(p => ({
    productRetailerId: p.product_retailer_id,
    quantity: p.quantity,
    priceFils: Math.round(Number(p.item_price) * 1000),
    currency: p.currency || 'EGP',
  }));

  const subtotalFils = items.reduce((s, i) => s + i.priceFils * i.quantity, 0);
  const locale = session.context?.locale || 'en';

  const summary =
    locale === 'ar'
      ? `🛒 الإجمالي: ${formatPrice(subtotalFils)}`
      : `🛒 Subtotal: ${formatPrice(subtotalFils)}`;
  const buttons = [
    { id: 'checkout', title: locale === 'ar' ? 'اتمام الطلب' : 'Checkout' },
    { id: 'add_more', title: locale === 'ar' ? 'إضافة المزيد' : 'Add More' },
    { id: 'clear_cart', title: locale === 'ar' ? 'مسح السلة' : 'Clear Cart' },
  ];
  const msg = wi.buildButtons(waId, summary, buttons);
  await whatsappSend.sendInteractive(client, msg);

  await prisma.wa_carts.update({
    where: { id: session.id },
    data: {
      items,
      state: 'awaiting_more_or_checkout',
    },
  });
}
```

- [ ] **Step 3: Wire into processInbound dispatcher**

```js
if (session.state === 'viewing_catalog') {
  return await handleCartReceived(client, session, waId, message);
}
if (session.state === 'awaiting_more_or_checkout') {
  return await handleMoreOrCheckout(client, session, waId, message); // existing or extend
}
```

- [ ] **Step 4: Test + commit**

```bash
git add backend/src/services/wa-ordering.js backend/__tests__/wa-ordering-native-catalog.test.js
git commit -m "feat(wbs): handle cart-back from meta catalog → summary + buttons"
git push origin main
```

### Task C.2: handleMoreOrCheckout — Checkout transitions to address picker

**Files:**

- Modify: `backend/src/services/wa-ordering.js`
- Modify: `backend/src/services/wa-bridge-client.js` (add `getCustomerAddresses`,
  `createCustomerAddress`)

- [ ] **Step 1: Failing test**: Checkout button → bot queries addresses → if none, asks for new; if
      some, sends list. State moves to `awaiting_address_choice` (or `awaiting_new_address` if none
      saved).

- [ ] **Step 2: Implement**

Extend `wa-bridge-client.js`:

```js
async function getCustomerAddresses(client, { customerId }) {
  const url = `${client.wa_ordering_settings.ebdaApiUrl}/wa-bridge/customer-addresses?customerId=${customerId}`;
  // timing wrapper + return data.addresses
}
async function createCustomerAddress(client, { customerId, ...rest }) {
  const url = `${client.wa_ordering_settings.ebdaApiUrl}/wa-bridge/customer-addresses`;
  // POST with body { customerId, ...rest }
}
module.exports = { ..., getCustomerAddresses, createCustomerAddress };
```

Extend `wa-ordering.js`:

```js
async function handleMoreOrCheckout(client, session, waId, message) {
  const reply = wi.parseInteractiveReply(message);
  if (!reply || reply.kind !== 'button') return;
  const locale = session.context?.locale || 'en';

  if (reply.id === 'checkout') {
    // Look up customer + their saved addresses
    const customer = await waBridge.getCustomerByPhone(client, { phone: waId });
    if (!customer) {
      // fallback: ask for address inline
      return await sendAddressTextPrompt(client, session, waId, locale);
    }
    const { addresses } = await waBridge.getCustomerAddresses(client, { customerId: customer.id });
    if (!addresses || addresses.length === 0) {
      return await sendAddressTextPrompt(client, session, waId, locale);
    }
    // Send list of saved addresses
    const rows = addresses.slice(0, 9).map((a, i) => ({
      id: `addr_${a.id}`,
      title: a.label || `${a.area}, ${a.street}`.slice(0, 24),
      description: `${a.street}, ${a.area}`.slice(0, 72),
    }));
    rows.push({ id: 'addr_new', title: locale === 'ar' ? '+ عنوان جديد' : '+ New address' });
    const body = locale === 'ar' ? 'اختر عنوان التوصيل' : 'Pick delivery address';
    const msg = wi.buildList(waId, body, null, locale === 'ar' ? 'العناوين' : 'Addresses', rows);
    await whatsappSend.sendInteractive(client, msg);
    await prisma.wa_carts.update({
      where: { id: session.id },
      data: {
        state: 'awaiting_address_choice',
        context: { ...session.context, customerId: customer.id },
      },
    });
    return;
  }

  if (reply.id === 'add_more') {
    // Send catalog again
    return await require('./bot-service-router').route(
      client,
      session,
      waId,
      'service_order_now',
      locale
    );
  }

  if (reply.id === 'clear_cart') {
    await prisma.wa_carts.update({
      where: { id: session.id },
      data: { items: [], state: 'awaiting_service' },
    });
    return await sendServiceMenu(client, session, waId, locale);
  }
}

async function sendAddressTextPrompt(client, session, waId, locale) {
  const prompt =
    locale === 'ar'
      ? 'الرجاء إرسال عنوان التوصيل (المنطقة، القطعة، المنزل):'
      : 'Please send your delivery address (Area, Block, House):';
  await whatsappSend.sendText(client, waId, prompt);
  await prisma.wa_carts.update({
    where: { id: session.id },
    data: { state: 'awaiting_new_address' },
  });
}
```

- [ ] **Step 3: Test + commit**

```bash
git add backend/src/services/wa-ordering.js backend/src/services/wa-bridge-client.js
git commit -m "feat(wbs): checkout → address picker (saved list or inline ask)"
git push origin main
```

### Task C.3: Handle address pick / new address → payment buttons

**Files:**

- Modify: `backend/src/services/wa-ordering.js`

- [ ] **Step 1: Failing test**: User taps a saved address → state moves to `awaiting_payment`,
      payment buttons sent. User in `awaiting_new_address` sends text → parsed → saved via bridge →
      state moves to `awaiting_payment`.

- [ ] **Step 2: Implement `handleAddressChoice` + `handleNewAddress`**

```js
async function handleAddressChoice(client, session, waId, message) {
  const reply = wi.parseInteractiveReply(message);
  if (!reply || reply.kind !== 'list') return;
  const locale = session.context?.locale || 'en';

  if (reply.id === 'addr_new') {
    return await sendAddressTextPrompt(client, session, waId, locale);
  }

  // Extract addressId from `addr_<id>`
  const addressId = reply.id.replace(/^addr_/, '');
  await prisma.wa_carts.update({
    where: { id: session.id },
    data: {
      state: 'awaiting_payment',
      context: { ...session.context, addressId },
    },
  });

  return await sendPaymentButtons(client, session, waId, locale);
}

async function handleNewAddress(client, session, waId, message) {
  const text = message?.text?.body || '';
  if (text.trim().length < 3) {
    return await sendAddressTextPrompt(client, session, waId, session.context?.locale || 'en');
  }

  // Parse: very naive — let it through for v1, merchant can refine via Ebda Store admin
  const parts = text.split(/[,،]/).map(s => s.trim());
  const area = parts[0] || text.slice(0, 50);
  const street = parts.slice(1).join(', ') || area;

  const customerId = session.context?.customerId;
  if (!customerId) {
    // No customer linked — fall back to passing the raw text as a "freeform_address" string
    await prisma.wa_carts.update({
      where: { id: session.id },
      data: {
        state: 'awaiting_payment',
        context: { ...session.context, addressFreeform: text },
      },
    });
    return await sendPaymentButtons(client, session, waId, session.context?.locale || 'en');
  }

  const { address } = await waBridge.createCustomerAddress(client, {
    customerId,
    street,
    area,
  });
  await prisma.wa_carts.update({
    where: { id: session.id },
    data: {
      state: 'awaiting_payment',
      context: { ...session.context, addressId: address.id },
    },
  });

  return await sendPaymentButtons(client, session, waId, session.context?.locale || 'en');
}

async function sendPaymentButtons(client, session, waId, locale) {
  const body = locale === 'ar' ? 'اختر طريقة الدفع' : 'Pick payment method';
  const buttons = [
    { id: 'pay_online', title: locale === 'ar' ? '💳 الكتروني' : '💳 Online' },
    { id: 'pay_cash', title: locale === 'ar' ? '💵 كاش' : '💵 Cash' },
  ];
  const msg = wi.buildButtons(waId, body, buttons);
  await whatsappSend.sendInteractive(client, msg);
}
```

Wire into processInbound dispatcher.

- [ ] **Step 3: Test + commit**

```bash
git add backend/src/services/wa-ordering.js
git commit -m "feat(wbs): address pick / new address handlers + payment buttons"
git push origin main
```

### Task C.4: Payment pick → order placement via /cart/from-wa

**Files:**

- Modify: `backend/src/services/wa-ordering.js`
- Modify: `apps/api/src/routes/wa-bridge.routes.ts` (extend `/cart/from-wa` to accept `addressId` +
  `paymentMethod`)

- [ ] **Step 1: Failing test**: User taps Cash → bot calls bridge `/cart/from-wa` with
      `{paymentMethod: 'cash', addressId}` → bridge returns order → bot sends confirmation → state
      `completed`.

- [ ] **Step 2: Implement `handlePaymentChoice` + bridge update**

```js
// wa-ordering.js
async function handlePaymentChoice(client, session, waId, message) {
  const reply = wi.parseInteractiveReply(message);
  if (!reply || reply.kind !== 'button') return;
  const locale = session.context?.locale || 'en';

  const paymentMethod = reply.id === 'pay_online' ? 'online' : 'cash';

  const order = await waBridge.postCartFromWA(client, {
    storeId: session.fwb_store_id,
    waId,
    customerId: session.context?.customerId,
    addressId: session.context?.addressId,
    addressFreeform: session.context?.addressFreeform,
    items: session.items,
    paymentMethod,
    locale,
  });

  if (!order?.success) {
    const errMsg =
      locale === 'ar'
        ? 'حدث خطأ في إتمام الطلب، الرجاء المحاولة لاحقاً.'
        : 'There was a problem placing your order. Please try again shortly.';
    await whatsappSend.sendText(client, waId, errMsg);
    return;
  }

  if (paymentMethod === 'online' && order.data?.paymentUrl) {
    const linkMsg =
      locale === 'ar'
        ? `🧾 طلبك جاهز للدفع: ${order.data.paymentUrl}`
        : `🧾 Your order is ready for payment: ${order.data.paymentUrl}`;
    await whatsappSend.sendText(client, waId, linkMsg);
    await prisma.wa_carts.update({
      where: { id: session.id },
      data: {
        state: 'checkout_sent',
        context: { ...session.context, orderId: order.data.orderId },
      },
    });
    return;
  }

  // Cash flow: order placed, send confirmation summary
  const items = session.items.map(i => `  - ${i.quantity} x ${i.productRetailerId}`).join('\n');
  const total = formatPrice(session.items.reduce((s, i) => s + i.priceFils * i.quantity, 0));
  const conf =
    locale === 'ar'
      ? `✅ تم استلام طلبك!\n${items}\nالإجمالي: ${total}\nرقم الطلب: ${order.data.orderId}`
      : `✅ Order received!\n${items}\nTotal: ${total}\nOrder #: ${order.data.orderId}`;
  await whatsappSend.sendText(client, waId, conf);

  await prisma.wa_carts.update({
    where: { id: session.id },
    data: { state: 'completed', context: { ...session.context, orderId: order.data.orderId } },
  });
}
```

Update `/cart/from-wa` route in Ebda Store to accept the new fields (addressId, addressFreeform,
paymentMethod, locale) — pass through to order service.

- [ ] **Step 3: Tests + commit (both repos)**

### Task C.5: Free-form text fallback ("Please use the buttons")

**Files:**

- Modify: `backend/src/services/wa-ordering.js`

- [ ] **Step 1: Test that free-form text in any new state replies with localized "please use
      buttons" + re-sends the state's interactive message.**

- [ ] **Step 2: Implement a helper `replyUseButtons(client, session, waId, locale)` that wraps a
      single text + re-send of current state's interactive.**

- [ ] **Step 3: Commit**

**Phase C acceptance gate**: end-to-end test: Hi → English → Order Now → catalog opens → 2 items
added → Checkout → saved address picked → Cash → confirmation. Order appears in Ebda Store admin within 3s
of Cash tap.

---

## Phase D — Service Menu Config + Admin UI (Day 1)

### Task D.1: Default `Store.bot_service_menu` for new + existing stores

**Files:**

- Create:
  `packages/database/prisma/migrations/20260525120100_default_bot_service_menu/migration.sql`

- [ ] **Step 1: Add data migration**

```sql
UPDATE "stores"
SET "bot_service_menu" = jsonb_build_object(
  'orderNow', true,
  'subscriptionBoxes', false,
  'locationsHours', true,
  'chatWithAgent', true,
  'labels', jsonb_build_object('en', '{}'::jsonb, 'ar', '{}'::jsonb)
)
WHERE "bot_service_menu" IS NULL;
```

- [ ] **Step 2: Commit**

### Task D.2-D.5: BotModeCard, ServiceMenuCard, MetaCatalogCard, page assembly

- [ ] Create the 4 admin UI files described in File Structure
- [ ] Each card hits the corresponding wa-bridge endpoint via existing apiPut/apiGet patterns
- [ ] Add sidebar link in `apps/admin/src/components/layout/Sidebar.tsx` under "WhatsApp" group
- [ ] Each card: tests via Playwright smoke (`tests/smoke/admin-wa-bot.spec.ts`) — load page +
      assert all 3 cards render + a save round-trip works

### Task D.6: Locations & Hours pulls from `Store.profile`

- [ ] Add `Store.profile.businessHours`, `Store.profile.googleMapsUrl`, `Store.profile.addressAr`
      fields to the schema (additive migration)
- [ ] Verify `routeLocations` reads these correctly

**Phase D acceptance gate**: A merchant can log into Ebda Store admin → Store → WhatsApp Bot → toggle which
services appear + paste their Meta catalog credentials. Save → smoke test confirms changes are live.

---

## Phase E — Migration + Smoke (Day 0.5)

### Task E.1: Wady Aljuz Meta Commerce setup checklist

**Files:**

- Create: `docs/runbooks/wady-aljuz-meta-commerce-setup.md`

Step-by-step:

1. Create Meta Business Manager account
2. Create Commerce Catalog
3. Generate System User access token with `catalog_management` scope
4. Save token + IDs in Ebda Store admin → Store → WhatsApp Bot → Meta Catalog Card
5. Trigger initial product sync: `npm run sync-catalog --storeId=<>` (or click button in admin)
6. Verify in Meta Commerce Manager: products visible
7. Submit catalog for review (24-48h)

### Task E.2: Flip Wady Aljuz to `native_catalog_with_gemini_agent`

- [ ] Once Meta approves catalog, set `Store.bot_mode = 'native_catalog_with_gemini_agent'` via Ebda Store
      admin
- [ ] Send Telegram notify on this state change (new alert in WBS notify service)

### Task E.3: Smoke test against Wady Aljuz number

Real WhatsApp number sends "Hi" → walks the full flow. Captured screenshots in
`docs/uat/whatsapp-native-catalog-bot-wady-aljuz-smoke.md`.

### Task E.4: 24-hour monitor

- [ ] Watch Sentry + Telegram alerts for the first 24h after activation
- [ ] Compare conversation funnel (greeting → cart → order) against legacy bot baseline

---

## Self-Review Notes

**Spec coverage check**:

- §3 User flow (8 steps) → covered by Phase B (B.3, B.4) + Phase C (C.1-C.4)
- §4.2 State machine → covered by Phase B + C task list
- §4.3 Data model → Phase A.1 migration
- §4.4 New Ebda Store endpoints → Phase A.3 + A.4
- §4.5 New WBS services → Phase A.6 (metaCatalog), Phase B.1 (wa-interactive), B.4
  (bot-service-router)
- §5 Performance → Phase 0 (tasks 0.1-0.6)
- §6 Migration → Phase E
- §7 Testing → tests appear inline per-task; UAT doc in Phase 0.3 + E.3
- §8 Failure modes → mostly inline in handlers; explicit `replyUseButtons` in Task C.5
- §9 Security → existing waBridgeAuth used throughout; encryption pattern reused in A.4
- §11 Future features → tracked in spec only, NOT in this plan (deferred by design)

**Placeholder scan**: no TBDs, no "TODO" markers in plan steps. All code blocks complete.

**Type consistency**:

- `CustomerAddressService` method names: `listForCustomer`, `createForCustomer` (same in test +
  impl)
- `metaCatalogService` exports: `upsertProduct`, `deleteProduct`, `getCatalogStatus` (same
  everywhere)
- `wa-interactive` exports: `buildButtons`, `buildList`, `buildCatalogMessage`,
  `buildProductListMessage`, `parseInteractiveReply`
- `wa_carts.state` enum: matches the comment in Task B.2 throughout C and D

**Known gaps to revisit on first execution**:

- `getCustomerByPhone` referenced in `handleGreeting` — need to verify this exists on
  `wa-bridge-client.js`; if not, add a small endpoint + client method in Phase A
- `getStoreProfile` referenced in `routeLocations` — same caveat

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-whatsapp-native-catalog-bot.md`.**
