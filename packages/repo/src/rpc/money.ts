import { runMoneyOp } from '../do/money-ops';
import { MoneyError, type SyncSql } from '../do/sync-sql';
import { decodeRpc, encodeRpc } from './codec';

/**
 * The money half of the StoreDO RPC (INFRA-CF-1 PR D2b, Ruling CF-MONEY-1). Its own RPC beside `stockOp`: money moves only
 * through the named, single-section operations of `do/money-ops.ts`, never through the generic `mutate`.
 */
export type MoneyAnswer =
  | { ok: true; json: string }
  | { ok: false; code: string; status: number; message: string; meta?: Record<string, unknown> };

/** Run one operation and turn a refusal into an ANSWER (the DO never throws a refusal across the RPC boundary). */
export function answerMoneyOp(
  db: SyncSql,
  storeId: string,
  op: string,
  argsJson: string,
  key?: string
): MoneyAnswer {
  try {
    const args = decodeRpc<unknown>(argsJson);
    return { ok: true, json: encodeRpc(runMoneyOp(db, storeId, op, args, key)) };
  } catch (e) {
    if (e instanceof MoneyError)
      return {
        ok: false,
        code: e.code,
        status: e.status,
        message: e.message,
        ...(e.meta ? { meta: e.meta } : {}),
      };
    const err = e as { code?: unknown; message?: unknown };
    // a SQLite constraint failure, a decode error: reported, rolled back (transactionSync), never swallowed
    return {
      ok: false,
      code: typeof err.code === 'string' ? err.code : 'MONEY_OP_FAILED',
      status: 500,
      message: typeof err.message === 'string' ? err.message : 'money operation failed',
    };
  }
}
