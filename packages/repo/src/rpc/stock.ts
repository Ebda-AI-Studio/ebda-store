import { runStockOp } from '../do/stock-ops';
import { MoneyError, type SyncSql } from '../do/sync-sql';
import { decodeRpc, encodeRpc } from './codec';

/**
 * The stock half of the StoreDO RPC (INFRA-CF-1 PR D2a, Ruling CF-STOCK-1). `stockOp` is separate from `mutate` on purpose:
 * `mutate` REFUSES every stock column (CF-WRITES-1), so stock can only move through the named, locked-section operations
 * of `do/stock-ops.ts`, never through a generic write.
 */
export type StockAnswer =
  | { ok: true; json: string }
  | { ok: false; code: string; status: number; message: string };

/** Run one operation and turn a refusal into an ANSWER (the DO never throws a refusal across the RPC boundary). */
export function answerStockOp(
  db: SyncSql,
  storeId: string,
  op: string,
  argsJson: string,
  key?: string
): StockAnswer {
  try {
    const args = decodeRpc<unknown>(argsJson);
    return { ok: true, json: encodeRpc(runStockOp(db, storeId, op, args, key)) };
  } catch (e) {
    if (e instanceof MoneyError)
      return { ok: false, code: e.code, status: e.status, message: e.message };
    const err = e as { code?: unknown; message?: unknown };
    // a SQLite constraint failure, a decode error: reported, rolled back (transactionSync), never swallowed
    return {
      ok: false,
      code: typeof err.code === 'string' ? err.code : 'STOCK_OP_FAILED',
      status: 500,
      message: typeof err.message === 'string' ? err.message : 'stock operation failed',
    };
  }
}
