export { createPrismaLite, expandUnique } from './prisma-lite/client';
export { createD1Client, type D1Like } from './prisma-lite/d1';
export { withEntropy, type Entropy } from './prisma-lite/entropy';
export { Engine } from './prisma-lite/engine';
export { WriteEngine, mapDbError, knownError } from './prisma-lite/writes';
export type { Meta, SqlRunner } from './prisma-lite/types';
export { splitSql } from './prisma-lite/split-sql';
export { doSqlRunner, doSyncSql, type DoStorageLike } from './prisma-lite/do-runner';
export { placeOrder, type CheckoutInput, type PlacedOrder } from './do/checkout';
export { MoneyError, type SyncSql } from './do/sync-sql';
export {
  moneyInFlightOnDo,
  totalInFlight,
  isStoreClosed,
  closeStore,
  closeIfNoMoneyInFlight,
  reopenAfterFailedDelete,
  type CloseResult,
  type DoMoneyInFlight,
} from './do/closure';
export { ensureSearchIndex } from './do/search';
export { ensurePaymentSchema } from './do/payments';
export { trialBalance, postEntry as postJournalEntry } from './do/ledger';
export { encodeRpc, decodeRpc, wirePrismaNulls, revivePrismaNulls } from './rpc/codec';
export {
  runReads,
  rethrow,
  READ_OPS,
  type DoQuery,
  type DoQueryResult,
  type ReadOp,
} from './rpc/reads';
export { createDoClient, type DoTransport, type DoMutateTransport } from './rpc/client';
export {
  runWrites,
  checkMutation,
  ensureIdempotencySchema,
  DO_WRITABLE_MODELS,
  DO_PROCS,
  PROC_MODEL,
  WRITE_OPS,
  type DoMutation,
  type WriteOp,
} from './rpc/writes';
export {
  applyStoreSettings,
  bootstrapStoreRows,
  patchStoreSettings,
  readStoreRecord,
  PATCHABLE_JSON_FIELDS,
  type JsonKeyPatch,
} from './rpc/settings';
export { runStockOp, ensureStockOpsSchema, STOCK_OP_NAMES, type StockOpName } from './do/stock-ops';
export { answerStockOp, type StockAnswer } from './rpc/stock';
export { runMoneyOp, ensureMoneyOpsSchema, MONEY_OP_NAMES, type MoneyOpName } from './do/money-ops';
export {
  DO_METRICS,
  DO_METRIC_NAMES,
  runDoMetric,
  type DoMetricName,
  type DoMetricDef,
} from './do/do-metrics';
export { answerMoneyOp, type MoneyAnswer } from './rpc/money';
export { answerAuthOp, AUTH_OP_NAMES, type AuthAnswer } from './rpc/customer-auth';
export {
  ensureCustomerAuthSchema,
  purgeCustomerAuth,
  CAUTH_TABLES,
  IMPORT_COLUMNS as CAUTH_IMPORT_COLUMNS,
} from './do/customer-auth';

export {
  routePaymentWebhook,
  resolveStoreId,
  drainEntityIndexOutbox,
  awaitEntityIndexed,
  outboxHighWater,
  paymentIndexIds,
  outboxRowsAfter,
  nextOutboxAttempt,
  deadLetterReport,
  ABANDON_ATTEMPTS,
} from './platform/entity-index';
export type { DeadLetterReport, DeadLetterRow } from './platform/entity-index';
export { scrubReceiptsForOrders } from './do/instapay-receipts';
export { purgeErasureLedger } from './do/erase-shopper';
export {
  answerSmartLayerOp,
  ensureSmartLayerSchema,
  runSmartLayerOp,
  SMART_LAYER_OPS,
  SMART_LAYER_TABLES,
  RETENTION_MS as SMART_LAYER_RETENTION_MS,
} from './do/smart-layer';
export type { SmartLayerAnswer, SmartLayerOp } from './do/smart-layer';
export { scrubUserFromStoreDo } from './platform-erasure';
export type { ReceiptRow as InstapayReceiptRow } from './do/instapay-receipts';
export type { VectorWork, VectorizeLike, EmbeddingProviderLike } from './do/search-vectors';
export type { OrderRefundQuote } from './do/returns';
