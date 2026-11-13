# Ebda Store on Cloudflare only: detailed executable plan

## 0. Corrections folded in (read first)

- Prisma is **6.19.3** (`apps/api/package.json`), not 7. The draft's "Prisma 7 supports D1/DO via adapters" is not the baseline here.
- `apps/api` is **already a Cloudflare Worker on workerd** (`ebda-api`, Express via `httpServerHandler`) **with Durable Objects** (`AUTH_STATE`, `STORE_REALTIME`, `apps/api/wrangler.jsonc`); the migration changes the data layer, not the runtime.
- Reuse, do not redo: `docs/ebda/design/cloudflare-backend.md`, `docs/ebda/design/cloudflare-backend-inventory.md` (the draft cites them as `docs/design/...`) and `spikes/workers-api` (Prisma 6 + pg adapter + pgbouncer isolation spike).
- Phase 0 is spike-only: its code lives in `spikes/store-do/`, production money paths are untouched, the DO backend is reachable only behind the `STORE_DO_ENABLED_IDS` flag (default empty), and `qa-walk-store-1010` is never used.
- Phase 0 exit gate is decided by a written go/no-go memo (task 0.7), then work stops for the controller.

---

## Source draft (2026-10-24, kept for the target-architecture table and risks)

Ruling INFRA-CF-1 (Ahmad, 2026-10-24). The launch waits for this. Draft written at 96% weekly usage. After the reset, expand it into bite-sized tasks with the `superpowers:writing-plans` skill and commit it as `ebda-store/docs/plans/done/2026-10-28-store-on-cloudflare.md`.

## Finish line

- **Must work:** every Ebda Store flow (signup, admin, editor, storefront, cart, checkout with COD/InstaPay/Kashier, orders, shipping, gold pricing, lifecycle email, search) runs with ZERO Neon/Postgres dependencies.
- **Exercised by:** the full unit, integration and e2e suites, the 5 template matrices, the builder e2e, money/stock/gold invariant tests and a load test at the audit level (≥200 req/min, 10 min), all against Cloudflare (workerd).
- **Must NOT change:** public URLs and API contracts, the merchant UX, the money rules (piastres, refunds, COD), tenant isolation guarantees and Arabic-first behaviour.
- **Done =** Neon project `lucky-truth-54548746` deleted after a 7-day clean run; `/health` reports the CF storage backend; Sentry is clean for 7 days; CF bill ≤ projection.

## Target architecture

| Concern                                                                                                            | Today                      | Cloudflare                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Store data (catalogue, orders, customers, carts, content, gold, coupons…)                                          | Postgres, 270 RLS policies | **One Durable Object per store, SQLite storage** (`StoreDO`). Isolation by construction: a request can only reach its own store's DO.                                    |
| Concurrency (stock, money, gold, coupon limits)                                                                    | 43 `FOR UPDATE` row locks  | The DO is single-threaded per store, so the critical sections are serialised (write a single-writer rule per DO method; transactions via `ctx.storage.transactionSync`). |
| Platform data (users, sessions/passkeys, store directory host→store, plans/billing, super-admin, provider configs) | Postgres                   | **D1** `ebda-platform` (small, read-mostly)                                                                                                                              |
| SQL functions/triggers (93)                                                                                        | Postgres                   | Application code inside the DO methods (enumerate each one and port it with a test)                                                                                      |
| Search                                                                                                             | Postgres + external        | SQLite FTS5 inside each StoreDO, plus Vectorize for semantic search                                                                                                      |
| Cross-store analytics, Customer Intelligence                                                                       | SQL across tenants         | Analytics Engine plus the `commerce_outcomes` events to R2 (Parquet/NDJSON)                                                                                              |
| Background jobs                                                                                                    | Inngest (95 fns)           | Keep Inngest (it's an HTTP service, already Cloudflare-compatible); move per-store crons to **DO alarms** where they touch a single store (cuts Inngest executions)      |
| Caches                                                                                                             | KV / edge                  | Unchanged; most now become unnecessary (DO reads are local and fast)                                                                                                     |
| Media                                                                                                              | R2                         | Unchanged                                                                                                                                                                |
| Backups                                                                                                            | daily pg_dump              | A nightly alarm in each StoreDO exports to R2 (`backups/<store>/<date>.sqlite`), D1 Time Travel plus a nightly export, row-count asserts (rule N11)                      |

### ORM

Prisma 7 supports D1 and DO SQLite through driver adapters, but the per-request client pool and the wasm compiler (#177) are exactly the cost we're leaving behind. **Decision for task 1 (spike):** Drizzle (native DO SQLite plus D1, no wasm engine) vs Prisma-on-DO. Pick the one with zero per-request engine construction. Expected: Drizzle.

## Draft phases (each ends merged, deployed and verified; nothing big-bang)

0. **Spike (2–3 days):** a StoreDO with the SQLite schema for 5 core tables (store, product, variant, cart, order), Drizzle, behind a feature flag on ONE demo store; measure cold and warm latency, the cost per request and the DO alarm backup. Gate: p95 below today's and the backup restores.
1. **Schema port:** generate the SQLite schema from `schema.prisma` (146 models → split into platform (D1) vs store (DO)); enums become CHECK constraints; JSON stays TEXT JSON; money stays integer piastres. A parity test compares the model list and fields to the Prisma schema. `StaffInvite` (`staff_invites`, added 2026-10-24, Ruling ID-13) is a store table: it ports into the StoreDO schema beside `store_staff`, with the same single-transaction consume-and-create rule.
2. **Data access layer:** a `StoreRepo` interface implemented for BOTH Postgres (today) and the DO, so services switch per store via a flag. The 233 raw SQL sites get rewritten behind the repo.
3. **Money and stock correctness:** port checkout, the stock reservation, coupons (distinct-code limiter), gold repricing, refunds, COD and InstaPay holds; the 93 functions/triggers become explicit DO methods. Gate: every money/stock invariant test is green on the DO backend, plus a concurrency test (100 parallel checkouts on one SKU).
4. **Migration tooling:** a per-store export from Postgres into the StoreDO (idempotent, row-count and checksum verified) plus the platform data into D1. Dry-run on a copy.
5. **Cutover per store:** demo stores first (storedemo\*), then qa-walk last. Dual-read verification window, then the flag flips. Rollback = flip the flag back (Postgres stays read-only until the end).
6. **Jobs:** per-store crons → DO alarms; Inngest stays for cross-store and event fan-out (stays inside the cron budget).
7. **Decommission:** remove Prisma/pg/Hyperdrive and the client pool (#161/#168/#177 code), delete the Neon project after 7 clean days, update the docs (DEPLOYMENT, INCIDENT, CLAUDE.md) and the backups (launchd job).

## Risks

- Size: 146 models, 212 migrations, 233 raw SQL sites, 93 functions/triggers. Mitigation: the repo interface plus per-phase gates, porting the money flows LAST.
- Cross-store queries (super-admin lists, platform search): they must go through the D1 directory or Analytics Engine, never a fan-out to every DO in a request.
- DO hot-spotting: one viral store = one DO. A DO handles ~1k req/s of light work; reads cache at the edge (as today), and only writes reach the DO.
- Prisma-specific behaviour the tests assume (error codes, decimal handling). Mitigation: the repo-level contract tests from phase 2.

## Estimate (guess)

Phases 0–3 ≈ 2–3 weeks of agent work; 4–7 ≈ 1–2 weeks. Launch moves to roughly late November 2026. Refine after the phase-0 spike.

---

## Detailed plan

> For agentic workers: use `superpowers:subagent-driven-development` (or `superpowers:executing-plans`) task by task. Steps use `- [ ]`. Ruling INFRA-CF-1 (Ahmad, 2026-10-24). Source draft: `2026-10-24-store-on-cloudflare.md`. Commit this file as `ebda-store/docs/plans/done/2026-10-28-store-on-cloudflare.md`.

**Goal:** Ebda Store runs with zero Neon/Postgres: one SQLite Durable Object per store (`StoreDO`) plus D1 `ebda-platform`, R2 and Analytics Engine.
**Architecture:** see the draft's target-architecture table. Repo root: `internal-projects/ebda-store` (read-only root; work in a worktree via `new-task-worktree.sh ebda-store feat/<task>`).
**Finish line:** unchanged from the draft (suites green on workerd, money/stock/gold invariants, 5 template matrices, builder e2e, load test, Neon deleted after 7 clean days).
**Evidence labels:** file:line cites below are measured (grep on 2026-10-24 tree); effort numbers are guesses.

## 1. Model split table (146 models)

Counts are generated by the script check at the bottom of this section. Rule: storeId read in one store context = StoreDO; identity, host directory, plans/billing, super-admin, pre-store lookups and cross-store indexes = D1. Models without a storeId column (child tables) follow their parent.

| #   | Model                      | schema.prisma line | Target       | Reason                                                                                  |
| --- | -------------------------- | ------------------ | ------------ | --------------------------------------------------------------------------------------- |
| 1   | User                       | 31                 | D1 platform  | identity: global login, one user spans stores                                           |
| 2   | RefreshToken               | 144                | D1 platform  | identity: global login, one user spans stores                                           |
| 3   | VerificationToken          | 167                | D1 platform  | identity: global login, one user spans stores                                           |
| 4   | Store                      | 194                | D1 platform  | host/slug directory: resolves host to store before any DO is reachable                  |
| 5   | StoreCredential            | 554                | StoreDO      | storeId-scoped, read only in one store context                                          |
| 6   | StoreStaff                 | 578                | D1 platform  | staff login resolves cross-store membership by user                                     |
| 7   | SlugRedirect               | 609                | D1 platform  | host/slug directory: resolves host to store before any DO is reachable                  |
| 8   | BlogPost                   | 637                | StoreDO      | storeId-scoped, read only in one store context                                          |
| 9   | StoreLocation              | 663                | StoreDO      | storeId-scoped, read only in one store context                                          |
| 10  | StorePage                  | 708                | StoreDO      | storeId-scoped, read only in one store context                                          |
| 11  | Customer                   | 729                | StoreDO      | storeId-scoped customer; email to store lookup for storefront login stays inside the DO |
| 12  | CustomerGroup              | 795                | StoreDO      | storeId-scoped, read only in one store context                                          |
| 13  | CustomerAddress            | 831                | StoreDO      | storeId-scoped, read only in one store context                                          |
| 14  | Category                   | 880                | StoreDO      | storeId-scoped, read only in one store context                                          |
| 15  | Product                    | 926                | StoreDO      | storeId-scoped, read only in one store context                                          |
| 16  | InventoryHistory           | 1118               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 17  | ProductImage               | 1152               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 18  | ProductCategory            | 1166               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 19  | Tag                        | 1179               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 20  | ProductTag                 | 1195               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 21  | ProductOption              | 1212               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 22  | ProductOptionValue         | 1228               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 23  | ProductVariant             | 1248               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 24  | ProductModel               | 1299               | StoreDO      | 3D/AR models per store                                                                  |
| 25  | SearchQueryDaily           | 1336               | analytics/R2 | high-volume daily metric/log, cross-store aggregation, no transactional reads           |
| 26  | ProductEmbedding           | 1361               | analytics/R2 | vector index (Vectorize), rebuilt from Product                                          |
| 27  | ProductPriceTier           | 1387               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 28  | WholesaleApplication       | 1419               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 29  | ProductEmbedFailure        | 1453               | drop         | Vectorize upsert failures go to Sentry plus a retry alarm in the DO                     |
| 30  | SizeChart                  | 1476               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 31  | ProductModelBinding        | 1502               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 32  | ProductVariantOption       | 1526               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 33  | Cart                       | 1542               | StoreDO      | storeId-scoped; hot write path, single-writer                                           |
| 34  | CartItem                   | 1571               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 35  | Bundle                     | 1615               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 36  | BundleItem                 | 1641               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 37  | CartBundle                 | 1659               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 38  | Order                      | 1681               | StoreDO      | storeId-scoped; money/stock single-writer                                               |
| 39  | OrderEvent                 | 1913               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 40  | OrderItem                  | 1963               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 41  | Payment                    | 2034               | StoreDO      | child of Order; same DO transaction                                                     |
| 42  | PaymentEvent               | 2078               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 43  | WebhookEvent               | 2144               | D1 platform  | looked up by secret/id BEFORE the store is known (needs global index)                   |
| 44  | Return                     | 2214               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 45  | ReturnItem                 | 2268               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 46  | PaymentConfig              | 2320               | StoreDO      | per-store provider config (encrypted secrets stay encrypted at rest)                    |
| 47  | SystemSetting              | 2406               | D1 platform  | platform settings / legal / super-admin queue, cross-store                              |
| 48  | LegalAcceptance            | 2427               | D1 platform  | platform settings / legal / super-admin queue, cross-store                              |
| 49  | PasskeyCredential          | 2446               | D1 platform  | identity: global login, one user spans stores                                           |
| 50  | LegalNoticeSend            | 2468               | D1 platform  | platform settings / legal / super-admin queue, cross-store                              |
| 51  | LegalNoticeDelivery        | 2485               | D1 platform  | platform settings / legal / super-admin queue, cross-store                              |
| 52  | StoreFeature               | 2506               | D1 platform  | platform settings / legal / super-admin queue, cross-store                              |
| 53  | NotificationConfig         | 2528               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 54  | NotificationEventConfig    | 2545               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 55  | PushSubscription           | 2560               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 56  | OneSignalSubscription      | 2584               | StoreDO      | push subscription; no storeId, hangs off Customer inside the DO                         |
| 57  | NotificationLog            | 2599               | analytics/R2 | high-volume daily metric/log, cross-store aggregation, no transactional reads           |
| 58  | AbandonedCart              | 2627               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 59  | AbandonedCartConfig        | 2671               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 60  | ProductRelation            | 2701               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 61  | FrequentlyBoughtTogether   | 2722               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 62  | AiRecommendation           | 2757               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 63  | ShippingCarrierConfig      | 2781               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 64  | Shipment                   | 2809               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 65  | ShipmentPickup             | 2855               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 66  | CodRemittance              | 2895               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 67  | Affiliate                  | 2926               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 68  | AffiliateReferral          | 2959               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 69  | AffiliatePayout            | 2985               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 70  | AffiliateConfig            | 3007               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 71  | AffiliateEvent             | 3028               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 72  | AuditLog                   | 3056               | StoreDO      | per-store append-only; nightly rollover of old rows to R2                               |
| 73  | Address                    | 3086               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 74  | Wishlist                   | 3124               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 75  | WishlistItem               | 3143               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 76  | Coupon                     | 3161               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 77  | Promotion                  | 3205               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 78  | ShippingZone               | 3252               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 79  | ShippingAreaRate           | 3276               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 80  | TaxRate                    | 3302               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 81  | LoyaltyPoints              | 3327               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 82  | LoyaltyTransaction         | 3347               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 83  | CustomerWallet             | 3425               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 84  | WalletTransaction          | 3455               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 85  | NewsletterSubscriber       | 3510               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 86  | SmsMarketingConsent        | 3562               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 87  | Campaign                   | 3613               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 88  | CampaignRecipient          | 3650               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 89  | Review                     | 3688               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 90  | BulkImportJob              | 3737               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 91  | BulkAiJob                  | 3782               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 92  | AiUsage                    | 3862               | analytics/R2 | high-volume daily metric/log, cross-store aggregation, no transactional reads           |
| 93  | StoreFaq                   | 3901               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 94  | StoreHowto                 | 3922               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 95  | ProductFaq                 | 3948               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 96  | Sequence                   | 3993               | StoreDO      | counter: single-writer increment replaces FOR UPDATE                                    |
| 97  | Account                    | 4007               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 98  | JournalEntry               | 4035               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 99  | JournalLine                | 4062               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 100 | FxRateEntry                | 4103               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 101 | Supplier                   | 4164               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 102 | PurchaseOrder              | 4196               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 103 | PurchaseOrderItem          | 4231               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 104 | StockAdjustment            | 4254               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 105 | StockAdjustmentItem        | 4283               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 106 | ReorderRule                | 4304               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 107 | BackorderLine              | 4331               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 108 | Expense                    | 4364               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 109 | ReorderSuggestion          | 4449               | StoreDO      | derived per-store suggestion                                                            |
| 110 | DeadStockFlag              | 4483               | StoreDO      | derived per-store flag                                                                  |
| 111 | ProfitAnomaly              | 4511               | StoreDO      | derived per-store alert                                                                 |
| 112 | CustomerCohortSnapshot     | 4555               | StoreDO      | derived snapshot, read per store dashboard                                              |
| 113 | FunnelSnapshot             | 4573               | StoreDO      | derived snapshot, read per store dashboard                                              |
| 114 | CustomerRfmSnapshot        | 4593               | StoreDO      | derived snapshot, read per store dashboard                                              |
| 115 | StoreUsageSnapshot         | 4637               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 116 | ProductDailyView           | 4697               | analytics/R2 | high-volume daily metric/log, cross-store aggregation, no transactional reads           |
| 117 | GscDailyMetric             | 4716               | analytics/R2 | high-volume daily metric/log, cross-store aggregation, no transactional reads           |
| 118 | CountSession               | 4753               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 119 | CountLine                  | 4774               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 120 | WhatsAppTemplate           | 4804               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 121 | BankStatement              | 4848               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 122 | BankTransaction            | 4869               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 123 | Warehouse                  | 4901               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 124 | WarehouseStock             | 4929               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 125 | AnswerEngineCheck          | 4968               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 126 | AnswerEngineProviderConfig | 4995               | D1 platform  | platform settings / legal / super-admin queue, cross-store                              |
| 127 | MerchantApiKey             | 5020               | D1 platform  | looked up by secret/id BEFORE the store is known (needs global index)                   |
| 128 | Plan                       | 5072               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 129 | StoreSubscription          | 5106               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 130 | BillingEvent               | 5170               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 131 | InstapayReceipt            | 5216               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 132 | ManualPaymentClaim         | 5273               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 133 | BillingReminder            | 5306               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 134 | StoreLifecycleEmail        | 5328               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 135 | BillingWebhookEvent        | 5351               | D1 platform  | plans/billing: platform-owned, read by super-admin across stores                        |
| 136 | StorePageRevision          | 5377               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 137 | StoreTaxProfile            | 5441               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 138 | StoreTaxDocument           | 5475               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 139 | ProviderActivationRequest  | 5501               | D1 platform  | platform settings / legal / super-admin queue, cross-store                              |
| 140 | FiscalDocument             | 5539               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 141 | FiscalDocumentCounter      | 5588               | StoreDO      | storeId-scoped, read only in one store context                                          |
| 142 | WebhookEndpoint            | 5606               | StoreDO      | per-store config                                                                        |
| 143 | WebhookDelivery            | 5640               | StoreDO      | per-store outbound delivery log; old rows rolled to R2                                  |
| 144 | GoldRate                   | 5683               | StoreDO      | per-store gold rate history (has storeId)                                               |
| 145 | GoldRateCurrent            | 5710               | StoreDO      | per-store current rate; single-row, alarm-refreshed                                     |
| 146 | GoldRateSettings           | 5725               | StoreDO      | per-store settings                                                                      |

Totals: 146 models; D1 platform 25, StoreDO 114, analytics/R2 6, drop 1.

Notes:

- `Store` is split: D1 keeps the directory row (id, slug, host/domains, plan, status, owner); the StoreDO keeps a settings copy (theme, currency, gold config, flags) refreshed by a write-through on every settings change. Task 1.4 defines the exact column split.
- Prisma `Decimal` columns (for example FxRateEntry.rate, Decimal(16,8) at schema.prisma:4103) become INTEGER micro-units or TEXT decimal; the parity test (task 1.6) lists every Decimal field and its chosen representation. Money columns are already integer piastres and stay so.
- Cross-store reads that the D1 rule cannot serve (super-admin store lists, platform search) read the D1 directory plus `StoreUsageSnapshot`; no request fans out to every DO.
- Verify with: `rg -c '^model ' packages/database/prisma/schema.prisma` returns 146 and the table above has 146 rows.

---

## 2. Function and trigger inventory

Measured: `grep -inE '^\s*CREATE (OR REPLACE )?(FUNCTION|TRIGGER)' -r packages/database/prisma/migrations --include='*.sql'` finds **88 definitions in `migration.sql` files** (rollback.sql copies excluded; the draft's "93" counts those). Several are redefinitions of one function (`current_store_id` x3, `ebda_product_embed_doc` x2, `ebda_order_search_ids` x2). Cites are `<migration dir>/migration.sql:<line>` under `packages/database/prisma/migrations/`; `M1004` = `20261004000000_ebda_strict_rls`, `M1008` = `20261008000010_tenant_defence_expand`.

**Global rule:** the 270 RLS policies, `current_store_id()`, `current_user_id()`, `ebda_is_super_admin`, `ebda_may_act_on_user`, `ebda_is_system_job` and every `SECURITY DEFINER` "lookup around RLS" helper exist only because Postgres shares tables across tenants. In the DO model they vanish: isolation is "the request reaches only its own StoreDO"; cross-store lookups become D1 queries by the platform repo. Each replaced helper still gets a contract test (cell "Test").

### 2.1 Tenant isolation helpers (deleted by construction)

| Definition                                                                                                                                | What it does                     | Replacement                                                                                                  | Test                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `current_store_id()` 20260404000000_add_rls_policies:73, 20260609000000_complete_force_rls_coverage:41, 20260615000000_multi_warehouse:22 | reads `app.store_id` GUC for RLS | none: `StoreDO` id = store id; `getStore(env, storeId)` is the only entry                                    | cross-store attempt returns 404 (tenant isolation test) |
| `current_user_id()` 20260702170000_rls_close_denyall_tables:55                                                                            | reads user GUC for RLS           | none: user id comes from the session in the Worker; platform repo takes `userId` explicitly                  | session test                                            |
| `ebda_is_super_admin()` M1004:237, `ebda_may_act_on_user()` M1004:265, `ebda_is_system_job()` M1004:297                                   | RLS predicates                   | `requireSuperAdmin(ctx)` guard in the platform repo; `systemJob` capability check on Inngest-signed requests | authz tests                                             |

### 2.2 Directory and resolution (SECURITY DEFINER lookups) -> D1 `PlatformRepo`

| Definition                                                                                                                                                                                                                                                                       | Replacement                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `ebda_resolve_store_id(slug, domain)` M1004:1019; `ebda_store_id_by_slug` M1008:111; `ebda_store_id_by_domain` M1008:119; `ebda_store_ids_claiming_domain` M1008:127                                                                                                             | `platform.resolveStore({slug                                                                                                                                                                                                   | host})`against D1`stores`/`domains`/`slug_redirects` (unique indexes) |
| `ebda_store_lookup` M1008:90; `ebda_store_directory` M1008:141; `ebda_public_store_page` M1008:169; `ebda_owned_store_ids` M1008:195                                                                                                                                             | `platform.getStore`, `platform.listStores`, `platform.listPublicStores(cursor)`, `platform.listOwnedStoreIds(ownerId)`                                                                                                         |
| `ebda_wbs_bridge_keys` M1008:215                                                                                                                                                                                                                                                 | `platform.listBridgeKeys()` (D1)                                                                                                                                                                                               |
| `ebda_plan_subscriber_counts` M1004:1645; `ebda_plan_store_ids` M1004:1659                                                                                                                                                                                                       | `platform.planSubscriberCounts()`, `platform.storeIdsOnPlan(code)` (D1 `store_subscriptions`)                                                                                                                                  |
| `ebda_entity_store_id(kind,id)` M1004:1539; `ebda_order_store_id` M1004:1289; `ebda_payment_store_id` 20261004150000_egypt_gateways:20; `ebda_shipment_store_id_by_tracking` M1004:1463; `ebda_storefront_for_payment_ref` M1004:1447; `ebda_billing_refund_store_id` M1004:1560 | **D1 `entity_index(kind,id,store_id)`** written by the DO on create (outbox to D1, retried by alarm); `platform.storeIdForEntity(kind,id)`. Risk: index lag; task 3.5 makes creation write the index BEFORE the id is returned |
| `ebda_store_credentials_mirror` fn 20261008000010:53 + trigger `stores_credentials_mirror` :75                                                                                                                                                                                   | mirrors store credentials into `store_credentials` for lookups: dropped; credentials live in the DO, D1 holds only the directory fields                                                                                        |

### 2.3 Identity (D1)

| Definition                                                                                                                                                                                        | Replacement                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ebda_auth_find_user_id` M1004:1053; `ebda_user_state` M1004:1037; `ebda_admin_user_ensure` M1004:1076                                                                                            | `platform.findUserByEmail`, `platform.getUserState`, `platform.ensureAdminUser`                              |
| `ebda_refresh_token_user` M1008:237; `ebda_verification_token_user` M1008:246; `ebda_refresh_tokens_purge` M1008:257; `ebda_user_tokens_delete` M1008:281; `ebda_user_revoke_sessions` M1004:1483 | `platform.tokenUser`, `platform.purgeTokens` (D1 cron), `platform.revokeSessions(userId)`                    |
| `ebda_passkey_lookup` 20261029000100_passkey_credentials:50; `ebda_passkeys_delete` :61                                                                                                           | `platform.passkeyByCredentialId`, `platform.deletePasskeys(userId)`                                          |
| `ebda_user_addresses_delete` M1004:1514                                                                                                                                                           | erasure fan-out: platform enqueues `eraseUser` to each StoreDO the user touched (list from D1 `user_stores`) |
| `ebda_admin_push_player_ids` M1008:309                                                                                                                                                            | `platform.adminPushPlayerIds(role, storeId)`                                                                 |
| `ebda_sms_consent_lookup` M1004:1629                                                                                                                                                              | `StoreDO.smsConsent(id)` (id routed via entity_index)                                                        |
| `ebda_withdraw_legal_notice_send` 20261017000200_legal_notice_send_withdraw:19                                                                                                                    | `platform.withdrawLegalNotice(id)` (D1)                                                                      |

### 2.4 Webhook inbox (D1, routed by provider ref)

`ebda_webhook_resolve_store` M1004:1264; `ebda_webhook_order_by_idempotency` M1004:1278; `ebda_webhook_inbox_record` M1004:1306, `_get` :1336, `_update` :1353, `_stuck` :1390; `ebda_platform_webhook_inbox_list` M1004:1412. -> D1 `webhook_inbox` (unique `(provider,idempotency_key)` replaces ON CONFLICT logic) with `platform.webhookInbox.{record,get,update,listStuck,list}`; the processing step calls `StoreDO.applyPaymentEvent`. Test: replayed webhook is idempotent; stuck-row sweep.

### 2.5 Audit log

`ebda_audit_log_insert` M1004:1115; `_exists` :1180; `ebda_audit_logs_detach_store` :1139; `ebda_audit_logs_unlink_user` :1159; `_retention_count` :1197, `_retention_page` :1214, `_retention_purge` :1235; `ebda_platform_audit_log_list` :1575. -> `StoreDO.audit.{insert,exists,purge(cutoff)}` with a nightly alarm rolling old rows to R2; platform-level actions in D1 `platform_audit_log`; `platform.listAuditLog` reads D1 (store actions mirrored as summary rows). `detach_store` becomes "delete the DO" at store deletion; `unlink_user` becomes `eraseUser`.

### 2.6 Billing, plans, usage

| Definition                                                                                              | Replacement                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing_events_guard()` 20261003150000_billing_events_and_dunning:56 + triggers :84, :86 (append-only) | D1 has no triggers: repo exposes only `insertBillingEvent`; add D1 `CREATE TRIGGER ... RAISE(ABORT)` for UPDATE/DELETE (D1 supports SQLite triggers) |
| `ebda_ai_usage_count` M1004:1611                                                                        | `analytics.aiUsageCount(storeId, window)` (Analytics Engine SQL)                                                                                     |
| `platform_vat_setting_guard()` 20261007140000_vat_gate:185 + trigger :203                               | `platform.setVatSetting` validates; SQLite `CHECK` plus D1 trigger as defence                                                                        |
| `tax_profile_review_guard()` vat_gate:99 + trigger :130; `ebda_tax_profiles_for_review` vat_gate:139    | guard moves into `StoreDO.taxProfile.submit/review` (state machine); the super-admin review list reads D1 `tax_review_queue` fed by the DO           |

### 2.7 Fiscal, accounting, counters (StoreDO, SQLite triggers kept where they are pure row guards)

| Definition                                                                              | Replacement                                                                                                                       |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `fiscal_documents_immutable()` 20261008160000_fiscal_documents_expand:90 + trigger :136 | keep as SQLite `BEFORE UPDATE/DELETE ... RAISE(ABORT)` trigger in the DO schema (pure row guard)                                  |
| `ebda_fiscal_archive(store)` :158; `ebda_fiscal_archive_stores()` :200                  | `StoreDO.fiscal.archiveOld()` run by a DO alarm; the store list function disappears                                               |
| `journal_entry_dr_cr_balance_check()` 20260519100000_accounting_foundations:140         | `StoreDO.ledger.post(entry)` asserts sum(debit)=sum(credit) inside `transactionSync`; plus a deferred SQLite check query in tests |
| `set_updated_at()` 20260615000000_barcode_scanning:138 + trigger :147                   | repo layer sets `updated_at` on every write (one helper); no trigger                                                              |

### 2.8 Gold pricing

`gold_price_guard_products()` 20261102000200_gold_rate_pricing:190, `gold_price_guard_variants()` :206, triggers `ebda_gold_price_guard` :228 and :230 (reject manual price edits on gold-priced rows). -> `StoreDO.catalog.updateProduct/Variant` rejects price/compare_at/pricing_mode writes when `pricing_mode='gold'` (single method, plus SQLite trigger copy for defence). `ebda_gold_feed_stores()` :242 and `ebda_gold_rate_watch()` :258 -> the gold feed becomes a platform cron that posts the rate to each subscribed StoreDO (`StoreDO.gold.applyRate`) via a Queue; the DO reprices and the "watch" threshold runs in `applyRate`.

### 2.9 Search

| Definition                                                                                                                                                                                                                                                    | Replacement                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ebda_ar_norm(t)` 20261019000100_search_normalisation:44; `ebda_digits(t)` 20261027000100_admin_search_norm:25                                                                                                                                                | TypeScript `normaliseArabic()` / `digitsOnly()` shared by indexer and query (one function, both sides) |
| `ebda_product_search_doc` search_normalisation:56; `ebda_product_name_doc` :65; `ebda_product_embed_doc` 20261022000100_product_embeddings:36 (redefined 20261024000100_embed_doc_without_search_terms:31)                                                    | TS `buildProductDoc()` used for the FTS5 row and the Vectorize embedding text                          |
| `ebda_product_search_ids` 20261024000300_search_ids_definer:28; `ebda_order_search_ids` 20261024000500_order_customer_search_ids:29 (and 20261029000300_contract_unused_search_definers:28); `ebda_customer_search_ids` 20261027000200_customer_search_ids:25 | `StoreDO.search.{products,orders,customers}(q)` over FTS5 virtual tables                               |

### 2.10 Coverage check

- [ ] Task 1.5 writes `scripts/cf/fn-inventory.test.ts`: it greps the migrations for every `CREATE FUNCTION|TRIGGER` name and fails if a name is absent from a checked-in `docs/cf/fn-map.json` (name -> replacement method). Done = test green and 88/88 mapped.

---

## 3. Raw SQL inventory

Measured: `rg -n '\$(queryRaw|executeRaw)(Unsafe)?\b' apps packages scripts -g '*.ts' -g '*.tsx' -g '*.mjs'` excluding `*.test.*`, `*.spec.*`, `tests/`, `spikes/`, `loadtests/` = **279 call sites in 77 files** (the draft's 233 predates recent search/gold work; tests add ~580 more mentions, which move with the repo). Existing design notes to reuse, not redo: `docs/ebda/design/cloudflare-backend.md`, `docs/ebda/design/cloudflare-backend-inventory.md`, and the `spikes/workers-api` spike.

Paths below are relative to `apps/api/src/` unless prefixed. "Repo" = a method on `StoreRepo` (DO) or `PlatformRepo` (D1), defined in task 2.1.

| Group                                                          | Sites | Files (file:first line)                                                                                                                                                                                                                                                                                                                                                                                                                                            | Target repo method                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. SECURITY DEFINER wrappers (exactly the section-2 functions) | 55    | `lib/definer.ts:23..856` (resolveStoreId :18, getUserState :38, insertAuditLog :96, ensureAdminUser :124, passkeyLookup :855 ...)                                                                                                                                                                                                                                                                                                                                  | `PlatformRepo.*` as mapped in 2.2 to 2.6; `definer.ts` is deleted in 7.1                                                                                                                                                                    |
| B. Tenant-context plumbing (GUCs, guards, savepoint, retry)    | 32    | `packages/database/src/index.ts` (12), `tenant-guard.ts` (10), `tenant-gucs.ts` (2), `client.ts` (2), `lib/savepoint.ts` (5), `lib/db-retry.ts` (1)                                                                                                                                                                                                                                                                                                                | none: deleted (isolation is the DO boundary). `docs/security/defence-mutations.json` mutation tests are replaced by the cross-DO isolation test (task 3.8)                                                                                  |
| C. Money, stock, orders                                        | 31    | `services/inventory-decrement.ts:41..96` (6), `services/inventory.service.ts:50..229` (5), `services/warehouse.service.ts:691..954` (11), `lib/stock-hold-cap.ts:155,160` (4 incl. type decls), `services/order.service.ts:1628`, `services/return.service.ts:215,233`, `services/wallet.service.ts:175,183`, `services/loyalty.service.ts:153`, `services/payment-providers/instapay.service.ts:91`, `lib/effective-inventory-sql.ts:77`                          | `StoreRepo.stock.{decrement,reserve,release,syncAggregate}`, `orders.create/lockForRefund`, `wallet.debit/credit`, `loyalty.adjust`, `payments.instapay.{confirm,expire}` (see section 4)                                                   |
| D. Refunds, journals, accounting                               | 23    | `lib/inngest/functions/order-refunded.ts:267..1141` (6), `services/accounting/posting/{refund-posting.ts:56,partial-return-posting.ts:170,553}`, `accounting/{reorder-scan.service.ts (5),reports.service.ts (4),tax-report.service.ts (3),deadstock-scan.service.ts (3),bank-reconcile.service.ts (2),backorder-stock-heal.ts:42}`, `lib/inngest/functions/accounting-{daily-close,period-reconciliation}.ts`, `services/fiscal-document.service.ts:260`          | `StoreRepo.ledger.{post,reverse,lockEntry}`, `accounting.reports.{trialBalance,taxReport}`, `inventory.scan.{reorder,deadstock}`; reports become SQLite aggregate queries inside the DO                                                     |
| E. Gold pricing                                                | 16    | `services/gold-rate/gold-rate.service.ts:185..630` (8), `repricer.ts:85..205` (6), `gate.ts:96` (1), `scripts/gold-rate/freeze-all.mjs`                                                                                                                                                                                                                                                                                                                            | `StoreRepo.gold.{setRate,applyRate,reprice,gateRead}`; the `app.gold_reprice` GUC (repricer.ts:86,89) becomes an in-method flag                                                                                                             |
| F. Search and indexing                                         | 23    | `services/product-index.service.ts:105..430` (12), `product-search.service.ts:118..388` (6), `customer-search.service.ts:45`, `admin-search.service.ts:71`, `lib/order-search-ids.ts:32`, `lib/inngest/functions/bulk-ai-recommendations.ts:106`, `services/ai-autofill.service.ts:380`, `routes/ai.routes.ts:884..894`                                                                                                                                            | `StoreRepo.search.{products,orders,customers}` (FTS5) and `index.{upsert,remove,queueEmbedding}` (Vectorize); `admin-search` hits the D1 directory                                                                                          |
| G. Analytics and logs                                          | 14    | `services/analytics.service.ts:315..977` (6), `search-log.service.ts:168..257` (4), `view-ingest.service.ts:97`, `routes/insights.routes.ts:112`, `routes/admin.routes.ts:1779`, `lib/inngest/functions/store-usage-snapshot.ts:86`, `services/abandoned-cart.service.ts:1058`                                                                                                                                                                                     | per-store dashboards: `StoreRepo.stats.*` (SQLite aggregates); cross-store (`admin.routes.ts:1779`, `store-usage-snapshot.ts:86`): Analytics Engine / D1 `store_usage`                                                                      |
| H. Store lifecycle                                             | 14    | `services/store.service.ts:653..750` (11: hard-delete cascade DELETEs), `services/store-closure.service.ts:40,106,148`, `lib/r2-references.ts` (9), `services/r2-cleanup.service.ts:132`                                                                                                                                                                                                                                                                           | `PlatformRepo.deleteStore` + `StoreDO.destroy()` (deleteAll) replaces the 9 cascade DELETEs; `r2-references.ts` scans DO tables per store instead of Postgres catalog stats; `statement_timeout` (r2-cleanup:132) has no equivalent: remove |
| I. Catalogue/cart/misc                                         | 27    | `services/product.service.ts:1020,1601`, `barcode-scan.service.ts:328`, `campaign.service.ts:127`, `sequence.service.ts:52`, `sms-consent.service.ts:94`, `legal-notice.service.ts:264`, `shipping-carrier.service.ts:187,296`, `setup-guide.service.ts:112,124`, `customer-aggregate.service.ts:605`, `webhook-erasure.ts:19`, `routes/{public.routes.ts:1937,finance.routes.ts:645,merchant-webhooks.routes.ts:149}`, `worker.ts:86` plus remaining 1-site files | per-feature repo methods; `sequence.next(kind)` is the DO counter                                                                                                                                                                           |
| J. Health probes                                               | 5     | `app.ts:470`, `index.ts:81`, `routes/public.routes.ts:105`, `lib/inngest/functions/answer-engine-citation-scan.ts:59`, `cf/dev-stats.ts` (4)                                                                                                                                                                                                                                                                                                                       | `/health` pings D1 plus a demo StoreDO and reports `storage_backend`                                                                                                                                                                        |
| K. One-off scripts                                             | 20    | `scripts/flatten-single-variant-products-2026-09-30.ts` (8), `list-variantless-po-lines.ts` (6), `rls-payload-parity.mjs` (2), `archive-audit-logs.mjs`, `storedemo/seed.mjs`, `dahab-demo/migrate-legacy-dahab.mjs`                                                                                                                                                                                                                                               | do not port; archive to `scripts/legacy-pg/`, delete in 7.1; `storedemo/seed.mjs` is rewritten in task 5.1                                                                                                                                  |

(Group sums approximate overlaps between a file and its group; the authoritative per-site list is regenerated by task 2.2's script `scripts/cf/raw-sql-inventory.sh` and must reach zero remaining sites before 7.1.)

---

## 4. Row-lock inventory

Measured: `rg -in 'for update|for no key update|pg_advisory|skip locked'` on source (non-test). **43 lock sites** map to **12 single-writer DO methods**. In a StoreDO, requests to one store are serialised and `ctx.storage.transactionSync(() => {...})` makes the section atomic; every method below must be synchronous inside the transaction (no `await` of external I/O between read and write). External I/O (provider calls) goes before (reserve) and after (commit) the section, as `FOR UPDATE` could not span it either.

| #   | Lock site (file:line)                                                                                                                                                                                           | Protects                                                                                     | DO method that replaces it                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `services/inventory-decrement.ts:94` (`FOR UPDATE` on variant; atomic UPDATEs at :41..72)                                                                                                                       | variant stock never negative                                                                 | `StoreDO.stock.decrement(variantId, qty)`: read, check, write in one `transactionSync`                                                                                                                          |
| 2   | `services/warehouse.service.ts:761` (`FOR UPDATE OF v`), `:779` (product), `:933`, `:941`                                                                                                                       | per-warehouse stock vs aggregate                                                             | `StoreDO.stock.syncAggregate(productId)` and `stock.adjustWarehouse(...)`; lock ordering note at :877 disappears (single thread)                                                                                |
| 3   | `services/payment-providers/instapay.service.ts:96`                                                                                                                                                             | InstaPay confirm/expiry exactly once                                                         | `StoreDO.payments.instapay.confirm/expire` (state check then write)                                                                                                                                             |
| 4   | `lib/inngest/functions/order-refunded.ts:267, 490, 801, 864, 1141` (order row) and `:286` (product row)                                                                                                         | refund idempotency, restock, coupon and loyalty reversal                                     | `StoreDO.orders.applyRefund(orderId, refundId)`: one method per phase, each keyed by a refund marker row; replaces the 5 separate order locks                                                                   |
| 5   | `services/accounting/posting/refund-posting.ts:56`; `partial-return-posting.ts:170, 553` (journal entry row)                                                                                                    | one posting per source                                                                       | `StoreDO.ledger.post(entry)` with unique `(source, source_id)` plus in-method read-modify-write                                                                                                                 |
| 6   | `services/accounting/backorder-stock-heal.ts:45`                                                                                                                                                                | backorder fulfilment vs stock                                                                | `StoreDO.stock.healBackorders(variantId)`                                                                                                                                                                       |
| 7   | `lib/stock-hold-cap.ts:155` (`pg_advisory_xact_lock`)                                                                                                                                                           | cap on concurrent holds per variant                                                          | `StoreDO.stock.reserveHold(variantId, qty)` (count holds and insert in one section)                                                                                                                             |
| 8   | `services/return.service.ts:215` (advisory `return-order:<id>`)                                                                                                                                                 | one return flow per order                                                                    | `StoreDO.returns.create(orderId, ...)`                                                                                                                                                                          |
| 9   | `services/gold-rate/gold-rate.service.ts:185, 317, 387, 450, 630` (advisory per store); `gate.ts:92` (`FOR UPDATE`) and `:76` (`FOR SHARE`, Ruling B5-17)                                                       | rate writes serialise with checkout's rate read                                              | `StoreDO.gold.setRate/applyRate/reprice` and `checkout.readRateForOrder()`; the share/exclusive pair collapses to "same thread" (the pricing read and order write must be in ONE transactionSync; test it)      |
| 10  | `services/wallet.service.ts:186`; `services/loyalty.service.ts:156`                                                                                                                                             | balance never negative, no double-spend                                                      | `StoreDO.wallet.debit/credit`, `loyalty.adjust`                                                                                                                                                                 |
| 11  | `services/legal-notice.service.ts:268`; `services/shipping-carrier.service.ts:187, 296`; `routes/merchant-webhooks.routes.ts:149` (advisory `webhook-endpoints:<store>`); `services/ai-autofill.service.ts:380` | config rows: send once, one active carrier config, endpoint limits, one autofill per product | `platform.legalNotice.markSent` (D1, `UPDATE ... WHERE status='pending'` returning changes), `StoreDO.shipping.saveCarrierConfig`, `StoreDO.webhooks.createEndpoint`, `StoreDO.catalog.autofillLock(productId)` |
| 12  | `services/sequence.service.ts:52` (atomic counter via upsert)                                                                                                                                                   | gap-free numbers                                                                             | `StoreDO.sequence.next(kind)`                                                                                                                                                                                   |
| -   | `scripts/flatten-single-variant-products-2026-09-30.ts:659,660,787`                                                                                                                                             | one-off migration                                                                            | not ported (legacy script)                                                                                                                                                                                      |
| -   | `services/order.service.ts:1444, 1594, 1628` (comments about the old row lock; :1628 is the replacement atomic path)                                                                                            | order create stock reservation                                                               | `StoreDO.orders.create(cart)` with `stock.decrement` inside the same `transactionSync`                                                                                                                          |

Cross-store locks do not exist in the table above; the only multi-DO operations are (a) entity-index writes (idempotent, D1) and (b) erasure fan-out (queue, idempotent). Any new cross-DO need is a design-review item, not a lock.

Done criterion for this section: task 3.1 writes `scripts/cf/lock-inventory.test.ts` that re-greps the lock patterns and fails if a site is not listed in `docs/cf/lock-map.json`.

---

## 5. Tasks per phase

Conventions for every task: work in a worktree (`~/.claude/scripts/new-task-worktree.sh ebda-store feat/cf-<task>`), TDD (failing test first), `git add` specific paths, run only touched tests per task and the full suite at the PR end (LEAN mode), Sonnet for execution, Opus only for the Phase 3 final review. Existing facts: `apps/api` already runs on workerd (`apps/api/wrangler.jsonc`, Durable Objects `AUTH_STATE` and `STORE_REALTIME` at :46..51, Hyperdrive at :34, `cf:test` = `vitest.workers.config.mts`); Prisma is **6.19.3** (`apps/api/package.json`), not 7; the personal/Whisky 11 Cloudflare account hosts ebda-\* (check `wrangler whoami` = `as.montaseer@gmail.com` before any deploy).

### Phase 0: Spike (28 Oct to 30 Oct)

Goal: prove or kill the DO-SQLite architecture on one demo store behind a flag, with numbers. Nothing here touches production data or the Postgres path. All spike code lives in a new `spikes/store-do/` directory (own `package.json`, own `wrangler.jsonc`, own worker `ebda-store-do-spike`, NOT the production worker) so it cannot affect `apps/api`.

**Phase 0 exit gate (all must hold):** (1) ORM decision recorded as a Ruling; (2) 5-table StoreDO serves the demo store's product list, cart add and order create through the flag; (3) warm p95 of the DO read path <= today's measured Postgres path p95 for the same endpoint; (4) cold-start and cost per 1M requests computed from the measurement; (5) backup export restores to an identical row count and checksum. If (3) or (5) fails, stop and report; do not start Phase 1.

#### Task 0.1: Baseline today's numbers (measure before building)

**Files:** create `spikes/store-do/bench/baseline.mjs`, `spikes/store-do/results/baseline-2026-10-28.json`.

- [ ] Step 1: pick the demo store and the 3 endpoints: `GET /public/stores/<demo>/products?limit=24`, `POST /public/carts` + add item, `POST /public/orders` (COD). Find the real routes: `rg -n "router\.(get|post)\('/(products|carts|orders)" apps/api/src/routes/public.routes.ts`.
- [ ] Step 2: write `baseline.mjs` (k6-free, `fetch` loop, 200 requests per endpoint at concurrency 4, discards first 10, prints p50/p95/p99 and error count). Run against the live demo API: `node spikes/store-do/bench/baseline.mjs --base https://api.ebda.app --store <demo-slug> > spikes/store-do/results/baseline-2026-10-28.json`.
- [ ] Step 3: also capture one cold run (wait 10 minutes idle, first request) and record it.
- **Verify:** `jq '.endpoints | keys' spikes/store-do/results/baseline-2026-10-28.json` lists 3 endpoints with non-null `p95_ms`. Label the numbers measured; pass them through `benchmark-vet` before quoting.
- **Done:** baseline JSON committed; the number to beat per endpoint is written at the top of the spike README.

#### Task 0.2: ORM decision, Drizzle vs Prisma-on-DO (time-boxed to half a day)

**Files:** create `spikes/store-do/orm/drizzle-do.ts`, `spikes/store-do/orm/prisma-do.ts`, `spikes/store-do/orm/README.md`; Ruling in `docs/RULINGS.md`.

- [ ] Step 1: read the real source of both adapters first (`srcof drizzle-orm@<latest>`, `srcof @prisma/adapter-d1`; check whether Prisma has a Durable Object SQLite adapter at all; never bare `opensrc path`). Write down what each ships for DO SQLite and D1.
- [ ] Step 2: in each file implement the same 3 operations against the 5 tables: `listProducts(storeId, limit)`, `addCartItem`, `createOrder` (inside `ctx.storage.transactionSync`). Prisma file: construct the client per request exactly as the production code does today.
- [ ] Step 3: run both inside `wrangler dev` (workerd, local) via a tiny worker `spikes/store-do/orm/worker.ts`; measure per-request engine construction (time from request start to first query) and bundle size with `wrangler deploy --dry-run --outdir dist` then `du -k dist/*.js`.
- [ ] Step 4: decision rule from the draft: pick the one with ZERO per-request engine construction and a gzip bundle contribution under 300 KB. Expected: Drizzle. Record `Ruling INFRA-CF-2 - <ORM>. Evidence: <ms/bundle numbers>. Cost if wrong: <one sentence>.` in `docs/RULINGS.md`.
- **Verify:** `cd spikes/store-do && npx wrangler dev --local` then `curl -s localhost:8787/orm/drizzle/products | jq length` and the same for `/orm/prisma`; both return the seeded rows.
- **Done:** Ruling INFRA-CF-2 written with numbers; the loser's file kept under `orm/rejected/` for the record.

#### Task 0.3: StoreDO with the 5-table schema (store, product, variant, cart, order)

**Files:** create `spikes/store-do/src/store-do.ts`, `spikes/store-do/src/schema.ts` (Drizzle, or per 0.2), `spikes/store-do/migrations/0001_core.sql`, `spikes/store-do/src/worker.ts`, `spikes/store-do/wrangler.jsonc`, `spikes/store-do/test/store-do.test.ts`.

- [ ] Step 1 (test first): in `store-do.test.ts` using `@cloudflare/vitest-pool-workers` (already a devDependency in `apps/api`), assert: schema migrates on first request; `createProduct` then `listProducts` round-trips; `createOrder` decrements variant stock; two concurrent `createOrder` calls for stock=1 yield exactly one success (`Promise.all`). Run `npx vitest run test/store-do.test.ts`: all fail.
- [ ] Step 2: write `schema.ts` columns from `schema.prisma`: `Store` :194, `Product` :926, `ProductVariant` :1248, `Cart` :1542, `Order` :1681 (only the columns the 3 endpoints use, plus `store_id`, `created_at`, `updated_at`; money integer piastres; enums as `CHECK`; JSON as TEXT).
- [ ] Step 3: `store-do.ts`: `class StoreDO extends DurableObject` with `migrate()` run in `blockConcurrencyWhile` from the constructor (versioned by a `_migrations` table), and the methods `catalog.listProducts`, `cart.addItem`, `orders.create` (reads cart, decrements stock, inserts order and items, all inside one `transactionSync`; no `await` inside).
- [ ] Step 4: `worker.ts` routes `/s/<storeId>/...` to `env.STORE_DO.get(env.STORE_DO.idFromName(storeId))`. Binding + `new_sqlite_classes` migration tag in `wrangler.jsonc`.
- [ ] Step 5: rerun the tests.
- **Verify:** `cd spikes/store-do && npx vitest run` exits 0 including the concurrency test (stock=1, 20 parallel orders, exactly 1 success and stock = 0).
- **Done:** tests green; the DO has no dependency on Postgres or Prisma.

#### Task 0.4: Seed the demo store and put it behind a flag

**Files:** create `spikes/store-do/scripts/seed-from-pg.mjs`; modify (in the spike branch only) `apps/api/src/routes/public.routes.ts` at the 3 routes from 0.1 and add `apps/api/src/lib/store-backend.ts`.

- [ ] Step 1: `seed-from-pg.mjs` reads the demo store's rows from Postgres (read-only SELECTs through `DATABASE_URL`, `neonctl connection-string ... | psql` pattern; SELECT only) for the 5 tables and POSTs them to the spike worker `/s/<storeId>/__seed` (idempotent upsert).
- [ ] Step 2: `store-backend.ts` exports `backendFor(storeId, env)`: returns `'do'` only when `env.STORE_DO_ENABLED_IDS` (comma list, default empty) contains the store id, else `'pg'`.
- [ ] Step 3: in the 3 routes, `if (backendFor(...) === 'do') return proxyToStoreDO(...)`; the Postgres path is untouched. Deploy the spike worker to the personal Cloudflare account under `ebda-store-do-spike` (preview URL only, no custom domain), set `STORE_DO_ENABLED_IDS=<demo store id>` in a preview environment of `ebda-api` only.
- [ ] Step 4: compare responses: `node spikes/store-do/scripts/parity.mjs` fetches the same 3 endpoints from the `pg` path and the `do` path and diffs the JSON (ignoring timestamps and ids it generated).
- **Verify:** `node spikes/store-do/scripts/parity.mjs` prints `parity: 3/3 equal`; `curl -sI https://<preview>/health | rg -i x-store-backend` shows the demo store served by `do` and another store by `pg`.
- **Done:** parity script green; flag default OFF in production config (`rg STORE_DO_ENABLED_IDS apps/api/wrangler.jsonc` shows an empty value).

#### Task 0.5: Latency and cost measurement

**Files:** create `spikes/store-do/bench/compare.mjs`, `spikes/store-do/results/do-2026-10-29.json`, `spikes/store-do/results/cost.md`.

- [ ] Step 1: run `baseline.mjs` (0.1) against the DO-flagged demo store: warm run and a cold run (idle 10 minutes; a DO evicts after seconds of idle, also record a request after 60 s idle).
- [ ] Step 2: `compare.mjs` prints a table: endpoint, Postgres p50/p95/p99, DO p50/p95/p99, delta. Include the first-request-after-idle number separately.
- [ ] Step 3: cost model in `cost.md`, from Cloudflare's published pricing (fetch the current pricing page first; do not quote from memory): requests, duration (GB-s), SQLite rows read/written, storage; computed for 1 store at 100 k requests/month and for 1,000 stores. Compare with Neon Launch + Hyperdrive today (from `docs/` billing notes). Label as guess where inputs are assumed.
- **Verify:** `node spikes/store-do/bench/compare.mjs spikes/store-do/results/baseline-2026-10-28.json spikes/store-do/results/do-2026-10-29.json` exits 0 and prints `p95 gate: PASS|FAIL` for each endpoint.
- **Done:** gate (3) and (4) of the exit gate answered with numbers; if FAIL, record the cause and stop.

#### Task 0.6: Nightly backup alarm and restore drill

**Files:** modify `spikes/store-do/src/store-do.ts` (add `alarm()`); create `spikes/store-do/scripts/restore-drill.mjs`; add an R2 bucket binding `SPIKE_BACKUPS`.

- [ ] Step 1 (test first): test that after `setAlarm(now)`, `alarm()` writes `backups/<store>/<yyyy-mm-dd>.json` (table dumps as NDJSON plus a manifest with row counts and sha256 per table) to R2, then re-arms the alarm for +24 h.
- [ ] Step 2: implement the export with `ctx.storage.sql.exec('SELECT * FROM <t>')` in pages of 1,000 rows, streaming to R2 multipart; no `await` between page reads for the manifest counts (consistent snapshot: take counts inside `transactionSync`).
- [ ] Step 3: `restore-drill.mjs`: create a fresh StoreDO id `<store>-restore`, load the NDJSON, recompute counts and checksums, compare to the manifest. Also exercise the PITR path: `ctx.storage.getBookmarkForTime()` then restore to the bookmark (document whether available on this plan).
- [ ] Step 4: add the D1 side: `wrangler d1 time-travel info ebda-platform-spike` and a `d1 export` to R2; record the restore command in `spikes/store-do/results/backup.md`.
- **Verify:** `node spikes/store-do/scripts/restore-drill.mjs --store <demo>` prints `restore: counts equal, checksums equal` for all 5 tables.
- **Done:** exit gate (5) met; the drill output committed to `results/backup.md`.

#### Task 0.7: Spike report and go/no-go

**Files:** create `docs/plans/2026-10-30-cf-spike-report.md` (in ebda-store), update this plan's estimate.

- [ ] Step 1: report: the 5 gate results, ORM Ruling, p95 table, cost table, backup drill, surprises (DO limits: 10 GB per DO, 128 MB memory, 30 s CPU per request, SQLite row/column limits, check the 146-model max row width; list any model that would not fit).
- [ ] Step 2: run the quick limit checks on real data: the largest store's row counts by table (`SELECT store_id, count(*) ...` read-only) to confirm every store fits one DO well under 10 GB.
- [ ] Step 3: Ahmad's decision: go (open Phase 1) or stop. Record as Ruling.
- **Verify:** `rg -c 'PASS|FAIL' docs/plans/2026-10-30-cf-spike-report.md` shows all 5 gates answered.
- **Done:** Ahmad has the report and a go/no-go Ruling is in `docs/RULINGS.md`.

### Phase 1: Schema port

Paths: new package `packages/cf-schema/` (`src/platform/*.ts` for D1, `src/store/*.ts` for the DO, `migrations/platform/*.sql`, `migrations/store/*.sql`, `docs/cf/fn-map.json`, `docs/cf/lock-map.json`).

#### Task 1.1: Model-to-target manifest

- **Files:** create `packages/cf-schema/model-split.json` (from section 1, 146 entries), `packages/cf-schema/test/model-split.test.ts`.
- [ ] Steps: (a) write the test: parse `packages/database/prisma/schema.prisma` model names; assert each appears exactly once in `model-split.json` with a target in {d1, store-do, analytics, drop}. (b) run (fails), (c) generate the JSON from section 1 of this plan, (d) rerun.
- **Verify:** `npx vitest run packages/cf-schema/test/model-split.test.ts` exits 0.
- **Done:** 146/146 present, 0 unknown, a new Prisma model fails the test until classified.

#### Task 1.2: D1 platform schema

- **Files:** `packages/cf-schema/src/platform/*.ts`, `migrations/platform/0001_init.sql`; create D1 `ebda-platform` with `wrangler d1 create ebda-platform` (personal account) plus a `-staging` copy.
- [ ] Steps: define the 25 D1 tables (section 1), indexes: unique `domains.host`, `stores.slug`, `slug_redirects.from_slug`, `webhook_inbox(provider, idempotency_key)`, `entity_index(kind, id)`, `merchant_api_keys.key_hash`, `refresh_tokens.token_hash`. Add the append-only `billing_events` triggers (section 2.6). Apply with `wrangler d1 migrations apply ebda-platform --local`.
- **Verify:** `npx wrangler d1 execute ebda-platform --local --command "select count(*) from sqlite_master where type='table'"` returns the table count from the manifest; `npx vitest run packages/cf-schema/test/platform.test.ts` (inserting a duplicate host fails; updating a billing event aborts).
- **Done:** local D1 schema applies cleanly twice (idempotent) and the tests pass.

#### Task 1.3: StoreDO schema (114 tables)

- **Files:** `packages/cf-schema/src/store/*.ts`, `migrations/store/0001_init.sql`.
- [ ] Steps: port in dependency order (catalogue, customers, carts, orders and payments, shipping, marketing, accounting, inventory, gold, content). Rules: enums become `CHECK (col IN (...))`; `Json` becomes TEXT with `json_valid` CHECK; Prisma `Decimal` becomes INTEGER micro-units (documented per column, list from `rg 'Decimal' schema.prisma`); `DateTime` becomes INTEGER epoch ms UTC; every table keeps `store_id` (cheap, and makes export/import mechanical); foreign keys with `ON DELETE` mirror the Prisma relations; the fiscal immutability trigger (2.7) and gold guard (2.8) are SQLite triggers.
- **Verify:** `npx vitest run packages/cf-schema/test/store-schema.test.ts` (opens an in-memory SQLite via `@cloudflare/vitest-pool-workers`, applies all migrations, runs `PRAGMA foreign_key_check` and `PRAGMA integrity_check`).
- **Done:** schema applies in a DO; foreign_key_check returns no rows.

#### Task 1.4: Store split (directory vs settings)

- **Files:** `packages/cf-schema/src/store-split.ts` and test.
- [ ] Steps: list the `Store` columns (`schema.prisma:194..553`, about 360 lines) into D1 directory fields vs DO settings; write the write-through contract (settings change in the DO emits a D1 `stores` update for the directory fields only, via an outbox row retried by alarm).
- **Verify:** `npx vitest run packages/cf-schema/test/store-split.test.ts` (every Store column assigned exactly once).
- **Done:** no column unassigned; outbox retry test green.

#### Task 1.5: Function/trigger map test

- **Files:** `docs/cf/fn-map.json` (88 entries from section 2), `scripts/cf/fn-inventory.test.ts`.
- [ ] Steps: test greps `migrations/**/migration.sql` for `CREATE (OR REPLACE )?(FUNCTION|TRIGGER) (public\.)?<name>` and asserts each name is in `fn-map.json` with a non-empty `replacement` and a `test` path (or `deleted-by-construction`).
- **Verify:** `npx vitest run scripts/cf/fn-inventory.test.ts` exits 0.
- **Done:** 88/88 mapped; a new SQL function fails CI until mapped.

#### Task 1.6: Prisma-vs-SQLite parity test

- **Files:** `packages/cf-schema/test/parity.test.ts`.
- [ ] Steps: parse `schema.prisma` (use `@prisma/internals` getDMMF, or the already-installed Prisma generator output) and compare every model field with the SQLite column (name, nullability, type class, default). Whitelist intentional differences in `parity-exceptions.json` with a reason each.
- **Verify:** `npx vitest run packages/cf-schema/test/parity.test.ts` exits 0; mutation check: rename one column locally, the test fails.
- **Done:** parity green; exceptions file reviewed (Decimal fields listed).

### Phase 2: Data access layer

#### Task 2.1: Repo interfaces and contract tests

- **Files:** `packages/repo/src/{store-repo,platform-repo}.ts` (interfaces grouped as in sections 3 and 4), `packages/repo/test/contract/*.contract.ts` (shared tests parameterised by implementation).
- [ ] Steps: define `StoreRepo` modules: catalog, cart, orders, payments, stock, ledger, gold, wallet, loyalty, returns, search, stats, sequence, audit, shipping, webhooks. Write contract tests first for stock, orders and wallet (the Prisma behaviours the tests assume: error codes such as unique violation, rounding, null vs undefined). Run them against the existing Postgres implementation (task 2.3) first to pin current behaviour.
- **Verify:** `npx vitest run packages/repo/test/contract` exits 0 for the `pg` implementation.
- **Done:** contract suite pinned on Postgres; each repo method named in sections 3 and 4 exists in an interface.

#### Task 2.2: Raw SQL inventory script

- **Files:** `scripts/cf/raw-sql-inventory.sh`, `docs/cf/raw-sql-map.json`.
- [ ] Steps: script prints every `$queryRaw|$executeRaw` site in source (excluding tests/spikes) with file:line; map file assigns each site a repo method or `deleted`. CI check: count of unmapped = 0, count of remaining Postgres sites decreases monotonically (store it in `docs/cf/raw-sql-progress.txt`).
- **Verify:** `bash scripts/cf/raw-sql-inventory.sh --check` exits 0.
- **Done:** 279/279 sites mapped.

#### Task 2.3: Postgres implementation of the repos

- **Files:** `packages/repo/src/pg/*.ts`; modify the services in the order: sequence, inventory, warehouse, wallet, loyalty, then the rest of sections 3 groups C, F, G, H, I.
- [ ] Steps: move each raw/Prisma call behind the repo method with no behaviour change; services depend on the interface only. One PR per group; each PR: contract tests + the touched service tests.
- **Verify:** `npm run test:unit && npm run test:integration` exits 0 after each group; `bash scripts/cf/raw-sql-inventory.sh --check` shows the remaining count shrinking.
- **Done:** zero `prisma.` or raw calls in `apps/api/src/services` and `routes` (rg returns nothing outside `packages/repo/src/pg`).

#### Task 2.4: Backend selector

- **Files:** `apps/api/src/lib/store-backend.ts` (from 0.4), `apps/api/src/lib/repo-factory.ts`.
- [ ] Steps: `getStoreRepo(storeId, env)` returns the pg or DO implementation per store flag stored in D1 `stores.storage_backend` (cached 5 s at the edge, NEVER-stale class: invalidated on flag write, TTL is not the control; document at the cache site). `/api/v1/health` (super_admin) reports `storage_backend` counts; public `/health` reports `platform_db`.
- **Verify:** `npx vitest run apps/api/test/repo-factory.test.ts`; `curl -s $API/health | jq .storage_backend`.
- **Done:** switching one store in staging changes the backend without a deploy.
- **Status (PR A, Ruling CF-PLATFORM-1):** D1 binding `PLATFORM_DB`, deploy-time migrations, D1-backed `backendFor` (no cache: NEVER-stale) and super_admin `/api/v1/health` `storage_backend` counts (public `/health`: `platform_db` only) are in. `repo-factory.ts` moves to PR C (it needs the prisma-lite wiring).

#### Task 2.5: DO implementation skeleton

- **Files:** `packages/repo/src/do/*.ts`, `apps/api/src/cf/store-do.ts` (productionised from the spike).
- [ ] Steps: implement read-only modules first (catalog, search, stats), run the same contract tests against the DO implementation using `@cloudflare/vitest-pool-workers`.
- **Verify:** `npm run cf:test -w apps/api` plus `npx vitest run packages/repo/test/contract --config vitest.workers.config.mts` exit 0.
- **Done:** read contracts green on both backends.
- **Status (PR C, 2026-10-28; rulings CF-DO-SCHEMA-1, CF-REPO-1; `docs/cf/repo-factory.md`):** the StoreDO runs the full generated schema (versioned, idempotent) and answers prisma-lite reads over RPC; `lib/repo-factory.ts` (`storeDb`) picks pg or the DO per store; 5 services / 10 read methods are moved and contract-tested against both backends (`tests/integration/repo-factory-contract.test.ts`). Left: tasks 2.2 and 2.3 for raw SQL, locks, writes, aggregate/groupBy, interactive transactions and the D1 models (PR D).

### Phase 3: Money and stock correctness (port last; Opus final review of the whole branch)

#### Task 3.1: Lock map test

- **Files:** `docs/cf/lock-map.json` (section 4), `scripts/cf/lock-inventory.test.ts`.
- **Verify:** `npx vitest run scripts/cf/lock-inventory.test.ts` exits 0 (every `FOR UPDATE|pg_advisory` site mapped).
- **Done:** 43/43 sites mapped to a DO method.

#### Task 3.2: Stock (sections 4 rows 1, 2, 6, 7, 12)

- **Files:** `packages/repo/src/do/stock.ts`, `sequence.ts`, tests.
- [ ] Steps: port `inventory-decrement.ts`, `warehouse.service.ts` aggregate sync, `stock-hold-cap.ts`, backorder heal, `sequence.next`; each as one synchronous `transactionSync`. Contract tests plus a concurrency test: 100 parallel decrements on one SKU, exactly `stock` successes, final stock 0, never negative.
- **Verify:** `npx vitest run packages/repo/test/do/stock.concurrency.test.ts` exits 0 on 5 consecutive runs.
- **Done:** invariant tests green on DO; hold cap holds under parallel load.

#### Task 3.3: Orders, checkout, payments (rows 3, 4 part)

- **Files:** `packages/repo/src/do/orders.ts`, `payments.ts`.
- [ ] Steps: `orders.create` (cart, price, stock, coupon, COD/InstaPay hold in one section; Kashier redirect initiated outside the section with a reservation), InstaPay confirm/expire once-only, webhook apply idempotency (`webhook_inbox` in D1 routes to `StoreDO.applyPaymentEvent`).
- **Verify:** `npx vitest run tests/integration -t "checkout|instapay|kashier|cod"` against the DO backend (`STORE_BACKEND=do`); 100 parallel checkouts on one SKU test: exactly `stock` orders.
- **Done:** all money/stock invariant tests green on both backends; piastres exact.

#### Task 3.4: Refunds, returns, wallet, loyalty, coupons (rows 4, 5, 8, 10)

- **Files:** `packages/repo/src/do/{refunds,returns,wallet,loyalty,coupons,ledger}.ts`; replace `order-refunded.ts` locks with `orders.applyRefund` phases keyed by refund marker.
- **Verify:** `npx vitest run tests/integration -t "refund|return|wallet|loyalty|coupon|ledger"` on DO backend; double-delivery of the refund event leaves state unchanged.
- **Done:** refund idempotency test (event replayed 3 times) green; ledger balanced after every test (sum debit = credit assertion).

#### Task 3.5: Entity index (D1) for lookups by id

- **Files:** `packages/repo/src/platform/entity-index.ts`.
- [ ] Steps: DO writes `entity_index` rows (order, payment, shipment tracking, billing refs) in the same request, before returning ids; backfill job; webhook resolution uses it.
- **Verify:** `npx vitest run packages/repo/test/entity-index.test.ts`; webhook for an unknown ref returns 200-noop with a Sentry breadcrumb, not a crash.
- **Done:** 100% of ids created in tests resolve through D1.

#### Task 3.6: Gold pricing (row 9)

- **Files:** `packages/repo/src/do/gold.ts`.
- **Verify:** `npx vitest run tests/integration -t gold` on DO; test: rate write concurrent with 50 checkouts, every order priced with a rate that was current at its commit.
- **Done:** gold invariants green; platform feed cron posts rates via Queue to each store.

#### Task 3.7: Search (FTS5 + Vectorize)

- **Files:** `packages/repo/src/do/search.ts`, `packages/shared/src/arabic-normalise.ts`.
- **Verify:** `tests/search-eval` run (existing eval harness, `tests/search-eval/`) on DO backend: recall at least equal to the Postgres baseline recorded first.
- **Done:** eval score >= baseline; Arabic normalisation shared by indexer and query.

#### Task 3.8: Isolation test (replaces RLS mutation tests)

- **Files:** `tests/integration/do-isolation.test.ts`; retire `docs/security/defence-mutations.json` entries when 7.1 lands.
- **Verify:** `npx vitest run tests/integration/do-isolation.test.ts`: store A token cannot read/write store B through any route (loop over the route manifest); an unresolved host returns 404, never a default store (tenant-resolver rule).
- **Done:** every public and admin route covered by the loop.

#### Task 3.9: Phase gate

- [ ] Run: `npm run test:unit && npm run test:integration` with `STORE_BACKEND=do`, the 5 template matrices (`playwright.*.config.ts`: dahab, jasmine, lamma, qamar, souq), builder e2e (`playwright.builder.config.ts`), then Opus whole-branch review.
- **Verify:** all exit 0; review findings fixed or ruled.
- **Done:** gate recorded in the handoff with evidence per rule.

### Phase 4: Migration tooling

#### Task 4.1: Per-store export/import

- **Files:** `scripts/cf/migrate-store-to-do.mjs`, `scripts/cf/verify-store.mjs`, tests.
- [ ] Steps: read-only Postgres cursor per table (ordered by id, 1,000 rows), transform (Decimals, dates, enums, JSON), POST NDJSON pages to `StoreDO.__import` (idempotent upsert, advertises a `import_batch` id); finish with `verify-store.mjs`: per-table row counts plus a checksum (sha256 of sorted `id|updated_at`) on both sides.
- **Verify:** `node scripts/cf/migrate-store-to-do.mjs --store <demo> --dry-run` then without the flag on a staging DO; `node scripts/cf/verify-store.mjs --store <demo>` prints `114/114 tables equal`.
- **Done:** a second run is a no-op (idempotent); counts and checksums equal.

#### Task 4.2: Platform data to D1

- **Files:** `scripts/cf/migrate-platform-to-d1.mjs`.
- **Verify:** `wrangler d1 execute ebda-platform --command "select count(*) from users"` equals Postgres `select count(*) from users`; same for the other 24 tables.
- **Done:** all 25 tables equal; secrets/tokens copied hashed as-is.

#### Task 4.3: Dry run on a copy

- [ ] Restore the latest `backup-all-neon` dump into a scratch Postgres (container), run 4.1 for every demo store and 4.2, time it, and run the Phase 3 test suites against the migrated DOs.
- **Verify:** `node scripts/cf/verify-store.mjs --all` exits 0; duration per store recorded.
- **Done:** timing table in the handoff; max store fits the Worker CPU limit per batch.

### Phase 5: Cutover per store

#### Task 5.1: Demo stores (`storedemo*`, rewrite `scripts/storedemo/seed.mjs` to seed the DO directly)

- [ ] Steps: migrate (4.1), dual-read window: shadow-compare GET responses (pg vs DO) for 24 h and log diffs to Sentry; flip `stores.storage_backend='do'`; watch.
- **Verify:** diff count 0 for 24 h; `curl -s $API/health | jq .storage_backend`; storefront Arabic locale smoke on the demo store; write-path smoke (guest cart only; no purchase completion without asking Ahmad).
- **Done:** demo stores on DO for 3 days, no Sentry regressions.

#### Task 5.2: Remaining stores in batches, `qa-walk` last

- [ ] Steps: batches of 10; same procedure; each batch records counts, diffs and the rollback command (flip flag back; Postgres read-only mirror kept consistent by a write-back? NO: write-back is out of scope, so rollback is only valid before the first DO-side write after the flip; document the window and take a DO export before each flip).
- **Verify:** verify-store per store; 24 h Sentry clean per batch.
- **Done:** 100% stores on DO; production `/health` commit equals main tip (per rule F), plus what could not be verified listed.

### Phase 6: Jobs

#### Task 6.1: Per-store crons to DO alarms

- **Files:** `packages/repo/src/do/alarms.ts`; modify the Inngest function list (95 functions: `ls apps/api/src/lib/inngest/functions | wc -l`) in `docs/cf/jobs-map.json` (function -> inngest | do-alarm | queue).
- [ ] Steps: move single-store crons (accounting daily close, reorder/deadstock scans, abandoned cart sweeps, audit rollover, fiscal archive, backups) to alarms; platform-level and fan-out stay in Inngest; the gold feed uses Queues.
- **Verify:** `npx vitest run apps/api/test/jobs-map.test.ts` (every function listed); alarm tests with `runDurableObjectAlarm`.
- **Done:** Inngest execution count in the dashboard drops as projected; no missed daily close in a 3-day soak.

### Phase 7: Decommission

#### Task 7.1: Remove Postgres code

- [ ] Steps: delete `apps/api/src/lib/definer.ts`, `packages/database/src/{index,tenant-guard,tenant-gucs,client}.ts`, `lib/savepoint.ts`, `lib/db-retry.ts`, Hyperdrive bindings, `docker-compose` Postgres, `packages/repo/src/pg`, Prisma deps (keep schema.prisma archived under `docs/legacy/` as the parity source until 7 clean days), `scripts/legacy-pg/`.
- **Verify:** `rg -n '@prisma/client|\$queryRaw|pg_advisory|hyperdrive|NEON|DATABASE_URL' apps packages scripts` returns nothing (apart from `docs/legacy/`); `npm run lint && npm run test && npm run cf:test -w apps/api` exit 0; `npm audit` 0/0/0/0.
- **Done:** blast-radius swept across code, CI, wrangler, launchd, docs, `.env.example`, sibling repos (state the result in the PR).

#### Task 7.2: Backups and monitoring

- [ ] Steps: nightly alarm export confirmed in R2 for every store; D1 time travel plus export; row-count asserts (rule N11); retire the host launchd Neon backup job's Ebda entry (remove only the Ebda project entry, verified by listing the script's project set first); alerting on missed backup.
- **Verify:** `wrangler r2 object list ebda-backups --prefix backups/ | wc -l` equals stores x days; restore drill (0.6) rerun against production export.
- **Done:** drill passes on production data.

#### Task 7.3: Delete Neon after 7 clean days

- [ ] Steps: confirm 7 days: Sentry clean, `/health` reports DO backend for 100% of stores, CF bill within projection; take a final `pg_dump` kept in cold storage; then delete Neon project `lucky-truth-54548746` (removing is a production action: Ahmad approves explicitly at this step).
- **Verify:** `neonctl projects list` no longer lists it; `curl $API/health` still green; one write-path smoke.
- **Done:** deleted; DEPLOYMENT, INCIDENT and `CLAUDE.md` docs updated in the same PR (doc parity); memory updated.

---

## Estimate and open decisions

- Estimates from the draft stand (guess); Phase 0 report refreshes them on 30 Oct.
- Open for Ahmad: (1) go/no-go after Phase 0; (2) rollback window policy after first DO write (task 5.2); (3) Neon deletion approval (7.3).

## Status log

- 2026-10-24: Phase 1 (tasks 1.1 to 1.6) implemented in `packages/cf-schema` (PR feat/cf-phase1-schema). Paths differ from the task text: `docs/cf/fn-map.json` (82 distinct names, 88 definitions), tests under `packages/cf-schema/test/` (fn-inventory lives there so the PR unit lane runs it). Rulings CF-SCHEMA-1 to 5.
