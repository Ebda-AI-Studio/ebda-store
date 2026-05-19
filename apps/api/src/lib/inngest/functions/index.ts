import type { InngestFunction } from 'inngest';
import { orderCreated } from './order-created';
import { orderRefunded } from './order-refunded';
import { bulkImportProducts } from './bulk-import';
import { invoiceEmail } from './invoice-email';
import { heartbeat } from './heartbeat';
import { auditLogArchive } from './audit-log-archive';
import { bulkAiTranslate } from './bulk-ai-translate';
import { bulkAiSeo } from './bulk-ai-seo';
import { bulkAiFaqAeo, bulkAiHowtoAeo, bulkAiMetaAeo } from './bulk-ai-aeo';
import { bulkAiRecommendations } from './bulk-ai-recommendations';
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
  invoiceEmail,
  heartbeat,
  auditLogArchive,
  bulkAiTranslate,
  bulkAiSeo,
  bulkAiFaqAeo,
  bulkAiHowtoAeo,
  bulkAiMetaAeo,
  bulkAiRecommendations,
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
];
