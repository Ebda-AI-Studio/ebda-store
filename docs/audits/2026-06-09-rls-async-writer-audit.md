# RLS async-writer audit — 2026-06-09

Migration `complete_force_rls_coverage` enabled FORCE row-level security on 76
tables. Any DB connection that runs without `app.current_client_id` set to a
valid store UUID sees **zero rows** — silently. HTTP requests are covered by
`apps/api/src/middleware/tenant-context.ts`. Async paths (Inngest jobs, cron
functions, webhook handlers) are NOT — they run in their own Node.js async
contexts with no incoming HTTP request.

The established fix pattern (see `packages/database/src/index.ts`):

- `runInTenantContext(storeId, async () => { ...prisma... })` — **preferred**
  when storeId is known. Sets `app.current_store_id` via `SET LOCAL` inside a
  Postgres transaction. Uses AsyncLocalStorage so all `prisma.*` calls inside
  the callback automatically use the scoped tx.
- `withRlsBypass(async tx => { ...tx... })` — for **cross-tenant** reads/writes
  where storeId is unknown (cron enumeration, pre-resolution lookup). Sets
  `app.bypass_rls = 'true'` inside a transaction.

---

## Scope

Paths audited: `apps/api/src/lib/inngest/functions/`, `apps/api/src/routes/*webhook*`.

---

## Findings table

| path                                                                                                   | tables touched                                                       | sets-context-before?                                                       | fix applied                                                                                                                                                                   | residual risk                                                                         |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/api/src/routes/webhook.routes.ts` — `checkIdempotency()`                                         | `orders`                                                             | no                                                                         | `withRlsBypass` (cross-tenant — storeId not known)                                                                                                                            | none                                                                                  |
| `apps/api/src/routes/webhook.routes.ts` — `resolveStoreIdFromWebhookPayload()`                         | `payments`, `orders`                                                 | no                                                                         | `withRlsBypass` (cross-tenant — storeId not known)                                                                                                                            | none                                                                                  |
| `apps/api/src/routes/webhook.routes.ts` — `POST /payment/:provider` — `PaymentService.handleWebhook()` | `payments`, `orders`, `payment_events`, `stores`                     | no                                                                         | `runInTenantContext(storeIdForWebhook)` when storeId resolved; `withRlsBypass` when undefined                                                                                 | platform-level path (undefined storeId) is inherently cross-tenant; bypass is correct |
| `apps/api/src/routes/webhook.routes.ts` — `POST /payment/:provider` — `markWebhookProcessed()`         | `orders`                                                             | no                                                                         | `runInTenantContext(storeId)` / `withRlsBypass` fallback                                                                                                                      | none                                                                                  |
| `apps/api/src/routes/webhook.routes.ts` — `POST /payment` (generic) — `PaymentService.handleWebhook()` | `payments`, `orders`, `payment_events`, `stores`                     | no                                                                         | same pattern as provider-specific handler                                                                                                                                     | same as above                                                                         |
| `apps/api/src/routes/webhook.routes.ts` — `POST /payment` (generic) — `markWebhookProcessed()`         | `orders`                                                             | no                                                                         | `runInTenantContext(storeId)` / `withRlsBypass` fallback                                                                                                                      | none                                                                                  |
| `apps/api/src/lib/inngest/functions/order-created.ts`                                                  | `orders`, `stores`                                                   | **yes — ALREADY FIXED** (prior commit)                                     | `runInTenantContext(storeId)` on both steps                                                                                                                                   | none                                                                                  |
| `apps/api/src/lib/inngest/functions/order-whatsapp-notify.ts` — `load-store-config`                    | `stores`                                                             | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/order-whatsapp-notify.ts` — `load-order`                           | `orders`, `shipments`, `customers`                                   | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/order-whatsapp-notify.ts` — `send-whatsapp` error paths            | `notification_logs`, `stores`                                        | no                                                                         | `runInTenantContext(storeId)` on each write                                                                                                                                   | none                                                                                  |
| `apps/api/src/lib/inngest/functions/order-whatsapp-notify.ts` — `record-success`                       | `notification_logs`                                                  | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/order-refunded.ts` — `load-order`                                  | `orders`, `payments`, `customers`                                    | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/order-refunded.ts` — `load-store`                                  | `stores`                                                             | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/invoice-email.ts` — `render-invoice`                               | `orders`, `stores`, `order_items`                                    | no                                                                         | `runInTenantContext(storeId)` wrapping `InvoiceService.generateInvoice`                                                                                                       | none                                                                                  |
| `apps/api/src/lib/inngest/functions/invoice-email.ts` — `load-order-number`                            | `orders`                                                             | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/review-request.ts` — `load-order`                                  | `orders`, `customers`, `order_items`, `products`                     | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/review-request.ts` — `load-store`                                  | `stores`                                                             | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/review-request.ts` — `mark-sent`                                   | `orders`                                                             | no                                                                         | `runInTenantContext(storeId)`                                                                                                                                                 | none                                                                                  |
| `apps/api/src/lib/inngest/functions/data-retention.ts` — `abandonedCartPurge` count + delete           | `abandoned_carts`                                                    | no                                                                         | `withRlsBypass` (cross-tenant cron — no storeId)                                                                                                                              | correct by design                                                                     |
| `apps/api/src/lib/inngest/functions/data-retention.ts` — `softDeletedUserAnonymize` find               | `users`                                                              | no                                                                         | `withRlsBypass` (cross-tenant cron)                                                                                                                                           | correct by design                                                                     |
| `apps/api/src/lib/inngest/functions/data-retention.ts` — `orderAnonymizeAtFiveYears` find + update     | `orders`                                                             | no                                                                         | `withRlsBypass` (cross-tenant cron — orders from all tenants)                                                                                                                 | correct by design                                                                     |
| `apps/api/src/lib/inngest/functions/accounting-post-order-journal.ts` — `post-journal`                 | `orders`, `payments`, `journal_entries`, `journal_lines`, `accounts` | no                                                                         | `runInTenantContext(storeId)` wrapping `postOrderPaymentJournal` (accounting services already call `withRlsBypass` internally for GL writes; wrapping the outer read is safe) | none                                                                                  |
| `apps/api/src/lib/inngest/functions/accounting-daily-close.ts` — `list-stores-with-accounting`         | `stores`                                                             | no                                                                         | `withRlsBypass` (cross-tenant cron)                                                                                                                                           | correct by design                                                                     |
| `apps/api/src/lib/inngest/functions/accounting-daily-close.ts` — `drift-*`                             | `journal_lines`, `journal_entries`                                   | **partially** (inner `withRlsBypass` existed, but `list-stores` lacked it) | `withRlsBypass` added to the store enumeration                                                                                                                                | none                                                                                  |
| `apps/api/src/lib/inngest/functions/stock-reorder-scan.ts` — `list-stores` (cron)                      | `stores`                                                             | no                                                                         | `withRlsBypass` (cross-tenant cron)                                                                                                                                           | correct by design                                                                     |
| `apps/api/src/lib/inngest/functions/stock-reorder-scan.ts` — `scan-*`                                  | `products`, `order_items`, `reorder_suggestions`                     | partial — `runReorderScan` uses `withRlsBypass` internally                 | none needed at callsite                                                                                                                                                       | none — `runReorderScan` owns its bypass                                               |

---

## Follow-up fixes (this PR — fix/rls-async-writer-tail)

All items from the "NOT fixed" table above were addressed in this PR plus 4
additional files found by a full grep of `apps/api/src/lib/inngest/functions/`.

| path                                      | tables                                                                                        | fix applied                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounting-period-reconciliation.ts`     | `stores`, `journal_entries`                                                                   | `withRlsBypass` for store enumeration; inner queries already wrapped                                                                                     |
| `accounting-profit-anomaly.ts`            | `stores`, `journal_entries`                                                                   | `withRlsBypass` for store listing + `runInTenantContext(store.id)` per-store scan                                                                        |
| `analytics-daily-rollup.ts`               | `stores`, `store_analytics_daily`                                                             | `withRlsBypass` for store listing (cron path) + `runInTenantContext(storeId)` for both cron per-store and on-demand paths                                |
| `audit-log-archive.ts`                    | `audit_logs`                                                                                  | `withRlsBypass` on count, paginated findMany loop, and `$executeRawUnsafe` delete                                                                        |
| `stock-deadstock-scan.ts`                 | `stores`, `products`                                                                          | `withRlsBypass` for store listing; `runDeadstockScan` already wraps its own queries internally                                                           |
| `review-moderation.ts`                    | `reviews`                                                                                     | `runInTenantContext(storeId)` wrapping `detectSpamReview`, `prisma.review.update`, and `translateReview`                                                 |
| `bulk-import.ts`                          | `bulk_import_jobs`, `products`, `categories`                                                  | `withRlsBypass` for initial job load (no storeId yet); `runInTenantContext(job.storeId)` wrapping the entire execution body                              |
| `product-meta-sync.ts`                    | `stores`, `products`                                                                          | `runInTenantContext(storeId)` wrapping store/product reads and fetch dispatch                                                                            |
| `queue-depth-watch.ts`                    | `bulk_ai_jobs`                                                                                | `withRlsBypass` on dual findMany + auto-reap update                                                                                                      |
| `bulk-ai-seo.ts`                          | `products`, `bulk_ai_jobs`                                                                    | `runInTenantContext(storeId)` wrapping entire function body                                                                                              |
| `bulk-ai-translate.ts`                    | `products`, `categories`, `stores`, `bulk_ai_jobs`                                            | `runInTenantContext(storeId)` wrapping entire function body                                                                                              |
| `bulk-ai-aeo.ts` (3 functions)            | `products`, `bulk_ai_jobs`                                                                    | `runInTenantContext(storeId)` wrapping each function independently                                                                                       |
| `bulk-ai-geo.ts` (3 functions)            | `stores`, `products`, `bulk_ai_jobs`                                                          | `runInTenantContext(storeId)` wrapping each function independently                                                                                       |
| `bulk-ai-product-faqs.ts`                 | `stores`, `products`, `product_faqs`, `bulk_ai_jobs`                                          | `runInTenantContext(storeId)` wrapping function body                                                                                                     |
| `bulk-ai-recommendations.ts`              | `products`, `product_recommendations`, `frequently_bought_together`, `bulk_ai_jobs`, `orders` | `runInTenantContext(storeId)` wrapping function body                                                                                                     |
| `ai-autofill-cleanup.ts` _(extra)_        | `ai_recommendations`, `frequently_bought_together`, `product_relations`                       | `runInTenantContext(storeId)` wrapping findMany + $transaction delete block (event-driven `product.deleted`, storeId in event.data)                      |
| `bulk-import-orphan-cleanup.ts` _(extra)_ | `bulk_import_jobs`                                                                            | `withRlsBypass` on findMany + updateMany (cross-tenant cron, no storeId)                                                                                 |
| `ai-autofill-sweep.ts` _(extra)_          | `stores`, `products`, `bulk_ai_jobs`                                                          | `withRlsBypass` for store listing + `runInTenantContext(s.id)` per-store for `recalculateFBT` + `sweepStore` calls                                       |
| `ai-autofill-product.ts` _(extra)_        | `products`, `bulk_ai_jobs`                                                                    | `runInTenantContext(storeId)` wrapping `isAutopilotEnabled`, `fillProductFields`, and `bulkAiJob.findFirst/create` (event-driven, storeId in event.data) |

**Intentionally not wrapped (out of scope for async-context RLS):**

| path                                           | reason                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/scripts/*.mjs`              | One-shot admin scripts run as DB owner via `railway run`; not async Inngest paths; FORCE RLS does not apply to owner-role connections |
| `apps/api/src/services/ai-autofill.service.ts` | Service is always called from a wrapper that already sets the context (`runInTenantContext` at the Inngest function level covers it)  |

---

## Webhook RLS context flow (post-fix)

```
POST /webhooks/payment/:provider
  │
  ├─ verifyWebhookSignature            (no DB)
  ├─ generateIdempotencyKey            (no DB — pure function)
  ├─ checkIdempotency()                withRlsBypass  ← cross-tenant: storeId unknown
  ├─ resolveStoreIdFromWebhookPayload  withRlsBypass  ← cross-tenant: storeId unknown
  │
  ├─ storeId resolved?
  │   ├─ YES → runInTenantContext(storeId)
  │   │          └─ PaymentService.handleWebhook(...)
  │   │               reads/writes: payment, order, payment_events
  │   │               (inherits ALS context — no nested bypass needed)
  │   └─ NO  → withRlsBypass(_tx =>)
  │              └─ PaymentService.handleWebhook(...)
  │
  └─ markWebhookProcessed()
       ├─ storeId known → runInTenantContext(storeId) → prisma.order.update
       └─ storeId unknown → withRlsBypass(tx => tx.order.update)
```

---

## Test coverage

`tests/integration/rls-async-context.test.ts` — verifies that:

1. A raw `prisma.order.findUnique` without context returns `null` (RLS filters).
2. The same query inside `runInTenantContext(storeId)` returns the row.
3. The same query inside `withRlsBypass` returns the row.

This is the regression guard for the whole class of async-context RLS bugs.
