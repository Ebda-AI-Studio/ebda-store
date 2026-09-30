# Phase 2: Abandoned Cart Recovery — Design Spec

## Overview

A cron-driven system that detects carts inactive for 1+ hour, marks them abandoned, and sends up to 3 configurable reminder messages via the Communication Hub (WhatsApp, SMS, Email, Push). Step 3 can optionally auto-generate a single-use discount coupon. The coupon is independently toggleable — stores can send the Step 3 message without a coupon. Toggleable per store via Feature Toggle Engine (`abandoned_cart` feature key).

## Decisions

- **Abandonment threshold:** 1 hour of inactivity (industry standard)
- **Reminder sequence:** 3 steps, each independently enableable per store
- **Default timing:** Step 1 at 1h, Step 2 at 4h, Step 3 at 24h (all configurable)
- **Auto-coupon:** Independently toggleable on Step 3 (ON/OFF). When OFF, Step 3 sends message without coupon.
- **Channels:** Uses existing Communication Hub dispatcher — sends via whichever channels are enabled for the store
- **Cron:** `setInterval` in the API server process (Railway), same pattern as queue processing
- **Recovery detection:** Check for completed order before each step — cancel remaining if recovered

## Data Layer

### New Model: AbandonedCart

```prisma
model AbandonedCart {
  id              String    @id @default(uuid())
  storeId         String    @map("store_id")
  cartId          String    @map("cart_id")
  customerId      String?   @map("customer_id")
  sessionId       String?   @map("session_id")
  customerEmail   String?   @map("customer_email")
  customerPhone   String?   @map("customer_phone")
  cartTotal       Decimal   @map("cart_total") @db.Decimal(12, 3)
  cartItemCount   Int       @map("cart_item_count")
  cartItems       Json      @map("cart_items") // Snapshot of cart items at abandonment
  status          String    @default("pending") // pending | step1_sent | step2_sent | step3_sent | recovered | expired
  step1SentAt     DateTime? @map("step1_sent_at")
  step2SentAt     DateTime? @map("step2_sent_at")
  step3SentAt     DateTime? @map("step3_sent_at")
  recoveredAt     DateTime? @map("recovered_at")
  recoveredOrderId String?  @map("recovered_order_id")
  couponId        String?   @map("coupon_id")
  nextStepAt      DateTime? @map("next_step_at") // When the next reminder is due
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  store    Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  cart     Cart     @relation(fields: [cartId], references: [id], onDelete: Cascade)
  customer User?    @relation("AbandonedCartCustomer", fields: [customerId], references: [id], onDelete: SetNull)
  coupon   Coupon?  @relation(fields: [couponId], references: [id], onDelete: SetNull)

  @@unique([storeId, cartId])
  @@index([storeId])
  @@index([storeId, status])
  @@index([nextStepAt])
  @@map("abandoned_carts")
}
```

### New Model: AbandonedCartConfig

```prisma
model AbandonedCartConfig {
  id                    String  @id @default(uuid())
  storeId               String  @unique @map("store_id")
  step1Enabled          Boolean @default(true) @map("step1_enabled")
  step1DelayMinutes     Int     @default(60) @map("step1_delay_minutes")
  step2Enabled          Boolean @default(true) @map("step2_enabled")
  step2DelayMinutes     Int     @default(240) @map("step2_delay_minutes")
  step3Enabled          Boolean @default(true) @map("step3_enabled")
  step3DelayMinutes     Int     @default(1440) @map("step3_delay_minutes")
  autoCouponEnabled     Boolean @default(true) @map("auto_coupon_enabled")
  couponDiscountPercent Int     @default(10) @map("coupon_discount_percent")
  couponMaxDiscount     Decimal? @map("coupon_max_discount") @db.Decimal(12, 3)
  couponExpiryHours     Int     @default(48) @map("coupon_expiry_hours")
  createdAt             DateTime @default(now()) @map("created_at")
  updatedAt             DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@map("abandoned_cart_configs")
}
```

### Modify Existing: Cart Model

Add `lastActivityAt` field to track when the cart was last interacted with:

```prisma
// Add to Cart model
lastActivityAt DateTime @default(now()) @map("last_activity_at")
```

### Relations

Add to Store model:

```prisma
abandonedCarts       AbandonedCart[]
abandonedCartConfig  AbandonedCartConfig?
```

Add to Cart model:

```prisma
abandonedCart AbandonedCart?
```

Add to User model:

```prisma
abandonedCarts AbandonedCart[] @relation("AbandonedCartCustomer")
```

Add to Coupon model:

```prisma
abandonedCarts AbandonedCart[]
```

## Cart Activity Tracking

The `lastActivityAt` field on Cart is updated whenever:

- `POST /stores/:storeId/cart` — add item to cart
- `PUT /stores/:storeId/cart/:itemId` — update quantity
- `DELETE /stores/:storeId/cart/:itemId` — remove item
- `GET /stores/:storeId/cart` — view cart (customer is still engaged)

Implementation: In the cart service or route handlers, add `lastActivityAt: new Date()` to every cart update operation.

## Abandoned Cart Detection (Cron)

### Cron Job: `abandoned-cart-scanner`

Runs every 15 minutes via `setInterval` in the API server process (same pattern as queue processing in index.ts).

**Step 1: Detect new abandonments**

```
SELECT carts WHERE:
  - lastActivityAt < NOW() - 1 hour
  - has items (cartItemCount > 0 or via relation)
  - NOT already in abandoned_carts table
  - store has 'abandoned_cart' feature enabled
  - cart has customerEmail OR customerPhone (need contact info to send reminders)
```

For each qualifying cart:

1. Snapshot cart items (product names, images, prices, quantities) into JSON
2. Create AbandonedCart record with status `pending`
3. Calculate `nextStepAt` based on store's Step 1 delay config

**Step 2: Process pending reminders**

```
SELECT abandoned_carts WHERE:
  - status IN ('pending', 'step1_sent', 'step2_sent')
  - nextStepAt <= NOW()
  - NOT recovered
```

For each:

1. **Recovery check:** Look for an Order with matching cartId or customerId created after the AbandonedCart.createdAt. If found → mark `recovered`, set `recoveredAt` and `recoveredOrderId`, skip.
2. **Send next step** via Communication Hub dispatcher with appropriate event type
3. **Update status** and `nextStepAt` for the following step (if enabled)
4. If all enabled steps are sent → mark `expired`

### Step Processing Logic

```
if status == 'pending':
  send step1 (if step1Enabled)
  status → 'step1_sent', step1SentAt = now
  if step2Enabled: nextStepAt = now + step2DelayMinutes
  else if step3Enabled: nextStepAt = now + step3DelayMinutes
  else: status → 'expired'

if status == 'step1_sent':
  send step2 (if step2Enabled)
  status → 'step2_sent', step2SentAt = now
  if step3Enabled: nextStepAt = now + step3DelayMinutes
  else: status → 'expired'

if status == 'step2_sent':
  send step3 (if step3Enabled)
  if autoCouponEnabled: generate coupon, include in message
  status → 'step3_sent', step3SentAt = now
  status → 'expired' (final step)
```

## Communication Hub Integration

### New Notification Events

Add to `packages/shared/src/notifications.ts`:

```typescript
// Add to NOTIFICATION_EVENTS
'cart_abandoned_step1';
'cart_abandoned_step2';
'cart_abandoned_step3';
```

### New Templates

**WhatsApp templates** (must be pre-approved by Meta):

- `cart_reminder_1` — "Hi {{1}}, you left {{2}} items worth {{3}} KWD in your cart. Complete your order: {{4}}"
- `cart_reminder_2` — "Hi {{1}}, your cart with {{2}} items is waiting! Don't miss out: {{3}}"
- `cart_reminder_3` — "Hi {{1}}, complete your order now! {{2}}" ({{2}} = coupon text or empty)

**SMS templates** (bilingual):

- Step 1 EN: "Hi {name}, you left {itemCount} items ({total} KWD) in your cart at {storeName}. Complete your order: {cartUrl}"
- Step 1 AR: "مرحبا {name}، لديك {itemCount} منتجات ({total} د.ك) في سلتك في {storeName}. أكمل طلبك: {cartUrl}"
- Step 2/3 similar with urgency/coupon variations

**Push templates:**

- Step 1: title "Items waiting in your cart!", body "{itemCount} items worth {total} KWD"
- Step 2: title "Don't miss out!", body "Your cart is about to expire"
- Step 3: title "Last chance!" / "Special offer!", body with/without coupon

**Email templates:**

- Uses existing EmailService pattern
- Step 1: Cart reminder with product images
- Step 2: Urgency with product images
- Step 3: Discount offer (if coupon enabled) with product images

### Dispatcher Call

```typescript
await notificationDispatcher.dispatch(storeId, 'cart_abandoned_step1', {
  customerName,
  customerPhone,
  customerEmail,
  orderNumber: '', // Not applicable
  storeId,
  storeName,
  // Extended data for cart-specific templates:
  cartUrl: `${storeUrl}/cart?recover=${abandonedCartId}`,
  cartTotal,
  cartItemCount,
  cartItems, // For email product images
  couponCode, // Only for step3 with auto-coupon
});
```

The NotificationData interface needs to be extended with optional cart-specific fields.

## Auto-Coupon Generation

When `autoCouponEnabled` is ON and Step 3 is triggered:

1. Generate unique code: `RECOVER-{6 random alphanumeric chars}`
2. Create a Coupon record using existing CouponService:
   - `code`: generated code
   - `type`: 'percentage'
   - `value`: store's `couponDiscountPercent`
   - `maxDiscount`: store's `couponMaxDiscount` (nullable)
   - `usageLimit`: 1 (single use)
   - `usageLimitPerUser`: 1
   - `expiresAt`: now + `couponExpiryHours`
   - `storeId`: the store
   - `isActive`: true
3. Link coupon to AbandonedCart record (`couponId`)
4. Include coupon code in the Step 3 message
5. Cart recovery URL includes `?coupon=RECOVER-XXXX` for auto-apply at checkout

When `autoCouponEnabled` is OFF:

- Step 3 sends the message without any coupon text
- No coupon is generated
- Cart URL has no coupon parameter

## Cart Recovery URL

Each reminder includes a recovery URL: `{storeUrl}/cart?recover={abandonedCartId}`

When the storefront receives this URL:

1. Load the abandoned cart's items
2. Merge into the customer's current cart (or create new cart)
3. If `?coupon=XXX` is present, auto-apply the coupon
4. Redirect to cart page

## Admin UI

### New Page: `/stores/[id]/abandoned-carts`

Gated by `requireFeature('abandoned_cart')`.

**Dashboard Stats:**

- Total abandoned carts (this month)
- Recovered carts (this month)
- Recovery rate %
- Revenue recovered (sum of recovered order totals)

**Settings Panel:**

```
Step 1: Gentle Reminder
  [✓ Enabled]  Delay: [60] minutes

Step 2: Follow-up
  [✓ Enabled]  Delay: [240] minutes

Step 3: Final Reminder
  [✓ Enabled]  Delay: [1440] minutes

  Auto-Coupon: [✓ Enabled]
    Discount: [10] %
    Max discount: [5.000] KWD
    Coupon expires in: [48] hours
```

**Abandoned Carts List:**

- Table: customer (email/phone), cart total, items, status, created, last action
- Status badges: pending (yellow), step1/2/3_sent (blue), recovered (green), expired (gray)
- Filter by status
- Pagination

**Settings card** in `/stores/[id]/settings/page.tsx`:

- "Abandoned Cart Recovery" card linking to this page

## API Routes

```
GET  /stores/:storeId/abandoned-carts/stats    → Dashboard stats
GET  /stores/:storeId/abandoned-carts/config   → Get config
PUT  /stores/:storeId/abandoned-carts/config   → Update config
GET  /stores/:storeId/abandoned-carts          → List (paginated, filterable)
GET  /stores/:storeId/abandoned-carts/:id      → Detail
```

All routes: `authenticate → authorize('store_admin', 'super_admin') → requireStoreAccess → requireFeature('abandoned_cart')`

### Public Route for Cart Recovery

```
GET /stores/public/:storeId/cart/recover/:abandonedCartId?sig= → Returns cart items for recovery  (path moved under /stores; unconsumed as of 2026-10-01 — issue 2035)
```

No auth required (recovery links are sent via WhatsApp/SMS to anonymous users). The storefront fetches items and merges into current cart.

## Cron Implementation

```typescript
// In apps/api/src/services/abandoned-cart.service.ts

class AbandonedCartService {
  private intervalId: NodeJS.Timer | null = null;

  startProcessing(intervalMs = 900000) {
    // 15 minutes
    this.intervalId = setInterval(() => this.process(), intervalMs);
  }

  stopProcessing() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  async process() {
    await this.detectNewAbandonments();
    await this.processReminders();
  }

  async detectNewAbandonments() {
    /* ... */
  }
  async processReminders() {
    /* ... */
  }
  async sendStep(abandonedCart, stepNumber, config) {
    /* ... */
  }
  async generateRecoveryCoupon(storeId, config) {
    /* ... */
  }
  async markRecovered(abandonedCartId, orderId) {
    /* ... */
  }
}
```

Started in `index.ts` alongside queue processing:

```typescript
abandonedCartService.startProcessing(900000); // 15 min
```

## Recovery Detection

Two mechanisms:

1. **Cron check:** Before sending each step, query for orders matching the cart's customer
2. **Order creation hook:** In `OrderService.create()`, check if the customer had an AbandonedCart → mark recovered

The order creation hook is the most reliable — it catches recoveries immediately, even between cron cycles.

## Security

- **Recovery URLs are HMAC-signed:** URL format is `/cart?recover={abandonedCartId}&sig={hmac}` where `sig = HMAC-SHA256(abandonedCartId, ENCRYPTION_KEY)`. Storefront verifies the signature before loading cart items. This prevents enumeration attacks on UUID-based recovery URLs.
- **Auto-generated coupons are single-use with expiry** — Coupon code is deterministic per abandoned cart: `RECOVER-{first6chars(sha256(abandonedCartId + storeId))}`. This prevents duplicate coupons from race conditions (upsert by code). The Coupon record has `usageLimit: 1` and `expiresAt`.
- **Coupon usage enforced at checkout:** The existing coupon validation in the order creation flow already checks `usageLimit`. No additional enforcement needed.
- Cart item snapshots stored in JSON — no sensitive data beyond product names/prices
- Customer contact info (email/phone) stored in AbandonedCart for sending — same data already in Cart/User
- Feature gated — only active when `abandoned_cart` feature is enabled for the store

## Concurrency & Race Conditions

- **Cron locking:** Use a Redis lock (`abandoned-cart:processing` key with TTL) to prevent concurrent cron runs. If lock exists, skip the cycle. This prevents duplicate reminders when cron intervals overlap.
- **Coupon generation:** Deterministic coupon codes (derived from abandonedCartId) + Prisma upsert ensures no duplicates even if Step 3 fires twice.
- **Recovery detection in order creation:** `OrderService.create()` atomically marks AbandonedCart as recovered inside the order creation transaction. This prevents sending reminders for already-recovered carts.
- **Cart activity scoping:** All `lastActivityAt` updates include `storeId` in the WHERE clause to ensure multi-tenant isolation.

## Cart Activity Scoping

Every cart update that touches `lastActivityAt` must include the storeId scope:

```typescript
await prisma.cart.update({
  where: { id: cartId, storeId }, // Always include storeId
  data: { lastActivityAt: new Date() },
});
```

This prevents cross-store cart confusion in the abandonment detection query.

## Error Handling

- Cron failures are logged, never crash the server
- Individual cart processing failures don't affect other carts (try/catch per cart)
- Notification dispatch failures are handled by the Communication Hub (fire-and-forget)
- Recovery coupon creation failure → send Step 3 without coupon (degrade gracefully)
- Cron adds a correlation ID per cycle (`cronCycleId = uuid()`) to all log entries for debugging
- Cart item snapshot validated before storage (must have at least one item with name, price, quantity)

## Files to Create

| File                                                      | Responsibility                                           |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `apps/api/src/services/abandoned-cart.service.ts`         | Core service: detection, reminders, recovery, coupon gen |
| `apps/api/src/routes/abandoned-cart.routes.ts`            | Admin + public endpoints                                 |
| `apps/admin/src/app/stores/[id]/abandoned-carts/page.tsx` | Admin UI: stats, settings, cart list                     |
| `tests/unit/abandoned-cart.test.ts`                       | Unit tests                                               |

## Files to Modify

| File                                                   | Change                                                    |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `packages/database/prisma/schema.prisma`               | Add AbandonedCart, AbandonedCartConfig models + relations |
| `packages/shared/src/notifications.ts`                 | Add cart_abandoned_step1/2/3 events + templates           |
| `apps/api/src/routes/index.ts`                         | Mount abandoned cart routes                               |
| `apps/api/src/index.ts`                                | Start abandoned cart cron processing                      |
| `apps/api/src/services/order.service.ts`               | Mark abandoned cart as recovered on order creation        |
| `apps/api/src/routes/cart.routes.ts` (or cart service) | Update lastActivityAt on cart operations                  |
| `apps/admin/src/app/stores/[id]/settings/page.tsx`     | Add Abandoned Cart Recovery settings card                 |
