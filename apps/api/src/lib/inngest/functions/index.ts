import type { InngestFunction } from 'inngest';
import { orderCreated } from './order-created';
import { orderRefunded } from './order-refunded';
import { bulkImportProducts } from './bulk-import';
import { bulkImportOrphanCleanup } from './bulk-import-orphan-cleanup';
import { invoiceEmail } from './invoice-email';
import { heartbeat } from './heartbeat';
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
  softDeletedUserAnonymize,
  orderAnonymizeAtFiveYears,
} from './data-retention';
import { alertsFailureWatch } from './alerts-failure-watch';
import { gmailAlertPoller } from './gmail-alert-poller';
import { queueDepthWatch } from './queue-depth-watch';
import { orderWhatsAppNotify } from './order-whatsapp-notify';
import { accountingPostOrderJournal } from './accounting-post-order-journal';
import { accountingPostRefundJournal } from './accounting-post-refund-journal';
import { accountingDailyClose } from './accounting-daily-close';
import { accountingPeriodReconciliation } from './accounting-period-reconciliation';
import { accountingPostPoReceiveJournal } from './accounting-post-po-receive-journal';
import { accountingPostStockAdjustmentJournal } from './accounting-post-stock-adjustment-journal';
import { accountingPostExpenseJournal } from './accounting-post-expense-journal';
import { stockReorderScanCron, stockReorderScanOnDemand } from './stock-reorder-scan';
import { stockDeadstockScanCron, stockDeadstockScanOnDemand } from './stock-deadstock-scan';
import { stockLowStockAlertCron, stockLowStockAlertOnDemand } from './stock-low-stock-alert';
import { accountingProfitAnomalyCron } from './accounting-profit-anomaly';
import { accountingExpenseOcrProcess } from './accounting-expense-ocr-process';
import { analyticsDailyRollupCron, analyticsRollupOnDemand } from './analytics-daily-rollup';
import { productMetaSyncFn, productMetaSyncDeleteFn } from './product-meta-sync';
import { aiAutofillProduct } from './ai-autofill-product';
import { aiAutofillCleanup } from './ai-autofill-cleanup';
import { aiAutofillSweep } from './ai-autofill-sweep';
import { orderCapiConversion } from './order-capi-conversion';
import { orderStuckPaymentSweep } from './order-stuck-payment-sweep';
import { orderAutoCancelUnpaid } from './order-auto-cancel-unpaid';
import { r2OrphanSweep } from './r2-orphan-sweep';
import { paymentAbandonmentSweep } from './payment-abandonment-sweep';
import { paymentWebhookProcess } from './payment-webhook-process';
import { paymentWebhookStuckSweep } from './payment-webhook-stuck-sweep';
import { bulkAiBalanceDescriptions } from './bulk-ai-balance-descriptions';
import { bulkAiRevertBalance } from './bulk-ai-revert-balance';

/**
 * Registry of every Inngest function the API exposes. The serve
 * handler in `apps/api/src/index.ts` mounts this list at
 * `/api/v1/inngest`. Functions added here are picked up by the
 * Inngest platform on the next deploy / dev sync.
 */
export const inngestFunctions: InngestFunction.Any[] = [
  orderCreated,
  orderRefunded,
  bulkImportProducts,
  bulkImportOrphanCleanup,
  invoiceEmail,
  heartbeat,
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
  softDeletedUserAnonymize,
  orderAnonymizeAtFiveYears,
  alertsFailureWatch,
  gmailAlertPoller,
  queueDepthWatch,
  orderWhatsAppNotify,
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
  stockLowStockAlertOnDemand,
  accountingProfitAnomalyCron,
  accountingExpenseOcrProcess,
  analyticsDailyRollupCron,
  analyticsRollupOnDemand,
  // Phase A: product → Meta Catalog sync (native catalog bot)
  productMetaSyncFn,
  productMetaSyncDeleteFn,
  // AI-first autofill: fills product fields + kicks recommendations on create
  aiAutofillProduct,
  // AI-first autofill: purges recommendation graph rows on product delete
  aiAutofillCleanup,
  // AI-first autofill: 3-day leader-locked catalogue sweep with order-driven recos
  aiAutofillSweep,
  // Server-side conversion API: Meta CAPI + TikTok Events API on purchase
  orderCapiConversion,
  // Stuck-payment merchant alert: 15-min sweep for online orders placed but
  // unpaid past STUCK_PAYMENT_MINUTES — pushes the merchant to follow up.
  orderStuckPaymentSweep,
  // Auto-cancel stale unpaid orders past AUTO_CANCEL_UNPAID_DAYS (daily cron).
  orderAutoCancelUnpaid,
  // Weekly R2 orphan sweep: lists bucket vs DB references and reports
  // orphans via logger + Telegram. Deletion gated on R2_ORPHAN_SWEEP_APPLY=true.
  r2OrphanSweep,
  // Enterprise: every-30-min sweep that stamps paymentGatewayAbandonedAt on
  // orders that reached a payment gateway (paymentUrl non-null) but never paid.
  // Only runs for stores with the 'payment_abandonment' feature enabled.
  paymentAbandonmentSweep,
  // Payment webhook offload: consumes payment/webhook.received and runs the
  // heavy PaymentService.handleWebhook mutation OFF the inbound webhook
  // request path so a provider webhook storm can't starve the shared
  // Prisma pool / auth (P2024). See payment-webhook-process.ts.
  paymentWebhookProcess,
  // Safety net: re-sends undelivered payment webhook inbox rows + P0-alerts
  // wedged ones (the inngest.send-ok-but-never-delivered gap). 5-min cron.
  paymentWebhookStuckSweep,
  // AI description-language balancer: translates the richer EN/AR description
  // into the thinner language across the whole catalogue. Revert backup included.
  bulkAiBalanceDescriptions,
  // Bulk revert: restores description fields from the balance snapshot.
  bulkAiRevertBalance,
];
