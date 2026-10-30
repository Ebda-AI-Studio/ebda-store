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
  // reads the webhook inbox (a platform table) and re-sends events; it never opens a store table (Ruling CF-JOBS-3)
  'payment-webhook-stuck-sweep',
  // Ruling CF-JOBS-4: platform tables only (the ad-attribution ledger `BillingEvent` and the identity `User`; the legal
  // notice fan-out reads `User` / `LegalNotice*`), so there is no store data to move
  'ebda-ads-conversion',
  'legal-notice-send',
  // Ruling CF-JOBS-4B: GSC ingest reads the platform Store row and writes GscDailyMetric (analytics target, Postgres): no DO table is opened, so one cron serves every store
  'gsc-ingest-cron',
  'gsc-ingest-on-demand',
  // Ruling CF-JOBS-4B (data retention): receipts and orders are swept on the DO store's own alarm
  'search-log-purge-daily',
  'soft-deleted-user-anonymize-monthly',
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
  // Ruling CF-JOBS-3 (money jobs): each one reaches its store only through `storeDb` / `sweepStoresDb` / the DO money ops
  // (`storeMoney`), and runs on the store's alarm (sweeps) or its event (the rest) - tests/unit/jobs-money-on-do.test.ts
  'payment-webhook-process',
  'payment-reconcile-sweep',
  'payment-abandonment-sweep',
  'refund-reversal-stuck-sweep',
  'order-created-stuck-sweep',
  'order-auto-cancel-unpaid',
  'instapay-expiry',
  'instapay-receipt-extract',
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
]);

export const MONEY_JOBS: ReadonlySet<string> = new Set([
  'shipment-create',
  'order-refunded-fanout',
  'order-created-fanout',
  'order-status-changed-fanout',
  'accounting-post-expense-journal',
  'accounting-post-po-receive-journal',
  'accounting-post-stock-adjustment-journal',
  'stock-reorder-scan-cron',
  'stock-reorder-scan-on-demand',
  'warehouse-reconcile-sweep-cron',
  'warehouse-reconcile-on-demand',
]);

/**
 * The money jobs that ARE ported (Ruling CF-JOBS-3): a skip of a DO store by one of them still pages P0. `MONEY_JOBS` above
 * lists only the money jobs still refused, so together they are every job that moves money or stock.
 */
export const PORTED_MONEY_JOBS: ReadonlySet<string> = new Set([
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
