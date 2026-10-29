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
]);

export const PORTED_JOBS: ReadonlySet<string> = new Set(['wholesale-pending-nudge-cron']);

export const MONEY_JOBS: ReadonlySet<string> = new Set([
  'payment-webhook-process',
  'payment-webhook-stuck-sweep',
  'payment-reconcile-sweep',
  'payment-abandonment-sweep',
  'refund-reversal-stuck-sweep',
  'shipment-create',
  'order-refunded-fanout',
  'order-created-fanout',
  'order-created-stuck-sweep',
  'order-status-changed-fanout',
  'order-status-fanout-stuck-sweep',
  'order-auto-cancel-unpaid',
  'instapay-expiry',
  'instapay-receipt-extract',
  'accounting-post-order-journal',
  'accounting-post-refund-journal',
  'accounting-post-expense-journal',
  'accounting-post-po-receive-journal',
  'accounting-post-stock-adjustment-journal',
  'accounting-daily-close',
  'accounting-period-reconciliation',
  'stock-reorder-scan-cron',
  'stock-reorder-scan-on-demand',
  'warehouse-reconcile-sweep-cron',
  'warehouse-reconcile-on-demand',
]);

export function jobDataClass(id: string): JobDataClass {
  if (NO_STORE_DATA_JOBS.has(id)) return 'none';
  if (PORTED_JOBS.has(id)) return 'ported';
  return 'unported';
}
