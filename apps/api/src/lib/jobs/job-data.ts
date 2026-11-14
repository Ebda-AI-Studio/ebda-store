/**
 * Which store data does each background job touch, and is that data reachable on a store's Durable Object yet?
 * (INFRA-CF-1 PR E, Ruling CF-JOBS-1.) Every id of JOBS_MAP is classified by exactly one of three sets; the default
 * is the SAFE one: a job nobody has proven is "none" or "ported" is `unported`, i.e. refused for a store that lives on
 * its Durable Object. `tests/unit/jobs-do-guard.test.ts` pins that the sets are disjoint, name only real jobs, and
 * that every `ported` job really calls `storeDb`/`storeWriter`.
 *
 *  - `none`     touches no per-store data (platform tables, logs, queues). Runs unchanged for every store.
 *  - `ported`   reads and writes its store data only through `storeDb` / `storeWriter` (works for either backend).
 *  - `unported` (default) reads or writes store tables with `prisma` / `withStore`. Refused for DO stores.
 *
 * `MONEY_JOBS` are the unported jobs whose refusal pages P0, because the work they skip moves money or stock
 * (they wait for the money/stock ports, D2a/D2b).
 */
export type JobDataClass = 'none' | 'ported' | 'unported';

export const NO_STORE_DATA_JOBS: ReadonlySet<string> = new Set([
  'heartbeat',
  'gmail-alert-poller',
  'alerts-failure-watch',
  'audit-log-archive-weekly',
  'billing-renewal-daily',
  // INSTAPAY-AUTO-1: reads/stamps the platform auto-confirmation rows only and talks to the brain; no store data to move
  'instapay-auto-digest',
  // reads the webhook inbox (a platform table) and re-sends events; it never opens a store table (Ruling CF-JOBS-4)
  'payment-webhook-stuck-sweep',
  // Ruling CF-JOBS-4: platform tables only (the ad-attribution ledger `BillingEvent` and the identity `User`; the legal
  // notice fan-out reads `User` / `LegalNotice*`), so there is no store data to move
  'ebda-ads-conversion',
  'legal-notice-send',
  // identity rows only (the erasure itself already reaches the DO half)
  'soft-deleted-user-anonymize-monthly',
  // Ruling CF-JOBS-4: jobs that touch only platform (D1) rows or third parties, never a store-do table
  // third-party erasure (OneSignal, PostHog) + the CI bucket in R2, keyed by ids the event carries; the DO erasure scope is finalized by its last step (Ruling CF-OPUS-1)
  'account-erased-propagation',
  'ci-erasure-second-pass',
  // the store's public contact address + its owner (stores / users: platform rows) and the mail provider
  'contact-form-send',
  // custom-domain claims live on the `stores` row and at the domain provider
  'domain-claim-sweep',
  // Customer Intelligence daily aggregation: reads the platform's R2 envelopes, writes the platform `CiInsight` (D1) rows, lists stores from the directory; opens no store-do table (Ruling INTEG-1)
  'ci-aggregation-daily',
  // expired uploads in the private bucket only (R2 listing + delete); opens no store table (Ruling INTEG-1)
  'catalog-import-uploads-sweep',
]);

export const PORTED_JOBS: ReadonlySet<string> = new Set([
  'wholesale-pending-nudge-cron',
  // reads through storeDb and disarms through the DO money op (Ruling CF-PAY-1)
  'order-status-fanout-stuck-sweep',
  // the abandoned-cart rows and the newsletter consent follow the store's backend (Ruling CF-R4-5)
  'abandoned-cart-purge-weekly',
  'cart-recovery-email',
  // campaigns, recipients and the consent list follow the store's backend (Ruling CF-R6A-2)
  'campaign-send',
  // Ruling CF-JOBS-4 (money jobs): each one reaches its store only through `storeDb` / `sweepStoresDb` / the DO money ops
  // (`storeMoney`), and runs on the store's alarm (sweeps) or its event (the rest) - tests/unit/jobs-money-on-do.test.ts
  'payment-webhook-process',
  'payment-reconcile-sweep',
  'payment-abandonment-sweep',
  'refund-reversal-stuck-sweep',
  'order-created-stuck-sweep',
  'order-auto-cancel-unpaid',
  'instapay-expiry',
  'instapay-receipt-extract',
  'instapay-auto-confirm',
  'accounting-post-order-journal',
  'accounting-post-refund-journal',
  'accounting-daily-close',
  'accounting-period-reconciliation',
  // the WhatsApp store events (incl. `customer.erased`): link, consent and order/cart/catalog reads follow the backend
  'wa-store-events',
  // Ruling CF-JOBS-4 (non-money jobs): each reaches its store only through `storeDb` / `storeWriter` / `acrossStoresDb` / the
  // store's DO ops, and the platform rows (`Store`, `User`, billing) through `withStore` - tests/unit/jobs-nonmoney-b-on-do.test.ts
  'wa-plan-sync',
  'review-request',
  'review-moderation',
  'invoice-email',
  'order-capi-conversion',
  'lifecycle-emails',
  'lifecycle-first-order',
  // Ruling CF-JOBS-4B (gold rate): alarm per DO store
  'gold-rate-feed-fetch',
  'gold-rate-staleness-watch',
  // Ruling CF-JOBS-4B (ETA e-receipts): the receipt and connection rows are DO-writable; every read and write goes through withStoreRw
  'eta-receipt-enqueue',
  'eta-receipt-submit',
  'eta-receipt-redrive',
  // Ruling CF-JOBS-4B (data retention): receipts and orders are swept on the DO store's own alarm
  'instapay-receipt-retention-daily',
  'order-anonymize-5y-monthly',
  // Ruling CF-JOBS-4B (queue-depth-watch): BulkAiJob follows the store's backend; a DO store is watched on its alarm
  'queue-depth-watch',
  // Ruling CF-JOBS-4B (store-usage-snapshot): the store side comes from the DO op usageCounts
  'store-usage-snapshot',
  // Ruling CF-JOBS-4B (stock): the scans read the catalogue through the store's backend and write dead-stock flags through the DO writer
  'stock-deadstock-scan-cron',
  'stock-deadstock-scan-on-demand',
  'stock-low-stock-alert-cron',
  'stock-low-stock-alert-on-demand',
  // Ruling CF-JOBS-4 (non-money jobs): each reaches its store only through `storeDb` / `storeWriter` / `acrossStoresDb`
  // (tests/unit/jobs-nonmoney-a-on-do.test.ts), event jobs on the store's own event, sweeps on its alarm
  'bulk-import-orphan-cleanup',
  'bulk-import-products',
  'ai-autofill-cleanup',
  'bulk-ai-balance-descriptions',
  'bulk-ai-brand-facts',
  'bulk-ai-categorize',
  'bulk-ai-citation-copy',
  'bulk-ai-excerpt',
  'bulk-ai-faq-aeo',
  'bulk-ai-howto-aeo',
  'bulk-ai-image-alt',
  'bulk-ai-llms-txt',
  'bulk-ai-meta-aeo',
  'bulk-ai-product-faqs',
  'bulk-ai-recommendations',
  'bulk-ai-revert-balance',
  'bulk-ai-seo',
  'bulk-ai-tags',
  'bulk-ai-translate',
  // reads through `storeDb` / `storeWriter` / `storeMoney`; event jobs run on the store's own event
  'ai-autofill-product',
  'ci-outcomes',
  'analytics-rollup-on-demand',
  'answer-engine-scan-on-demand',
  // sweeps with a per-store alarm (`alarm: true` + ALARM_READY): the store's own alarm runs them for a DO store
  'accounting-profit-anomaly-cron',
  'analytics-daily-rollup',
  // cross-store crons that cover every store from their ONE cron run (ALL_STORES_JOBS below)
  'agent-write-denied-watch',
  'ai-autofill-sweep',
  'answer-engine-citation-scan-cron',
  // Ruling CF-JOBS-4B (expense OCR): the draft is one DO op; accounts are read from the store's own chart
  'accounting-expense-ocr-process',
  // Ruling CF-JOBS-4B (webhooks): endpoints and the delivery log follow the store's backend; the log purge runs on a DO store's alarm
  'webhook-fanout',
  'webhook-deliver',
  'webhook-delivery-purge-daily',
  // Ruling CF-JOBS-4B (r2-orphan-sweep): a DO store's references are read from its DO; any unreadable store ends the run before a delete
  'r2-orphan-sweep',
  // Ruling CF-JOBS-4B (search): a DO store is indexed from its DO into Vectorize, probed on its own alarm
  'search-product-index',
  'search-index-backstop',
  'warehouse-reconcile-sweep-cron',
  'warehouse-reconcile-on-demand',
  'stock-reorder-scan-cron',
  'stock-reorder-scan-on-demand',
  'accounting-post-expense-journal',
  'accounting-post-po-receive-journal',
  'accounting-post-stock-adjustment-journal',
  'shipment-create',
  'order-created-fanout',
  'order-status-changed-fanout',
  'order-refunded-fanout',
  // Ruling NZ-AN-1: the GSC ingest and the search-log purge read and write the store's analytics tables, which live in its
  // StoreDO (`analyticsWrite` / `analyticsMoney`, lib/analytics-backend.ts); the Store row is read through the store's backend
  'gsc-ingest-cron',
  'gsc-ingest-on-demand',
  'search-log-purge-daily',
  // Ruling INTEG-1: the catalogue import and the weekly CI hint calibration reach their store only through `storeDb` /
  // `storeWriter` / `storeMoney.importBatch` (tests/unit/integ-1-on-do.test.ts)
  'catalog-import-run',
  'catalog-import-create-drafts',
  'ci-hint-calibration-weekly',
]);

/**
 * Ported cron jobs whose single cron run covers EVERY store, Postgres and Durable Object alike (Ruling CF-JOBS-4): they list
 * the stores with `allStoresDirectory` / `acrossAllStoresDb` (lib/jobs/store-db.ts) and reach each DO store through its DO.
 * A watcher that ranks stores against each other, a leader-locked sweep with one shared AI quota and a weekly scan with one
 * provider budget cannot be split into per-store alarms without losing the aggregate, so they are not "skipped sweeps".
 */
export const ALL_STORES_JOBS: ReadonlySet<string> = new Set([
  // lists every store itself and reads each DO store's references from its DO (it deletes, so it needs ALL of them)
  'r2-orphan-sweep',
  'agent-write-denied-watch',
  'ai-autofill-sweep',
  'answer-engine-citation-scan-cron',
  // lists every store and resolves each one's open hint logs; the platform check ranks all stores' rows together (Ruling INTEG-1)
  'ci-hint-calibration-weekly',
  // Ruling NZ-AN-1: each lists every store (DO stores included, `allStoresDirectory` / the store directory) and reaches a store's
  // analytics through its own backend, one failing store never stops the rest
  'gsc-ingest-cron',
  'search-log-purge-daily',
]);

export const MONEY_JOBS: ReadonlySet<string> = new Set([]);

/**
 * The money jobs that ARE ported (Ruling CF-JOBS-4): a skip of a DO store by one of them still pages P0. `MONEY_JOBS` above
 * lists only the money jobs still refused, so together they are every job that moves money or stock.
 */
export const PORTED_MONEY_JOBS: ReadonlySet<string> = new Set([
  'order-status-changed-fanout',
  'order-refunded-fanout',
  'order-created-fanout',
  'shipment-create',
  'accounting-post-expense-journal',
  'accounting-post-po-receive-journal',
  'accounting-post-stock-adjustment-journal',
  'stock-reorder-scan-cron',
  'stock-reorder-scan-on-demand',
  'warehouse-reconcile-sweep-cron',
  'warehouse-reconcile-on-demand',
  'order-status-fanout-stuck-sweep',
  'payment-webhook-process',
  'payment-reconcile-sweep',
  'payment-abandonment-sweep',
  'refund-reversal-stuck-sweep',
  'order-created-stuck-sweep',
  'order-auto-cancel-unpaid',
  'instapay-expiry',
  'accounting-post-order-journal',
  'accounting-post-refund-journal',
  'accounting-daily-close',
  'accounting-period-reconciliation',
]);

export function jobDataClass(id: string): JobDataClass {
  if (NO_STORE_DATA_JOBS.has(id)) return 'none';
  if (PORTED_JOBS.has(id)) return 'ported';
  return 'unported';
}
