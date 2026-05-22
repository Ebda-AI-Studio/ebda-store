## 2. Database & Performance Audit

### Executive Summary

FWB's database tier is well-engineered at its core — RLS is genuinely implemented and on by default, the index set is thoughtful, the caching stack has two layers with a TTL floor, and the Inngest queue is fully instrumented. The **critical gaps are narrower than expected**: 8 tables added after the initial RLS migration are missing RLS policies (blog, FAQ, howto, AI recs, job tables), offset pagination still used in the accounting service, and `bulk-import` has zero retries which can silently orphan jobs. The throughput ceiling has already been raised 2.3× to 190 req/s through index work; the current blocker is Railway single-instance vertical scaling.

---

### Findings

#### 2.1 Schema Overview

**Totals:** 79 models, 34 enums, 2628 lines. 41 migrations spanning 2024-12-27 → 2026-05-20.

**Domain groupings:**

| Domain           | Models                                                                                                                                                                                                               | Notes |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Core commerce    | Store, Product, Category, ProductImage, ProductOption, ProductOptionValue, ProductVariant, ProductVariantOption, ProductCategory, ProductTag, Tag                                                                    | 11    |
| Transactions     | Order, OrderItem, Payment, Cart, CartItem, Return, ReturnItem                                                                                                                                                        | 7     |
| Auth & users     | User, RefreshToken, VerificationToken, Address                                                                                                                                                                       | 4     |
| CRM / loyalty    | Customer, LoyaltyPoints, LoyaltyTransaction, NewsletterSubscriber, Wishlist, WishlistItem                                                                                                                            | 6     |
| Marketing        | Coupon, Affiliate, AffiliateReferral, AffiliatePayout, AffiliateConfig, AbandonedCart, AbandonedCartConfig, Review                                                                                                   | 8     |
| Ops              | InventoryHistory, Shipment, ShippingZone, ShippingCarrierConfig, TaxRate, PaymentConfig                                                                                                                              | 6     |
| Async jobs       | BulkImportJob, BulkAiJob, AiUsage                                                                                                                                                                                    | 3     |
| Notifications    | PushSubscription, OneSignalSubscription, NotificationConfig, NotificationEventConfig, NotificationLog                                                                                                                | 5     |
| CMS / content    | StorePage, BlogPost, StoreFaq, StoreHowto, ProductFaq, ProductRelation, FrequentlyBoughtTogether, AiRecommendation                                                                                                   | 8     |
| Accounting (new) | Account, JournalEntry, JournalLine, Sequence, Supplier, PurchaseOrder, PurchaseOrderItem, StockAdjustment, StockAdjustmentItem, ReorderRule, BackorderLine, Expense, ReorderSuggestion, DeadStockFlag, ProfitAnomaly | 15    |
| Insights (new)   | CustomerCohortSnapshot, FunnelSnapshot, CustomerRfmSnapshot                                                                                                                                                          | 3     |
| Admin/meta       | AuditLog, StoreFeature, SystemSetting, NotificationConfig                                                                                                                                                            | 3     |

**Multi-tenancy:** `storeId` foreign key on every tenant-scoped model. Cascade delete on Store wipes all its data. Accounting tables use `onDelete: Restrict` on Store (correct — can't accidentally orphan financial records). Schema-level comment guards `users_admin_email_key` partial unique (`schema.prisma:82-85`) preventing `prisma migrate dev` from dropping it.

**Soft-delete:** Present on User, Store, Category, Product, Order, Supplier — using `deletedAt DateTime?`. Missing on peripheral models (BlogPost, StorePage, StoreFeature, Review) — acceptable as those have hard-delete semantics.

**ENUMs:** 34 enums in Prisma's lowercase_with_underscores or camelCase convention.

#### 2.2 Indexes

**Coverage (170 `@@index` directives, 292 total index+unique directives):**

✅ Core hot paths well covered: `products` composite `[storeId, deletedAt, createdAt(Desc)]`, `orders` `[storeId, createdAt(Desc)]`, `audit_logs` `[storeId, createdAt(Desc)]`, `bulk_*_jobs` `[storeId, createdAt(Desc)]`, `products` `[storeId, isBestSeller]` and `[storeId, status]`.

⚠️ **P2 — Missing composite on `order_items` for product sales analysis.** Individual indexes on `orderId` and `productId`, but no composite. Best-seller calc or product revenue reports = sequential scan at scale. (`schema.prisma:922-924`)

⚠️ **P2 — `journal_lines` no composite on `accountId + entryId`.** Balance queries only have single-column index. At ~146k rows/year this slows P&L generation. (`schema.prisma:2163-2166`)

⚠️ **P2 — `loyalty_transactions` missing `[storeId, customerId, createdAt(Desc)]`.** Admin customer loyalty history view needs the composite. (`schema.prisma:1772-1776`)

⚠️ **P2 — `customer_rfm_snapshots` missing index on `[storeId, computedAt]`.** RFM history diff queries need it. (`schema.prisma:2625-2628`)

⚠️ **P2 — `ProductCategory` join table lacks standalone `@@index([categoryId])`.** PK index is forward-only `(productId, categoryId)`; reverse lookups are sequential. At 200+ products/category this is P2.

#### 2.3 Query Patterns

**Raw SQL:** 0 `$queryRaw`, 3 `$executeRaw` (all `SET LOCAL` GUC commands, not data queries). Sanitized via UUID pre-validation. Clean.

**`$transaction`:** Used in 20 files. Patterns correct: atomic multi-write, sequence counter via interactive transaction, RLS context setup.

**N+1 risk:** 165 `include:` directives. Spot-checked:

- `order.service.ts` order creation: bounded.
- ⚠️ `loyalty-automation.service.ts:112`: `findMany(loyaltyPoints, include: { customer })` per-store scan, no `take` cap. P2.
- `inventory.service.ts:162,416`: bounded.
- `review.service.ts:65,169`: bounded via pagination params.

**SELECT \* (no `select:`):** 71 `take:` vs 2 `cursor:` uses. Dominant pattern is **offset pagination** (`skip: (page-1) * limit`). Storefront product list (`product.service.ts:492`) has `MAX_SKIP = 10,000` hard cap. Accounting service (`purchase-order.service.ts:274`) uses raw offset without skip cap — P2 for large PO histories.

**Cursor pagination:** Only 2 cursor usages. Offset-with-cap is the platform's primary pattern, acceptable given MAX_SKIP guard.

#### 2.4 RLS Posture

**Architecture:** ✅ Solid. `packages/database/src/index.ts` exports `runInTenantContext(storeId, fn)` which wraps every fn in `$transaction` + `SET LOCAL app.current_store_id`. `apps/api/src/middleware/tenant-context.ts` wires this to every Express route with UUID `:storeId` or `:id` param. Non-UUID params correctly skipped via UUID_RE guard.

**Policy pattern:** All policies use `current_store_id() IS NULL OR store_id = current_store_id()`. The `IS NULL` branch = "no tenant context set" → allow all rows (correct super_admin / migration bypass).

**Bypass mechanism:** `withRlsBypass()` (`packages/database/src/index.ts:233`) opens fresh transaction + `SET LOCAL app.bypass_rls = 'true'`. Transaction-scoped, no leak. Used in 3 places: store hard-delete, provisioning, Inngest Accounting functions.

**RLS coverage — 52 ALTER TABLE ENABLE ROW LEVEL SECURITY across migrations:**

- Initial migration: 31 core tables (products, orders, carts, categories, etc.)
- Subsequent migrations: store_pages, accounting tables, insight tables, reorder/deadstock/anomaly tables.

❌ **P1 — 8 tables missing RLS policies:** `blog_posts`, `store_faqs`, `store_howtos`, `product_faqs`, `ai_recommendation`, `bulk_ai_jobs`, `ai_usage`, `onesignal_subscriptions`. All have `storeId` columns and are tenant-scoped in application code, but their migrations never ran `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. Future query bug or super_admin route missing `WHERE storeId = ?` would silently return cross-tenant data. Application-layer filters still enforce isolation on normal paths — risk is the missing DB-level backstop.

#### 2.5 Caching

✅ **Redis service** (`apps/api/src/services/redis.service.ts`): ioredis with `maxRetriesPerRequest: 3`, exponential retry, graceful fallback to in-memory. Railway internal — no cross-AZ latency.

✅ **TTL floor rule:** 120s minimum Redis TTL enforced by ESLint rule (commit `b6e6cd7`).

✅ **In-memory bounded-map fallback** (`apps/api/src/lib/bounded-map.ts`): 1000 entries with LRU eviction.

✅ **Two-layer public cache** (`apps/api/src/lib/public-cache.ts`): tries Redis first, falls back to BoundedMap. `invalidateCachedPrefix(prefix)` busts memory only — documented tradeoff.

⚠️ **P2 — Product list cache key includes full JSON params** (`product.service.ts:496-508`): each unique sort/filter/page combo = own cache entry. Bot scans create unbounded keys until TTL. At 30s TTL acceptable; if TTL bumped higher = Redis memory issue.

⚠️ **P2 — Redis cache bust on bulk writes is prefix-only (in-memory) not Redis SCAN.** Product update misses all Redis-side product list entries until TTL. Documented tradeoff, materializes as "admin edits product, storefront shows old name for 30s."

#### 2.6 Inngest Queue Health

**Function inventory (30 functions):**

| Category        | Count | Functions                                                                                                                                                                      |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounting      | 9     | daily-close, expense-ocr, period-reconciliation, post-expense-journal, post-order-journal, post-po-receive-journal, post-refund-journal, post-stock-adjustment, profit-anomaly |
| Bulk AI         | 4     | aeo, recommendations, seo, translate                                                                                                                                           |
| Orders/Commerce | 6     | created, refunded, whatsapp-notify, invoice-email, review-request, review-moderation                                                                                           |
| Analytics/BI    | 1     | daily-rollup                                                                                                                                                                   |
| Inventory       | 2     | deadstock-scan, reorder-scan                                                                                                                                                   |
| Ops             | 6     | audit-log-archive, data-retention, heartbeat, alerts-failure-watch, queue-depth-watch, gmail-alert-poller                                                                      |
| Cart/Import     | 1     | bulk-import                                                                                                                                                                    |

✅ **Retry config:** Bulk AI functions all have `retries: 2`. Accounting post functions have `retries: 3`. Alert/heartbeat have `retries: 0` (justified).

❌ **P1 — `bulk-import` has `retries: 0`.** A CSV import hitting Neon transient error or Railway restart leaves `BulkImportJob` row in `running` forever. Admin sees "import is running" indefinitely. **Fix:** `retries: 2` + catch block marks job `failed` on retry exhaustion.

✅ **Throttle/quota gates:** `THROTTLE_MS` (2500ms) on bulk-ai-translate. `AI_DAILY_REQUEST_CAP` / `AI_MONTHLY_REQUEST_CAP` via `lib/ai-quota.ts`. Quota errors throw distinctly (not retried), per-sweep failure list capped at 50.

✅ **Deploy-sync trap resolved:** `apps/api/src/lib/inngest/client.ts:174-181` auto-populates `INNGEST_DEPLOY_ID` from `RAILWAY_DEPLOYMENT_ID` at process start.

#### 2.7 Rate Limiting

**As of 2026-05-21 redesign (`apps/api/src/index.ts:198-261`):**

✅ Global limiter mutations-only (skip GET/HEAD/OPTIONS). Resolves status-polling 429 false-positives.

✅ `max: 200` mutations/15min/IP — comfortable for normal admin, blocks scripted abuse.

✅ Load-test bypass token: `LOAD_TEST_BYPASS_TOKEN` active only when env var set on Railway.

✅ Auth limiter: 5 attempts/15min on auth routes.

⚠️ **P3 — No mutation rate limiter for payment webhook endpoints.** Webhooks routed _before_ global limiter. Webhook handler has idempotency key enforcement (`Order.idempotencyKey`) — stronger guard than rate limiting. Low risk.

#### 2.8 Hot Path Latency Suspects

1. **`/storefront/products` list** — Redis 30s TTL cache per unique param combo. Cache-warm: ~2ms. Cache-miss: composite index then `take:limit` — fast at current catalog sizes.
2. **`/storefront/categories` tree** — `getCached` with 120s TTL. Safe at current depth (2 levels, 20 categories).
3. **Cart sync on login** — N-calls-per-item pattern (frontend bug per CLAUDE.md tech debt). At 5 items = 5 sequential write requests. ⚠️ P2.
4. **AI generation routes** — All through Inngest async. Correctly non-blocking.
5. **Bulk import** — Async via Inngest. CSV stored as TOAST text in `BulkImportJob.csvData`. Admin polls bounded.

#### 2.9 Throughput Ceiling

Per `project-fwb-api-throughput.md` (verified 2026-05-04 load test):

- **Current ceiling: ~190 req/s** on cached storefront read path, Railway 1GB/shared CPU.
- p95: ~520ms. p99: 1.08s. 0% failures at 200 req/s arrival.
- 2.3× improvement from 81 req/s baseline via `perf_indexes` migration + Redis TTL bumps.

**Postgres connection pool:** `DATABASE_URL` (Neon pooler 5432) + `DIRECT_URL` (port 5433 for migrations). `pgbouncer` in transaction mode. `SET LOCAL` GUCs safe in transaction mode.

**Scaling path:**

- 190–400 req/s: edge cache (`s-maxage` on storefront reads via Vercel CDN) absorbs peaks.
- 400+ req/s sustained: Railway Pro + multiple replicas + aggressive pre-warming.
- Neon connection limit: pooler multiplexes — not the bottleneck before Railway CPU.

#### 2.10 Backup/Restore Discipline

✅ All 4 pieces present: `scripts/rollback.sh`, `scripts/backup-db.sh`, `.github/workflows/neon-snapshot.yml`, `docs/ROLLBACK.md`.

⚠️ **P2 — `docs/ROLLBACK.md` references stale Vercel project names** (`force-admin-seven`, `force-web-sigma`). Canonical projects are `force-admin` and `force-web`. 3am rollback following ROLLBACK.md would navigate to wrong dashboards.

---

### Performance Regression Timeline

| Commit                            | Impact                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `20260501030000_perf_indexes`     | Composite indexes on products, orders, audit_logs, bulk_import_jobs. 2.3× req/s improvement by 2026-05-04 load test. |
| `20260404000000_add_rls_policies` | RLS activation adds `current_store_id()` overhead. Minimal at scale (function is `STABLE`).                          |
| `b6e6cd7` (TTL floor)             | Raised all Redis TTLs to ≥120s, reducing Neon compute on cache misses.                                               |
| `5126c20` (INNGEST_DEPLOY_ID)     | Fixed Inngest manifest stale-cache trap.                                                                             |
| 2026-05-19 to 20 accounting batch | 4 migrations / 15 new tables in 2 days. Inngest functions wrapped in `withRlsBypass`.                                |
| 2026-05-21 limiter redesign       | Mutations-only global limiter, resolving 429 false-positives.                                                        |

---

### Top 5 P0/P1 Performance/Data Risks

**P1.1 — 8 tables with no RLS** (blog, FAQ, howto, AI jobs/usage/recs, OneSignal subs)
Application-layer `WHERE storeId` filters still work, but no DB-level backstop. **Fix:** One migration adding `ALTER TABLE + CREATE POLICY` for all 8 using `current_store_id() IS NULL OR store_id = current_store_id()`.

**P1.2 — `bulk-import` Inngest function `retries: 0`**
Transient error leaves `BulkImportJob` permanently `running`. **Fix:** `retries: 2` + catch block marks job `failed` on exhaustion.

**P1.3 — `docs/ROLLBACK.md` references stale Vercel projects**
3am rollback following the doc would hit wrong dashboards. **Fix:** Update to `force-admin` / `force-web`.

**P2.1 — Cart sync on login is per-item N sequential API calls**
At 5 items = 5 sequential POST requests. Visible multi-second stall on mobile. **Fix:** `POST /stores/:id/cart/sync` bulk endpoint.

**P2.2 — `loyalty-automation.service.ts:112` unbounded findMany**
Per-store scan, no `take` cap. 10k members × 200 bytes = 2MB per store memory spike during cron. **Fix:** `take: 500` + cursor batching.
