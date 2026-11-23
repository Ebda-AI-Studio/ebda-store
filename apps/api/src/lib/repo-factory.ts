/**
 * Per-store data access factory (INFRA-CF-1 task 2.4, Ruling CF-REPO-1).
 *
 * `storeDb(storeId)` hands a service the READ client of the backend that serves that store:
 *   - 'pg' (the DEFAULT for every store): the same `prisma` proxy every service uses today, so a service that moves to
 *     `storeDb` behaves byte-for-byte as before (request transaction, tenant guard, RLS GUCs all unchanged);
 *   - 'do': a Prisma-shaped READ client for that store's Durable Object (packages/repo createDoClient), over the
 *     StoreDO `query` RPC.
 * The backend is chosen by `backendFor` (lib/store-backend.ts: the D1 `stores.storage_backend` flag). Nothing here
 * flips a store; with every flag at 'pg' this module changes no behaviour.
 *
 * FAIL CLOSED: an empty/unresolved store id is a 404 (never "the first store", never the default); a DO that is not bound
 * is a 503 (never a silent fall back to Postgres for a store whose flag says 'do').
 *
 * REQUEST SCOPE: `repoScope` (mounted once in app.ts) opens an AsyncLocalStorage scope per request so the flag is read
 * AT MOST ONCE per (request, store) and a service needs only the store id. STALENESS CLASS of that memo: NEVER-stale
 * data (it decides where money and stock live) cached for ONE REQUEST. Residual window = the request's own duration: a
 * flip happens while writes are frozen and the store sealed (docs/runbooks/cutover-cf.md), so a request that began before
 * the flip finishes on the backend it started on, which is also the only consistent choice mid-request. There is NO
 * cross-request cache, so the flag writer has nothing to invalidate. Outside a request (job, cron, script) every call
 * reads the flag afresh.
 *
 * ISOLATION: the DO client is built per store id and the DO itself refuses any other store (StoreDO.bind), so a client
 * for store A can never read store B's rows.
 *
 * WRITES (PR D1, Ruling CF-WRITES-1): `storeWriter(storeId)` is the write client for the NON-MONEY catalogue/content models
 * (WritableModel below = DO_WRITABLE_MODELS in packages/repo/src/rpc/writes.ts; a unit test keeps the two equal). On 'pg'
 * it is the `prisma` proxy (request transaction, tenant guard, RLS unchanged); on 'do' each call is ONE atomic `mutate`
 * RPC and `$transaction([...], { idempotencyKey })` ships the whole batch as one atomic, replay-safe unit.
 *
 * WHAT IS NOT HERE (PR D2): raw SQL, `$queryRaw`, interactive `$transaction`, row locks, money/stock
 * models. The types `StoreReads`/`StoreWrites` offer only what prisma-lite answers on the DO, and the DO re-checks the
 * allow-list, so a service that compiles against them cannot reach a money path on either backend.
 */
import { platformFamilyOnD1 } from '../services/platform/cutover';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import {
  afterTenantTxCommit,
  afterTxCommit,
  currentStoreId,
  prisma,
  withStore,
  Prisma,
  type AppPrismaClient,
} from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { warnD1OnlySkips } from './store-cas-warn';
import { backendFor, storeDo, type StoreBackend } from './store-backend';
import { scheduleStoreDirectorySync } from './store-directory-sync';
import { platformDb, requirePlatformDb } from './platform-db';
import { d1StorePatch, STORE_D1_ONLY_FIELDS } from './store-columns';
import { reportAndRetryStoreUpdate, reportStoreUpdateFailure } from './store-update-retry';
import { getAccountState } from './identity-client';

type WriteOp =
  | 'create'
  | 'createMany'
  | 'update'
  | 'updateMany'
  | 'upsert'
  | 'delete'
  | 'deleteMany';
type ReadOp =
  | 'findMany'
  | 'findFirst'
  | 'findUnique'
  | 'findFirstOrThrow'
  | 'findUniqueOrThrow'
  | 'count'
  | 'aggregate'
  | 'groupBy';

/** The read-only slice of every model delegate of the Prisma client: what prisma-lite answers on the StoreDO. */
export type StoreReads = {
  [K in keyof AppPrismaClient as AppPrismaClient[K] extends { findMany: unknown }
    ? K
    : never]: Pick<AppPrismaClient[K], Extract<keyof AppPrismaClient[K], ReadOp>>;
};

/** Delegates the StoreDO accepts writes for (equal to DO_WRITABLE_MODELS, lower-camel; see tests/unit/repo-factory-writes.test.ts). */
export type WritableModel =
  | 'paymentConfig'
  | 'storeCredential'
  | 'shippingCarrierConfig'
  | 'storeTaxProfile'
  | 'taxRate'
  | 'storeTaxDocument'
  | 'product'
  | 'productVariant'
  | 'productOption'
  | 'productOptionValue'
  | 'productVariantOption'
  | 'productImage'
  | 'productCategory'
  | 'productFaq'
  | 'productRelation'
  | 'productPriceTier'
  | 'productTag'
  | 'tag'
  | 'category'
  | 'blogPost'
  | 'storePage'
  | 'storePageRevision'
  | 'storeLocation'
  | 'sizeChart'
  | 'cart'
  | 'cartItem'
  | 'cartBundle'
  | 'abandonedCart'
  | 'abandonedCartConfig'
  | 'newsletterSubscriber'
  | 'campaign'
  | 'campaignRecipient'
  | 'notificationConfig'
  | 'notificationEventConfig'
  | 'review'
  | 'etaConnection'
  | 'etaReceipt'
  | 'bulkAiJob'
  | 'deadStockFlag'
  | 'webhookEndpoint'
  | 'webhookDelivery'
  | 'bulkImportJob'
  | 'storeFaq'
  | 'storeHowto'
  | 'aiRecommendation'
  | 'frequentlyBoughtTogether'
  | 'profitAnomaly'
  | 'customerCohortSnapshot'
  | 'funnelSnapshot'
  | 'customerRfmSnapshot'
  | 'answerEngineCheck'
  | 'shipment'
  | 'shipmentPickup'
  | 'shippingZone'
  | 'shippingAreaRate'
  | 'reorderSuggestion'
  | 'supplier'
  | 'reorderRule'
  | 'catalogImportJob'
  | 'catalogImportFile'
  | 'catalogImportItem'
  | 'ciHintLog'
  | 'ciStoreGate'
  | 'searchQueryDaily'
  | 'productDailyView'
  | 'qrScanDaily'
  | 'notificationLog'
  | 'gscDailyMetric'
  | 'wishlist'
  | 'wishlistItem'
  | 'bundle'
  | 'bundleItem'
  | 'auditLog'
  | 'customerGroup'
  | 'address'
  | 'customerAddress'
  | 'coupon'
  | 'promotion'
  | 'wholesaleApplication'
  | 'productModel'
  | 'productModelBinding'
  | 'storeWhatsAppLink'
  // marketing consents a shopper grants / withdraws on the storefront (NEON-ZERO class sweep, 2026-11-09)
  | 'storeWhatsAppConsent'
  | 'smsMarketingConsent'
  | 'goldRateSettings'
  | 'warehouse'
  | 'affiliateConfig'
  | 'affiliate'
  | 'affiliateEvent'
  | 'affiliateReferral'
  // finance admin (Ruling NZ-FEAT-1): never the ledger (JournalEntry / JournalLine use the journal money ops)
  | 'account'
  | 'fxRateEntry'
  | 'bankStatement'
  | 'bankTransaction';
/** `inventory` is never written through this client (stock moves only in the locked money/stock sections, PR D2). */
export type StoreWrites = {
  [K in WritableModel]: Pick<
    AppPrismaClient[K],
    Extract<keyof AppPrismaClient[K], ReadOp | WriteOp>
  >;
} & {
  /** DO-only named procedure (see DO_PROCS); the Postgres twin is the raw statement kept in the service. */
  $proc(name: string, args: Record<string, unknown>): PromiseLike<any>;
  /** Array form only. `idempotencyKey` is honoured by the DO (a replay returns the first result); Postgres ignores it. */
  $transaction<T extends readonly PromiseLike<unknown>[]>(
    ops: [...T],
    opts?: { idempotencyKey?: string }
  ): Promise<{ [I in keyof T]: Awaited<T[I]> }>;
};

/**
 * Stock and inventory operations of a store served by its Durable Object (PR D2a, Ruling CF-STOCK-1). One method per
 * operation, each ONE atomic section in the DO; results and refusals carry the same codes the Postgres services use.
 * `key` makes a retry return the first result (store it per logical action: an order id plus a line, an import row).
 */
export type HistoryType =
  | 'manual_add'
  | 'manual_remove'
  | 'sale'
  | 'return_stock'
  | 'adjustment'
  | 'damage'
  | 'transfer_in'
  | 'transfer_out'
  | 'initial';
interface StockLevel {
  productId: string;
  name: string;
  previousStock: number;
  newStock: number;
}
export interface StockClient {
  adjustProduct(
    a: {
      productId: string;
      quantity: number;
      type: HistoryType;
      reason?: string;
      reference?: string;
      userId?: string;
    },
    key?: string
  ): Promise<StockLevel & { historyId: string }>;
  setProduct(
    a: { productId: string; quantity: number; reason?: string; userId?: string },
    key?: string
  ): Promise<StockLevel & { historyId: string }>;
  bulkAdjustProducts(
    a: {
      adjustments: Array<{
        productId: string;
        quantity: number;
        type: HistoryType;
        reason?: string;
        reference?: string;
      }>;
      userId?: string;
    },
    key?: string
  ): Promise<{ successful: number; failed: number; errors: string[]; applied: StockLevel[] }>;
  setVariantInventory(
    a: { productId: string; updates: Array<{ variantId: string; inventory: number }> },
    key?: string
  ): Promise<{
    updated: number;
    failed: number;
    results: Array<{ variantId: string; success: boolean }>;
  }>;
  /** Disable / re-enable a variant; a variant holding units gets its stock-history row in the same DO transaction. */
  setVariantActive(
    a: { productId: string; variantId: string; isActive: boolean; userId?: string },
    key?: string
  ): Promise<{ changed: boolean; historyId: string | null }>;
  setWarehouseStock(
    a: { warehouseId: string; productId: string; variantId?: string | null; quantity: number },
    key?: string
  ): Promise<{ quantity: number }>;
  adjustWarehouseStock(
    a: {
      warehouseId: string;
      productId: string;
      variantId?: string | null;
      delta: number;
      reason?: string;
    },
    key?: string
  ): Promise<{ newQuantity: number }>;
  /** One SKU's warehouse shadow back to its aggregate (Ruling CF-JOBS-4). */
  reconcileWarehouseSku(a: {
    productId: string;
    variantId?: string | null;
  }): Promise<{ reconciled: boolean; diff: number }>;
  /** A page of the reconcile sweep: every SKU with a warehouse row after `afterKey`, up to `limit`. */
  /** R7 (Ruling CF-R7-1): the accounting + scan stock flows, each ONE section in the DO. */
  createStockAdjustment(
    a: {
      type: string;
      reason?: string | null;
      reasonAr?: string | null;
      evidenceUrl?: string | null;
      createdBy?: string | null;
      importKey?: string | null;
      items: Array<{ productId: string; variantId?: string | null; newQty: number }>;
    },
    key?: string
  ): Promise<{
    id: string;
    adjustmentNumber: string;
    status: string;
    itemCount: number;
  }>;
  postStockAdjustment(
    a: { id: string; postedBy?: string | null },
    key?: string
  ): Promise<{ id: string; status: string }>;
  createPurchaseOrder(
    a: {
      supplierId: string;
      expectedDate?: Date | null;
      notes?: string | null;
      notesAr?: string | null;
      createdBy?: string | null;
      suggestionId?: string | null;
      items: Array<{
        productId: string;
        variantId?: string | null;
        qty: number;
        unitCost: number;
        notes?: string | null;
      }>;
    },
    key?: string
  ): Promise<{ id: string; poNumber: string }>;
  cancelPurchaseOrder(a: { id: string }): Promise<{ id: string; status: string }>;
  receivePurchaseOrder(
    a: {
      poId: string;
      receivedBy?: string | null;
      receipts: Array<{ poItemId: string; qtyReceived: number }>;
    },
    key?: string
  ): Promise<{
    poId: string;
    status: string;
    clearedBackorders: Array<{
      backorderLineId: string;
      orderItemId: string;
      qty: number;
      actualUnitCost: number;
      estimateUnitCost: number;
      variance: number;
    }>;
  }>;
  seedCoa(a: {
    accounts: Array<{ code: string; nameEn: string; nameAr?: string | null; type: string }>;
  }): Promise<{ created: number; opening: { posted: boolean; total: number; skus: number } }>;
  openingBalance(): Promise<{ posted: boolean; total: number; skus: number }>;
  receiveVariant(
    a: {
      productId: string;
      variantId: string;
      quantity: number;
      reason?: string;
      reference?: string | null;
      userId?: string | null;
    },
    key?: string
  ): Promise<{
    productId: string;
    variantId: string;
    previousInventory: number;
    newInventory: number;
    qtyReceived: number;
  }>;
  openCountSession(a: { createdBy?: string | null; note?: string | null }): Promise<{
    id: string;
    storeId: string;
    status: string;
    note: string | null;
    createdAt: Date;
  }>;
  submitCountLine(a: {
    sessionId: string;
    productId: string;
    variantId?: string | null;
    countedQty: number;
  }): Promise<{
    id: string;
    sessionId: string;
    productId: string;
    variantId: string | null;
    countedQty: number;
    systemQty: number;
    variance: number;
  }>;
  closeCountSession(a: {
    sessionId: string;
  }): Promise<{ id: string; status: string; closedAt: Date }>;
  reconcileCountSession(
    a: { sessionId: string; reconciledBy?: string | null },
    key?: string
  ): Promise<{ adjustmentId: string | null; linesReconciled: number; zeroVarianceLines: number }>;
  importCodRemittances(a: {
    carrier: string;
    source?: string;
    rows: Array<{
      trackingNumber: string;
      lineRef: string;
      batchId?: string | null;
      grossAmount: number;
      feeAmount: number;
      netAmount: number;
      remittedAt: Date;
    }>;
  }): Promise<{ inserted: number; duplicates: number; unmatched: number }>;
  bulkSetInventory(a: {
    productIds: string[];
    mode: 'set' | 'adjust';
    value: number;
  }): Promise<{ updated: number }>;
  reconcileWarehouseAll(a: { limit?: number; afterKey?: string | null }): Promise<{
    skusReconciled: number;
    skusFailed: number;
    more: boolean;
    nextKey: string | null;
  }>;
  /** Scan-to-pick: one section reads the order's lines, increments the first open one (capped), counts what is left. */
  pickOrderItem(a: {
    orderId: string;
    productId: string;
    variantId?: string | null;
    qty: number;
  }): Promise<
    | { kind: 'not_in_order' | 'already_picked' }
    | {
        kind: 'picked';
        item: {
          id: string;
          orderId: string;
          productId: string;
          variantId: string | null;
          productName: string;
          personalisation: string | null;
          quantity: number;
        };
        pickedQtyBefore: number;
        pickedQtyAfter: number;
        orderFullyPicked: boolean;
      }
  >;
}

/** A `loyalty_points` row as the DO returns it (Prisma field names, epoch-ms timestamps). */
export interface DoLoyaltyPointsRow {
  id: string;
  storeId: string;
  customerId: string;
  points: number;
  totalEarned: number;
  totalRedeemed: number;
  tier: string;
  createdAt: number;
  updatedAt: number;
}

/** An InstaPay order receipt as the DO returns it (`ReceiptRow` of `do/instapay-receipts.ts`). */
export type DoReceipt = import('@ebda-src/repo').InstapayReceiptRow;

/** Money operations of the StoreDO (Ruling CF-MONEY-1); each takes an optional idempotency key. */
export interface MoneyClient {
  loyaltyEarn(
    a: { customerId: string; orderId: string; featureEnabled: boolean },
    key?: string
  ): Promise<{ pointsEarned: number; newBalance: number; replayed: boolean }>;
  loyaltyReverseEarned(
    a: { orderId: string },
    key?: string
  ): Promise<{ pointsReversed: number; newBalance: number; replayed: boolean } | null>;
  loyaltyReverseRedeemed(
    a: { orderId: string },
    key?: string
  ): Promise<{ pointsRecredited: number; newBalance: number; replayed: boolean } | null>;
  /** L-1 (Ruling FP-2): the admin / storefront reads and manual awards, on the DO ledger. Row timestamps are epoch ms. */
  loyaltyAward(
    a: {
      customerId: string;
      points: number;
      type: string;
      description?: string | null;
      featureEnabled: boolean;
    },
    key?: string
  ): Promise<{ newBalance: number }>;
  loyaltyInit(
    a: { customerId: string; giveSignupBonus: boolean; featureEnabled: boolean },
    key?: string
  ): Promise<{ row: DoLoyaltyPointsRow; settings: Record<string, any> }>;
  loyaltyReviewBonus(
    a: { customerId: string; productId: string; reviewId: string; featureEnabled: boolean },
    key?: string
  ): Promise<{ awarded: boolean; points: number }>;
  loyaltyBirthdays(a: {
    month: number;
    day: number;
    yearStart: number;
    featureEnabled: boolean;
  }): Promise<{ awarded: number; points: number }>;
  loyaltyExpire(a: { after?: string | null; limit?: number }): Promise<{
    members: number;
    expired: number;
    last: string | null;
    more: boolean;
  }>;
  loyaltyCustomerPoints(a: {
    customerId: string;
    featureEnabled: boolean;
  }): Promise<{ row: DoLoyaltyPointsRow; settings: Record<string, any> } | null>;
  loyaltyHistory(a: { customerId: string; page?: number; limit?: number }): Promise<{
    transactions: Array<{
      id: string;
      storeId: string;
      customerId: string;
      orderId: string | null;
      type: string;
      points: number;
      description: string | null;
      expiresAt: number | null;
      createdAt: number;
      order: { id: string; orderNumber: string } | null;
    }>;
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>;
  loyaltyMembers(a: { page?: number; limit?: number; tier?: string }): Promise<{
    members: DoLoyaltyPointsRow[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }>;
  loyaltyStats(a?: Record<string, never>): Promise<{
    totalMembers: number;
    tierBreakdown: { bronze: number; silver: number; gold: number; platinum: number };
    totalPointsIssued: number;
    totalPointsRedeemed: number;
    outstandingPoints: number;
  }>;
  loyaltyStoreTransactions(a: {
    page?: number;
    limit?: number;
    type?: string;
    customerId?: string;
    from?: number | null;
    to?: number | null;
  }): Promise<{
    transactions: Array<{
      id: string;
      storeId: string;
      customerId: string;
      orderId: string | null;
      type: string;
      points: number;
      description: string | null;
      expiresAt: number | null;
      createdAt: number;
      order: { id: string; orderNumber: string } | null;
    }>;
    total: number;
  }>;
  loyaltyImportState(a: { customerId?: string }): Promise<{ done: boolean }>;
  loyaltyMarkImported(a: { customerId?: string }): Promise<{ done: boolean }>;
  loyaltyImport(a: {
    customerId: string;
    markDone?: boolean;
    rows: Array<{
      id: string;
      orderId?: string | null;
      type: string;
      points: number;
      description?: string | null;
      expiresAt?: number | null;
      createdAt: number;
    }>;
  }): Promise<{ inserted: number; skipped: number; newBalance: number; disabled?: true }>;
  /** WalletService.applyEntry on the DO (Ruling WALLET-GL-1): ledger row + balance + GL in one section. */
  walletEntry(
    a: {
      customerId: string;
      amount: number;
      type: string;
      idempotencyKey: string;
      orderId?: string | null;
      returnId?: string | null;
      actorId?: string | null;
      note?: string | null;
    },
    key?: string
  ): Promise<{ balance: number; replayed: boolean; entry: Record<string, unknown> }>;
  /** OrderService.create on the DO (Ruling CF-ORDERS-1): ONE section = stock, hold cap, coupon, loyalty redeem, wallet, rows. */
  createOrder(a: CreateOrderArgs, key?: string): Promise<PlacedOrderResult>;
  /** OrderService.quote (dryRun): totals and per-line prices; nothing reserved, nothing written (Ruling CF-FINAL-1). */
  quoteOrder(a: CreateOrderArgs): Promise<OrderQuoteAnswer>;
  confirmPayment(
    a: { orderId: string; actorUserId?: string | null; proofSubmitted?: boolean },
    key?: string
  ): Promise<{ changed: boolean; orderId: string; status: string; approvedReceiptIds?: string[] }>;
  /** InstaPay ORDER receipts on the DO (Ruling INSTAPAY-DO-1). Rows are the engine's camelCase `ReceiptRow` (dates are epoch ms). */
  receiptCreate(a: {
    orderId: string;
    paymentId?: string | null;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<DoReceipt>;
  receiptExtraction(a: {
    receiptId: string;
    status: 'done' | 'failed';
    extracted?: unknown;
    confidence?: number | null;
    error?: string | null;
  }): Promise<{ updated: boolean }>;
  receiptGet(a: { receiptId: string; orderId?: string }): Promise<DoReceipt>;
  receiptList(a: { orderId: string }): Promise<DoReceipt[]>;
  receiptProof(a: {
    orderId: string;
    sha256?: string;
    exceptId?: string;
  }): Promise<{ submitted: number; sameImage: number }>;
  receiptSubmit(a: {
    orderId: string;
    receiptId: string;
    fields: Record<string, unknown>;
    referenceKey: string;
    flags: string[];
    extractionStatus: string;
    expectedAmountMinor: number | null;
    expectedReceiver: string | null;
  }): Promise<DoReceipt>;
  receiptReject(a: {
    orderId: string;
    receiptId: string;
    note: string;
    actorId: string | null;
  }): Promise<{ receiptId: string; expiresAt: number; referenceKey: string | null }>;
  receiptImageDeleted(a: {
    receiptId: string;
  }): Promise<{ storageKey: string | null; alreadyDeleted: boolean }>;
  receiptSweep(a?: object): Promise<{
    dueImages: Array<{ id: string; storageKey: string }>;
    scrubbed: number;
  }>;
  /** One batch of the CSV import (Ruling IMPORT-DO-1): products, stock, links and variants in ONE section. */
  importBatch(a: { rows: unknown[]; aiFields: string[]; userId?: string | null }): Promise<{
    created: number;
    updated: number;
    variantsCreated: number;
    products: Array<{ rowIndex: number; productId: string }>;
    renames: Array<{ from: string; to: string }>;
  }>;
  importVariants(a: {
    productId: string;
    variants: unknown[];
  }): Promise<{ variantsCreated: number }>;
  /** In-store barcodes (Ruling BARCODE-DO-1). */
  barcodeFill(a: {
    limit?: number;
  }): Promise<{ products: number; variants: number; remaining: number }>;
  barcodeEnsure(a: { productId?: string; variantId?: string }): Promise<{ code: string | null }>;
  cancel(
    a: {
      orderId: string;
      restoreInventory?: boolean;
      note?: string;
      unpaidOnly?: boolean;
      /** Cancel only while the order is in one of these states (checked in the DO's section, Fixes #614); otherwise the
       * order is untouched, `exceptionNote` is appended to its notes and the result says `skipped: 'status_moved'`. */
      onlyFrom?: string[];
      exceptionNote?: string;
    },
    key?: string
  ): Promise<CancelResult>;
  expireHold(
    a: { orderId: string; proofSubmitted?: boolean },
    key?: string
  ): Promise<'expired' | 'skipped'>;
  /** The payment's index rows are in D1 (written now if queued), else a 503 ENTITY_INDEX_UNAVAILABLE (Ruling NZ-MONEY-2). */
  paymentIndexCheck(a: { paymentId: string }): Promise<{ paymentId: string }>;
  /** InstapayService.initiate on the DO: the hold + its pending payment, one section; a replay returns the same payment. */
  instapayInitiate(
    a: {
      orderId: string;
      /** epoch ms */
      expiresAt: number;
      providerRef: string | null;
      metadata: Record<string, unknown>;
      actorUserId: string | null;
    },
    key?: string
  ): Promise<{
    created: boolean;
    paymentId: string;
    amountMinor: number;
    metadata: Record<string, unknown>;
    expiresAt: number;
  }>;
  /** Payments, webhooks, refunds, the ledger and gold repricing (Rulings CF-PAY-1, CF-LEDGER-1). Results are the engine's. */
  paymentCreate(
    a: {
      orderId: string;
      provider: string;
      /** the amount DUE: order total less the wallet part */
      amount: number;
      method?: string | null;
      currency?: string;
      transactionId?: string | null;
      invoiceId?: string | null;
      paymentUrl?: string | null;
      metadata?: Record<string, unknown>;
    },
    key?: string
  ): Promise<{ paymentId: string; replayed?: boolean }>;
  paymentWebhook(
    a: { input: DoWebhookInput; confirmed?: { kind: string; status: string } | null },
    key?: string
  ): Promise<DoWebhookResult>;
  refundBegin(
    a: {
      paymentId: string;
      amount?: number;
      refundKey?: string;
      attemptKey?: string;
      reason?: string;
      itemLevel?: boolean;
    },
    key?: string
  ): Promise<DoRefundClaim>;
  refundComplete(
    a: { claimId: string; refundId: string; providerStatus?: string; reason?: string },
    key?: string
  ): Promise<{ orderStatus: string; booked: boolean; review: boolean }>;
  refundMatchClaim(a: {
    claimId: string;
    providerRefundId: string;
    actorUserId: string;
    orderId?: string;
  }): Promise<{ result: 'matched' | 'already_matched' }>;
  manualRefundRecord(a: {
    orderId: string;
    method: string;
    reference: string | null;
    actorUserId: string | null;
  }): Promise<{ recorded: number; payments: number }>;
  instapayRefundRecord(a: {
    orderId: string;
    referenceKey: string;
    amountMinor: number;
    record: Record<string, unknown>;
    actorUserId: string | null;
  }): Promise<{
    duplicate: boolean;
    full: boolean;
    paymentId: string;
    fromStatus: string;
    status: string;
    refundedAmount: number;
    orderStatus: string;
  }>;
  refundRelease(
    a: { claimId: string; reason: string; error?: string },
    key?: string
  ): Promise<{ released: boolean; review: boolean }>;
  refundIndeterminate(a: { claimId: string; error: string }, key?: string): Promise<{ ok: true }>;
  refundBook(
    a: {
      orderId: string;
      amount?: number;
      lines?: Array<{ orderItemId: string; quantity: number }>;
      refundKey?: string;
      walletCredit?: number;
      external?: boolean;
      keepPaymentStatus?: boolean;
    },
    key?: string
  ): Promise<CancelResult & { walletCredited: number; review?: string }>;
  journalSale(
    a: { orderId: string },
    key?: string
  ): Promise<{ posted: boolean; skipped?: string; entries: number }>;
  journalRefund(
    a: { orderId: string; reason?: string },
    key?: string
  ): Promise<{ reversed: number }>;
  goldApplyRates(a: Record<string, unknown>, key?: string): Promise<any>;
  goldDecidePending(a: Record<string, unknown>, key?: string): Promise<any>;
  goldUpdateSettings(a: Record<string, unknown>, key?: string): Promise<any>;
  goldRepriceProduct(a: { productId: string }, key?: string): Promise<{ repriced: number }>;
  /** The credit note / refund receipt of a refund event, keyed per refund (Ruling CF-R2-1); `document` is null when nothing is left to credit. */
  fiscalRefund(
    a: { orderId: string; refundRef: string; amount: number | 'remaining'; reason?: string | null },
    key?: string
  ): Promise<{ document: { number: string; docType: string } | null }>;
  /** A sale cancelled before any money was taken keeps its number, marked cancelled. */
  fiscalCancelSale(
    a: { orderId: string },
    key?: string
  ): Promise<{ document: { number: string } | null }>;
  /** The admin order-list search's id sets, resolved from the DO's derived search index (Ruling CF-R4-1). A read. */
  searchOrders(a: { search: string; numberLimit?: number }): Promise<{
    numberIds: string[];
    userIds: string[];
    guestOrderIds: string[];
    truncated: boolean;
  }>;
  /** The store-owned half of a shopper's account erasure, one section (Ruling CF-R6A-3). */
  eraseShopper(a: {
    userId: string;
    role: string;
    email: string | null;
    phone: string | null;
    smsPhoneKey: string | null;
    provenBuyerKey: string | null;
    actorId: string;
    capWindowMs: number;
  }): Promise<{
    orderIds: string[];
    buyerKeys: string[];
    since: number | null;
    receiptIds: string[];
    provenBuyerKey: string | null;
    replayed: boolean;
    crmChecked: boolean;
    crmRowsScrubbed: number;
    crmAmbiguous: boolean;
    walletForfeited: number;
    walletNotesScrubbed: boolean;
  }>;
  /** The erasure finished: delete its saved scope (Ruling CF-R6A-3). */
  finalizeErasure(a: { userId: string }): Promise<{ deleted: number }>;
  /** Product lexical search on the DO's own index (Ruling CF-R6A-1). A read. */
  searchProducts(a: {
    raw: string;
    opts: {
      scope: 'storefront' | 'admin';
      field?: 'doc' | 'name';
      limit?: number;
      includeDeleted?: boolean;
      withSku?: boolean;
      order?: 'similarity' | 'featured';
    };
  }): Promise<{ ids: string[]; truncated: boolean }>;
  /** Registered customers and guest orders matching a typed term, from the DO's index (Ruling CF-R6A-1). A read. */
  searchCustomers(a: { q: string; userCap?: number; guestCap?: number }): Promise<{
    userIds: string[];
    guestOrderIds: string[];
    truncated: boolean;
    usersTruncated: boolean;
    guestsTruncated: boolean;
  }>;
  /** A merchant's manual order (Ruling CF-R4-2). */
  createAdminOrder(
    a: Record<string, unknown>,
    key?: string
  ): Promise<{
    orderId: string;
    orderNumber: string;
    subtotal: number;
    discount: number;
    shipping: number;
    tax: number;
    total: number;
  }>;
  /** The step-3 abandoned-cart recovery coupon, created or re-activated and linked to the cart in one section (Ruling CF-R4-5). */
  recoveryCoupon(
    a: {
      abandonedCartId: string;
      code: string;
      percent: number;
      maxDiscount: number | null;
      expiresAt: number;
    },
    key?: string
  ): Promise<{ couponId: string; created: boolean }>;
  goldSetProductPricing(a: Record<string, unknown>, key?: string): Promise<any>;
  goldBulkSwitchMode(a: Record<string, unknown>, key?: string): Promise<any>;
  goldCreateVariant(a: Record<string, unknown>, key?: string): Promise<{ id: string }>;
  /** Disarm a status fanout that was superseded (the stuck sweep): conditional on it still being unclaimed. */
  fanoutDisarm(
    a: { orderId: string; requestedAt: number },
    key?: string
  ): Promise<{ disarmed: boolean }>;
  /** A payment-timeline audit row (`recordPaymentEvent`) written on the DO (Ruling CF-JOBS-4). */
  paymentEventRecord(a: {
    paymentId: string;
    orderId: string;
    eventType: string;
    fromStatus?: string | null;
    toStatus?: string | null;
    provider?: string | null;
    details?: Record<string, unknown>;
  }): Promise<{ recorded: true }>;
  /** The payment-abandonment stamp: once, only while the order is unpaid and unstamped. */
  abandonStamp(a: { orderId: string }): Promise<{ stamped: boolean }>;
  /** COD mark-paid (single and bulk) in ONE section; skips paid / cancelled / refunded / non-COD orders (Ruling NZ-A-2). */
  codMarkPaid(a: { orderIds: string[] }): Promise<{
    updated: Array<{ orderId: string; paymentId: string; fromStatus: string; orderNumber: string }>;
  }>;
  /** Stamp an order once for a job (`reviewRequestSentAt`): false when an earlier run already did (Ruling CF-JOBS-4). */
  orderStamp(a: { orderId: string; stamp: 'reviewRequestSentAt' }): Promise<{ stamped: boolean }>;
  /** Catalogue and period commerce counts for the monthly usage snapshot. */
  usageCounts(a: { startMs: number; endMs: number }): Promise<Record<string, number>>;
  /** Per-store analytics counters and reads on the DO (Ruling NZ-AN-1). */
  searchLogRecord(a: {
    dayMs: number;
    term: string;
    count: number;
    zero: number;
    cap: number;
  }): Promise<{ counted: boolean }>;
  searchLogPurge(a: { cutoffMs: number }): Promise<{ deleted: number }>;
  searchInsights(a: {
    sinceMs: number;
    minShown: number;
    zeroOnly: boolean;
    limit?: number;
  }): Promise<{
    totals: { searches: number; zero: number };
    terms: Array<{
      term: string;
      searches: number;
      zero_results: number;
      last_result_count: number;
    }>;
  }>;
  qrScanRecord(a: {
    dayMs: number;
    kind: string;
    ref: string;
    pruneBeforeMs?: number;
  }): Promise<{ counted: true }>;
  viewRecord(a: { dayMs: number; productId: string }): Promise<{ counted: true }>;
  /** Merchant analytics reads on the DO (analytics-reads.ts); the Postgres twins are raw SQL in analytics.service.ts. */
  analyticsPeriod(a: { startMs: number; endMs: number; nonRevenue: string[] }): Promise<{
    revenue: number;
    orders: number;
    customers: number;
    profit: number | null;
    costedLines: number;
    missingLines: number;
    missingRevenue: number;
  }>;
  /** The ONE revenue definition's net total + order count (see packages/repo/src/revenue.ts); optional window, optional paid-only. */
  analyticsNetRevenue(a: {
    startMs?: number;
    endMs?: number;
    paidOnly?: boolean;
    /** Whole-order totals (no partial-refund netting): only the GL reconciliation, whose credits are gross of partials. */
    gross?: boolean;
  }): Promise<{ revenue: number; orders: number }>;
  /** The same, for many [fromMs, toMs) windows in ONE query (<= 400): one row per window, in order. */
  analyticsNetRevenueDays(a: {
    windows: Array<{ fromMs: number; toMs: number }>;
    paidOnly?: boolean;
  }): Promise<Array<{ revenue: number; orders: number }>>;
  analyticsSales(a: {
    startMs: number;
    endMs: number;
    offsetMinutes: number;
    granularity: 'day' | 'week' | 'month';
  }): Promise<Array<{ key: string; revenue: number; orders: number }>>;
  analyticsItems(
    a:
      | { by: 'product'; startMs: number; endMs: number; nonRevenue: string[]; limit?: number }
      | { by: 'priceSource'; startMs: number; endMs: number; nonRevenue: string[] }
  ): Promise<
    Array<{
      productId?: string;
      priceSource?: string | null;
      priceGroupApplied?: boolean | null;
      quantity: number;
      total: number;
    }>
  >;
  analyticsOrdersBy(a: {
    by: 'status' | 'paymentStatus';
    startMs: number;
    endMs: number;
    nonRevenue?: string[];
  }): Promise<Array<{ key: string; count: number; total: number }>>;
  analyticsCustomers(a: { startMs: number; endMs: number; nonRevenue: string[] }): Promise<{
    newCustomers: number;
    returningCustomers: number;
    top: Array<{ customerId: string | null; total: number; count: number }>;
  }>;
  /** Paid orders since `sinceMs` grouped by the dashboard buyer key (insights repeat-purchase rate). */
  analyticsRepeatBuyers(a: { sinceMs: number }): Promise<{ repeat: number; buyers: number }>;
  analyticsStock(a: Record<string, never>): Promise<{
    stockValue: number;
    backorderCount: number;
    backorderValue: number;
  }>;
  analyticsCashflow(a: {
    fromMs: number;
    toMs: number;
  }): Promise<Array<{ dayMs: number; net: number }>>;
  /** Tax report lines (analytics-reads.ts taxReportLinesOp); the Postgres twin is raw SQL in tax-report.service.ts. */
  taxReportLines(a: { fromMs: number; toMs: number }): Promise<
    Array<{
      postedAtMs: number;
      orderNumber: string;
      customerName: string | null;
      taxDelta: number;
      baseDelta: number;
      orderTotal: number;
      isSale: boolean;
    }>
  >;
  analyticsLowStock(a: { threshold: number }): Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      sku: string | null;
      inventory: number;
      imageUrl: string | null;
    }>
  >;
  analyticsImportStatus(a: Record<string, never>): Promise<{
    done: boolean;
    batches: number;
    tables: Record<string, { rows: number; sums: Record<string, number> }>;
  }>;
  analyticsImport(a: {
    batchId: string;
    table: string;
    rows: Array<Record<string, unknown>>;
  }): Promise<{ applied: number; replayed: boolean }>;
  analyticsImportReset(a: {
    confirm: string;
  }): Promise<{ reset: true; deleted: Record<string, number> }>;
  analyticsImportFinish(a: {
    expect: Record<string, { rows: number; sums: Record<string, number> }>;
  }): Promise<{ done: true; tables: Record<string, number> }>;
  /** True while any indexable product still needs a vector. */
  vectorStale(a: Record<string, never>): Promise<{ stale: boolean }>;
  vectorStatus(a: Record<string, never>): Promise<{
    products: number;
    indexed: number;
    stale: number;
    failed: number;
  }>;
  /** The storefront-visible subset of the product ids a Vectorize query returned (Ruling CF-VEC-1). A read. */
  vectorVisible(a: { ids: string[] }): Promise<{ ids: string[] }>;
  /** An expense's status step: approve (draft/pending), post (approved) or reject, one conditional UPDATE (Ruling CF-EXP-1). */
  expenseTransition(a: {
    expenseId: string;
    action: 'approve' | 'post' | 'reject';
    userId?: string | null;
    pending?: boolean;
  }): Promise<{ found: boolean; changed: boolean; status: string | null }>;
  /** Settle an embedded batch: usage, orphans, quarantines, per-product state against the current row. */
  vectorCommit(a: {
    ready: import('@ebda-src/repo').VectorWork[];
    failures: Array<{ work: import('@ebda-src/repo').VectorWork; kind: string }>;
    forget: string[];
    texts: number;
  }): Promise<{ embedded: number; cleanup: string[]; quarantined: number }>;
  /** The next product vectors to build, fitted to today's embedding budget, plus orphaned vectors (Ruling CF-JOBS-4B). */
  vectorPlan(a: { limit: number; dailyCap?: number }): Promise<{
    work: import('@ebda-src/repo').VectorWork[];
    orphans: string[];
    capped: boolean;
  }>;
  /** Create a webhook endpoint under the per-store cap, count and insert in ONE section (Ruling CF-JOBS-4B). */
  webhookEndpointCreate(a: {
    maxEndpoints: number;
    url: string;
    description: string | null;
    events: string[];
    includeCustomer: boolean;
    secretEnc: string;
    secretHint: string;
    createdBy: string | null;
  }): Promise<{ id: string }>;
  /** One page of R2-URL-bearing column values of a table (orphan sweep); `missing` when the schema lacks the table or a column. */
  r2References(a: { table: string; columns: string[]; after?: string; limit: number }): Promise<{
    missing: boolean;
    rows: Array<Record<string, string | null>>;
    last: string | null;
  }>;
  /** A draft expense (receipt OCR): accounts guarded, number claimed, OCR metadata in the same section (Ruling CF-JOBS-4B). */
  expenseDraft(
    a: Record<string, unknown>,
    key?: string
  ): Promise<{ expenseId: string; expenseNumber: string }>;
  /** Last paid-sale time (ms) per product, one grouped read (dead-stock scan). */
  lastPaidSales(a: { productIds: string[] }): Promise<{ sales: Record<string, number> }>;
  /** Retention at 5 years: scrub up to `limit` old orders' personal snapshots (Ruling CF-JOBS-4B). */
  orderAnonymize(a: { cutoffMs: number; limit: number }): Promise<{ anonymized: number }>;
  /** Posted debit / credit totals of the store (accounting daily close). */
  trialBalance(): Promise<{ debit: number; credit: number }>;
  /** Revenue-side GL credits posted since `sinceMs` (accounting period reconciliation). */
  periodGlCredits(a: { sinceMs: number }): Promise<{ total: number }>;
  /** Per-account totals of the counted journal entries in an optional posted-at window (reports, profit-anomaly scan). */
  accountTotals(a: { fromMs?: number; toMs?: number }): Promise<{
    rows: Array<{
      id: string;
      code: string;
      nameEn: string;
      nameAr: string | null;
      type: string;
      debit: number;
      credit: number;
    }>;
  }>;
  /** Customer Intelligence area / buyer stamp of an order, only where both are still null. */
  ciOrderStamp(a: {
    orderId: string;
    areaKey: string | null;
    buyerKey: string | null;
  }): Promise<{ stamped: boolean }>;
  /** Expense / stock-adjustment / PO-receive journals on the DO (Ruling CF-JOBS-4); idempotent per source row. */
  journalExpense(a: { expenseId: string }): Promise<{ posted: boolean; skipped?: string }>;
  journalStockAdjustment(a: {
    adjustmentId: string;
  }): Promise<{ posted: boolean; skipped?: string }>;
  journalPoReceive(a: {
    poId: string;
    clearedBackorders: Array<Record<string, unknown>>;
  }): Promise<{ posted: boolean; skipped?: string; entries: number }>;
  /**
   * Finance admin (Ruling NZ-FEAT-1): a manual adjusting entry (balanced, active store accounts, one section), the ledger side of a
   * bank reconciliation difference, and the on-hand / disabled-variant stock value of the finance dashboard.
   */
  /** cancelBackorder on the DO (Ruling NZ-FEAT-1): claim + flag + stock heal + marker in ONE section; a re-cancel is a replay. */
  backorderCancel(
    a: { backorderLineId: string; reason: string; userId?: string | null },
    key?: string
  ): Promise<
    | { found: false }
    | {
        found: true;
        /** true: the line was already cancelled; nothing was written, the figures are that cancel's */
        replayed: boolean;
        orderId: string;
        orderItemId: string;
        quantity: number;
        stockRestored: number;
        /** epoch ms and reason of the cancel that wrote the row (the first one, on a replay) */
        cancelledAt: number;
        cancelledReason: string;
        /** the allocation computed in that cancel's section: the line's share net of discount + tax; notify = paid and > 0 */
        refundAmount: number;
        notify: boolean;
      }
  >;
  journalManual(
    a: {
      memo?: string | null;
      memoAr?: string | null;
      postedAtMs?: number | null;
      postedBy?: string | null;
      lines: Array<{
        accountId: string;
        debit: number;
        credit: number;
        lineMemo?: string | null;
        currency?: string;
        fxRate?: number | null;
        originalAmount?: number;
      }>;
    },
    key?: string
  ): Promise<{ id: string; entryNumber: string }>;
  bankLedgerSide(a: {
    accountId: string;
    statementId: string;
    asOfMs: number;
    startMs?: number | null;
  }): Promise<{ debit: number; credit: number; unmatchedCount: number; unmatchedNet: number }>;
  stockValue(): Promise<{ value: number; disabledValue: number }>;
  /** Order fan-out claims, refund notification markers and affiliate commission writes (Ruling CF-JOBS-4). */
  orderNotifyClaim(a: { orderId: string }): Promise<{ claimed: boolean }>;
  statusFanoutClaim(a: { orderId: string; status: string }): Promise<{ claimed: boolean }>;
  statusFanoutComplete(a: { orderId: string; status: string }): Promise<{ completed: boolean }>;
  markerClaim(a: { orderId: string; marker: string }): Promise<{ claimed: boolean }>;
  markerRelease(a: { orderId: string; marker: string }): Promise<{ released: number }>;
  refundNotifyClaim(a: { orderId: string }): Promise<{ channels: string[] }>;
  refundNotifyRelease(a: { orderId: string; channel?: string }): Promise<{ released: string[] }>;
  reversalClaim(a: {
    orderId: string;
    restoreInventory?: boolean;
    returnId?: string;
  }): Promise<{ claimed: boolean }>;
  affiliateCommission(a: {
    referralId: string;
    commissionAmount: number;
    rate?: number;
  }): Promise<{ claimed: boolean }>;
  affiliateReverse(a: { orderId: string }): Promise<{ amount: number | null }>;
  /** AffiliateService.createPayout: balance debit + payout row + event, one section (INSUFFICIENT_BALANCE when it does not cover). */
  affiliatePayout(
    a: {
      affiliateId: string;
      amount: number;
      method?: string;
      notes?: string | null;
      payoutId?: string;
    },
    key?: string
  ): Promise<{ payout: Record<string, unknown> }>;
  /** Reorder scan phase 1: expire stale / unit-gone suggestions (Ruling CF-JOBS-4). */
  reorderExpire(a: {
    thresholdMs: number;
  }): Promise<{ expired: number; variantlessOpenPoLines: number }>;
  /** Reorder scan phase 3: upsert one open suggestion per unit. */
  reorderUpsert(a: { scannedAtMs: number; items: Array<Record<string, unknown>> }): Promise<{
    upserted: number;
  }>;
  /** confirmed / processing / shipped / delivered (Ruling CF-FINAL-1): state machine, fanout arming, COD settlement, event. */
  orderStatus(
    a: {
      orderId: string;
      status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered';
    },
    key?: string
  ): Promise<OrderStatusResult>;
  /** The Return row lifecycle and the partial-return journal (Ruling CF-RETURNS-1): see `packages/repo/src/do/returns.ts`. */
  returnCreate(
    a: {
      orderId: string;
      customerId: string;
      type: string;
      reason: string;
      reasonDetail?: string;
      customerNotes?: string;
      items?: Array<{
        orderItemId: string;
        productId: string;
        productName: string;
        quantity: number;
        reason?: string;
        condition?: string;
      }>;
      bundleGroupIds?: string[];
    },
    key?: string
  ): Promise<{ returnId: string }>;
  returnStatus(
    a: { returnId: string; status: string; userId: string; notes?: string },
    key?: string
  ): Promise<{ returnId: string; status: string }>;
  returnTracking(
    a: { returnId: string; trackingNumber: string },
    key?: string
  ): Promise<{ returnId: string }>;
  /** Start of ReturnService.complete: status gate, atomic claim, the plan for the gateway call. */
  returnClaim(a: ReturnCompleteArgs, key?: string): Promise<DoReturnPlan>;
  /** End of ReturnService.complete: the completion row AND the wallet credit AND the stock effects in ONE section. */
  returnFinish(
    a: ReturnCompleteArgs & {
      userId: string;
      gatewayAmount?: number;
      gatewayRanFullEffects?: boolean;
    },
    key?: string
  ): Promise<{
    returnId: string;
    replayed: boolean;
    refundAmount: number;
    tierCarryWaived: number;
    walletCredited: number;
    walletShareCredited: number;
  }>;
  returnRelease(a: { returnId: string }, key?: string): Promise<{ released: boolean }>;
  journalPartialReturn(
    a: {
      orderId: string;
      refundKey: string;
      items: Array<{ orderItemId: string; quantity: number }>;
    },
    key?: string
  ): Promise<{ posted: number; skipped?: string }>;
  journalAmountOnlyRefund(
    a: { orderId: string; refundKey: string; amount: number },
    key?: string
  ): Promise<{ posted: number; skipped?: string }>;
}

export interface ReturnCompleteArgs {
  returnId: string;
  refundMethod: string;
  refundOverrides?: Record<string, { amountMinor: number; reason: string }>;
  walletFeature?: boolean;
}
export interface DoReturnPlan {
  returnId: string;
  orderId: string | null;
  customerId: string;
  type: string;
  isInventoryRestoring: boolean;
  isFullReturn: boolean;
  isGatewayRefund: boolean;
  partial: {
    cashCredit: number;
    returnedLineCount: number;
    allLinesNowReturned: boolean;
    walletShare: number;
    gatewayShare: number;
  } | null;
  tierTotal: number;
  allocatedAmount: number | null;
  walletCreditAmount: number | null;
  walletShare: number;
  skipProvider: boolean;
  items: Array<{ orderItemId: string; quantity: number }>;
  outstandingClaims: string[];
}

export interface OrderQuoteAnswer {
  subtotal: number;
  discount: number;
  shipping: number;
  codFee: number;
  tax: number;
  total: number;
  taxIncludedInPrice: boolean;
  lines: Array<{
    index: number;
    productId: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    listPrice: number;
    priceSource: 'base' | 'tier' | 'group';
    priceTierMinQty: number | null;
  }>;
}

export interface OrderStatusResult {
  orderId: string;
  from: string;
  status: string;
  requestedAt: number;
  codSettled: string | null;
  orderNumber: string;
  customerId: string | null;
}

export interface DoWebhookInput {
  provider: string;
  eventId: string;
  providerRef: string;
  kind: 'payment' | 'refund';
  event?: string;
  status?: string;
  amount?: number | null;
  currency?: string | null;
  paidAt?: number | null;
  paymentMethod?: string | null;
  refund?: {
    refundId: string;
    status: 'completed' | 'failed' | 'pending' | 'processing';
    amount?: number | null;
    refundReference?: string | null;
  };
  rawPayload?: unknown;
  /** #625: a status poll's amount is ours, not the gateway's (see the DO's PaymentWebhookInput) */
  amountUnverified?: boolean;
}
export interface DoWebhookResult {
  outcome: 'applied' | 'replayed' | 'ignored' | 'held';
  paymentId: string;
  orderId: string;
  paymentStatus: string;
  orderStatus: string;
  alerts: Array<{
    kind: string;
    paymentId: string;
    orderId: string;
    body: string;
    context?: Record<string, unknown>;
  }>;
  postCommit: Array<'order_paid' | 'payment_failed' | 'order_reversed'>;
}
export interface DoRefundClaim {
  claimId: string;
  paymentId: string;
  orderId: string;
  amount: number;
  isFullRefund: boolean;
  flipsOrder: boolean;
  priorStatus: string;
  claimedStatus: 'refunded' | 'partially_refunded';
  refundKey: string | null;
}

/** The checkout input of the DO engine (`packages/repo/src/do/checkout.ts` `CheckoutInput`) minus `storeId` and `now`. */
export interface CreateOrderArgs {
  lines: Array<{
    productId: string;
    variantId?: string;
    quantity: number;
    quotedUnitPrice?: number | null;
    note?: string;
  }>;
  bundles?: Array<{ bundleId: string; quantity: number }>;
  buyer?: unknown;
  customerId?: string;
  couponCode?: string;
  walletAmount?: number;
  pointsToRedeem?: number;
  paymentMethod?: string;
  currency?: string;
  idempotencyKey?: string;
  cart?: { id: string };
  /** Ruling CF-FINAL-1: the cart state claimed atomically with the order (the cart rows are on Postgres) */
  cartClaim?: { id: string; fingerprint: string };
  shippingAddress: Record<string, unknown>;
  billingAddress?: unknown;
  checkoutIp?: string;
  holdCaps?: { manual?: number; gateway?: number; ip?: number };
  wholesaleEntitled?: boolean;
  loyaltyFeatureEnabled?: boolean;
  backorderEnabled?: boolean;
  goldRequireQuote?: boolean;
  expectedTotal?: number;
  /** stamped on the order row after the engine wrote it (Postgres parity) */
  locale?: string;
  smsOptIn?: boolean;
  source?: string;
  orderNotes?: string;
}
export interface PlacedOrderResult {
  orderId: string;
  orderNumber: string;
  subtotal: number;
  discount: number;
  couponDiscount: number;
  promotionDiscount: number;
  bundleDiscount: number;
  loyaltyDiscount: number;
  shipping: number;
  codFee: number;
  tax: number;
  walletAmount: number;
  total: number;
  paymentStatus: 'unpaid' | 'paid';
  replayed: boolean;
}
export interface CancelResult {
  orderId: string;
  kind: 'cancel' | 'refund' | 'partial_refund';
  replayed: boolean;
  status: string;
  couponUnclaimed: boolean;
  walletReversed: number;
  loyalty: { earnedReversed: number; redeemedRecredited: number };
  backorderLinesCancelled: number;
  /** Set when an `onlyFrom` cancel found the order already past those states: nothing was changed but its note. */
  skipped?: 'status_moved';
}

export interface StoreRepo {
  storeId: string;
  backend: StoreBackend;
  /** Stock operations. Present ONLY on 'do'; on 'pg' the service keeps its own Postgres path (see `storeStock`). */
  stock?: StockClient;
  /** Money operations. Present ONLY on 'do' (see `storeMoney`). */
  money?: MoneyClient;
  db: StoreReads;
  /** The write client (see StoreWrites). Resolved with the repo, so one flag read serves both. */
  writer: StoreWrites;
  /** The assistant's journal on the store's own Durable Object. Present ONLY on 'do' (see `storeSmartLayer`). */
  smartLayer?: SmartLayerClient;
}

/** One named journal operation of the Smart Layer (packages/repo do/smart-layer.ts). A refusal is an AppError; `args` is a plain JSON list. */
export type SmartLayerClient = (op: string, args: unknown[]) => Promise<unknown>;

type RequestLike = Pick<Request, 'headers'>;
interface Scope {
  req: RequestLike;
  repos: Map<string, Promise<StoreRepo>>;
}
const scopes = new AsyncLocalStorage<Scope>();
const NO_REQUEST: RequestLike = { headers: {} };

/** The StoreDO stub's read entry point (lib/store-backend.ts types the rest of the stub). */
interface QueryStub {
  storeRecord(
    storeId: string,
    fields?: string[]
  ): Promise<
    | { ok: true; data: { json: string; missing: string[] } }
    | { ok: false; code: string; status?: number; message?: string }
  >;
  mutate(
    storeId: string,
    m: {
      key?: string;
      actorRole?: string;
      ops: Array<{ model: string; op: string; args?: Record<string, unknown> }>;
    }
  ): Promise<
    { ok: true; json: string } | { ok: false; code: string; message: string; json?: string }
  >;
  stockOp(
    storeId: string,
    op: string,
    argsJson: string,
    key?: string
  ): Promise<
    { ok: true; json: string } | { ok: false; code: string; status: number; message: string }
  >;
  moneyOp(
    storeId: string,
    op: string,
    argsJson: string,
    key?: string
  ): Promise<
    | { ok: true; json: string }
    | { ok: false; code: string; status: number; message: string; meta?: Record<string, unknown> }
  >;
  smartLayerOp(
    storeId: string,
    op: string,
    argsJson: string
  ): Promise<
    { ok: true; json: string } | { ok: false; code: string; status: number; message: string }
  >;
  query(
    storeId: string,
    queries: Array<{ model: string; op: string; args?: Record<string, unknown> }>
  ): Promise<
    { ok: true; json: string } | { ok: false; code: string; message: string; json?: string }
  >;
}

/** The typed stock client over a transport `call(op, args, key)`; shared by the Worker and the contract tests. */
export function makeStockClient(
  call: (op: string, args: unknown, key?: string) => Promise<any>
): StockClient {
  return {
    adjustProduct: (a, key) => call('adjustProduct', a, key),
    setProduct: (a, key) => call('setProduct', a, key),
    bulkAdjustProducts: (a, key) => call('bulkAdjustProducts', a, key),
    setVariantInventory: (a, key) => call('setVariantInventory', a, key),
    setVariantActive: (a, key) => call('setVariantActive', a, key),
    setWarehouseStock: (a, key) => call('setWarehouseStock', a, key),
    adjustWarehouseStock: (a, key) => call('adjustWarehouseStock', a, key),
    createStockAdjustment: (a, key) => call('createStockAdjustment', a, key),
    postStockAdjustment: (a, key) => call('postStockAdjustment', a, key),
    createPurchaseOrder: (a, key) => call('createPurchaseOrder', a, key),
    cancelPurchaseOrder: a => call('cancelPurchaseOrder', a),
    receivePurchaseOrder: (a, key) => call('receivePurchaseOrder', a, key),
    seedCoa: a => call('seedCoa', a),
    openingBalance: () => call('openingBalance', {}),
    receiveVariant: (a, key) => call('receiveVariant', a, key),
    openCountSession: a => call('openCountSession', a),
    submitCountLine: a => call('submitCountLine', a),
    closeCountSession: a => call('closeCountSession', a),
    reconcileCountSession: (a, key) => call('reconcileCountSession', a, key),
    bulkSetInventory: a => call('bulkSetInventory', a),
    importCodRemittances: a => call('importCodRemittances', a),
    reconcileWarehouseSku: a => call('reconcileWarehouseSku', a),
    reconcileWarehouseAll: a => call('reconcileWarehouseAll', a),
    pickOrderItem: a => call('pickOrderItem', a),
  };
}

/** The money client over a transport `call(op, args, key)`; shared by the Worker and the contract tests. */
export function makeMoneyClient(
  call: (op: string, args: unknown, key?: string) => Promise<any>
): MoneyClient {
  return {
    loyaltyEarn: (a, key) => call('loyaltyEarn', a, key),
    loyaltyReverseEarned: (a, key) => call('loyaltyReverseEarned', a, key),
    loyaltyReverseRedeemed: (a, key) => call('loyaltyReverseRedeemed', a, key),
    loyaltyAward: (a, key) => call('loyaltyAward', a, key),
    loyaltyInit: (a, key) => call('loyaltyInit', a, key),
    loyaltyReviewBonus: (a, key) => call('loyaltyReviewBonus', a, key),
    loyaltyBirthdays: a => call('loyaltyBirthdays', a),
    loyaltyExpire: a => call('loyaltyExpire', a),
    loyaltyCustomerPoints: a => call('loyaltyCustomerPoints', a),
    loyaltyHistory: a => call('loyaltyHistory', a),
    loyaltyMembers: a => call('loyaltyMembers', a),
    loyaltyStats: a => call('loyaltyStats', a ?? {}),
    loyaltyStoreTransactions: a => call('loyaltyStoreTransactions', a),
    loyaltyImport: a => call('loyaltyImport', a),
    loyaltyImportState: a => call('loyaltyImportState', a),
    loyaltyMarkImported: a => call('loyaltyMarkImported', a),
    walletEntry: (a, key) => call('walletEntry', a, key),
    receiptCreate: a => call('receiptCreate', a),
    receiptExtraction: a => call('receiptExtraction', a),
    receiptGet: a => call('receiptGet', a),
    receiptList: a => call('receiptList', a),
    receiptProof: a => call('receiptProof', a),
    receiptSubmit: a => call('receiptSubmit', a),
    receiptReject: a => call('receiptReject', a),
    receiptImageDeleted: a => call('receiptImageDeleted', a),
    receiptSweep: a => call('receiptSweep', a ?? {}),
    importBatch: a => call('importBatch', a),
    importVariants: a => call('importVariants', a),
    createOrder: (a, key) => call('createOrder', a, key),
    quoteOrder: a => call('quoteOrder', a),
    confirmPayment: (a, key) => call('confirmPayment', a, key),
    cancel: (a, key) => call('cancel', a, key),
    expireHold: (a, key) => call('expireHold', a, key),
    instapayInitiate: (a, key) => call('instapayInitiate', a, key),
    paymentIndexCheck: a => call('paymentIndexCheck', a),
    paymentCreate: (a, key) => call('paymentCreate', a, key),
    paymentWebhook: (a, key) => call('paymentWebhook', a, key),
    refundBegin: (a, key) => call('refundBegin', a, key),
    refundComplete: (a, key) => call('refundComplete', a, key),
    refundRelease: (a, key) => call('refundRelease', a, key),
    refundMatchClaim: a => call('refundMatchClaim', a),
    instapayRefundRecord: a => call('instapayRefundRecord', a),
    manualRefundRecord: a => call('manualRefundRecord', a),
    refundIndeterminate: (a, key) => call('refundIndeterminate', a, key),
    refundBook: (a, key) => call('refundBook', a, key),
    journalSale: (a, key) => call('journalSale', a, key),
    journalRefund: (a, key) => call('journalRefund', a, key),
    goldApplyRates: (a, key) => call('goldApplyRates', a, key),
    goldDecidePending: (a, key) => call('goldDecidePending', a, key),
    goldUpdateSettings: (a, key) => call('goldUpdateSettings', a, key),
    goldRepriceProduct: (a, key) => call('goldRepriceProduct', a, key),
    goldSetProductPricing: (a, key) => call('goldSetProductPricing', a, key),
    goldBulkSwitchMode: (a, key) => call('goldBulkSwitchMode', a, key),
    goldCreateVariant: (a, key) => call('goldCreateVariant', a, key),
    fanoutDisarm: (a, key) => call('fanoutDisarm', a, key),
    paymentEventRecord: a => call('paymentEventRecord', a),
    abandonStamp: a => call('abandonStamp', a),
    codMarkPaid: a => call('codMarkPaid', a),
    trialBalance: () => call('trialBalance', {}),
    orderStamp: a => call('orderStamp', a),
    orderAnonymize: a => call('orderAnonymize', a),
    lastPaidSales: a => call('lastPaidSales', a),
    usageCounts: a => call('usageCounts', a),
    searchLogRecord: a => call('searchLogRecord', a),
    searchLogPurge: a => call('searchLogPurge', a),
    searchInsights: a => call('searchInsights', a),
    qrScanRecord: a => call('qrScanRecord', a),
    viewRecord: a => call('viewRecord', a),
    analyticsImportStatus: a => call('analyticsImportStatus', a),
    analyticsImport: a => call('analyticsImport', a),
    analyticsImportFinish: a => call('analyticsImportFinish', a),
    analyticsPeriod: a => call('analyticsPeriod', a),
    analyticsNetRevenue: a => call('analyticsNetRevenue', a),
    analyticsNetRevenueDays: a => call('analyticsNetRevenueDays', a),
    analyticsSales: a => call('analyticsSales', a),
    analyticsItems: a => call('analyticsItems', a),
    analyticsOrdersBy: a => call('analyticsOrdersBy', a),
    analyticsCustomers: a => call('analyticsCustomers', a),
    analyticsRepeatBuyers: a => call('analyticsRepeatBuyers', a),
    analyticsLowStock: a => call('analyticsLowStock', a),
    analyticsStock: a => call('analyticsStock', a),
    analyticsCashflow: a => call('analyticsCashflow', a),
    taxReportLines: a => call('taxReportLines', a),
    analyticsImportReset: a => call('analyticsImportReset', a),
    vectorStale: a => call('vectorStale', a),
    vectorStatus: a => call('vectorStatus', a),
    vectorVisible: a => call('vectorVisible', a),
    expenseTransition: a => call('expenseTransition', a),
    vectorCommit: a => call('vectorCommit', a),
    vectorPlan: a => call('vectorPlan', a),
    webhookEndpointCreate: a => call('webhookEndpointCreate', a),
    r2References: a => call('r2References', a),
    expenseDraft: (a, key) => call('expenseDraft', a, key),
    periodGlCredits: a => call('periodGlCredits', a),
    accountTotals: a => call('accountTotals', a),
    ciOrderStamp: a => call('ciOrderStamp', a),
    journalExpense: a => call('journalExpense', a),
    journalStockAdjustment: a => call('journalStockAdjustment', a),
    journalPoReceive: a => call('journalPoReceive', a),
    journalManual: (a, key) => call('journalManual', a, key),
    backorderCancel: (a, key) => call('backorderCancel', a, key),
    bankLedgerSide: a => call('bankLedgerSide', a),
    stockValue: () => call('stockValue', {}),
    orderNotifyClaim: a => call('orderNotifyClaim', a),
    statusFanoutClaim: a => call('statusFanoutClaim', a),
    statusFanoutComplete: a => call('statusFanoutComplete', a),
    markerClaim: a => call('markerClaim', a),
    markerRelease: a => call('markerRelease', a),
    refundNotifyClaim: a => call('refundNotifyClaim', a),
    refundNotifyRelease: a => call('refundNotifyRelease', a),
    reversalClaim: a => call('reversalClaim', a),
    affiliateCommission: a => call('affiliateCommission', a),
    affiliateReverse: a => call('affiliateReverse', a),
    affiliatePayout: (a, key) => call('affiliatePayout', a, key),
    reorderExpire: a => call('reorderExpire', a),
    reorderUpsert: a => call('reorderUpsert', a),
    orderStatus: (a, key) => call('orderStatus', a, key),
    fiscalRefund: (a, key) => call('fiscalRefund', a, key),
    fiscalCancelSale: (a, key) => call('fiscalCancelSale', a, key),
    searchOrders: a => call('searchOrders', a),
    searchProducts: a => call('searchProducts', a),
    eraseShopper: a => call('eraseShopper', a),
    finalizeErasure: a => call('finalizeErasure', a),
    searchCustomers: a => call('searchCustomers', a),
    createAdminOrder: (a, key) => call('createAdminOrder', a, key),
    recoveryCoupon: (a, key) => call('recoveryCoupon', a, key),
    barcodeFill: a => call('barcodeFill', a),
    barcodeEnsure: a => call('barcodeEnsure', a),
    returnCreate: (a, key) => call('returnCreate', a, key),
    returnStatus: (a, key) => call('returnStatus', a, key),
    returnTracking: (a, key) => call('returnTracking', a, key),
    returnClaim: (a, key) => call('returnClaim', a, key),
    returnFinish: (a, key) => call('returnFinish', a, key),
    returnRelease: (a, key) => call('returnRelease', a, key),
    journalPartialReturn: (a, key) => call('journalPartialReturn', a, key),
    journalAmountOnlyRefund: (a, key) => call('journalAmountOnlyRefund', a, key),
  };
}

/**
 * `db.store` for a store served by its Durable Object (NEON-ZERO-1). `Store` is split (D1 directory columns, DO profile +
 * config), so no table serves a whole `Store` read. This delegate answers the shape every storefront and gate read uses:
 * `findUnique|findFirst({ where: { id, ...scalar equality }, select })` with scalar `select` fields. The DO supplies the
 * profile/config/mirror columns in ONE RPC; D1-only columns (domain verification, billing suspension, deletedAt, ...)
 * come from the platform D1 client in one more read, only when asked for. A relation, `include`, an unknown filter shape or
 * another store's id is refused loudly (the other store's id is `null`, never a read): the caller is a port that needs a
 * dedicated accessor, not a silent Postgres fallback.
 */
export function doStoreDelegate(
  storeId: string,
  stub: QueryStub,
  decodeRpc: (t: string) => unknown
) {
  const matches = (rec: Record<string, any>, filter: Record<string, any>): boolean =>
    Object.entries(filter).every(([k, cond]) => {
      const v = rec[k];
      if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
        return cond instanceof Date ? v?.getTime?.() === cond.getTime() : v === cond;
      }
      const keys = Object.keys(cond);
      if (keys.length === 1 && keys[0] === 'in') return (cond.in as unknown[]).includes(v);
      if (keys.length === 1 && keys[0] === 'not') return v !== cond.not;
      throw new AppError(
        501,
        'STORE_FILTER_UNSUPPORTED',
        `Store filter on ${k} is not served by the DO`
      );
    });

  const read = async (args: any): Promise<any | null> => {
    const a = args ?? {};
    // `include: { owner }` is served (the DO record carries `ownerId`, the account is the platform's); it means "every scalar +
    // the owner". Any other relation in `include` is still refused loudly.
    const includeKeys = a.include ? Object.keys(a.include).filter(k => a.include[k]) : [];
    if (includeKeys.some(k => k !== 'owner'))
      throw new AppError(501, 'STORE_READ_UNSUPPORTED', 'Store include is not served by the DO');
    const includeOwner = includeKeys.includes('owner');
    const { id, ...rest } = (a.where ?? {}) as Record<string, any>;
    if (id !== undefined && id !== storeId) return null;
    const requested: string[] | undefined = a.select
      ? Object.keys(a.select).filter(k => a.select[k])
      : undefined;
    // `owner` is the only relation served here: the DO record carries `ownerId`, the account is the platform's (D1). Any other
    // relation is refused by the DO record, and the refusal now carries its message (see StoreDO.storeRecord).
    const wantsOwner = !!requested?.includes('owner') || includeOwner;
    const selected = requested?.filter(k => k !== 'owner');
    const need = selected
      ? [...new Set([...selected, ...Object.keys(rest), ...(wantsOwner ? ['ownerId'] : [])])]
      : undefined;
    const r = await stub.storeRecord(storeId, need);
    if (!r.ok) {
      if (r.code === 'STORE_NOT_FOUND') return null;
      throw new AppError(
        r.status ?? 502,
        r.code,
        `store record refused: ${r.code}${'message' in r && r.message ? ` (${String(r.message)})` : ''}`
      );
    }
    const rec = decodeRpc(r.data.json) as Record<string, any>;
    // A whole-record read (no `select`: `include: { owner }`, bare findUnique) makes the DO skip the D1-only columns silently
    // (`readStoreRecord` only reports `missing` for NAMED fields). Ask D1 for them too, or GET /stores/:id loses
    // `pendingDomain` / `domainStatus` and the admin domain page shows a pending claim as "no custom domain".
    const missing = selected ? r.data.missing : [...STORE_D1_ONLY_FIELDS];
    if (missing.length) {
      const platform = await requirePlatformDb();
      const d1 = await platform.store.findUnique({
        where: { id: storeId },
        select: Object.fromEntries(missing.map(f => [f, true])),
      });
      if (!d1) return null; // directory row gone: the store does not exist
      Object.assign(rec, d1);
    }
    if (!matches(rec, rest)) return null;
    const out: Record<string, any> = selected
      ? Object.fromEntries(selected.map(k => [k, rec[k]]))
      : rec;
    if (wantsOwner) {
      const acc = rec.ownerId ? await getAccountState(String(rec.ownerId)) : null;
      const sub = (a.select?.owner ?? a.include?.owner) as
        | { select?: Record<string, boolean> }
        | true;
      const ownerSel = typeof sub === 'object' && sub.select ? sub.select : undefined;
      const full = acc
        ? { id: acc.id, email: acc.email, firstName: acc.firstName, lastName: acc.lastName }
        : null;
      out.owner =
        full && ownerSel
          ? Object.fromEntries(
              Object.keys(ownerSel)
                .filter(k => ownerSel[k])
                .map(k => [k, (full as Record<string, unknown>)[k]])
            )
          : full;
    }
    return out;
  };
  const orThrow = async (args: any) => {
    const row = await read(args);
    if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    return row;
  };
  return {
    findUnique: read,
    findFirst: read,
    findUniqueOrThrow: orThrow,
    findFirstOrThrow: orThrow,
  };
}

type CoalescedResult = { ok: true; json: string } | { ok: false; code?: string; message?: string };

/**
 * PERF-BATCH-1 (Ruling PERF-BATCH-1): one store's StoreDO read transport that folds every read batch started in the same
 * microtask into ONE `query` RPC (the DO runs them in order on one snapshot, `runReads`), then hands each caller exactly its
 * own slice of the results, encoded as the DO would have. Independent reads run with `Promise.all` (a cold store resolve's
 * tax, FAQs, pages, opt-ins, locations) therefore cost one round trip instead of one each.
 *
 * Errors stay per caller: when the folded call fails (a refused store, a failed query, a thrown RPC) every batch is sent again
 * on its own, so each caller gets the answer it would have had alone. Reads only: writes go through `mutate`, never here.
 */
// pq-allow(unused-export): imported by tests/unit/store-do-read-coalesce.test.ts
export function coalesceReads(
  send: (queries: unknown[]) => Promise<CoalescedResult>,
  encode: (v: unknown) => string,
  decode: <T>(json: string) => T
): (queries: unknown[]) => Promise<CoalescedResult> {
  type Item = {
    queries: unknown[];
    resolve: (r: CoalescedResult) => void;
    reject: (e: unknown) => void;
  };
  let queue: Item[] | null = null;
  const alone = (it: Item) => send(it.queries).then(it.resolve, it.reject);
  const flush = async (items: Item[]) => {
    if (items.length === 1) return alone(items[0]);
    let folded: CoalescedResult | undefined;
    try {
      folded = await send(items.flatMap(i => i.queries));
    } catch {
      folded = undefined;
    }
    if (!folded?.ok) return Promise.all(items.map(alone));
    const results = decode<unknown[]>(folded.json);
    let at = 0;
    for (const it of items) {
      it.resolve({ ok: true, json: encode(results.slice(at, at + it.queries.length)) });
      at += it.queries.length;
    }
  };
  return queries =>
    new Promise<CoalescedResult>((resolve, reject) => {
      if (!queue) {
        const items: Item[] = (queue = []);
        queueMicrotask(() => {
          queue = null;
          void flush(items);
        });
      }
      queue.push({ queries, resolve, reject });
    });
}

async function doClients(storeId: string): Promise<{
  db: StoreReads;
  writer: StoreWrites;
  stock: StockClient;
  money: MoneyClient;
  smartLayer: SmartLayerClient;
}> {
  const stub = storeDo(storeId) as unknown as QueryStub; // 503 here when the binding is absent
  // Dynamic: the Node build cannot resolve the @ebda-src alias (apps/api/src/cf/repo-modules.d.ts); only a Worker with a
  // bound StoreDO ever reaches this line.
  const { createDoClient, encodeRpc, decodeRpc } = await import('@ebda-src/repo');
  const call = async (op: string, args: unknown, key?: string) => {
    const r = await stub.stockOp(storeId, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc<any>(r.json);
  };
  const callMoney = async (op: string, args: unknown, key?: string) => {
    const r = await stub.moneyOp(storeId, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message, r.meta);
    const out = decodeRpc<unknown>(r.json);
    const alerts = (out as { moneyAlerts?: unknown } | null)?.moneyAlerts;
    if (Array.isArray(alerts) && alerts.length > 0)
      void sendMoneyAlerts(storeId, op, alerts as Parameters<typeof sendMoneyAlerts>[2]);
    return out;
  };
  const callSmartLayer: SmartLayerClient = async (op, args) => {
    const r = await stub.smartLayerOp(storeId, op, JSON.stringify(args));
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return JSON.parse(r.json) as unknown;
  };
  // PERF-BATCH-1: read batches started in the same microtask (Promise.all over independent reads) share ONE `query` RPC.
  const send = coalesceReads(
    queries => stub.query(storeId, queries as never) as Promise<CoalescedResult>,
    encodeRpc,
    decodeRpc
  );
  return {
    // `db` has NO write delegates at all (the read-only guarantee of CF-REPO-1 is runtime, not just types)
    db: withStoreDelegate(
      createDoClient(send as never) as unknown as StoreReads,
      doStoreDelegate(storeId, stub, decodeRpc as never)
    ),
    writer: createDoClient(send as never, m =>
      // the caller's role, from the verified token of THIS request (the DO's tax-profile review guard reads it)
      stub.mutate(storeId, { ...m, actorRole: currentActorRole() })
    ) as unknown as StoreWrites,
    stock: makeStockClient(call),
    money: makeMoneyClient(callMoney),
    smartLayer: callSmartLayer,
  };
}

/** The authenticated role of the current request, or undefined outside one (jobs, crons: never a super_admin). */
function currentActorRole(): string | undefined {
  const role = (scopes.getStore()?.req as { user?: { role?: unknown } } | undefined)?.user?.role;
  return typeof role === 'string' ? role : undefined;
}

/** The DO read client plus the split-aware `store` delegate (the DO tables have no `Store`). */
function withStoreDelegate(base: StoreReads, store: object): StoreReads {
  return new Proxy(base as object, {
    get: (t, prop, recv) => (prop === 'store' ? store : Reflect.get(t, prop, recv)),
  }) as StoreReads;
}

/**
 * True ONLY when there is definitely no ambient store scope (no request transaction, `withStore` or `runInStoreScope`): then a
 * Postgres store's model call must open its own. With an ambient scope the call is made as-is: for the same store it is the
 * request's own atomic scope, for ANOTHER store the tenant guard must still refuse it (a service handed a foreign store id from
 * inside store B's scope is a cross-tenant call, never silently re-scoped). Any other answer (the helper unavailable, a mocked
 * module) also means "call as-is", which is the behaviour before the scoped client existed.
 */
const STORE_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function needsOwnScope(): boolean {
  try {
    currentStoreId();
    return false;
  } catch (e) {
    return e instanceof Error && /no ambient store/.test(e.message);
  }
}

/**
 * One model call made with no ambient store scope. It stays UNSTARTED (like a PrismaPromise): awaited, it runs in its own short
 * `withStore(storeId, ...)`; handed to `$transaction([ ...ops ])`, the whole array is built and run inside ONE `withStore` so the
 * batch is still atomic and still tenant-scoped.
 */
class ScopedCall implements PromiseLike<unknown> {
  private started?: Promise<unknown>;
  constructor(
    readonly storeId: string,
    readonly call: () => unknown
  ) {}
  then<R1 = unknown, R2 = never>(
    onfulfilled?: ((v: unknown) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2> {
    this.started ??= withStore(this.storeId, async () => this.call());
    return this.started.then(onfulfilled, onrejected);
  }
  catch<R = never>(onrejected?: ((e: unknown) => R | PromiseLike<R>) | null): Promise<unknown> {
    return this.then(undefined, onrejected);
  }
  finally(f?: (() => void) | null): Promise<unknown> {
    return Promise.resolve(this).finally(f);
  }
}

function scopedTransaction(storeId: string, args: unknown[]): unknown {
  const ops = args[0];
  if (Array.isArray(ops) && ops.some(o => o instanceof ScopedCall)) {
    return withStore(storeId, async () =>
      (prisma as any).$transaction(
        ops.map(o => (o instanceof ScopedCall ? o.call() : o)),
        ...args.slice(1)
      )
    );
  }
  return (prisma as any).$transaction(...args);
}

/**
 * The Postgres client of ONE store, tenant-scoped on its own (Ruling NZ-INTEG-1). Services moved to `storeDb(id)` /
 * `storeWriter(id)` read through it from places with no request transaction (MCP, jobs, webhooks, the hub), and the tenant guard
 * REFUSES an unscoped model call, so for a Postgres store every call made with no ambient store scope runs in a short
 * `withStore(storeId, ...)` (BEGIN + set_config, as before the port). Inside a scope it is the plain, LAZY `prisma` delegate call,
 * so request atomicity and `$transaction([ ...ops ])` arrays are unchanged. `$`-methods other than `$transaction` stay the raw
 * proxy's. A Durable Object store never comes through here.
 */
function scopedPg(storeId: string, singleArgTransaction = false): object {
  return new Proxy({} as object, {
    get(_t, prop) {
      if (prop === '$proc')
        return () => {
          throw new Error(
            '$proc exists on the Durable Object writer only (the service keeps its Postgres statement)'
          );
        };
      if (prop === '$transaction')
        return singleArgTransaction
          ? (ops: unknown) => scopedTransaction(storeId, [ops])
          : (...a: unknown[]) => scopedTransaction(storeId, a);
      if (typeof prop !== 'string' || prop.startsWith('$')) return (prisma as any)[prop];
      return new Proxy({} as object, {
        get(_d, method) {
          if (typeof method !== 'string') return undefined;
          return (...args: unknown[]) => {
            const call = () => (prisma as any)[prop][method](...args);
            // an id that is not a UUID can never be scoped (`withStore` refuses it); the call goes as-is and the guard decides
            return STORE_ID_SHAPE.test(storeId) && needsOwnScope()
              ? new ScopedCall(storeId, call)
              : call();
          };
        },
      });
    },
  });
}

/** pg writer: the store-scoped `prisma` client, minus the DO-only second argument of `$transaction`. */
function pgWriter(storeId: string): StoreWrites {
  return scopedPg(storeId, true) as unknown as StoreWrites;
}

/**
 * Money alerts a DO operation raised and COMMITTED (a wallet give-back trimmed by the one refundable balance, #659 B2):
 * a store-scoped P1 to the platform channel. The merchant sees the same fact on the order's payment timeline. Never
 * throws into the caller: the money state is already committed and recorded for review.
 */
// pq-allow(unused-export): test seam, imported by tests/unit/money-alerts-dispatch.test.ts
export async function sendMoneyAlerts(
  storeId: string,
  op: string,
  alerts: Array<{ kind: string; orderId: string; body: string; context?: Record<string, unknown> }>
): Promise<void> {
  try {
    const { sendAlert } = await import('../services/alerts.service.js');
    for (const a of alerts)
      await sendAlert({
        level: 'p1',
        scope: 'store',
        store: { id: storeId, name: storeId },
        source: `money.${op}.${a.kind}`,
        title: `Refund needs review: ${a.kind}`,
        body: a.body,
        context: { storeId, orderId: a.orderId, ...(a.context ?? {}) },
      }).catch(() => undefined);
  } catch {
    /* the review event is already on the payment timeline */
  }
}

async function resolve(storeId: string, _req: RequestLike): Promise<StoreRepo> {
  const backend = await backendFor(storeId); // server-side flag only: the request never chooses (Ruling CF-BACKEND-1)
  if (backend === 'do') {
    return { storeId, backend, ...(await doClients(storeId)) };
  }
  return {
    storeId,
    backend: 'pg',
    db: scopedPg(storeId) as unknown as StoreReads,
    writer: pgWriter(storeId),
  };
}

/** The repo for a store: pg (default) or its Durable Object, per the store's flag. Memoised per request. */
export function storeRepo(storeId: string): Promise<StoreRepo> {
  if (typeof storeId !== 'string' || !storeId.trim())
    return Promise.reject(new AppError(404, 'STORE_NOT_FOUND', 'Store not found'));
  const scope = scopes.getStore();
  if (!scope) return resolve(storeId, NO_REQUEST);
  let p = scope.repos.get(storeId);
  if (!p) {
    p = resolve(storeId, scope.req);
    scope.repos.set(storeId, p);
    // a failed resolution must not be remembered as the answer
    p.catch(() => scope.repos.delete(storeId));
  }
  return p;
}

/** The read client services use: `const db = await storeDb(storeId); db.blogPost.findMany(...)`. */
export async function storeDb(storeId: string): Promise<StoreReads> {
  return (await storeRepo(storeId)).db;
}

/** The write client for a store's non-money catalogue/content models: `const w = await storeWriter(id); await w.blogPost.create(...)`. */
export async function storeWriter(storeId: string): Promise<StoreWrites> {
  return (await storeRepo(storeId)).writer;
}

/**
 * The stock client of a store served by its Durable Object, or `null` on Postgres (the default for every store). A stock
 * service uses it as `const stock = await storeStock(id); if (stock) return doPath(stock);` followed by its unchanged
 * Postgres code, so with every flag at 'pg' the Postgres code (row locks, request transaction, RLS) runs exactly as before.
 */
export async function storeStock(storeId: string): Promise<StockClient | null> {
  return (await storeRepo(storeId)).stock ?? null;
}

/**
 * The assistant's journal of a store, kept in the store's own Durable Object (Ruling SL-STORE-1). A store that is not on its DO has no
 * journal: the assistant refuses it with a 503, the same fail-closed behaviour as `lib/store-backend.ts`; it never falls back to Postgres.
 */
// pq-allow(unused-export): the assistant adapter (next PR of the stack) and the assistant routes import it
export async function storeSmartLayer(storeId: string): Promise<SmartLayerClient> {
  const repo = await storeRepo(storeId);
  if (!repo.smartLayer)
    throw new AppError(
      503,
      'ASSISTANT_UNAVAILABLE',
      'The assistant is not available for this store yet'
    );
  return repo.smartLayer;
}

/**
 * The money client of a store served by its Durable Object, or `null` on Postgres (the default for every store): a money
 * service does `const money = await storeMoney(id); if (money) return doPath(money);` followed by its unchanged Postgres
 * code, so with every flag at 'pg' the Postgres code (row locks, request transaction, RLS) runs exactly as before.
 */
export async function storeMoney(storeId: string): Promise<MoneyClient | null> {
  return (await storeRepo(storeId)).money ?? null;
}

/**
 * Settings write-through (Ruling CF-WRITES-2). `Store` is authoritative in D1/Postgres; a store on its Durable Object also
 * carries a settings copy (`store_profile` / `store_config`) that the storefront reads. Called AFTER the authoritative
 * write, in the same request: on 'pg' it does nothing; on 'do' it sends the changed Prisma `Store` fields to the DO and a
 * refusal fails the request loudly (the update is idempotent, so the retry converges). No cache, no stale window.
 */
export async function copyStoreSettings(
  storeId: string,
  fields: Record<string, unknown>
): Promise<void> {
  // Hotfix N-22: every authoritative Store write also lands its directory columns in D1, which lookups read: read back from
  // the COMMITTED row after the surrounding transaction commits (dropped on rollback), never the caller's patch.
  // A store on its Durable Object is the OPPOSITE direction: D1 + the DO are authoritative (storeUpdateOnDo wrote D1 first), and a
  // mirror from the stale Postgres row would overwrite them (plan N-22), so `do` stores are never mirrored from Postgres.
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') {
    await scheduleStoreDirectorySync(storeId, fields);
    return;
  }
  const stub = storeDo(storeId) as unknown as {
    applySettings(
      storeId: string,
      fieldsJson: string
    ): Promise<{ ok: true } | { ok: false; code: string; status: number }>;
  };
  const { encodeRpc } = await import('@ebda-src/repo');
  const r = await stub.applySettings(storeId, encodeRpc(fields));
  if (!r.ok) throw new AppError(502, 'SETTINGS_COPY_FAILED', `settings copy refused: ${r.code}`);
}

/**
 * Routed `Store` writes (Ruling CF-WRITES-3). Every `Store` write outside `StoreService.updateStoreThrough` uses one of
 * these so the DO settings copy cannot drift; `tests/unit/store-settings-routed.test.ts` fails on a direct
 * `.store.update|updateMany|upsert(`. The authoritative write runs first on the caller's own client (so a request
 * transaction, tenant guard and RLS are unchanged), the copy follows in the same request; on 'pg' the copy does nothing.
 * `updateMany` copies only when a row matched. Residual (as CF-WRITES-2): a caller that later rolls back its own
 * transaction leaves the DO ahead of the authoritative row until the next settings write converges it.
 */
// structural on purpose: the request `prisma` proxy, a `withStore` tx and the extended client all differ in their generic
// delegate types, but all take Store update args; the result type comes from `A`, not from the client.
type StoreUpdateClient = { store: { update: (args: any) => PromiseLike<unknown> } };
type StoreUpdateManyClient = {
  store: { updateMany: (args: any) => PromiseLike<{ count: number }> };
};

/**
 * The AUTHORITATIVE Store update for a store served by its Durable Object (Ruling NZ-D8, single writer): the D1 `stores`
 * row owns the directory + mirror columns, the StoreDO owns profile + config. D1 is written FIRST (its unique indexes refuse
 * a slug / domain taken by another store before anything else changes), then the whole patch goes to the DO
 * (`applySettings` stores what it carries and reports the D1-only rest). Not atomic across the two: a DO failure leaves D1
 * ahead and fails the request loudly (502); the retry is idempotent and converges. No Postgres.
 * Relation writes (`credentials`, `owner`, ...) and Prisma update operators are refused (501): the caller needs its own port.
 */
/**
 * True when a Store write must go to D1 + the DO instead of Postgres: the store is on its DO AND the platform D1 is bound (every
 * deployed Worker). Where D1 is unbound (Node, unit / integration tests, local dev; `backendFor` only returns `do` there from
 * the non-production env list) the legacy path stays: Postgres is authoritative and the DO gets the write-through copy.
 */
export async function storeWritesToDo(storeId: string): Promise<boolean> {
  return (await storeRepo(storeId)).backend === 'do' && !!(await platformDb());
}

export async function storeUpdateOnDo(
  storeId: string,
  args: { data: Record<string, unknown>; select?: unknown; include?: { owner?: unknown } }
): Promise<any> {
  const data = Object.fromEntries(Object.entries(args.data).filter(([, v]) => v !== undefined));
  for (const [k, v] of Object.entries(data)) {
    const isOperator =
      v !== null &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      !Array.isArray(v) &&
      Object.keys(v).length === 1 &&
      [
        'set',
        'increment',
        'decrement',
        'multiply',
        'divide',
        'push',
        'upsert',
        'create',
        'connect',
        'update',
      ].includes(Object.keys(v)[0]);
    if (isOperator)
      throw new AppError(
        501,
        'STORE_WRITE_UNSUPPORTED',
        `Store.${k}: update operators and relation writes are not served by the DO`
      );
  }
  await mirrorEntitlementToPg(storeId, data); // NZ-D21: Postgres sources the entitlement copy-back
  // the ONE D1 Store writer (NZ-D20); no row matched = unknown store: fail closed, never a blind DO write
  if ((await d1StoreWrite({ id: storeId }, d1StorePatch(data))) === 0)
    throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  await copyStoreSettings(storeId, data);
  return readStoreRowOnDo(storeId, args);
}

/**
 * The ATOMIC settings patch for a store served by its Durable Object (BE:F-2 / BE:F-3, StoreDO `patchSettings`): the DO merges
 * ONLY the sent top-level keys of `settings` / `theme` / `socialLinks` against the value it holds now and writes the plain `fields`
 * in the SAME DO transaction, so interleaved saves of different keys both survive and a refused part leaves nothing written.
 * Order is the DO FIRST (the only step that can refuse a part), then the D1 mirror columns of `fields` (a plain UPDATE on the
 * directory row); a D1 failure after that leaves the mirror behind the DO and fails the request, and the idempotent retry converges.
 */
export async function storePatchOnDo(
  storeId: string,
  patch: {
    fields?: Record<string, unknown>;
    json?: Record<string, { set?: Record<string, unknown>; remove?: string[] }>;
  },
  args: { select?: unknown; include?: { owner?: unknown } } = {}
): Promise<any> {
  const fields = Object.fromEntries(
    Object.entries(patch.fields ?? {}).filter(([, v]) => v !== undefined)
  );
  await mirrorEntitlementToPg(storeId, fields);
  const stub = storeDo(storeId) as unknown as {
    patchSettings(
      storeId: string,
      inputJson: string
    ): Promise<{ ok: true } | { ok: false; code: string; status: number }>;
  };
  const { encodeRpc } = await import('@ebda-src/repo');
  const r = await stub.patchSettings(storeId, encodeRpc({ fields, json: patch.json ?? {} }));
  if (!r.ok) throw new AppError(502, 'SETTINGS_COPY_FAILED', `settings patch refused: ${r.code}`);
  if ((await d1StoreWrite({ id: storeId }, d1StorePatch(fields))) === 0)
    throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  return readStoreRowOnDo(storeId, args);
}

/**
 * Compare-and-set of Store fields for the AI jobs (issue #620, Ruling NEVER-OVERWRITE-1): each field in `set` is written only if it
 * still holds `expect[field]` (blank equivalence). A DO store does it in ONE DO transaction (`casStoreFields`) and then mirrors ONLY the
 * written fields that live in D1; a Postgres store does one conditional `updateMany` per field. Returns the fields written.
 */
export async function storeCompareAndSet(
  storeId: string,
  expect: Record<string, unknown>,
  set: Record<string, unknown>,
  job?: string
): Promise<string[]> {
  if (Object.keys(set).length === 0) return [];
  if (await storeWritesToDo(storeId)) {
    const stub = storeDo(storeId) as unknown as {
      casStoreFields(
        storeId: string,
        inputJson: string
      ): Promise<
        | { ok: true; data: { written: string[]; stale: string[]; directoryOnly: string[] } }
        | { ok: false; code: string; status: number }
      >;
    };
    const { encodeRpc } = await import('@ebda-src/repo');
    const r = await stub.casStoreFields(storeId, encodeRpc({ expect, set }));
    if (!r.ok)
      throw new AppError(502, 'STORE_CAS_REFUSED', `store compare-and-set refused: ${r.code}`);
    const { written, directoryOnly } = r.data;
    warnD1OnlySkips(storeId, directoryOnly, job);
    const mirror = Object.fromEntries(written.map(f => [f, set[f]]));
    if (written.length > 0) {
      await mirrorEntitlementToPg(storeId, mirror);
      await d1StoreWrite({ id: storeId }, d1StorePatch(mirror));
    }
    return written;
  }
  const written: string[] = [];
  for (const [field, value] of Object.entries(set)) {
    const was = expect[field];
    const blank =
      was === null ||
      was === undefined ||
      (typeof was === 'string' && was.trim() === '') ||
      (typeof was === 'object' && Object.keys(was as object).length === 0);
    const jsonValue = typeof value === 'object' && value !== null;
    const cond = blank
      ? jsonValue
        ? {
            OR: [
              { [field]: { equals: Prisma.DbNull } },
              { [field]: { equals: Prisma.JsonNull } },
              { [field]: { equals: {} } },
            ],
          }
        : { OR: [{ [field]: null }, { [field]: '' }] }
      : { [field]: jsonValue ? { equals: was } : was };
    // storeUpdateMany copies the written settings to the DO mirror itself when it matched a row
    const res = await storeUpdateMany(prisma, {
      where: { id: storeId, ...cond } as never,
      data: { [field]: value } as never,
    });
    if (res.count > 0) written.push(field);
  }
  return written;
}

async function readStoreRowOnDo(
  storeId: string,
  args: { select?: unknown; include?: { owner?: unknown } }
): Promise<any> {
  const stub = storeDo(storeId) as unknown as QueryStub;
  const { decodeRpc } = await import('@ebda-src/repo');
  const row = await doStoreDelegate(storeId, stub, decodeRpc as never).findUnique({
    where: { id: storeId },
    ...(args.select ? { select: args.select } : {}),
  });
  if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  if (args.include?.owner) {
    const ownerId = (row.ownerId ??
      (
        await doStoreDelegate(storeId, stub, decodeRpc as never).findUnique({
          where: { id: storeId },
          select: { ownerId: true },
        })
      )?.ownerId) as string;
    const acc = await getAccountState(ownerId);
    row.owner = acc
      ? { id: acc.id, email: acc.email, firstName: acc.firstName, lastName: acc.lastName }
      : null;
  }
  return row;
}

/**
 * Defer a DO store's update to the commit of the surrounding transaction (Ruling NZ-D18). Returns the PROJECTED row (the current
 * record with the patch laid over it) without writing anything. 501 when there is no post-commit hook on this path.
 */
/**
 * THE one writer of D1 `stores` (Ruling NZ-D20): every Store directory / entitlement write to D1 goes through here (an immediate DO
 * update, a compare-and-set, a post-commit sync, a retry). Returns the number of rows written (for an empty patch: matched).
 */
async function d1StoreWrite(
  where: Record<string, unknown>,
  patch: Record<string, unknown>
): Promise<number> {
  const platform = await requirePlatformDb();
  if (Object.keys(patch).length === 0) return (await platform.store.count({ where })) as number;
  return ((await platform.store.updateMany({ where, data: patch })) as { count: number }).count;
}

/**
 * Re-sync a DO store's ENTITLEMENT state from its committed authoritative row (Ruling NZ-D20). Plan, billing suspension, status and
 * deletion are decided in Postgres (the write that the transaction committed); this reads the CURRENT row there and copies the
 * full current state to D1 and the DO. It replays no patch and carries no version: idempotent and latest-state-wins, so a late or
 * duplicated retry, or two concurrent ones, converge on whatever Postgres holds NOW (a deleted or suspended store copies its
 * restrictive state). Throws when the row cannot be read or either copy fails (the caller retries).
 */
export async function syncStoreEntitlement(storeId: string): Promise<void> {
  const select = Object.fromEntries(ENTITLEMENT_FIELDS.map(f => [f, true]));
  if (await platformFamilyOnD1('access')) {
    // D1 is the source: copy ITS current row to the Durable Object (nothing is read from Postgres, nothing is written to D1).
    const d1Row = (await (
      await requirePlatformDb()
    ).store.findUnique({
      where: { id: storeId },
      select,
    })) as Record<string, unknown> | null;
    if (!d1Row) throw new AppError(404, 'STORE_NOT_FOUND', 'store not found');
    await copyStoreSettings(storeId, d1Row);
    return;
  }
  const row = (await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select })
  )) as Record<string, unknown> | null;
  if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'store not found');
  if ((await d1StoreWrite({ id: storeId }, d1StorePatch(row))) === 0)
    throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found in the directory');
  await copyStoreSettings(storeId, row);
}

/**
 * The post-commit D1 / DO write of a deferred update. Postgres has already committed it. Entitlement fields are re-synced from the
 * committed row (`syncStoreEntitlement`); a failure is logged, alerted and put on the jobs queue as `{storeId}` only
 * (lib/store-update-retry.ts), the handler re-syncs the CURRENT state. Other fields of the same patch are absolute profile / config
 * values written once through the same D1 writer; a failure there is alerted (P1) with no retry (residual, NZ-D20).
 */
async function applyPostCommit(storeId: string, patch: Record<string, unknown>): Promise<void> {
  const rest = Object.fromEntries(
    Object.entries(patch).filter(([k]) => !(ENTITLEMENT_FIELDS as readonly string[]).includes(k))
  );
  if (touchesEntitlement(patch)) {
    try {
      await syncStoreEntitlement(storeId);
    } catch (err) {
      await reportAndRetryStoreUpdate(storeId, err);
    }
  }
  if (Object.keys(rest).length > 0) {
    try {
      await d1StoreWrite({ id: storeId }, d1StorePatch(rest));
      await copyStoreSettings(storeId, rest);
    } catch (err) {
      await reportStoreUpdateFailure(storeId, Object.keys(rest), err);
    }
  }
}

/** Fields whose rollback must not leave a D1 / DO change behind: plan (entitlements), billing suspension, lifecycle status. */
const ENTITLEMENT_FIELDS: readonly string[] = [
  'plan',
  'billingSuspendedReason',
  'billingSuspendedAt',
  'status',
  'deletedAt',
];
const touchesEntitlement = (data: Record<string, unknown>): boolean =>
  ENTITLEMENT_FIELDS.some(f => data[f] !== undefined);

/**
 * Postgres is the SOURCE of the entitlement fields that `syncStoreEntitlement` copies to D1 / the DO and that the hourly reconciler
 * reads (Ruling NZ-D21). An IMMEDIATE D1 + DO write of plan / billing suspension / status / deletion (`storeUpdateOnDo`, the
 * compare-and-set `storeUpdateMany`) therefore also writes them to Postgres, FIRST (a failure here changes nothing), so a later
 * copy-back or repair sources the value that was just written, never a stale one. Only those fields; absent row = no-op.
 */
async function mirrorEntitlementToPg(
  storeId: string,
  data: Record<string, unknown>
): Promise<void> {
  const patch = Object.fromEntries(
    ENTITLEMENT_FIELDS.filter(f => data[f] !== undefined).map(f => [f, data[f]])
  );
  if (Object.keys(patch).length === 0) return;
  // The access family is on D1: D1 `stores` IS the record of the entitlement fields, there is no Postgres copy to keep in step.
  if (await platformFamilyOnD1('access')) return;
  await withStore(storeId, async tx => {
    await (tx as unknown as StoreUpdateManyClient).store.updateMany({
      where: { id: storeId },
      data: patch,
    });
  });
}

/** The row an update WILL produce (current record with the patch laid over it), read without writing. */
async function projectStoreUpdate(
  storeId: string,
  args: { data: Record<string, unknown>; select?: unknown; include?: { owner?: unknown } }
): Promise<Record<string, unknown>> {
  const stub = storeDo(storeId) as unknown as QueryStub;
  const { decodeRpc } = await import('@ebda-src/repo');
  const selected = args.select
    ? Object.keys(args.select as object).filter(k => (args.select as any)[k])
    : undefined;
  const current = await doStoreDelegate(storeId, stub, decodeRpc as never).findUnique({
    where: { id: storeId },
    ...(selected ? { select: Object.fromEntries(selected.map(k => [k, true])) } : {}),
  });
  if (!current) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  const projected: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(args.data))
    if (v !== undefined && (!selected || selected.includes(k))) projected[k] = v;
  return projected;
}

export async function storeUpdateAfterCommit(
  tx: object,
  storeId: string,
  args: { data: Record<string, unknown>; select?: unknown; include?: { owner?: unknown } }
): Promise<any> {
  // The hook is bound to THIS transaction object (Ruling NZ-D19), not to the ambient tenant scope: a separate money transaction can
  // roll back while the outer tenant transaction commits. A transaction with no hook registry cannot take it: refused (fail closed).
  const pending: { write?: () => Promise<void> } = {};
  if (!afterTxCommit(tx, () => pending.write?.()))
    throw new AppError(
      501,
      'STORE_TX_WRITE_UNSUPPORTED',
      'A Store update inside this database transaction has no post-commit hook for a Durable Object store'
    );
  const stub = storeDo(storeId) as unknown as QueryStub;
  const { decodeRpc } = await import('@ebda-src/repo');
  const delegate = doStoreDelegate(storeId, stub, decodeRpc as never);
  const data = Object.fromEntries(Object.entries(args.data).filter(([, v]) => v !== undefined));
  const selected = args.select
    ? Object.keys(args.select as object).filter(k => (args.select as any)[k])
    : undefined;
  const current = await delegate.findUnique({
    where: { id: storeId },
    ...(selected ? { select: Object.fromEntries(selected.map(k => [k, true])) } : {}),
  });
  if (!current) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  // Postgres owns the entitlement fields: the committed intent lives in THIS transaction, so it commits or rolls back with it and a
  // retry can re-read it (NZ-D20). Never a bare patch held only in memory.
  await (tx as StoreUpdateClient).store.update({
    where: { id: storeId },
    data,
    select: { id: true },
  });
  pending.write = () => applyPostCommit(storeId, data);
  const projected: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(data))
    if (!selected || selected.includes(k)) projected[k] = v;
  return projected;
}

export async function storeUpdate<A extends Prisma.StoreUpdateArgs>(
  db: StoreUpdateClient,
  args: Prisma.SelectSubset<A, Prisma.StoreUpdateArgs>
): Promise<Prisma.StoreGetPayload<A>> {
  const a = args as Prisma.StoreUpdateArgs;
  const id = a.where.id as string;
  if (await storeWritesToDo(id)) {
    // Ruling NZ-D18: a D1 / DO write is NOT in the caller's Postgres transaction. Called with a TRANSACTION client (a billing / money
    // tx), applying it now would leave a plan or entitlement change that a later rollback never undoes (a free upgrade). So it is
    // applied after the tx COMMITS (dropped on rollback), and the caller gets the projected row; with no post-commit hook available
    // (a job's own transaction) it is refused, so that caller gets a proper port.
    if ((db as unknown) !== (prisma as unknown))
      return (await storeUpdateAfterCommit(
        db as object,
        id,
        a as never
      )) as Prisma.StoreGetPayload<A>;
    // The base `prisma` proxy writes into the AMBIENT tenant transaction (`withStore` hands callers `prisma` itself, not a registered
    // tx object). An ENTITLEMENT / lifecycle change (plan, billing suspension, status) made there must not outlive that transaction's
    // rollback (a free upgrade, a re-activation): it applies after the AMBIENT transaction commits, when one with a hook registry
    // exists. Every other field, and a write with no ambient transaction, is applied now (like every other DO write in a request).
    if (touchesEntitlement(a.data as Record<string, unknown>)) {
      let write: (() => Promise<void>) | undefined;
      if (afterTenantTxCommit(() => write?.())) {
        const projected = await projectStoreUpdate(id, a as never);
        const patch = Object.fromEntries(
          Object.entries(a.data as object).filter(([, v]) => v !== undefined)
        );
        await db.store.update({ where: { id }, data: patch, select: { id: true } });
        write = () => applyPostCommit(id, patch);
        return projected as Prisma.StoreGetPayload<A>;
      }
    }
    return (await storeUpdateOnDo(id, a as never)) as Prisma.StoreGetPayload<A>;
  }
  const row = (await db.store.update(a)) as Prisma.StoreGetPayload<A>;
  await copyStoreSettings(id, a.data as Record<string, unknown>);
  return row;
}

export async function storeUpdateMany(
  db: StoreUpdateManyClient,
  args: Prisma.StoreUpdateManyArgs & { where: { id: string } }
): Promise<Prisma.BatchPayload> {
  if (await storeWritesToDo(args.where.id)) {
    // Ruling NZ-D18: a compare-and-set returns its count NOW, so it cannot be deferred past a transaction's commit: refused for a
    // transaction client (the caller ports it), allowed for the base client.
    if ((db as unknown) !== (prisma as unknown))
      throw new AppError(
        501,
        'STORE_TX_WRITE_UNSUPPORTED',
        'Store.updateMany inside a database transaction is not served for a Durable Object store'
      );
    // Compare-and-set stays ONE atomic D1 statement: the filter may name only D1 columns (id + directory / mirror fields); a
    // filter on a DO-only column is refused. The DO copy follows only when the row matched.
    const filter = args.where as Record<string, unknown>;
    const foreign = Object.keys(filter).filter(
      k => k !== 'id' && Object.keys(d1StorePatch({ [k]: filter[k] })).length === 0
    );
    if (foreign.length)
      throw new AppError(
        501,
        'STORE_WRITE_UNSUPPORTED',
        `Store.updateMany filter on ${foreign.join(', ')} is not served by the DO`
      );
    const data = Object.fromEntries(
      Object.entries(args.data as object).filter(([, v]) => v !== undefined)
    );
    const res = {
      count: await d1StoreWrite(args.where as Record<string, unknown>, d1StorePatch(data)),
    } as Prisma.BatchPayload;
    if (res.count > 0) {
      await mirrorEntitlementToPg(args.where.id, data); // NZ-D21
      await copyStoreSettings(args.where.id, data);
    }
    return res;
  }
  const res = await db.store.updateMany(args);
  if (res.count > 0) await copyStoreSettings(args.where.id, args.data as Record<string, unknown>);
  return res;
}

/** Express middleware: one repo scope per request. Cheap (no I/O); the flag is read lazily by the first `storeDb`. */
export function repoScope(req: Request, _res: Response, next: NextFunction): void {
  scopes.run({ req, repos: new Map() }, next);
}

/** Run `fn` in a repo scope with `repo` pre-resolved for its store (contract tests, diagnostics). */
export function withRepo<T>(repo: StoreRepo, fn: () => T, req: RequestLike = NO_REQUEST): T {
  return scopes.run({ req, repos: new Map([[repo.storeId, Promise.resolve(repo)]]) }, fn);
}

/**
 * Run a background job in its own repo scope, so `storeDb` / `storeWriter` follow the store's server-side flag exactly
 * like an HTTP request (Ruling CF-JOBS-1, CF-BACKEND-1). Only lib/jobs/do-guard.ts calls it,
 * and only while `JOBS_ON_DO=1`.
 */
export function runInJobRepoScope<T>(fn: () => T): T {
  return scopes.run({ req: NO_REQUEST, repos: new Map() }, fn);
}

/**
 * ATOMIC money gate + close of a DO store's deletion (Ruling NZ-D17): ONE DO call checks money in flight and sets the closed flag, so
 * nothing can slip in between. Refused -> 409 STORE_HAS_MONEY_IN_FLIGHT with the counts (nothing was changed). `token` is
 * a closure token when THIS call closed the store (null when it was already closed): only that token can reopen it.
 */
export async function closeDoIfNoMoney(storeId: string): Promise<{ token: string | null }> {
  const stub = storeDo(storeId) as unknown as {
    closeIfNoMoneyInFlight(id: string): Promise<
      | {
          ok: true;
          data:
            | { closed: true; token: string | null }
            | { refused: true; counts: Record<string, number> };
        }
      | { ok: false; code: string; status: number }
    >;
  };
  const r = await stub.closeIfNoMoneyInFlight(storeId);
  if (!r.ok) throw new AppError(r.status, r.code, `store close refused: ${r.code}`);
  if ('refused' in r.data)
    throw new AppError(
      409,
      'STORE_HAS_MONEY_IN_FLIGHT',
      'This store still has money in flight (paid orders not delivered, transfers awaiting confirmation, open returns, cash on delivery not settled, payments in dispute, unsettled payouts or wallet balances). Settle them before deleting the store.',
      { ...r.data.counts }
    );
  return { token: r.data.token };
}

/** Compensating rollback (Ruling NZ-D17): reopen a DO that THIS delete closed, when the delete then failed. Clears only its own flag. */
export async function reopenDoAfterFailedDelete(storeId: string, token: string): Promise<void> {
  const stub = storeDo(storeId) as unknown as {
    reopenAfterFailedDelete(
      id: string,
      token: string
    ): Promise<{ ok: true } | { ok: false; code: string; status: number }>;
  };
  const r = await stub.reopenAfterFailedDelete(storeId, token);
  if (!r.ok) throw new AppError(r.status, r.code, `store reopen refused: ${r.code}`);
}
