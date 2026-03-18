# Phase 7: Affiliate / Influencer Program — Design Spec

## Overview

Commission-based affiliate program. Affiliates get a unique referral link (`?ref=CODE`). When a customer buys via that link, the affiliate earns a configurable % commission on delivered orders. Public signup with admin approval + admin invite. Per-store program. Toggleable via `affiliate` feature key.

## Decisions

- **Model:** Commission-based (% of order total on delivered orders)
- **Tracking:** Cookie-based referral tracking (30-day default window)
- **Signup:** Public application + admin invite. Admin approves all public applications.
- **Payout:** Manual — admin reviews pending balances and marks payouts
- **Commission trigger:** Order delivered (not created — prevents commission on cancelled/returned orders)

## Data Layer

### New Model: Affiliate

```prisma
model Affiliate {
  id             String    @id @default(uuid())
  storeId        String    @map("store_id")
  name           String
  email          String
  phone          String?
  instagram      String?
  tiktok         String?
  referralCode   String    @map("referral_code")
  status         String    @default("pending") // pending | approved | rejected | suspended
  commissionRate Decimal?  @map("commission_rate") @db.Decimal(5, 2) // Override store default
  totalEarned    Decimal   @default(0) @map("total_earned") @db.Decimal(12, 3)
  totalPaid      Decimal   @default(0) @map("total_paid") @db.Decimal(12, 3)
  pendingBalance Decimal   @default(0) @map("pending_balance") @db.Decimal(12, 3)
  approvedAt     DateTime? @map("approved_at")
  approvedBy     String?   @map("approved_by")
  notes          String?
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  store     Store              @relation(fields: [storeId], references: [id], onDelete: Cascade)
  referrals AffiliateReferral[]
  payouts   AffiliatePayout[]

  @@unique([storeId, referralCode])
  @@unique([storeId, email])
  @@index([storeId])
  @@index([storeId, status])
  @@map("affiliates")
}
```

### New Model: AffiliateReferral

```prisma
model AffiliateReferral {
  id               String    @id @default(uuid())
  storeId          String    @map("store_id")
  affiliateId      String    @map("affiliate_id")
  orderId          String?   @map("order_id")
  sessionId        String?   @map("session_id")
  referralCode     String    @map("referral_code")
  status           String    @default("clicked") // clicked | converted | expired
  commissionAmount Decimal?  @map("commission_amount") @db.Decimal(12, 3)
  convertedAt      DateTime? @map("converted_at")
  cookieExpiresAt  DateTime  @map("cookie_expires_at")
  createdAt        DateTime  @default(now()) @map("created_at")

  store     Store      @relation(fields: [storeId], references: [id], onDelete: Cascade)
  affiliate Affiliate  @relation(fields: [affiliateId], references: [id], onDelete: Cascade)
  order     Order?     @relation(fields: [orderId], references: [id], onDelete: SetNull)

  @@index([storeId])
  @@index([affiliateId])
  @@index([storeId, referralCode])
  @@index([sessionId])
  @@map("affiliate_referrals")
}
```

### New Model: AffiliatePayout

```prisma
model AffiliatePayout {
  id          String    @id @default(uuid())
  storeId     String    @map("store_id")
  affiliateId String    @map("affiliate_id")
  amount      Decimal   @db.Decimal(12, 3)
  method      String    @default("manual") // bank_transfer | wallet | manual
  status      String    @default("pending") // pending | paid | cancelled
  paidAt      DateTime? @map("paid_at")
  notes       String?
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  store     Store     @relation(fields: [storeId], references: [id], onDelete: Cascade)
  affiliate Affiliate @relation(fields: [affiliateId], references: [id], onDelete: Cascade)

  @@index([storeId])
  @@index([affiliateId])
  @@map("affiliate_payouts")
}
```

### New Model: AffiliateConfig

```prisma
model AffiliateConfig {
  id                    String  @id @default(uuid())
  storeId               String  @unique @map("store_id")
  defaultCommissionRate Decimal @default(10) @map("default_commission_rate") @db.Decimal(5, 2)
  cookieDurationDays    Int     @default(30) @map("cookie_duration_days")
  minPayoutAmount       Decimal @default(5000) @map("min_payout_amount") @db.Decimal(12, 3) // In fils
  autoApprove           Boolean @default(false) @map("auto_approve")
  publicSignupEnabled   Boolean @default(true) @map("public_signup_enabled")
  createdAt             DateTime @default(now()) @map("created_at")
  updatedAt             DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@map("affiliate_configs")
}
```

### Relations

Store: `affiliates Affiliate[]`, `affiliateReferrals AffiliateReferral[]`, `affiliatePayouts AffiliatePayout[]`, `affiliateConfig AffiliateConfig?`
Order: `affiliateReferrals AffiliateReferral[]`

## Referral Tracking Flow

1. Customer visits `store.com/products?ref=AHMED`
2. Web storefront detects `ref` query param → saves to cookie (`affiliate_ref={code}`, expires in N days) + calls `GET /public/:storeId/affiliates/track?ref=AHMED` to register click
3. API creates AffiliateReferral (status: clicked, sessionId from header, cookieExpiresAt)
4. Customer browses and eventually checks out
5. On order creation: check for `affiliate_ref` cookie → find active referral → link orderId to AffiliateReferral
6. On order status = 'delivered': calculate commission, credit affiliate pendingBalance, update referral status to 'converted'

## Commission Calculation

Triggered in OrderService.updateStatus() when status = 'delivered':

1. Find AffiliateReferral where orderId = this order AND status = 'clicked'
2. Get affiliate's commissionRate (or store default)
3. Commission = order.total × rate / 100, rounded to 3 decimal places
4. Update AffiliateReferral: status='converted', commissionAmount, convertedAt
5. Update Affiliate: totalEarned += commission, pendingBalance += commission
6. All in a transaction

## API Routes

### Admin (authenticate + authorize + requireStoreAccess + requireFeature('affiliate'))

```
GET    /stores/:storeId/affiliates                    → List (paginated, filterable by status)
POST   /stores/:storeId/affiliates                    → Create/invite affiliate
GET    /stores/:storeId/affiliates/:id                → Detail
PUT    /stores/:storeId/affiliates/:id                → Update (commission rate, notes)
DELETE /stores/:storeId/affiliates/:id                → Remove
POST   /stores/:storeId/affiliates/:id/approve        → Approve application
POST   /stores/:storeId/affiliates/:id/reject         → Reject
POST   /stores/:storeId/affiliates/:id/suspend        → Suspend
GET    /stores/:storeId/affiliates/:id/referrals      → Referral history
GET    /stores/:storeId/affiliates/:id/payouts        → Payout history
POST   /stores/:storeId/affiliates/:id/payout         → Create payout (body: {amount, method, notes})
GET    /stores/:storeId/affiliate-config               → Get config
PUT    /stores/:storeId/affiliate-config               → Update config
GET    /stores/:storeId/affiliate-stats                → Program stats
```

### Public

```
POST /public/:storeId/affiliates/apply     → Public signup (body: {name, email, phone?, instagram?, tiktok?})
GET  /public/:storeId/affiliates/track     → Register referral click (query: ref=CODE)
GET  /public/:storeId/affiliates/dashboard → Affiliate's own stats (requires affiliate auth via email token)
```

## Admin UI

Page: `/stores/[id]/affiliates` (gated by `affiliate` feature)

**Stats:** Total affiliates, active referrals, conversion rate, total paid, pending payouts
**Config:** Commission rate, cookie duration, min payout, auto-approve, public signup toggles
**Affiliates table:** Name, email, referral code, status, total earned, pending, actions
**Affiliate detail modal/page:** Referral history, payout history, create payout button

Settings card in `/stores/[id]/settings`

## Storefront

- Referral cookie middleware: detect `?ref=` in URLs, set cookie
- `/affiliate` page: public signup form (if enabled)
- `/affiliate/dashboard`: affiliate self-service (earnings, referral link, stats)

## Files to Create

| File                                                 | Responsibility                                          |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `apps/api/src/services/affiliate.service.ts`         | Core: CRUD, referral tracking, commission calc, payouts |
| `apps/api/src/routes/affiliate.routes.ts`            | Admin + public endpoints                                |
| `apps/admin/src/app/stores/[id]/affiliates/page.tsx` | Admin UI                                                |
| `apps/web/src/app/affiliate/page.tsx`                | Public signup form                                      |
| `tests/unit/affiliate.test.ts`                       | Unit tests                                              |

## Files to Modify

| File                                               | Change                                                |
| -------------------------------------------------- | ----------------------------------------------------- |
| `packages/database/prisma/schema.prisma`           | Add 4 models + relations                              |
| `apps/api/src/routes/index.ts`                     | Mount affiliate routes                                |
| `apps/api/src/services/order.service.ts`           | Link referral on create, calc commission on delivered |
| `apps/admin/src/app/stores/[id]/settings/page.tsx` | Add settings card                                     |
| `apps/web/src/app/layout.tsx` or middleware        | Detect ref cookie                                     |
