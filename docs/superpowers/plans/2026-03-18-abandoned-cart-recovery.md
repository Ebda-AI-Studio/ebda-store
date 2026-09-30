# Abandoned Cart Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cron-driven abandoned cart recovery system that detects inactive carts and sends up to 3 configurable reminder messages via WhatsApp/SMS/Email/Push, with optional auto-coupon on the final step.

**Architecture:** Cron job (setInterval, 15min) scans for carts inactive >1h, creates AbandonedCart records, and processes a 3-step reminder sequence via the existing Communication Hub dispatcher. Per-store config controls timing, enabled steps, and auto-coupon. Recovery detected via order creation hook.

**Tech Stack:** Prisma, Express.js, Redis (cron locking), Communication Hub dispatcher, existing CouponService, HMAC-signed recovery URLs

**Spec:** `docs/superpowers/specs/2026-03-18-abandoned-cart-recovery-design.md`

---

## File Structure

**New files:**
| File | Responsibility |
|------|---------------|
| `apps/api/src/services/abandoned-cart.service.ts` | Core: detection, step processing, coupon gen, recovery marking |
| `apps/api/src/routes/abandoned-cart.routes.ts` | Admin endpoints + public recovery endpoint |
| `apps/admin/src/app/stores/[id]/abandoned-carts/page.tsx` | Admin UI: stats, settings, cart list |
| `tests/unit/abandoned-cart.test.ts` | Unit tests |

**Modified files:**
| File | Change |
|------|--------|
| `packages/database/prisma/schema.prisma` | Add AbandonedCart, AbandonedCartConfig models, lastActivityAt on Cart |
| `packages/shared/src/notifications.ts` | Add cart_abandoned_step1/2/3 events + templates |
| `apps/api/src/routes/index.ts` | Mount abandoned cart routes |
| `apps/api/src/index.ts` | Start abandoned cart cron |
| `apps/api/src/services/order.service.ts` | Mark abandoned cart recovered on order create |
| `apps/api/src/routes/cart.routes.ts` | Update lastActivityAt on all cart operations |
| `apps/admin/src/app/stores/[id]/settings/page.tsx` | Add Abandoned Cart settings card |

---

## Task 1: Add Cart Abandoned Notification Events + Templates

**Files:**

- Modify: `packages/shared/src/notifications.ts`

- [ ] **Step 1: Add 3 new events to NOTIFICATION_EVENTS array**

Read `packages/shared/src/notifications.ts`. Add to the `NOTIFICATION_EVENTS` array (around line 11-18):

```typescript
'cart_abandoned_step1',
'cart_abandoned_step2',
'cart_abandoned_step3',
```

- [ ] **Step 2: Add NotificationData extensions**

The `NotificationData` interface needs optional cart fields:

```typescript
// Add to NotificationData interface:
cartUrl?: string;
cartTotal?: string;
cartItemCount?: number;
couponCode?: string;
```

- [ ] **Step 3: Add WhatsApp, SMS, Push templates for 3 new events**

Follow the existing template pattern. Add entries to `WHATSAPP_TEMPLATES`, `SMS_TEMPLATES`, and `PUSH_TEMPLATES` for all 3 cart events. SMS templates bilingual EN/AR. Step 3 templates include optional coupon text.

- [ ] **Step 4: Rebuild shared package and commit**

```bash
cd packages/shared && npm run build
git commit -m "feat(shared): add abandoned cart notification events and templates"
```

---

## Task 2: Prisma Schema — AbandonedCart + AbandonedCartConfig + lastActivityAt

**Files:**

- Modify: `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Add lastActivityAt to Cart model**

In the Cart model (around line 526-545), add:

```prisma
lastActivityAt DateTime @default(now()) @map("last_activity_at")
```

Add index: `@@index([lastActivityAt])`

- [ ] **Step 2: Add AbandonedCart model**

Add after the notification models:

```prisma
model AbandonedCart {
  id               String    @id @default(uuid())
  storeId          String    @map("store_id")
  cartId           String    @map("cart_id")
  customerId       String?   @map("customer_id")
  sessionId        String?   @map("session_id")
  customerEmail    String?   @map("customer_email")
  customerPhone    String?   @map("customer_phone")
  cartTotal        Decimal   @map("cart_total") @db.Decimal(12, 3)
  cartItemCount    Int       @map("cart_item_count")
  cartItems        Json      @map("cart_items")
  status           String    @default("pending")
  step1SentAt      DateTime? @map("step1_sent_at")
  step2SentAt      DateTime? @map("step2_sent_at")
  step3SentAt      DateTime? @map("step3_sent_at")
  recoveredAt      DateTime? @map("recovered_at")
  recoveredOrderId String?   @map("recovered_order_id")
  couponId         String?   @map("coupon_id")
  nextStepAt       DateTime? @map("next_step_at")
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")

  store    Store   @relation(fields: [storeId], references: [id], onDelete: Cascade)
  cart     Cart    @relation(fields: [cartId], references: [id], onDelete: Cascade)
  customer User?   @relation("AbandonedCartCustomer", fields: [customerId], references: [id], onDelete: SetNull)
  coupon   Coupon? @relation(fields: [couponId], references: [id], onDelete: SetNull)

  @@unique([storeId, cartId])
  @@index([storeId])
  @@index([storeId, status])
  @@index([nextStepAt])
  @@map("abandoned_carts")
}
```

- [ ] **Step 3: Add AbandonedCartConfig model**

```prisma
model AbandonedCartConfig {
  id                    String   @id @default(uuid())
  storeId               String   @unique @map("store_id")
  step1Enabled          Boolean  @default(true) @map("step1_enabled")
  step1DelayMinutes     Int      @default(60) @map("step1_delay_minutes")
  step2Enabled          Boolean  @default(true) @map("step2_enabled")
  step2DelayMinutes     Int      @default(240) @map("step2_delay_minutes")
  step3Enabled          Boolean  @default(true) @map("step3_enabled")
  step3DelayMinutes     Int      @default(1440) @map("step3_delay_minutes")
  autoCouponEnabled     Boolean  @default(true) @map("auto_coupon_enabled")
  couponDiscountPercent Int      @default(10) @map("coupon_discount_percent")
  couponMaxDiscount     Decimal? @map("coupon_max_discount") @db.Decimal(12, 3)
  couponExpiryHours     Int      @default(48) @map("coupon_expiry_hours")
  createdAt             DateTime @default(now()) @map("created_at")
  updatedAt             DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@map("abandoned_cart_configs")
}
```

- [ ] **Step 4: Add relations**

Add to Store model: `abandonedCarts AbandonedCart[]`, `abandonedCartConfig AbandonedCartConfig?`
Add to Cart model: `abandonedCart AbandonedCart?`
Add to User model: `abandonedCarts AbandonedCart[] @relation("AbandonedCartCustomer")`
Add to Coupon model: `abandonedCarts AbandonedCart[]`

- [ ] **Step 5: Run prisma generate**

```bash
npm run db:generate
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(database): add abandoned cart and config models with cart activity tracking"
```

---

## Task 3: Cart Activity Tracking

**Files:**

- Modify: `apps/api/src/routes/cart.routes.ts`

- [ ] **Step 1: Read cart.routes.ts**

Read the full file to understand how cart operations work.

- [ ] **Step 2: Add lastActivityAt update to all cart operations**

After every successful cart mutation (add item, update quantity, remove item, clear cart), update the cart's `lastActivityAt`. Also update on GET (viewing cart = still engaged).

The pattern depends on how the routes work:

- If routes call `CartService` methods → modify the service methods
- If routes do inline Prisma calls → add `lastActivityAt: new Date()` to each update

**IMPORTANT:** Always include `storeId` in the WHERE clause for multi-tenant safety:

```typescript
await prisma.cart.update({
  where: { id: cartId, storeId },
  data: { lastActivityAt: new Date() },
});
```

If the cart service is a separate file, read and modify that instead.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(cart): track last activity timestamp for abandonment detection"
```

---

## Task 4: Abandoned Cart Service (Core)

**Files:**

- Create: `apps/api/src/services/abandoned-cart.service.ts`

- [ ] **Step 1: Create the service**

Import patterns:

```typescript
import { prisma } from '@force/database';
import { redis } from './redis.service';
import { featureService } from './feature.service';
import { notificationDispatcher } from './notification-dispatcher.service';
import { encryption } from './encryption.service';
import logger from '../lib/logger';
import crypto from 'crypto';
```

**Methods:**

`startProcessing(intervalMs = 900000)` / `stopProcessing()` — setInterval pattern matching queue services.

`process()` — Acquires Redis lock (`abandoned-cart:processing`, TTL 60s), calls detectNewAbandonments + processReminders, releases lock. Generates correlationId (uuid) for logging.

`detectNewAbandonments()`:

1. Get all stores with `abandoned_cart` feature enabled
2. For each store, query carts: `lastActivityAt < now() - 1h`, has items, NOT in abandoned_carts table, has customer email or phone
3. Snapshot cart items (product name, image, price, quantity) into JSON
4. Create AbandonedCart with status `pending`, calculate `nextStepAt` from store config

`processReminders()`:

1. Query AbandonedCart where `status IN (pending, step1_sent, step2_sent)` AND `nextStepAt <= now()`
2. For each: check recovery (order exists?), then send next step
3. Recovery check: query Order where customerId matches AND createdAt > AbandonedCart.createdAt

`sendStep(abandonedCart, stepNumber, config)`:

1. Build notification data with cart-specific fields
2. Generate HMAC-signed recovery URL: `{storeUrl}/cart?recover={id}&sig={hmac}`
3. HMAC: `crypto.createHmac('sha256', config.encryptionKey).update(abandonedCartId).digest('hex')`
4. If step 3 + autoCouponEnabled: generate coupon via `generateRecoveryCoupon()`
5. Dispatch via `notificationDispatcher.dispatch(storeId, event, data)`
6. Update status + timestamps + nextStepAt

`generateRecoveryCoupon(storeId, abandonedCartId, config)`:

1. Deterministic code: `RECOVER-{first6chars(sha256(abandonedCartId + storeId))}`
2. Upsert Coupon (deterministic code prevents duplicates)
3. Return coupon code
4. On failure: log error, return null (Step 3 sends without coupon)

`markRecovered(abandonedCartId, orderId)`:

1. Update AbandonedCart: status `recovered`, recoveredAt, recoveredOrderId

`getConfig(storeId)`:

1. Query AbandonedCartConfig, return defaults if not found

`upsertConfig(storeId, data)`:

1. Upsert AbandonedCartConfig

`getStats(storeId)`:

1. Count by status, sum recovered order totals, calculate recovery rate

Export as `abandonedCartService` singleton.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(api): add abandoned cart service with cron detection and step processing"
```

---

## Task 5: Abandoned Cart API Routes

**Files:**

- Create: `apps/api/src/routes/abandoned-cart.routes.ts`
- Modify: `apps/api/src/routes/index.ts`

- [ ] **Step 1: Create routes**

Follow pattern from existing routes (read `coupon.routes.ts` for middleware chain).

Admin routes (authenticate + authorize('store_admin', 'super_admin') + requireStoreAccess + requireFeature('abandoned_cart')):

- `GET /:storeId/abandoned-carts/stats` — Dashboard stats
- `GET /:storeId/abandoned-carts/config` — Get config
- `PUT /:storeId/abandoned-carts/config` — Update config (Zod validated)
- `GET /:storeId/abandoned-carts` — List (paginated, filterable by status)
- `GET /:storeId/abandoned-carts/:id` — Detail

Public route:

- `GET /stores/public/:storeId/cart/recover/:abandonedCartId?sig=` — Returns cart items for recovery (the path moved under the `/stores` mount; as of 2026-10-01 no storefront code calls it and `markRecovered` has no caller — see issue 2035)
  - Verify HMAC signature from `?sig=` query param
  - Return cart items snapshot + coupon code if exists
  - No auth required (recovery links sent via WhatsApp to anonymous users)

- [ ] **Step 2: Mount in index.ts**

```typescript
import abandonedCartRoutes from './abandoned-cart.routes';
router.use('/stores', abandonedCartRoutes);
```

Mount public route under `/public`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): add abandoned cart management and recovery endpoints"
```

---

## Task 6: Order Recovery Detection Hook

**Files:**

- Modify: `apps/api/src/services/order.service.ts`

- [ ] **Step 1: Add recovery detection to order creation**

Read `order.service.ts`. Inside the create() method, after the order is created (around line 278, after cart items are cleared), add:

```typescript
// Check for abandoned cart recovery
try {
  const abandonedCart = await tx.abandonedCart.findFirst({
    where: {
      storeId,
      OR: [{ cartId: cart.id }, { customerId: cart.customerId, status: { not: 'recovered' } }],
      status: { in: ['pending', 'step1_sent', 'step2_sent', 'step3_sent'] },
    },
  });
  if (abandonedCart) {
    await tx.abandonedCart.update({
      where: { id: abandonedCart.id },
      data: {
        status: 'recovered',
        recoveredAt: new Date(),
        recoveredOrderId: newOrder.id,
      },
    });
  }
} catch (err) {
  logger.error('Abandoned cart recovery detection failed:', err);
  // Never fail order creation
}
```

This runs INSIDE the existing transaction so it's atomic.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(order): detect and mark abandoned cart recovery on order creation"
```

---

## Task 7: Start Cron on Server Boot

**Files:**

- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Add cron startup**

Read `index.ts`. After the queue processing starts (around line 42), add:

```typescript
import { abandonedCartService } from './services/abandoned-cart.service';

// Start abandoned cart recovery cron (every 15 minutes)
abandonedCartService.startProcessing(900000);
```

Also add `abandonedCartService.stopProcessing()` in the graceful shutdown handler.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(api): start abandoned cart recovery cron on server boot"
```

---

## Task 8: Admin UI — Abandoned Carts Page

**Files:**

- Create: `apps/admin/src/app/stores/[id]/abandoned-carts/page.tsx`
- Modify: `apps/admin/src/app/stores/[id]/settings/page.tsx`

- [ ] **Step 1: Read existing admin patterns**

Read loyalty page and notifications page for form + stats + table patterns.

- [ ] **Step 2: Create abandoned carts page**

`'use client'` component with sections:

**Stats Dashboard:**

- Total abandoned (this month), Recovered, Recovery rate %, Revenue recovered
- Fetch from `GET /stores/:storeId/abandoned-carts/stats`

**Settings Panel:**

- Step 1: [enabled toggle] delay [input] minutes
- Step 2: [enabled toggle] delay [input] minutes
- Step 3: [enabled toggle] delay [input] minutes
  - Auto-coupon: [enabled toggle]
  - Discount: [input] %
  - Max discount: [input] KWD
  - Coupon expiry: [input] hours
- Save button → `PUT /stores/:storeId/abandoned-carts/config`

**Abandoned Carts List:**

- Table: customer, cart total, items, status, created
- Status badges with colors
- Filter by status
- Pagination

- [ ] **Step 3: Add settings card**

In settings/page.tsx, add "Abandoned Cart Recovery" card with `featureKey: 'abandoned_cart'`.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(admin): add abandoned cart recovery dashboard and settings page"
```

---

## Task 9: Unit Tests

**Files:**

- Create: `tests/unit/abandoned-cart.test.ts`

- [ ] **Step 1: Write tests**

Tests:

1. NOTIFICATION_EVENTS includes 3 new cart events (total 9)
2. SMS_TEMPLATES has entries for cart_abandoned_step1/2/3
3. HMAC recovery URL generation + verification
4. Deterministic coupon code generation (same input → same code)
5. Step progression logic (pending → step1_sent → step2_sent → step3_sent/expired)
6. Config defaults (all steps enabled, 60/240/1440 min delays)

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/unit/abandoned-cart.test.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(api): add unit tests for abandoned cart recovery"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Run all tests**

```bash
npx vitest run tests/unit/
```

- [ ] **Step 2: Build all workspaces**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: complete phase 2 abandoned cart recovery implementation"
```
