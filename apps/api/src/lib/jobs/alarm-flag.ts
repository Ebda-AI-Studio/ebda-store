/**
 * Which per-store schedules run as Durable Object alarms instead of one global cron that lists every
 * store. `JOBS_CF_ALARMS` (wrangler var, flipped by PR + deploy): a comma list of function ids, or
 * `all`; empty = every one stays a cron. A job must also be alarm-ready (its handler sweeps only `event.data.storeId` for an alarm run).
 */
import { cfBindings } from '../../cf/bindings';
import { jobRunsOnCf } from './flag';
import { JOBS_MAP } from './jobs-map';

/**
 * Handlers that honour `alarmStoreId(event)` (lib/jobs/store-scope.ts). Not in the list on purpose:
 *  - `audit-log-archive-weekly`: audit_logs is one cross-tenant system table, not a per-store one
 *    (it moves with the audit table).
 *  - `ai-autofill-sweep`: a platform-wide leader lock and the shared Gemini quota make it a single
 *    throttled sweep; per-store parallel runs would skip each other or burn the quota.
 */
export const ALARM_READY: ReadonlySet<string> = new Set([
  'abandoned-cart-purge-weekly',
  'store-usage-snapshot',
  'accounting-daily-close',
  'accounting-period-reconciliation',
  'accounting-profit-anomaly-cron',
  'analytics-daily-rollup',
  'stock-deadstock-scan-cron',
  'stock-low-stock-alert-cron',
  'stock-reorder-scan-cron',
  'warehouse-reconcile-sweep-cron',
  'wholesale-pending-nudge-cron',
  // Ruling CF-JOBS-4
  'bulk-import-orphan-cleanup',
  // money sweeps (Ruling CF-JOBS-4)
  'payment-reconcile-sweep',
  'payment-abandonment-sweep',
  'refund-reversal-stuck-sweep',
  'order-created-stuck-sweep',
  'order-auto-cancel-unpaid',
  'instapay-expiry',
  'wa-plan-sync',
  'order-status-fanout-stuck-sweep',
  // non-money sweeps (Ruling CF-JOBS-4)
  'wa-plan-sync',
  // Ruling CF-JOBS-4B (gold rate): alarm per DO store
  'gold-rate-feed-fetch',
  'gold-rate-staleness-watch',
  // Ruling CF-JOBS-4B (data retention): receipts and orders are swept on the DO store's own alarm
  'instapay-receipt-retention-daily',
  'order-anonymize-5y-monthly',
  // Ruling CF-JOBS-4B (queue-depth-watch): BulkAiJob follows the store's backend; a DO store is watched on its alarm
  'queue-depth-watch',
  // Ruling CF-JOBS-4B (webhooks): endpoints and the delivery log follow the store's backend; the log purge runs on a DO store's alarm
  'webhook-delivery-purge-daily',
  // Ruling CF-JOBS-4B (search): a DO store is indexed from its DO into Vectorize, probed on its own alarm
  'search-index-backstop',
]);

function tokens(): string[] {
  return (process.env.JOBS_CF_ALARMS ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

export function jobRunsOnAlarm(id: string): boolean {
  if (!JOBS_MAP[id]?.alarm || !ALARM_READY.has(id)) return false;
  const t = tokens();
  if (!(t.includes('all') || t.includes(id))) return false;
  return jobRunsOnCf(id) && !!cfBindings()?.STORE_SCHEDULE;
}
