import { encodeRpc } from './codec';
import { READ_OPS, type DoQuery, type DoQueryResult } from './reads';
import type { SqlRunner } from '../prisma-lite/types';

/**
 * The WRITE half of the StoreDO RPC (INFRA-CF-1 PR D1, Ruling CF-WRITES-1).
 *
 * One call = one ATOMIC unit (a single `storage.transaction`): every op of the batch commits together or none does,
 * exactly what `prisma.$transaction([...])` gives on Postgres. A batch may carry an idempotency key: the first run
 * stores its result under the key INSIDE the same transaction, a replay returns that stored result without running
 * anything, and the same key with different ops is refused (`IDEMPOTENCY_KEY_REUSED`), so a lost response can be retried.
 *
 * REFUSED, never ported silently:
 *  - a model that is not on the D1 allow-list (orders, payments, refunds, ledger, stock, coupons, wallet, loyalty... are PR D2);
 *  - a write to the stock columns of Product/ProductVariant (stock only moves through the locked money/stock sections);
 *  - an op that is not a read or one of WRITE_OPS.
 */
export const WRITE_OPS = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
] as const;
export type WriteOp = (typeof WRITE_OPS)[number];

/** Non-money catalogue and content models whose writes the StoreDO accepts in D1. Everything else is D2. */
export const DO_WRITABLE_MODELS: ReadonlySet<string> = new Set([
  'Product',
  'ProductVariant',
  'ProductOption',
  'ProductOptionValue',
  'ProductVariantOption',
  'ProductImage',
  'ProductCategory',
  'ProductFaq',
  'ProductRelation',
  'ProductPriceTier',
  'ProductTag',
  'Tag',
  'Category',
  'BlogPost',
  'StorePage',
  'StorePageRevision',
  'StoreLocation',
  'SizeChart',
]);

/** Stock columns: never written through the generic path (a stock change is a locked money/stock section, D2). */
const STOCK_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Product: ['inventory'],
  ProductVariant: ['inventory'],
};

export interface DoMutation {
  /** Optional replay key (8-128 chars of [A-Za-z0-9._:-]). */
  key?: string;
  ops: DoQuery[];
}

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MODEL_RE = /^[A-Z][A-Za-z0-9]*$/;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const isWrite = (op: unknown): op is WriteOp =>
  (WRITE_OPS as readonly string[]).includes(op as string);
const isRead = (op: unknown): boolean => (READ_OPS as readonly string[]).includes(op as string);
const delegateOf = (model: string) => model[0].toLowerCase() + model.slice(1);

const refuse = (code: string, message: string): DoQueryResult => ({ ok: false, code, message });

/** FNV-1a over the encoded ops: enough to tell "same batch replayed" from "key reused for another batch". */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${s.length}:${h.toString(16)}`;
}

/** Does any data object under `value` (top level, or inside create/update/set of an upsert/nested write) name a stock column? */
function touchesStock(model: string, value: unknown, depth = 0): boolean {
  const cols = STOCK_COLUMNS[model];
  if (!cols || value === null || typeof value !== 'object' || depth > 6) return false;
  if (Array.isArray(value)) return value.some(v => touchesStock(model, v, depth + 1));
  const o = value as Record<string, unknown>;
  return Object.entries(o).some(
    ([k, v]) => cols.includes(k) || (typeof v === 'object' && touchesStock(model, v, depth + 1))
  );
}

/** Validate a batch BEFORE any statement runs. Returns a refusal, or undefined when the batch may run. */
export function checkMutation(m: DoMutation): DoQueryResult | undefined {
  if (!m || !Array.isArray(m.ops) || m.ops.length === 0 || m.ops.length > 200)
    return refuse('BAD_BATCH', 'ops must be 1..200');
  if (m.key !== undefined && (typeof m.key !== 'string' || !KEY_RE.test(m.key)))
    return refuse('BAD_IDEMPOTENCY_KEY', 'key');
  for (const q of m.ops) {
    if (typeof q?.model !== 'string' || !MODEL_RE.test(q.model))
      return refuse('BAD_MODEL', 'model');
    if (isRead(q.op)) continue;
    if (!isWrite(q.op)) return refuse('OP_NOT_ALLOWED', `op ${String(q.op)}`);
    if (!DO_WRITABLE_MODELS.has(q.model))
      return refuse('MODEL_NOT_WRITABLE', `${q.model} is not ported to the StoreDO write path`);
    const a = (q.args ?? {}) as Record<string, unknown>;
    // only the VALUES a write stores are checked (a `where: { inventory: 0 }` filter is a read of stock, not a write)
    if ([a.data, a.create, a.update].some(v => touchesStock(q.model, v)))
      return refuse('STOCK_WRITE_REFUSED', `${q.model}: stock columns are not written here`);
  }
  return undefined;
}

export function ensureIdempotencySchema(sql: SqlRunner): void {
  sql.run(
    'CREATE TABLE IF NOT EXISTS _idempotency (k TEXT PRIMARY KEY, fp TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL)',
    []
  );
}

/**
 * Run a batch atomically against a prisma-lite client. Returns, never throws: a refusal, a constraint failure (P-code)
 * and a rollback are all answers. `now` is injectable for the key-expiry test.
 */
export async function runWrites(
  lite: Record<string, unknown>,
  sql: SqlRunner,
  m: DoMutation,
  now: () => number = Date.now
): Promise<DoQueryResult> {
  const bad = checkMutation(m);
  if (bad) return bad;
  if (!sql.transaction) return refuse('NO_TRANSACTION', 'runner has no transaction');
  const fp = fingerprint(encodeRpc(m.ops));
  try {
    return await sql.transaction(async () => {
      if (m.key) {
        const prior = sql.all('SELECT fp, result, at FROM _idempotency WHERE k = ?', [m.key])[0];
        if (prior && (prior.at as number) > now() - KEY_TTL_MS) {
          if (prior.fp !== fp)
            return refuse('IDEMPOTENCY_KEY_REUSED', 'key used for another batch');
          return { ok: true, json: prior.result as string } satisfies DoQueryResult;
        }
        if (prior) sql.run('DELETE FROM _idempotency WHERE k = ?', [m.key]);
      }
      const out: unknown[] = [];
      for (const q of m.ops) {
        const d = lite[delegateOf(q.model)] as Record<
          string,
          (a?: unknown) => PromiseLike<unknown>
        >;
        out.push(await d[q.op](q.args));
      }
      const json = encodeRpc(out);
      if (m.key) {
        sql.run('DELETE FROM _idempotency WHERE at < ?', [now() - KEY_TTL_MS]);
        sql.run('INSERT INTO _idempotency (k, fp, result, at) VALUES (?, ?, ?, ?)', [
          m.key,
          fp,
          json,
          now(),
        ]);
      }
      return { ok: true, json } satisfies DoQueryResult;
    });
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; meta?: unknown };
    return {
      ok: false,
      code: typeof err.code === 'string' ? err.code : 'PRISMA_LITE',
      message: typeof err.message === 'string' ? err.message : 'write failed',
      json: err.meta === undefined ? undefined : encodeRpc(err.meta),
    };
  }
}
