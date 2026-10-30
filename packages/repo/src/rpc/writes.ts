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

/** Non-money catalogue, content and cart models whose writes the StoreDO accepts in D1 (and R2). Everything else is a money op. */
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
  // carts and abandoned carts (INFRA-CF-1 PR R2, Ruling CF-R2-1)
  'Cart',
  'CartItem',
  'CartBundle',
  'AbandonedCart',
  'AbandonedCartConfig',
  // the newsletter list and its consent (INFRA-CF-1 PR R4, Ruling CF-R4-4)
  'NewsletterSubscriber',
  // email campaigns and their recipients (INFRA-CF-1 PR R6a, Ruling CF-R6A-2)
  'Campaign',
  'CampaignRecipient',
  // the channel credentials and per-event switches the push / SMS / WhatsApp dispatchers read (Ruling CF-NOTIFY-1)
  'NotificationConfig',
  'NotificationEventConfig',
  // the bulk AI / import job rows and the AI-written store content the jobs persist (Ruling CF-JOBS-4)
  'BulkAiJob',
  'BulkImportJob',
  'StoreFaq',
  'StoreHowto',
  'AiRecommendation',
  'FrequentlyBoughtTogether',
  'ProfitAnomaly',
  'CustomerCohortSnapshot',
  'FunnelSnapshot',
  'CustomerRfmSnapshot',
  'AnswerEngineCheck',
]);

/** Stock columns: never written through the generic path (a stock change is a locked money/stock section, D2). */
const STOCK_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Product: ['inventory'],
  ProductVariant: ['inventory'],
};

/**
 * Named in-DO procedures for the few writes that are one SQL statement Prisma cannot express (the Postgres twin is a raw
 * `UPDATE ... jsonb ||`). They ride in the same atomic batch as the model ops, take typed args, and never accept SQL text.
 * Model `$proc`, op = the procedure name. Result = the procedure's return value.
 */
export const PROC_MODEL = '$proc';
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
type Proc = (sql: SqlRunner, args: Record<string, unknown>) => unknown;
export const DO_PROCS: Record<string, Proc> = {
  /**
   * products.ai_field_sources: merge `set` (field -> 'ai'|'human') into the row AS IT IS NOW and drop `remove`, so a stamp
   * another writer committed on a different key survives (review N1). Returns the merged map, or null when no such row.
   */
  mergeAiFieldSources(sql, a) {
    const { productId, set, remove } = a as {
      productId: unknown;
      set: unknown;
      remove: unknown;
    };
    if (typeof productId !== 'string' || !productId) throw procErr('productId');
    if (!set || typeof set !== 'object' || Array.isArray(set)) throw procErr('set');
    if (!Array.isArray(remove)) throw procErr('remove');
    const entries = Object.entries(set as Record<string, unknown>);
    for (const [k, v] of entries)
      if (!KEY.test(k) || (v !== 'ai' && v !== 'human')) throw procErr(`set.${k}`);
    for (const k of remove as unknown[])
      if (typeof k !== 'string' || !KEY.test(k)) throw procErr('remove');
    const paths = (remove as string[]).map(k => `$."${k}"`);
    const expr = paths.length
      ? `json_remove(json_patch(COALESCE(ai_field_sources, '{}'), ?), ${paths.map(() => '?').join(', ')})`
      : `json_patch(COALESCE(ai_field_sources, '{}'), ?)`;
    sql.run(`UPDATE products SET ai_field_sources = ${expr} WHERE id = ?`, [
      JSON.stringify(Object.fromEntries(entries)),
      ...paths,
      productId,
    ]);
    const row = sql.all('SELECT ai_field_sources AS v FROM products WHERE id = ?', [productId])[0];
    return row ? JSON.parse((row.v as string) ?? '{}') : null;
  },
  /**
   * The guarded AI write of one product (Ruling CF-JOBS-4), the in-DO twin of `writeAiFieldsGuarded`'s Postgres section
   * (row lock, fresh re-read, per-field compare-and-set). One procedure = one atomic section, so no merchant save can land
   * between the re-read and the write. A field is written only when its stored value still equals `baseline[field]` AND its
   * owner is not 'human'; each written field is stamped 'ai' on the FRESH provenance map. `extra.aiBalanceBackup` is stored
   * with the write. Returns the written / stale field names and the product's category count at write time.
   */
  guardedAiWrite(sql, a) {
    const { productId, baseline, writes, extra } = a as {
      productId: unknown;
      baseline: unknown;
      writes: unknown;
      extra: unknown;
    };
    if (typeof productId !== 'string' || !productId) throw procErr('productId');
    const obj = (v: unknown, what: string): Record<string, unknown> => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw procErr(what);
      return v as Record<string, unknown>;
    };
    const base = obj(baseline, 'baseline');
    const wr = obj(writes, 'writes');
    const col = (f: string): string => {
      if (!KEY.test(f)) throw procErr(`field ${f}`);
      return f.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
    };
    const row = sql.all('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [
      productId,
    ])[0];
    if (!row) return { found: false, written: [], stale: Object.keys(wr), categoryCount: 0 };
    const sources = JSON.parse((row.ai_field_sources as string) ?? '{}') as Record<string, unknown>;
    const next: Record<string, unknown> = { ...sources };
    const sets: string[] = [];
    const vals: unknown[] = [];
    const written: string[] = [];
    const stale: string[] = [];
    for (const [field, value] of Object.entries(wr)) {
      if (value !== null && typeof value !== 'string') throw procErr(`value ${field}`);
      const c = col(field);
      const changed =
        String((row[c] as string | null) ?? '') !== String((base[field] as string | null) ?? '');
      if (sources[field] === 'human' || changed) {
        stale.push(field);
        continue;
      }
      sets.push(`${c} = ?`);
      vals.push(value);
      next[field] = 'ai';
      written.push(field);
    }
    if (written.length > 0) {
      sets.push('ai_field_sources = ?');
      vals.push(JSON.stringify(next));
      const ex = extra && typeof extra === 'object' ? (extra as Record<string, unknown>) : {};
      if (ex.aiBalanceBackup !== undefined) {
        sets.push('ai_balance_backup = ?');
        vals.push(JSON.stringify(ex.aiBalanceBackup));
      }
      sets.push('updated_at = ?');
      vals.push(Date.now());
      sql.run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, [...vals, productId]);
    }
    const n = sql.all('SELECT COUNT(*) AS n FROM product_categories WHERE product_id = ?', [
      productId,
    ])[0];
    return { found: true, written, stale, categoryCount: Number(n?.n ?? 0) };
  },
};
function procErr(what: string): Error {
  return Object.assign(new Error(`bad procedure argument: ${what}`), { code: 'BAD_PROC_ARGS' });
}

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
    ([k, v]) =>
      v !== undefined &&
      (cols.includes(k) || (typeof v === 'object' && touchesStock(model, v, depth + 1)))
  );
}

/** Validate a batch BEFORE any statement runs. Returns a refusal, or undefined when the batch may run. */
export function checkMutation(m: DoMutation): DoQueryResult | undefined {
  if (!m || !Array.isArray(m.ops) || m.ops.length === 0 || m.ops.length > 200)
    return refuse('BAD_BATCH', 'ops must be 1..200');
  if (m.key !== undefined && (typeof m.key !== 'string' || !KEY_RE.test(m.key)))
    return refuse('BAD_IDEMPOTENCY_KEY', 'key');
  for (const q of m.ops) {
    if (q?.model === PROC_MODEL) {
      if (!Object.prototype.hasOwnProperty.call(DO_PROCS, q.op as string))
        return refuse('PROC_NOT_ALLOWED', `procedure ${String(q.op)}`);
      continue;
    }
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
        if (q.model === PROC_MODEL) {
          out.push(DO_PROCS[q.op as string](sql, (q.args ?? {}) as Record<string, unknown>));
          continue;
        }
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
