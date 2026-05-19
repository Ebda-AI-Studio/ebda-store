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

export type AppEvent =
  | OrderCreatedEvent
  | BulkImportStartedEvent
  | InvoiceEmailRequestedEvent
  | BulkAiTranslateEvent
  | BulkAiSeoEvent
  | OrderDeliveredEvent
  | OrderShippedEvent
  | ReviewSubmittedEvent
  | StockPoReceivedEvent
  | StockAdjustmentPostedEvent
  | AccountingExpensePostedEvent;

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

export const inngest = new Inngest({
  id: 'force-api',
  // Inngest's SDK auto-detects dev mode from the absence of an event
  // key, but on Railway we always have NODE_ENV=production set even
  // for staging — be explicit so dev mode is never accidentally on
  // in a deployed environment.
  isDev: config.nodeEnv !== 'production',
  eventKey: config.inngestEventKey || undefined,
  signingKey: config.inngestSigningKey || undefined,
});
