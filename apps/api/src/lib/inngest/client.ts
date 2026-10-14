import { Inngest, type EventPayload } from 'inngest';
import { config } from '../../config';

/**
 * Event registry — every event the API can fan out lives here so
 * publisher and consumer share a single source of truth. Adding a
 * new background job is a two-step process:
 *
 *   1. Add the event shape below
 *   2. Register a function in `./functions/index.ts` that listens for it
 *
 * Names follow the `domain/action.tense` convention so they read
 * naturally in the Inngest UI: `order/created`, `bulk-import/started`.
 */
type OrderCreatedEvent = EventPayload & {
  name: 'order/created';
  data: {
    orderId: string;
    storeId: string;
    paymentMethod: string;
  };
};

type BulkImportStartedEvent = EventPayload & {
  name: 'bulk-import/started';
  data: {
    jobId: string;
    storeId: string;
  };
};

type InvoiceEmailRequestedEvent = EventPayload & {
  name: 'order/invoice.email-requested';
  data: {
    orderId: string;
    storeId: string;
    to: string;
  };
};

type BulkAiTranslateEvent = EventPayload & {
  name: 'bulk-ai/translate-requested';
  data: {
    jobId: string;
    storeId: string;
    direction: 'to_ar' | 'to_en';
  };
};

type BulkAiSeoEvent = EventPayload & {
  name: 'bulk-ai/seo-requested';
  data: {
    jobId: string;
    storeId: string;
  };
};

type BulkAiProductFaqsEvent = EventPayload & {
  name: 'bulk-ai/product-faqs-requested';
  data: {
    jobId: string;
    storeId: string;
    force?: boolean;
  };
};

type OrderDeliveredEvent = EventPayload & {
  name: 'order/delivered';
  data: {
    orderId: string;
    storeId: string;
  };
};

type OrderShippedEvent = EventPayload & {
  name: 'order/shipped';
  data: {
    orderId: string;
    storeId: string;
  };
};

type ReviewSubmittedEvent = EventPayload & {
  name: 'review/submitted';
  data: {
    reviewId: string;
    storeId: string;
  };
};

type StockPoReceivedEvent = EventPayload & {
  name: 'stock/po-received';
  data: {
    storeId: string;
    poId: string;
    clearedBackorders: Array<{
      backorderLineId: string;
      orderItemId: string;
      qty: number;
      actualUnitCost: number;
      estimateUnitCost: number;
      variance: number;
    }>;
  };
};

type StockAdjustmentPostedEvent = EventPayload & {
  name: 'stock/adjustment-posted';
  data: {
    storeId: string;
    adjustmentId: string;
  };
};

type AccountingExpensePostedEvent = EventPayload & {
  name: 'accounting/expense-posted';
  data: {
    storeId: string;
    expenseId: string;
  };
};

type StockReorderScanRequestedEvent = EventPayload & {
  name: 'stock/reorder-scan-requested';
  data: {
    storeId: string;
    requestedBy?: string;
  };
};

type StockDeadstockScanRequestedEvent = EventPayload & {
  name: 'stock/deadstock-scan-requested';
  data: {
    storeId: string;
    requestedBy?: string;
  };
};

type StockLowStockScanRequestedEvent = EventPayload & {
  name: 'stock/low-stock-scan-requested';
  data: {
    storeId: string;
    requestedBy?: string;
  };
};

// On-demand twin of the daily warehouse-reconcile-sweep cron (Task 5's admin
// "Reconcile now" button). See warehouse-reconcile-sweep.ts.
type WarehouseReconcileRequestedEvent = EventPayload & {
  name: 'warehouse/reconcile-requested';
  data: {
    storeId: string;
    requestedBy?: string;
  };
};

/** Read an uploaded InstaPay transfer receipt with Gemini (money batch A). */
type InstapayReceiptExtractEvent = EventPayload & {
  name: 'instapay/receipt-extract';
  data: { storeId: string; receiptId: string };
};

type AccountingExpenseOcrProcessEvent = EventPayload & {
  name: 'accounting/expense-ocr-process';
  data: {
    storeId: string;
    receiptUrl: string;
    uploadedBy?: string;
  };
};

type InsightsRollupRequestedEvent = EventPayload & {
  name: 'insights/rollup-requested';
  data: {
    storeId: string;
    requestedBy?: string;
  };
};

type ShipmentCreateRequestedEvent = EventPayload & {
  name: 'shipment/create.requested';
  data: {
    storeId: string;
    orderId: string;
    /** Absent = the store's default carrier. */
    carrier?: string;
  };
};

type PaymentWebhookReceivedEvent = EventPayload & {
  name: 'payment/webhook.received';
  data: {
    /// PK of the WebhookEvent inbox row persisted by the route before send.
    webhookEventId: string;
    /// 'paymob' | 'kashier' | 'fawry'
    provider: string;
    /// Idempotency key (also the inbox row's unique key) for log correlation.
    idempotencyKey: string;
    /// Resolved upfront; undefined for the platform-only path.
    storeId?: string;
  };
};

type BulkAiBalanceDescriptionsEvent = EventPayload & {
  name: 'bulk-ai/balance-descriptions.requested';
  data: {
    jobId: string;
    storeId: string;
  };
};

type BulkAiRevertBalanceEvent = EventPayload & {
  name: 'bulk-ai/revert-balance.requested';
  data: {
    jobId: string;
    storeId: string;
  };
};

// Catalogue field sweeps (2026-07-03): category assignment, image alt-text,
// product excerpts, product tags. See docs/plans/2026-07-03-ai-bulk-sweeps.md.
type BulkAiCategorizeEvent = EventPayload & {
  name: 'bulk-ai/categorize-requested';
  data: {
    jobId: string;
    storeId: string;
    force?: boolean;
  };
};

type BulkAiImageAltEvent = EventPayload & {
  name: 'bulk-ai/image-alt-requested';
  data: {
    jobId: string;
    storeId: string;
    force?: boolean;
  };
};

type BulkAiExcerptEvent = EventPayload & {
  name: 'bulk-ai/excerpt-requested';
  data: {
    jobId: string;
    storeId: string;
    force?: boolean;
  };
};

type BulkAiTagsEvent = EventPayload & {
  name: 'bulk-ai/tags-requested';
  data: {
    jobId: string;
    storeId: string;
    force?: boolean;
  };
};

// Fired after AuthService.eraseAccount's Postgres transaction has already
// committed — the third-party propagation consumer (OneSignal player
// deletion + PostHog person deletion) runs entirely off this event so a
// slow/failing provider can never block or roll back the erase response.
// See apps/api/src/services/privacy-propagation.service.ts.
type AccountErasedEvent = EventPayload & {
  name: 'account/erased';
  data: {
    userId: string;
    /** OneSignal player/subscription ids captured before the erase
     *  transaction deleted the local OneSignalSubscription rows. Almost
     *  always empty for customer erasures — see the caveat in
     *  privacy-propagation.service.ts. */
    oneSignalPlayerIds: string[];
  };
};

type AnswerEngineScanRequestedEvent = EventPayload & {
  name: 'answer-engine/scan-requested';
  data: {
    storeId: string;
  };
};

// Plan 8B, Task 3: force-managed GSC Search Analytics daily ingestion —
// on-demand twin of gscIngestCron (see functions/gsc-ingest.ts).
type GscIngestRequestedEvent = EventPayload & {
  name: 'gsc/ingest-requested';
  data: {
    storeId: string;
  };
};

// #645: the platform "contact us" notification email — see
// functions/contact-form-send.ts for why this is queued instead of a
// fire-and-forget send.
type ContactFormSubmittedEvent = EventPayload & {
  name: 'contact/form.submitted';
  data: {
    name: string;
    email: string;
    subject: string;
    message: string;
  };
};

// D2 email campaigns: emitted ONLY by POST /stores/:storeId/campaigns/:id/send
// (a merchant pressing send). `scheduledAt` (ISO) doubles as the per-request
// nonce — see functions/campaign-send.ts.
type CampaignSendRequestedEvent = EventPayload & {
  name: 'campaign/send-requested';
  data: {
    campaignId: string;
    storeId: string;
    scheduledAt: string;
  };
};

// Ebda's own acquisition conversions (Meta Conversions API). Emitted after the business
// transaction committed; see functions/ebda-ads-conversion.ts and services/ebda-ads-emit.ts.
type EbdaAdsConversionRequestedEvent = EventPayload & {
  name: 'ebda-ads/conversion.requested';
  data: {
    name: 'CompleteRegistration' | 'StoreCreated' | 'Purchase';
    /** Meta dedup id, shared with the browser twin (shared/tracking/event-ids.ts). */
    eventId: string;
    userId: string;
    storeId?: string;
    billingEventId?: string;
  };
};

export type AppEvent =
  | OrderCreatedEvent
  | BulkImportStartedEvent
  | InvoiceEmailRequestedEvent
  | BulkAiTranslateEvent
  | BulkAiSeoEvent
  | BulkAiProductFaqsEvent
  | OrderDeliveredEvent
  | OrderShippedEvent
  | ReviewSubmittedEvent
  | StockPoReceivedEvent
  | StockAdjustmentPostedEvent
  | AccountingExpensePostedEvent
  | StockReorderScanRequestedEvent
  | StockDeadstockScanRequestedEvent
  | StockLowStockScanRequestedEvent
  | WarehouseReconcileRequestedEvent
  | AccountingExpenseOcrProcessEvent
  | InstapayReceiptExtractEvent
  | InsightsRollupRequestedEvent
  | PaymentWebhookReceivedEvent
  | ShipmentCreateRequestedEvent
  | BulkAiBalanceDescriptionsEvent
  | BulkAiRevertBalanceEvent
  | BulkAiCategorizeEvent
  | BulkAiImageAltEvent
  | BulkAiExcerptEvent
  | BulkAiTagsEvent
  | AccountErasedEvent
  | AnswerEngineScanRequestedEvent
  | GscIngestRequestedEvent
  | ContactFormSubmittedEvent
  | CampaignSendRequestedEvent
  | EbdaAdsConversionRequestedEvent;

// Inngest re-registers the function manifest only when it detects a
// deploy-version change. Without an explicit deploy id, Railway boots
// look identical across deploys to Inngest's tracker — new functions
// get accepted as events but no handler runs (BulkAiJob rows stuck
// 'queued' forever). Map RAILWAY_DEPLOYMENT_ID (auto-set per deploy)
// to INNGEST_DEPLOY_ID at process start. Fallback chain handles other
// platforms + local dev gracefully.
//
// See ~/.claude/projects/-Users-ahmadsharaf/memory/feedback-inngest-deploy-sync-trap.md
// for the full trap explanation.
if (!process.env.INNGEST_DEPLOY_ID) {
  const detected =
    process.env.RAILWAY_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.SOURCE_VERSION;
  if (detected) {
    process.env.INNGEST_DEPLOY_ID = detected;
  }
}

// In CI (and any test run), the Inngest dev server is not running.
// Rather than letting every inngest.send() throw a "fetch failed" network
// error that spams logs and can cascade into test failures, we substitute a
// no-op send when in dry-run mode.
//
// We always export a real Inngest instance (not a cast-to-any stub) so
// TypeScript can properly type the createFunction handlers (step, event,
// etc.). The send method is replaced at runtime when isDryRun is true.
//
// Activation: set INNGEST_DRY_RUN=true OR NODE_ENV=test.
// Production and local dev are never affected (NODE_ENV=production/development,
// INNGEST_DRY_RUN unset).
const isDryRun = process.env.INNGEST_DRY_RUN === 'true' || process.env.NODE_ENV === 'test';

export const inngest = new Inngest({
  id: 'force-api',
  // Inngest's SDK auto-detects dev mode from the absence of an event
  // key, but on Railway we always have NODE_ENV=production set even
  // for staging — be explicit so dev mode is never accidentally on
  // in a deployed environment.
  isDev: config.nodeEnv !== 'production',
  eventKey: config.inngestEventKey || undefined,
  signingKey: config.inngestSigningKey || undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...(isDryRun ? { middleware: [] } : {}),
});

// Override send() to be a no-op in dry-run mode so CI never hits the
// Inngest dev server over the network. createFunction() is left intact
// so that TypeScript has full handler-parameter types (step, event, etc.)
// — which is why we keep a real Inngest instance rather than cast-to-any.
if (isDryRun) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (inngest as any).send = async () => ({ ids: [] });
}
