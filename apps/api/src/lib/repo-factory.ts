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
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { prisma, withStore, type AppPrismaClient, type Prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { backendFor, storeDo, type StoreBackend } from './store-backend';

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
  | 'shipment';
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
  reconcileWarehouseAll(a: { limit?: number; afterKey?: string | null }): Promise<{
    skusReconciled: number;
    skusFailed: number;
    more: boolean;
    nextKey: string | null;
  }>;
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
    a: { orderId: string; restoreInventory?: boolean; note?: string; unpaidOnly?: boolean },
    key?: string
  ): Promise<CancelResult>;
  expireHold(
    a: { orderId: string; proofSubmitted?: boolean },
    key?: string
  ): Promise<'expired' | 'skipped'>;
  /** Payments, webhooks, refunds, the ledger and gold repricing (Rulings CF-PAY-1, CF-LEDGER-1). Results are the engine's. */
  paymentCreate(
    a: {
      orderId: string;
      provider: string;
      amount: number;
      method?: string | null;
      currency?: string;
      transactionId?: string | null;
      invoiceId?: string | null;
      paymentUrl?: string | null;
    },
    key?: string
  ): Promise<{ paymentId: string }>;
  paymentWebhook(
    a: { input: DoWebhookInput; confirmed?: { kind: string; status: string } | null },
    key?: string
  ): Promise<DoWebhookResult>;
  refundBegin(
    a: {
      paymentId: string;
      amount?: number;
      refundKey?: string;
      reason?: string;
      itemLevel?: boolean;
    },
    key?: string
  ): Promise<DoRefundClaim>;
  refundComplete(
    a: { claimId: string; refundId: string; providerStatus?: string; reason?: string },
    key?: string
  ): Promise<{ orderStatus: string; booked: boolean; review: boolean }>;
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
  /** Stamp an order once for a job (`reviewRequestSentAt`): false when an earlier run already did (Ruling CF-JOBS-4). */
  orderStamp(a: { orderId: string; stamp: 'reviewRequestSentAt' }): Promise<{ stamped: boolean }>;
  /** Catalogue and period commerce counts for the monthly usage snapshot. */
  usageCounts(a: { startMs: number; endMs: number }): Promise<Record<string, number>>;
  /** True while any indexable product still needs a vector. */
  vectorStale(a: Record<string, never>): Promise<{ stale: boolean }>;
  /** The storefront-visible subset of the product ids a Vectorize query returned (Ruling CF-VEC-1). A read. */
  vectorVisible(a: { ids: string[] }): Promise<{ ids: string[] }>;
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
}

type RequestLike = Pick<Request, 'headers'>;
interface Scope {
  req: RequestLike;
  repos: Map<string, Promise<StoreRepo>>;
}
const scopes = new AsyncLocalStorage<Scope>();
const NO_REQUEST: RequestLike = { headers: {} };

/** The StoreDO stub's read entry point (lib/store-backend.ts types the rest of the stub). */
interface QueryStub {
  mutate(
    storeId: string,
    m: { key?: string; ops: Array<{ model: string; op: string; args?: Record<string, unknown> }> }
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
    setWarehouseStock: (a, key) => call('setWarehouseStock', a, key),
    adjustWarehouseStock: (a, key) => call('adjustWarehouseStock', a, key),
    reconcileWarehouseSku: a => call('reconcileWarehouseSku', a),
    reconcileWarehouseAll: a => call('reconcileWarehouseAll', a),
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
    paymentCreate: (a, key) => call('paymentCreate', a, key),
    paymentWebhook: (a, key) => call('paymentWebhook', a, key),
    refundBegin: (a, key) => call('refundBegin', a, key),
    refundComplete: (a, key) => call('refundComplete', a, key),
    refundRelease: (a, key) => call('refundRelease', a, key),
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
    trialBalance: () => call('trialBalance', {}),
    orderStamp: a => call('orderStamp', a),
    orderAnonymize: a => call('orderAnonymize', a),
    lastPaidSales: a => call('lastPaidSales', a),
    usageCounts: a => call('usageCounts', a),
    vectorStale: a => call('vectorStale', a),
    vectorVisible: a => call('vectorVisible', a),
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

async function doClients(
  storeId: string
): Promise<{ db: StoreReads; writer: StoreWrites; stock: StockClient; money: MoneyClient }> {
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
    return decodeRpc<any>(r.json);
  };
  const send = (queries: unknown[]) => stub.query(storeId, queries as never);
  return {
    // `db` has NO write delegates at all (the read-only guarantee of CF-REPO-1 is runtime, not just types)
    db: createDoClient(send as never) as unknown as StoreReads,
    writer: createDoClient(send as never, m => stub.mutate(storeId, m)) as unknown as StoreWrites,
    stock: makeStockClient(call),
    money: makeMoneyClient(callMoney),
  };
}

/** pg writer: the `prisma` proxy, minus the DO-only second argument of `$transaction`. */
function pgWriter(): StoreWrites {
  return new Proxy({} as object, {
    get(_t, prop) {
      if (prop === '$proc')
        return () => {
          throw new Error(
            '$proc exists on the Durable Object writer only (the service keeps its Postgres statement)'
          );
        };
      if (prop === '$transaction') return (ops: unknown) => (prisma as any).$transaction(ops);
      return (prisma as any)[prop];
    },
  }) as unknown as StoreWrites;
}

async function resolve(storeId: string, _req: RequestLike): Promise<StoreRepo> {
  const backend = await backendFor(storeId); // server-side flag only: the request never chooses (Ruling CF-BACKEND-1)
  if (backend === 'do') {
    return { storeId, backend, ...(await doClients(storeId)) };
  }
  return { storeId, backend: 'pg', db: prisma as unknown as StoreReads, writer: pgWriter() };
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
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') return;
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

export async function storeUpdate<A extends Prisma.StoreUpdateArgs>(
  db: StoreUpdateClient,
  args: Prisma.SelectSubset<A, Prisma.StoreUpdateArgs>
): Promise<Prisma.StoreGetPayload<A>> {
  const a = args as Prisma.StoreUpdateArgs;
  const row = (await db.store.update(a)) as Prisma.StoreGetPayload<A>;
  await copyStoreSettings(a.where.id as string, a.data as Record<string, unknown>);
  return row;
}

export async function storeUpdateMany(
  db: StoreUpdateManyClient,
  args: Prisma.StoreUpdateManyArgs & { where: { id: string } }
): Promise<Prisma.BatchPayload> {
  const res = await db.store.updateMany(args);
  if (res.count > 0) await copyStoreSettings(args.where.id, args.data as Record<string, unknown>);
  return res;
}

/**
 * For a raw-SQL write to `stores` (jsonb_set on `settings`): re-read the named columns from the authoritative row and copy
 * them, so a partial JSON write reaches the DO as the whole resulting value.
 */
export async function syncStoreFields(storeId: string, fields: string[]): Promise<void> {
  if ((await storeRepo(storeId)).backend !== 'do') return;
  const select = Object.fromEntries(fields.map(f => [f, true]));
  const row = (await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select })
  )) as Record<string, unknown> | null;
  if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'store not found');
  await copyStoreSettings(storeId, row);
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
