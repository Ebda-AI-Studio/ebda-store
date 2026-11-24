/**
 * The Inngest -> Cloudflare job map (G5, Ruling INFRA-CF-1): every registered function, the
 * rollout group it ports with, and the Cloudflare primitive that runs it.
 *
 *  - `workflow`: sleeping, long-running or side-effecting multi-step handlers (emails, pushes,
 *    money) run as a Cloudflare Workflow instance: one durable step per `step.run`, per-step
 *    retries, so a retry never repeats an earlier step's side effect. Only code INSIDE `step.run`
 *    has a database connection there, which is what the per-group handler audit checks.
 *  - `queue`: handlers that are short and whole-run idempotent (sweeps, retention, one-step jobs) run
 *    on the `ebda-jobs` Queue: the WHOLE handler runs inside one database context, so code outside
 *    `step.run`, JSON-heavy step results and "now" computed once all just work; a failed attempt
 *    re-runs the handler (backoff, the job's `retries`, then the failure path). `step.sleep` is not
 *    available there.
 *  - `alarm`: a store-iterating schedule that becomes a per-store Durable Object alarm once StoreDO
 *    owns the data (phases 2-3, other agents). Alarm-ready ones run as alarms for stores on their Durable Object when `JOBS_CF_ALARMS` lists them (lib/jobs/alarm-flag.ts, Ruling CF-JOBS-1); Postgres stores keep the Cron Trigger -> Workflow path.
 * Cron Triggers start every `cron` function (lib/jobs/schedule.ts); events start the `event` ones.
 *
 * The group number is the order jobs were ported in (all run on Cloudflare now).
 * `tests/unit/jobs-map.test.ts` pins this table against the real registry.
 */
export type JobKind = 'workflow' | 'queue';

export interface JobMapEntry {
  group: string;
  kind: JobKind;
  trigger: 'cron' | 'event';
  /** Becomes a per-store DO alarm after the StoreDO phases. */
  alarm?: true;
}

export const JOBS_MAP: Readonly<Record<string, JobMapEntry>> = {
  'agent-write-denied-watch': { group: '1-observability', kind: 'queue', trigger: 'cron' },
  'gmail-alert-poller': { group: '1-observability', kind: 'queue', trigger: 'cron' },
  'gold-rate-staleness-watch': {
    group: '1-observability',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  heartbeat: { group: '1-observability', kind: 'queue', trigger: 'cron' },
  'storefront-purge-retry': { group: '1-observability', kind: 'queue', trigger: 'event' },
  'storefront-bundle-boundary': { group: '1-observability', kind: 'workflow', trigger: 'event' },
  'queue-depth-watch': { group: '1-observability', kind: 'queue', trigger: 'cron', alarm: true },
  'abandoned-cart-purge-weekly': {
    group: '2-housekeeping',
    kind: 'queue',
    trigger: 'cron',
    alarm: true,
  },
  'account-erased-propagation': { group: '2-housekeeping', kind: 'workflow', trigger: 'event' },
  'audit-log-archive-weekly': {
    group: '2-housekeeping',
    kind: 'queue',
    trigger: 'cron',
    alarm: true,
  },
  'bulk-import-orphan-cleanup': {
    group: '2-housekeeping',
    kind: 'queue',
    trigger: 'cron',
    alarm: true,
  },
  'catalog-import-uploads-sweep': { group: '2-housekeeping', kind: 'queue', trigger: 'cron' },
  'domain-claim-sweep': { group: '2-housekeeping', kind: 'queue', trigger: 'cron' },
  'instapay-receipt-retention-daily': {
    group: '2-housekeeping',
    kind: 'queue',
    trigger: 'cron',
    alarm: true,
  },
  'order-anonymize-5y-monthly': {
    group: '2-housekeeping',
    kind: 'queue',
    trigger: 'cron',
    alarm: true,
  },
  'r2-orphan-sweep': { group: '2-housekeeping', kind: 'queue', trigger: 'cron' },
  'search-log-purge-daily': { group: '2-housekeeping', kind: 'queue', trigger: 'cron' },
  'soft-deleted-user-anonymize-monthly': {
    group: '2-housekeeping',
    kind: 'queue',
    trigger: 'cron',
  },
  'store-usage-snapshot': {
    group: '2-housekeeping',
    kind: 'queue',
    trigger: 'cron',
    alarm: true,
  },
  'webhook-delivery-purge-daily': {
    group: '2-housekeeping',
    kind: 'queue',
    trigger: 'cron',
    alarm: true,
  },
  'accounting-daily-close': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'accounting-expense-ocr-process': { group: '3-books-stock', kind: 'queue', trigger: 'event' },
  'accounting-period-reconciliation': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'accounting-post-expense-journal': { group: '3-books-stock', kind: 'queue', trigger: 'event' },
  'accounting-post-order-journal': { group: '3-books-stock', kind: 'workflow', trigger: 'event' },
  'accounting-post-po-receive-journal': { group: '3-books-stock', kind: 'queue', trigger: 'event' },
  'accounting-post-refund-journal': { group: '3-books-stock', kind: 'workflow', trigger: 'event' },
  'accounting-post-stock-adjustment-journal': {
    group: '3-books-stock',
    kind: 'queue',
    trigger: 'event',
  },
  'accounting-profit-anomaly-cron': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'analytics-daily-rollup': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'analytics-funnel-backfill': { group: '3-books-stock', kind: 'workflow', trigger: 'event' },
  'analytics-refund-correction': { group: '3-books-stock', kind: 'workflow', trigger: 'event' },
  'analytics-rollup-on-demand': { group: '3-books-stock', kind: 'workflow', trigger: 'event' },
  'gold-rate-feed-fetch': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'stock-deadstock-scan-cron': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'stock-deadstock-scan-on-demand': { group: '3-books-stock', kind: 'queue', trigger: 'event' },
  'stock-low-stock-alert-cron': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'stock-low-stock-alert-on-demand': { group: '3-books-stock', kind: 'workflow', trigger: 'event' },
  'stock-reorder-scan-cron': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'stock-reorder-scan-on-demand': { group: '3-books-stock', kind: 'queue', trigger: 'event' },
  'warehouse-reconcile-on-demand': { group: '3-books-stock', kind: 'workflow', trigger: 'event' },
  'warehouse-reconcile-sweep-cron': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'wholesale-pending-nudge-cron': {
    group: '3-books-stock',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'ai-autofill-cleanup': { group: '4-ai', kind: 'queue', trigger: 'event' },
  'ai-autofill-product': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'ai-autofill-sweep': { group: '4-ai', kind: 'workflow', trigger: 'cron', alarm: true },
  'answer-engine-citation-scan-cron': { group: '4-ai', kind: 'workflow', trigger: 'cron' },
  'answer-engine-scan-on-demand': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-balance-descriptions': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-brand-facts': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-categorize': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-citation-copy': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-excerpt': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-faq-aeo': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-howto-aeo': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-image-alt': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-llms-txt': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-meta-aeo': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-product-faqs': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-recommendations': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-revert-balance': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-seo': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-tags': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-ai-translate': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'bulk-import-products': { group: '4-ai', kind: 'queue', trigger: 'event' },
  'catalog-import-run': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'catalog-import-create-drafts': { group: '4-ai', kind: 'workflow', trigger: 'event' },
  'gsc-ingest-cron': { group: '4-ai', kind: 'workflow', trigger: 'cron' },
  'gsc-ingest-on-demand': { group: '4-ai', kind: 'queue', trigger: 'event' },
  'ebda-ads-conversion': { group: '5-integrations', kind: 'queue', trigger: 'event' },
  'eta-receipt-enqueue': { group: '5-integrations', kind: 'queue', trigger: 'event' },
  'eta-receipt-redrive': { group: '5-integrations', kind: 'workflow', trigger: 'event' },
  'eta-receipt-submit': { group: '5-integrations', kind: 'queue', trigger: 'event' },
  'order-capi-conversion': { group: '5-integrations', kind: 'workflow', trigger: 'event' },
  'search-index-backstop': {
    group: '5-integrations',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'search-product-index': { group: '5-integrations', kind: 'workflow', trigger: 'event' },
  'wa-plan-sync': { group: '5-integrations', kind: 'queue', trigger: 'cron', alarm: true },
  'wa-store-events': { group: '5-integrations', kind: 'queue', trigger: 'event' },
  'ci-erasure-second-pass': { group: '5-integrations', kind: 'workflow', trigger: 'event' },
  'ci-outcomes': { group: '5-integrations', kind: 'queue', trigger: 'event' },
  'ci-aggregation-daily': { group: '5-integrations', kind: 'queue', trigger: 'cron' },
  'ci-hint-calibration-weekly': { group: '5-integrations', kind: 'queue', trigger: 'cron' },
  'webhook-deliver': { group: '5-integrations', kind: 'workflow', trigger: 'event' },
  'webhook-fanout': { group: '5-integrations', kind: 'workflow', trigger: 'event' },
  'campaign-send': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'cart-recovery-email': { group: '6-comms', kind: 'queue', trigger: 'event' },
  'contact-form-send': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'invoice-email': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'legal-notice-send': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'lifecycle-emails': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'lifecycle-first-order': { group: '6-comms', kind: 'queue', trigger: 'event' },
  'order-created-fanout': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'order-status-changed-fanout': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'review-moderation': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'review-request': { group: '6-comms', kind: 'workflow', trigger: 'event' },
  'billing-renewal-daily': { group: '7-money', kind: 'workflow', trigger: 'cron' },
  'instapay-expiry': {
    group: '7-money',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'instapay-receipt-extract': { group: '7-money', kind: 'queue', trigger: 'event' },
  'instapay-auto-confirm': { group: '7-money', kind: 'queue', trigger: 'event' },
  'instapay-auto-digest': { group: '7-money', kind: 'workflow', trigger: 'cron' },
  'order-auto-cancel-unpaid': {
    group: '7-money',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'order-created-stuck-sweep': {
    group: '7-money',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'order-refunded-fanout': { group: '7-money', kind: 'workflow', trigger: 'event' },
  'order-status-fanout-stuck-sweep': {
    group: '7-money',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'payment-abandonment-sweep': {
    group: '7-money',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'payment-reconcile-sweep': {
    group: '7-money',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'payment-webhook-process': { group: '7-money', kind: 'workflow', trigger: 'event' },
  'payment-webhook-stuck-sweep': { group: '7-money', kind: 'workflow', trigger: 'cron' },
  'refund-reversal-stuck-sweep': {
    group: '7-money',
    kind: 'workflow',
    trigger: 'cron',
    alarm: true,
  },
  'shipment-create': { group: '7-money', kind: 'queue', trigger: 'event' },
  'alerts-failure-watch': { group: '8-failure-watch', kind: 'queue', trigger: 'event' },
};

export const JOB_GROUPS: readonly string[] = [
  '1-observability',
  '2-housekeeping',
  '3-books-stock',
  '4-ai',
  '5-integrations',
  '6-comms',
  '7-money',
  '8-failure-watch',
];
