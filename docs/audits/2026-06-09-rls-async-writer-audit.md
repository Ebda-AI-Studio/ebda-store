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

## Paths NOT fixed in this PR (documented as residual risk)

These paths also touch RLS tables from async contexts but were **out of scope**
per the task brief. They are documented here as the next-priority work.

| path                                                                  | tables                         | priority | reason not fixed                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `accounting-period-reconciliation.ts` — `list-stores-with-accounting` | `stores`                       | medium   | `prisma.store.findMany` without bypass; inner queries already use `withRlsBypass`. Partial fix exists — complete it.             |
| `accounting-profit-anomaly.ts` — store enumeration                    | `stores`, `journal_entries`    | medium   | Cross-tenant cron with no RLS bypass on the outer store findMany.                                                                |
| `analytics-daily-rollup.ts` — all steps                               | `stores`, analytics tables     | medium   | Cross-tenant cron; `prisma.store.findMany` unguarded.                                                                            |
| `audit-log-archive.ts` — all steps                                    | `audit_logs`                   | medium   | Cron; `auditLog.count` + `auditLog.findMany` + `$executeRawUnsafe` without bypass.                                               |
| `stock-deadstock-scan.ts` — store enumeration                         | `stores`, `products`           | medium   | `prisma.store.findMany` without bypass.                                                                                          |
| `review-moderation.ts` — `update` call                                | `reviews`                      | medium   | `prisma.review.update` has a storeId in scope but no `runInTenantContext`.                                                       |
| `ai-autofill-sweep.ts` — store enumeration                            | `stores`, `bulk_ai_jobs`       | low      | Sweep dispatches per-store events; the actual writes happen in `ai-autofill-product.ts` which is event-driven and has a storeId. |
| `bulk-import.ts` — all steps                                          | `bulk_import_jobs`, `products` | medium   | `bulkImportJob.findUnique/update` without bypass; storeId available in event.data.                                               |
| `product-meta-sync.ts` — all steps                                    | `stores`, `products`           | medium   | `prisma.store.findUnique` + `prisma.product.findUnique` without bypass.                                                          |
| `queue-depth-watch.ts` — all steps                                    | `bulk_ai_jobs`                 | low      | Monitoring-only read; worst case = incomplete depth alert, not data corruption.                                                  |
| `bulk-ai-*.ts` (aeo, geo, seo, translate, faqs, recommendations)      | `products`, `bulk_ai_jobs`     | medium   | Bulk AI job functions read/update products without context. Each has storeId in event.data.                                      |

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
