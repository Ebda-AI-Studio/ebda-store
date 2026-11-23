import type { JobDef } from '../../jobs/types';
import { orderCreated } from './order-created';
import { orderRefunded } from './order-refunded';
import { bulkImportProducts } from './bulk-import';
import { catalogImportRun } from './catalog-import-run';
import { catalogImportCreateDrafts } from './catalog-import-create-drafts';
import { catalogImportUploadsSweep } from './catalog-import-uploads-sweep';
import { bulkImportOrphanCleanup } from './bulk-import-orphan-cleanup';
import { invoiceEmail } from './invoice-email';
import { heartbeat } from './heartbeat';
import { storefrontPurgeRetry, storefrontBundleBoundary } from './storefront-purge';
import { auditLogArchive } from './audit-log-archive';
import { bulkAiTranslate } from './bulk-ai-translate';
import { bulkAiSeo } from './bulk-ai-seo';
import { bulkAiFaqAeo, bulkAiHowtoAeo, bulkAiMetaAeo } from './bulk-ai-aeo';
import { bulkAiLlmsTxt, bulkAiCitationCopy, bulkAiBrandFacts } from './bulk-ai-geo';
import { bulkAiRecommendations } from './bulk-ai-recommendations';
import { bulkAiProductFaqs } from './bulk-ai-product-faqs';
import { reviewRequest } from './review-request';
import { reviewModeration } from './review-moderation';
import {
  abandonedCartPurge,
  searchLogPurge,
  instapayReceiptRetention,
  softDeletedUserAnonymize,
  orderAnonymizeAtFiveYears,
} from './data-retention';
import { alertsFailureWatch } from './alerts-failure-watch';
import { gmailAlertPoller } from './gmail-alert-poller';
import { isWorkers } from '../../runtime';
import { queueDepthWatch } from './queue-depth-watch';
import { agentWriteDeniedWatch } from './agent-write-denied-watch';
import { accountingPostOrderJournal } from './accounting-post-order-journal';
import { accountingPostRefundJournal } from './accounting-post-refund-journal';
import { accountingDailyClose } from './accounting-daily-close';
import { accountingPeriodReconciliation } from './accounting-period-reconciliation';
import { accountingPostPoReceiveJournal } from './accounting-post-po-receive-journal';
import { accountingPostStockAdjustmentJournal } from './accounting-post-stock-adjustment-journal';
import { accountingPostExpenseJournal } from './accounting-post-expense-journal';
import { stockReorderScanCron, stockReorderScanOnDemand } from './stock-reorder-scan';
import { stockDeadstockScanCron, stockDeadstockScanOnDemand } from './stock-deadstock-scan';
import { wholesalePendingNudgeCron } from './wholesale-pending-nudge';
import { lifecycleEmails, lifecycleFirstOrder } from './lifecycle-emails';
import { stockLowStockAlertCron, stockLowStockAlertOnDemand } from './stock-low-stock-alert';
import { goldRateFeedFetchCron } from './gold-rate-feed-fetch';
import { goldRateStalenessWatchCron } from './gold-rate-staleness-watch';
import { accountingProfitAnomalyCron } from './accounting-profit-anomaly';
import { accountingExpenseOcrProcess } from './accounting-expense-ocr-process';
import { instapayReceiptExtract } from './instapay-receipt-extract';
import { analyticsDailyRollupCron, analyticsRollupOnDemand } from './analytics-daily-rollup';
import { analyticsFunnelBackfill } from './analytics-funnel-backfill';
import { analyticsRefundCorrection } from './analytics-refund-correction';
import { aiAutofillProduct } from './ai-autofill-product';
import { aiAutofillCleanup } from './ai-autofill-cleanup';
import { aiAutofillSweep } from './ai-autofill-sweep';
import { searchProductIndex, searchIndexBackstop } from './search-product-index';
import { orderCapiConversion } from './order-capi-conversion';
import { ebdaAdsConversion } from './ebda-ads-conversion';
import { etaReceiptEnqueue, etaReceiptRedrive, etaReceiptSubmit } from './eta-receipt';
import { orderAutoCancelUnpaid } from './order-auto-cancel-unpaid';
import { instapayExpiry } from './instapay-expiry';
import { shipmentCreate } from './shipment-create';
import { storeUsageSnapshot } from './store-usage-snapshot';
import { billingRenewalDaily } from './billing-renewal';
import { domainClaimSweep } from './domain-claim-sweep';
import { legalEvidenceRetention } from './legal-evidence-retention';
import { r2OrphanSweep } from './r2-orphan-sweep';
import { paymentAbandonmentSweep } from './payment-abandonment-sweep';
import { paymentWebhookProcess } from './payment-webhook-process';
import { paymentWebhookStuckSweep } from './payment-webhook-stuck-sweep';
import { orderCreatedStuckSweep } from './order-created-stuck-sweep';
import { refundReversalStuckSweep } from './refund-reversal-stuck-sweep';
import { orderStatusFanoutStuckSweep } from './order-status-fanout-stuck-sweep';
import { paymentReconcileSweep } from './payment-reconcile-sweep';
import { orderStatusChanged } from './order-status-changed';
import { bulkAiBalanceDescriptions } from './bulk-ai-balance-descriptions';
import { bulkAiRevertBalance } from './bulk-ai-revert-balance';
import { bulkAiCategorize } from './bulk-ai-categorize';
import { bulkAiImageAlt } from './bulk-ai-image-alt';
import { bulkAiExcerpt } from './bulk-ai-excerpt';
import { bulkAiTags } from './bulk-ai-tags';
import { accountErasedPropagation } from './account-erased-propagation';
import {
  warehouseReconcileSweepCron,
  warehouseReconcileOnDemand,
} from './warehouse-reconcile-sweep';
import {
  answerEngineCitationScanCron,
  answerEngineScanOnDemand,
} from './answer-engine-citation-scan';
import { gscIngestCron, gscIngestOnDemand } from './gsc-ingest';
import { contactFormSend } from './contact-form-send';
import { campaignSend } from './campaign-send';
import { webhookFanout, webhookDeliver, webhookDeliveryPurge } from './webhook-delivery';
import { cartRecoveryEmail } from './cart-recovery-email';
import { legalNoticeSend } from './legal-notice-send';
import { waStoreEvents, waPlanSync } from './wa-store-events';
import { ciOutcomes } from './ci-outcomes';
import { ciAggregationDaily, ciHintCalibrationWeekly } from './ci-aggregation';
import { ciErasureSecondPassFn } from './ci-erasure-second-pass';

/**
 * Registry of every background function the API runs. Importing a
 * function file registers it (`createFunction`); the Worker's Workflow, Queue and
 * Cron runners (lib/jobs) execute them. A new function also needs its entry in
 * `lib/jobs/jobs-map.ts` (pinned by tests/unit/jobs-map.test.ts).
 */
const allInngestFunctions: JobDef[] = [
  orderCreated,
  orderRefunded,
  bulkImportProducts,
  // Catalogue import (photos / PDFs -> reviewed drafts).
  catalogImportRun,
  catalogImportCreateDrafts,
  catalogImportUploadsSweep,
  bulkImportOrphanCleanup,
  invoiceEmail,
  heartbeat,
  storefrontPurgeRetry,
  storefrontBundleBoundary,
  auditLogArchive,
  bulkAiTranslate,
  bulkAiSeo,
  bulkAiFaqAeo,
  bulkAiHowtoAeo,
  bulkAiMetaAeo,
  bulkAiRecommendations,
  bulkAiProductFaqs,
  bulkAiLlmsTxt,
  bulkAiCitationCopy,
  bulkAiBrandFacts,
  reviewRequest,
  reviewModeration,
  abandonedCartPurge,
  searchLogPurge,
  instapayReceiptRetention,
  softDeletedUserAnonymize,
  orderAnonymizeAtFiveYears,
  alertsFailureWatch,
  gmailAlertPoller,
  queueDepthWatch,
  agentWriteDeniedWatch,
  accountingPostOrderJournal,
  accountingPostRefundJournal,
  accountingDailyClose,
  accountingPeriodReconciliation,
  accountingPostPoReceiveJournal,
  accountingPostStockAdjustmentJournal,
  accountingPostExpenseJournal,
  stockReorderScanCron,
  stockReorderScanOnDemand,
  stockDeadstockScanCron,
  stockDeadstockScanOnDemand,
  stockLowStockAlertCron,
  wholesalePendingNudgeCron,
  lifecycleEmails,
  lifecycleFirstOrder,
  stockLowStockAlertOnDemand,
  accountingProfitAnomalyCron,
  accountingExpenseOcrProcess,
  instapayReceiptExtract,
  analyticsDailyRollupCron,
  analyticsRefundCorrection,
  analyticsFunnelBackfill,
  analyticsRollupOnDemand,
  // AI-first autofill: fills product fields + kicks recommendations on create
  aiAutofillProduct,
  // AI-first autofill: purges recommendation graph rows on product delete
  aiAutofillCleanup,
  // AI-first autofill: daily leader-locked catalogue sweep with order-driven recos
  aiAutofillSweep,
  // Search (Task 11): embed stale products per store + 6-hourly stale-store backstop/backfill
  searchProductIndex,
  searchIndexBackstop,
  // Server-side conversion API: Meta CAPI + TikTok Events API on purchase
  orderCapiConversion,
  // Ebda's OWN acquisition funnel: Meta CAPI for registration / store created / first paid sub.
  ebdaAdsConversion,
  // Egypt ETA e-receipts (Ruling ETA-1): enqueue on order created/refunded, submit + verdict poll, durable timer.
  etaReceiptEnqueue,
  etaReceiptSubmit,
  etaReceiptRedrive,
  // Auto-cancel stale unpaid orders past AUTO_CANCEL_UNPAID_DAYS (daily cron).
  orderAutoCancelUnpaid,
  instapayExpiry,
  // SP7: carrier booking off the order path, retried, merchant notified when it gives up.
  shipmentCreate,
  storeUsageSnapshot,
  billingRenewalDaily,
  domainClaimSweep,
  legalEvidenceRetention,
  // Weekly R2 orphan sweep: lists bucket vs DB references and reports
  // orphans via logger + Telegram. Deletion gated on R2_ORPHAN_SWEEP_APPLY=true.
  r2OrphanSweep,
  // Enterprise: hourly sweep that stamps paymentGatewayAbandonedAt on
  // orders that reached a payment gateway (paymentUrl non-null) but never paid.
  // Only runs for stores with the 'payment_abandonment' feature enabled.
  paymentAbandonmentSweep,
  // Payment webhook offload: consumes payment/webhook.received and runs the
  // heavy PaymentService.handleWebhook mutation OFF the inbound webhook
  // request path so a provider webhook storm can't starve the shared
  // Prisma pool / auth (P2024). See payment-webhook-process.ts.
  paymentWebhookProcess,
  // Safety net: re-sends undelivered payment webhook inbox rows + P0-alerts
  // wedged ones (the inngest.send-ok-but-never-delivered gap). 30-min cron (INNGEST-BUDGET-1).
  paymentWebhookStuckSweep,
  // Safety net: re-sends order/created for PAID orders whose fanout never ran
  // (the order/created enqueue is fire-and-forget with no fallback). Hourly cron.
  orderCreatedStuckSweep,
  refundReversalStuckSweep,
  orderStatusFanoutStuckSweep,
  // Reconciliation watch: P0-alerts a CAPTURED payment sitting on a CANCELLED
  // order (money taken for an order that will never ship). Hourly cron,
  // alert-once via a durable reconciliation PaymentEvent marker.
  paymentReconcileSweep,
  // Post-purchase status-transition side effects (emails/push/dispatch/affiliate/
  // loyalty/auto-ship) migrated off updateStatus's in-process fire-and-forget onto
  // retriable Inngest steps that dead-letter on failure (Lens E, E2-4).
  orderStatusChanged,
  // AI description-language balancer: translates the richer EN/AR description
  // into the thinner language across the whole catalogue. Revert backup included.
  bulkAiBalanceDescriptions,
  // Bulk revert: restores description fields from the balance snapshot.
  bulkAiRevertBalance,
  // Catalogue field sweeps (2026-07-03): category / image-alt / excerpt / tags.
  bulkAiCategorize,
  bulkAiImageAlt,
  bulkAiExcerpt,
  bulkAiTags,
  // Right-to-erasure third-party propagation: OneSignal player deletion +
  // PostHog person deletion, fired after AuthService.eraseAccount commits.
  accountErasedPropagation,
  // Item 5 data-integrity Task 4: daily completeness sweep that reconciles
  // WarehouseStock to the authoritative Product/ProductVariant.inventory
  // aggregate for every store with a warehouse, regardless of which writer
  // last drifted it (the class-fix, not a per-writer hook) + its on-demand
  // twin for the admin "Reconcile now" button.
  warehouseReconcileSweepCron,
  warehouseReconcileOnDemand,
  // Answer-Engine Insights (Task 6): weekly citation scan across every
  // enabled provider (Gemini + opt-in paid engines) + its on-demand twin.
  answerEngineCitationScanCron,
  answerEngineScanOnDemand,
  // Answer-Engine Insights (Plan 8B, Task 3): daily force-managed GSC Search
  // Analytics ingestion (dormant until GSC_SERVICE_ACCOUNT_JSON is set) +
  // its on-demand twin.
  gscIngestCron,
  gscIngestOnDemand,
  // Platform "contact us" notification email (#645) — queued instead of
  // fire-and-forget so an SMTP failure retries + dead-letter-alerts instead
  // of silently losing the submission.
  contactFormSend,
  // D2 email campaigns: event-triggered only (a merchant pressing send) —
  // no cron, so registering it sends nothing on its own.
  campaignSend,
  webhookFanout,
  webhookDeliver,
  webhookDeliveryPurge,
  // Abandoned-cart recovery email: event-triggered only (the 15-min cart sweep claims a due
  // cart and emits one event); consent-gated and once per cart.
  cartRecoveryEmail,
  // Material legal-policy change: one email per store owner (Ruling LEGAL-4). Event-triggered
  // only (a super admin pressing Send notice).
  legalNoticeSend,
  waStoreEvents,
  ciOutcomes,
  ciAggregationDaily,
  ciHintCalibrationWeekly,
  ciErasureSecondPassFn,
  waPlanSync,
  // Gold-rate pricing (Phase B5, Ruling B5-15/B5-16): the free automatic rate (6-hourly) and the stale-rate
  // alerts (hourly). Both exit un-stepped on an empty tick (one execution).
  goldRateFeedFetchCron,
  goldRateStalenessWatchCron,
];

/**
 * Served functions. On Workers the Gmail alert poller is left out: it is Ebda ops plumbing over IMAP
 * (TCP + TLS to Gmail), dropped from the Ebda API (R-EBDA-001 section 5); Ebda alerts come from
 * Sentry and the status page.
 */
export const inngestFunctions: JobDef[] = isWorkers
  ? allInngestFunctions.filter(f => f !== gmailAlertPoller)
  : allInngestFunctions;
