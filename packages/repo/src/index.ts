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
export { encodeRpc, decodeRpc } from './rpc/codec';
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
export { applyStoreSettings, readStoreRecord } from './rpc/settings';
export { runStockOp, ensureStockOpsSchema, STOCK_OP_NAMES, type StockOpName } from './do/stock-ops';
export { answerStockOp, type StockAnswer } from './rpc/stock';
export { runMoneyOp, ensureMoneyOpsSchema, MONEY_OP_NAMES, type MoneyOpName } from './do/money-ops';
export { answerMoneyOp, type MoneyAnswer } from './rpc/money';

export {
  routePaymentWebhook,
  resolveStoreId,
  drainEntityIndexOutbox,
} from './platform/entity-index';
export { scrubReceiptsForOrders } from './do/instapay-receipts';
export { purgeErasureLedger } from './do/erase-shopper';
export type { ReceiptRow as InstapayReceiptRow } from './do/instapay-receipts';
export type { VectorWork, VectorizeLike, EmbeddingProviderLike } from './do/search-vectors';
