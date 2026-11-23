# Background jobs on Cloudflare (G5)

Generated from `apps/api/src/lib/jobs/jobs-map.ts` (the code is the source of truth; `tests/unit/jobs-map.test.ts` pins it to the registry, 100 functions). Every job runs on Cloudflare (Ruling G5-3: Inngest is removed; the group numbers are only the order jobs were ported in).

## Primitives

| Primitive                                   | Used for                                                                         | Why                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Workflow (`ebda-jobs`, class `JobWorkflow`) | sleeping, long-running or side-effecting multi-step jobs (emails, pushes, money) | one durable step per `step.run`; a retry never repeats an earlier step's side effect                        |
| Queue (`ebda-jobs` + DLQ)                   | short, whole-run idempotent jobs (sweeps, retention, one-step jobs)              | whole handler in one DB context; retries with backoff, then the failure path                                |
| Cron Trigger                                | every Inngest schedule                                                           | zoned (Africa/Cairo) crons get winter + summer UTC triggers and a local-time guard                          |
| DO alarm (`StoreSchedule`)                  | per-store schedules (`alarm`, 11 alarm-ready jobs)                               | one SQLite DO per store fires that store's jobs, scoped to it (`JOBS_CF_ALARMS`); the rest stay Cron -> job |
| `JobGate` Durable Object                    | Inngest `concurrency` (limit <= 3) and `debounce`                                | lease renewed before every step, fenced; released while sleeping                                            |

## Inngest features and how they are reproduced

| Inngest                                                                                | On Cloudflare                                                                                                                                             | Functions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency` limit 1-3 (per key or global)                                            | `JobGate` lease (renew before every step, abort if lost, release while sleeping and on finish)                                                            | `gold-rate-staleness-watch`, `domain-claim-sweep`, `r2-orphan-sweep`, `store-usage-snapshot`, `accounting-daily-close`, `accounting-period-reconciliation`, `accounting-profit-anomaly-cron`, `analytics-daily-rollup`, `analytics-rollup-on-demand`, `gold-rate-feed-fetch`, `stock-deadstock-scan-cron`, `stock-low-stock-alert-cron`, `stock-reorder-scan-cron`, `warehouse-reconcile-sweep-cron`, `wholesale-pending-nudge-cron`, `ai-autofill-product`, `ai-autofill-sweep`, `answer-engine-citation-scan-cron`, `bulk-ai-balance-descriptions`, `bulk-ai-brand-facts`, `bulk-ai-categorize`, `bulk-ai-citation-copy`, `bulk-ai-excerpt`, `bulk-ai-faq-aeo`, `bulk-ai-howto-aeo`, `bulk-ai-image-alt`, `bulk-ai-llms-txt`, `bulk-ai-meta-aeo`, `bulk-ai-product-faqs`, `bulk-ai-recommendations`, `bulk-ai-revert-balance`, `bulk-ai-seo`, `bulk-ai-tags`, `bulk-ai-translate`, `bulk-import-products`, `gsc-ingest-cron`, `search-index-backstop`, `search-product-index`, `campaign-send`, `cart-recovery-email`, `legal-notice-send`, `lifecycle-first-order`, `billing-renewal-daily`, `instapay-expiry`, `instapay-receipt-extract`, `order-auto-cancel-unpaid`, `payment-abandonment-sweep`, `payment-webhook-process`, `shipment-create` |
| `concurrency` limit >= 4                                                               | not enforced: these were Inngest plan caps (INNGEST-PLAN-1, Hobby = 5), Workflows/Queues scale on their own                                               | `accounting-expense-ocr-process`, `accounting-post-expense-journal`, `accounting-post-order-journal`, `accounting-post-po-receive-journal`, `accounting-post-refund-journal`, `accounting-post-stock-adjustment-journal`, `ebda-ads-conversion`, `order-capi-conversion`, `webhook-deliver`, `webhook-fanout`, `invoice-email`, `order-created-fanout`, `order-status-changed-fanout`, `order-refunded-fanout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `debounce`                                                                             | `JobGate.touch` at dispatch + quiet-period sleep/delay + `isLatest` check (timeout honoured)                                                              | `ai-autofill-product`, `search-product-index`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `idempotency`                                                                          | Workflow instance id = function + key (a duplicate create is a no-op)                                                                                     | `webhook-deliver`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `throttle`, `rateLimit`, `batchEvents`, `cancelOn`, `step.waitForEvent`, `step.invoke` | not used by any function                                                                                                                                  | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `retries`                                                                              | per-step retries (Workflow) or whole-handler retries (Queue), exponential backoff, same count (default 4)                                                 | all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `onFailure` + `inngest/function.failed`                                                | run in a final step / the failure path, then a direct P1 alert (P0 for the payment webhook) plus Sentry: job, group, instance id, error; never event data | all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NonRetriableError`                                                                    | mapped to `NonRetryableError` / immediate failure path                                                                                                    | all                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Functions

| Function                                   | Group           | Runs as  | Trigger | Alarm later |
| ------------------------------------------ | --------------- | -------- | ------- | ----------- |
| `agent-write-denied-watch`                 | 1-observability | queue    | cron    |             |
| `gmail-alert-poller`                       | 1-observability | queue    | cron    |             |
| `gold-rate-staleness-watch`                | 1-observability | workflow | cron    |             |
| `heartbeat`                                | 1-observability | queue    | cron    |             |
| `queue-depth-watch`                        | 1-observability | queue    | cron    |             |
| `abandoned-cart-purge-weekly`              | 2-housekeeping  | queue    | cron    | yes         |
| `account-erased-propagation`               | 2-housekeeping  | workflow | event   |             |
| `audit-log-archive-weekly`                 | 2-housekeeping  | queue    | cron    | yes         |
| `bulk-import-orphan-cleanup`               | 2-housekeeping  | queue    | cron    | yes         |
| `domain-claim-sweep`                       | 2-housekeeping  | queue    | cron    |             |
| `instapay-receipt-retention-daily`         | 2-housekeeping  | queue    | cron    |             |
| `order-anonymize-5y-monthly`               | 2-housekeeping  | queue    | cron    |             |
| `r2-orphan-sweep`                          | 2-housekeeping  | queue    | cron    |             |
| `search-log-purge-daily`                   | 2-housekeeping  | queue    | cron    |             |
| `soft-deleted-user-anonymize-monthly`      | 2-housekeeping  | queue    | cron    |             |
| `store-usage-snapshot`                     | 2-housekeeping  | queue    | cron    | yes         |
| `webhook-delivery-purge-daily`             | 2-housekeeping  | queue    | cron    |             |
| `accounting-daily-close`                   | 3-books-stock   | workflow | cron    | yes         |
| `accounting-expense-ocr-process`           | 3-books-stock   | queue    | event   |             |
| `accounting-period-reconciliation`         | 3-books-stock   | workflow | cron    | yes         |
| `accounting-post-expense-journal`          | 3-books-stock   | queue    | event   |             |
| `accounting-post-order-journal`            | 3-books-stock   | workflow | event   |             |
| `accounting-post-po-receive-journal`       | 3-books-stock   | queue    | event   |             |
| `accounting-post-refund-journal`           | 3-books-stock   | workflow | event   |             |
| `accounting-post-stock-adjustment-journal` | 3-books-stock   | queue    | event   |             |
| `accounting-profit-anomaly-cron`           | 3-books-stock   | workflow | cron    | yes         |
| `analytics-daily-rollup`                   | 3-books-stock   | workflow | cron    | yes         |
| `analytics-funnel-backfill`                | 3-books-stock   | workflow | event   |             |
| `analytics-refund-correction`              | 3-books-stock   | workflow | event   |             |
| `analytics-rollup-on-demand`               | 3-books-stock   | workflow | event   |             |
| `gold-rate-feed-fetch`                     | 3-books-stock   | workflow | cron    |             |
| `stock-deadstock-scan-cron`                | 3-books-stock   | workflow | cron    | yes         |
| `stock-deadstock-scan-on-demand`           | 3-books-stock   | queue    | event   |             |
| `stock-low-stock-alert-cron`               | 3-books-stock   | workflow | cron    | yes         |
| `stock-low-stock-alert-on-demand`          | 3-books-stock   | workflow | event   |             |
| `stock-reorder-scan-cron`                  | 3-books-stock   | workflow | cron    | yes         |
| `stock-reorder-scan-on-demand`             | 3-books-stock   | queue    | event   |             |
| `warehouse-reconcile-on-demand`            | 3-books-stock   | workflow | event   |             |
| `warehouse-reconcile-sweep-cron`           | 3-books-stock   | workflow | cron    | yes         |
| `wholesale-pending-nudge-cron`             | 3-books-stock   | workflow | cron    | yes         |
| `ai-autofill-cleanup`                      | 4-ai            | queue    | event   |             |
| `ai-autofill-product`                      | 4-ai            | workflow | event   |             |
| `ai-autofill-sweep`                        | 4-ai            | workflow | cron    | yes         |
| `answer-engine-citation-scan-cron`         | 4-ai            | workflow | cron    |             |
| `answer-engine-scan-on-demand`             | 4-ai            | workflow | event   |             |
| `bulk-ai-balance-descriptions`             | 4-ai            | workflow | event   |             |
| `bulk-ai-brand-facts`                      | 4-ai            | workflow | event   |             |
| `bulk-ai-categorize`                       | 4-ai            | workflow | event   |             |
| `bulk-ai-citation-copy`                    | 4-ai            | workflow | event   |             |
| `bulk-ai-excerpt`                          | 4-ai            | workflow | event   |             |
| `bulk-ai-faq-aeo`                          | 4-ai            | workflow | event   |             |
| `bulk-ai-howto-aeo`                        | 4-ai            | workflow | event   |             |
| `bulk-ai-image-alt`                        | 4-ai            | workflow | event   |             |
| `bulk-ai-llms-txt`                         | 4-ai            | workflow | event   |             |
| `bulk-ai-meta-aeo`                         | 4-ai            | workflow | event   |             |
| `bulk-ai-product-faqs`                     | 4-ai            | workflow | event   |             |
| `bulk-ai-recommendations`                  | 4-ai            | workflow | event   |             |
| `bulk-ai-revert-balance`                   | 4-ai            | workflow | event   |             |
| `bulk-ai-seo`                              | 4-ai            | workflow | event   |             |
| `bulk-ai-tags`                             | 4-ai            | workflow | event   |             |
| `bulk-ai-translate`                        | 4-ai            | workflow | event   |             |
| `bulk-import-products`                     | 4-ai            | queue    | event   |             |
| `gsc-ingest-cron`                          | 4-ai            | workflow | cron    |             |
| `gsc-ingest-on-demand`                     | 4-ai            | queue    | event   |             |
| `ebda-ads-conversion`                      | 5-integrations  | queue    | event   |             |
| `eta-receipt-enqueue`                      | 5-integrations  | queue    | event   |             |
| `eta-receipt-redrive`                      | 5-integrations  | workflow | event   |             |
| `eta-receipt-submit`                       | 5-integrations  | queue    | event   |             |
| `order-capi-conversion`                    | 5-integrations  | workflow | event   |             |
| `storefront-order-purge`                   | 5-integrations  | queue    | event   |             |
| `search-index-backstop`                    | 5-integrations  | workflow | cron    |             |
| `wa-plan-sync`                             | 5-integrations  | queue    | cron    |             |
| `wa-store-events`                          | 5-integrations  | queue    | event   |             |
| `ci-erasure-second-pass`                   | 5-integrations  | workflow | event   |             |
| `ci-outcomes`                              | 5-integrations  | queue    | event   |             |
| `search-product-index`                     | 5-integrations  | workflow | event   |             |
| `webhook-deliver`                          | 5-integrations  | workflow | event   |             |
| `webhook-fanout`                           | 5-integrations  | workflow | event   |             |
| `campaign-send`                            | 6-comms         | workflow | event   |             |
| `cart-recovery-email`                      | 6-comms         | queue    | event   |             |
| `contact-form-send`                        | 6-comms         | workflow | event   |             |
| `invoice-email`                            | 6-comms         | workflow | event   |             |
| `legal-notice-send`                        | 6-comms         | workflow | event   |             |
| `lifecycle-emails`                         | 6-comms         | workflow | event   |             |
| `lifecycle-first-order`                    | 6-comms         | queue    | event   |             |
| `order-created-fanout`                     | 6-comms         | workflow | event   |             |
| `order-status-changed-fanout`              | 6-comms         | workflow | event   |             |
| `review-moderation`                        | 6-comms         | workflow | event   |             |
| `review-request`                           | 6-comms         | workflow | event   |             |
| `billing-renewal-daily`                    | 7-money         | workflow | cron    |             |
| `instapay-expiry`                          | 7-money         | workflow | cron    |             |
| `instapay-receipt-extract`                 | 7-money         | queue    | event   |             |
| `order-auto-cancel-unpaid`                 | 7-money         | workflow | cron    |             |
| `order-created-stuck-sweep`                | 7-money         | workflow | cron    |             |
| `order-refunded-fanout`                    | 7-money         | workflow | event   |             |
| `order-status-fanout-stuck-sweep`          | 7-money         | workflow | cron    |             |
| `payment-abandonment-sweep`                | 7-money         | workflow | cron    |             |
| `payment-reconcile-sweep`                  | 7-money         | workflow | cron    |             |
| `payment-webhook-process`                  | 7-money         | workflow | event   |             |
| `payment-webhook-stuck-sweep`              | 7-money         | workflow | cron    |             |
| `refund-reversal-stuck-sweep`              | 7-money         | workflow | cron    |             |
| `shipment-create`                          | 7-money         | queue    | event   |             |
| `alerts-failure-watch`                     | 8-failure-watch | queue    | event   |             |

## Per-store alarms (Ruling G5-2)

`JOBS_CF_ALARMS` (wrangler var, comma list of function ids or `all`, empty = all cron) moves a per-store schedule from one global Cron Trigger run to one Durable Object alarm per store (`apps/api/src/cf/store-schedule.ts`).

- Alarm-ready (handler sweeps only `event.data.storeId` for an alarm run): `abandoned-cart-purge-weekly`, `bulk-import-orphan-cleanup`, `store-usage-snapshot`, `accounting-daily-close`, `accounting-period-reconciliation`, `accounting-profit-anomaly-cron`, `analytics-daily-rollup`, `stock-deadstock-scan-cron`, `stock-low-stock-alert-cron`, `stock-reorder-scan-cron`, `warehouse-reconcile-sweep-cron`, `wholesale-pending-nudge-cron`.
- Analytics rollups on a DO store (M-048): `analytics-rollup-on-demand` reads the store's paid orders through `storeDb` (its Durable Object once the store is served there, Postgres otherwise), and the cohort and RFM rollups page them 1000 at a time by keyset (`createdAt`, `id`) instead of loading every paid order in one query.
- Stay crons on purpose: `audit-log-archive-weekly` (one cross-tenant table), `ai-autofill-sweep` (platform-wide leader lock + shared Gemini quota).
- Arming (Ruling CF-JOBS-1): the hourly Cron Trigger `0 * * * *` runs `syncStoreSchedules` for the stores served by their Durable Object only (`JOBS_ON_DO=1` + the store flag); it also removes entries for jobs switched back to cron. A Postgres store is never armed: it keeps the global cron run, and the cron hides DO stores from its sweep. See `docs/cf/jobs-on-do.md`.
- Exactly-once-ish: event id `alarm-<job>-<store>-<scheduledFor>` is the Workflow instance id (a re-fire is a no-op); the concurrency gate is `<job>|<store>`.
- Failure: start errors retry 30 s .. 15 min, then the occurrence is skipped and the same direct alert fires. A fire later than 24 h is skipped, not replayed.
- Cairo schedules are DST-safe: `next-run.ts` expands the zone's winter and summer UTC candidates and keeps the one whose local time matches.
- Rollback: empty `JOBS_CF_ALARMS`; the next hourly sync clears the entries and the Cron Trigger resumes the job. A store flipped back to Postgres: its remaining alarms start nothing and the cron covers it again.
- Write freeze (Ruling CF-JOBS-2): a due alarm is held (same due time, re-armed 5 minutes out) while `WRITES_FROZEN=1`.
