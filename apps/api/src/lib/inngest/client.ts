import { dispatchEvents } from '../jobs/dispatch';
import { registerJob } from '../jobs/registry';
import type { JobDef, JobEvent, JobHandler, JobOptions } from '../jobs/types';

/** The shape every event below extends (was the Inngest SDK's `EventPayload`). */
type EventPayload = { name: string; data?: unknown; id?: string; ts?: number };

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

type CatalogImportStartedEvent = EventPayload & {
  name: 'catalog-import/started';
  data: { jobId: string; storeId: string };
};

type CatalogImportCreateDraftsEvent = EventPayload & {
  name: 'catalog-import/create-drafts';
  data: { jobId: string; storeId: string; itemIds?: string[] };
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

/** InstaPay auto-confirm (Ruling INSTAPAY-AUTO-1): decide and, when everything matches, activate one subscription claim. */
type InstapayAutoConfirmRequestedEvent = EventPayload & {
  name: 'instapay/auto-confirm.requested';
  data: { storeId: string; claimId: string };
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
    /** The erased customer's store and hashed phone, for Ebda Chat's `customer.erased`. */
    storeId?: string;
    buyerKey?: string;
    /** Buyer keys of a phone the account PROVED it holds, and the store that proof was made in: erased in THAT store only. */
    ciProven?: { storeId: string; buyerKeys: string[] };
    /** The account's own orders in its store (and the keys on them): the default CI erase scope. */
    ciScope?: { storeId: string; orderIds: string[]; buyerKeys: string[]; sinceDay?: string };
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

// The storefront contact message (FU46-1): routed to the store named by `storeId`. Events
// enqueued before FU46-1 carry no `storeId` and keep the platform destination.
type ContactFormSubmittedEvent = EventPayload & {
  name: 'contact/form.submitted';
  data: {
    storeId?: string;
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

// Abandoned-cart recovery email: emitted ONLY by sweepCartRecoveryEmails for a cart it just
// claimed; the event id is `cart-recovery-email/<abandonedCartId>`.
type CartRecoveryEmailRequestedEvent = EventPayload & {
  name: 'cart-recovery/email-requested';
  data: {
    abandonedCartId: string;
    storeId: string;
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

// Egypt ETA e-receipt submit (Ruling ETA-1): one event per eta_receipts row; the job also re-sends
// itself for the verdict poll, so the same row id may arrive many times (idempotent by row state).
type EtaReceiptSubmitEvent = EventPayload & {
  name: 'eta/receipt.submit';
  data: { storeId: string; receiptId: string };
};

// Durable timer for the next ETA attempt/poll of a row (sleeps until `at`, then re-sends eta/receipt.submit).
type EtaReceiptScheduledEvent = EventPayload & {
  name: 'eta/receipt.scheduled';
  data: { storeId: string; receiptId: string; at: string };
};

// Material legal-policy change (Ruling LEGAL-4): emitted ONLY by the super-admin
// POST /admin/legal-policies/:docKey/:version/{send-notice,resume,retry-failed};
// see functions/legal-notice-send.ts. `sendId` pins the run to ONE legal_notice_sends row
// (a stale run never adopts a newer send of the same version); `sentBy` is the super admin
// acting for THIS run (the one who pressed Send, Resume or Retry failed).
type LegalNoticeSendRequestedEvent = EventPayload & {
  name: 'legal/notice.send-requested';
  data: { sendId: string; docKey: string; version: string; sentBy: string };
};

// Search program Task 11: ask the product embedding indexer to look at one store (debounced per
// store). Sent by every product-text writer outside ProductService.create/update, the backstop cron
// and the indexer's own continuation.
type SearchStoreReindexRequestedEvent = EventPayload & {
  name: 'search/store.reindex-requested';
  data: { storeId: string; reason: string };
};

// Merchant outgoing webhooks. `delivery.requested` is sent by the fan-out (after the delivery rows
// exist) and by the admin test/resend routes; `inventory.low` by the low-stock scan.
type WebhookDeliveryRequestedEvent = EventPayload & {
  name: 'webhook/delivery.requested';
  data: { storeId: string; deliveryId: string };
};

type WebhookInventoryLowEvent = EventPayload & {
  name: 'webhook/inventory.low';
  data: {
    storeId: string;
    /** UTC day (YYYY-MM-DD): at most one inventory.low per product per day. */
    day: string;
    items: Array<{ productId: string; name: string; inventory: number; lowStockThreshold: number }>;
  };
};

// A self-serve store was provisioned with its signup trial: starts the sleeping lifecycle-emails run
// (setup nudges + trial recap). Emitted once, after the provisioning transaction committed.
type StoreSelfServeProvisionedEvent = EventPayload & {
  name: 'store/self-serve-provisioned';
  data: { storeId: string };
};

export type AppEvent =
  | OrderCreatedEvent
  | BulkImportStartedEvent
  | InvoiceEmailRequestedEvent
  | BulkAiTranslateEvent
  | BulkAiSeoEvent
  | BulkAiProductFaqsEvent
  | OrderDeliveredEvent
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
  | InstapayAutoConfirmRequestedEvent
  | InsightsRollupRequestedEvent
  | PaymentWebhookReceivedEvent
  | ShipmentCreateRequestedEvent
  | BulkAiBalanceDescriptionsEvent
  | BulkAiRevertBalanceEvent
  | BulkAiCategorizeEvent
  | BulkAiImageAltEvent
  | BulkAiExcerptEvent
  | BulkAiTagsEvent
  | CatalogImportStartedEvent
  | CatalogImportCreateDraftsEvent
  | AccountErasedEvent
  | AnswerEngineScanRequestedEvent
  | GscIngestRequestedEvent
  | ContactFormSubmittedEvent
  | CampaignSendRequestedEvent
  | CartRecoveryEmailRequestedEvent
  | EbdaAdsConversionRequestedEvent
  | EtaReceiptSubmitEvent
  | EtaReceiptScheduledEvent
  | LegalNoticeSendRequestedEvent
  | SearchStoreReindexRequestedEvent
  | WebhookDeliveryRequestedEvent
  | WebhookInventoryLowEvent
  | StoreSelfServeProvisionedEvent;

/**
 * The background-job client. `createFunction` registers a handler in the job registry (the
 * Cloudflare Workflow / Queue runners execute it, lib/jobs); `send` starts every subscriber of an
 * event (lib/jobs/dispatch.ts). Same call shape the code used when this was the Inngest SDK, so no
 * call site changed; the SDK, its serve endpoint and its deploy sync are gone.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface JobClient {
  createFunction(
    options: JobOptions,
    handler: (ctx: {
      event: JobEvent & { data: any };
      step: import('../jobs/types').JobStep;
      runId: string;
      attempt: number;
    }) => Promise<any> | any
  ): JobDef;
  send(payload: JobEvent | JobEvent[]): Promise<{ ids: string[] }>;
}

export const inngest: JobClient = {
  createFunction: (options, handler) => registerJob(options, handler as unknown as JobHandler),
  send: payload => dispatchEvents(payload),
};
