import { encodeRpc } from './codec';
import { READ_OPS, type DoQuery, type DoQueryResult } from './reads';
import type { SqlRunner, WriteGuard } from '../prisma-lite/types';

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
  // review moderation (INFRA-CF-1, Ruling CF-JOBS-4)
  'Review',
  // ETA e-receipts: the connection and the receipt rows (Ruling CF-JOBS-4B)
  'EtaConnection',
  'EtaReceipt',
  // bulk AI job rows: the stuck-job watcher resumes or fails them (Ruling CF-JOBS-4B)
  'BulkAiJob',
  // dead-stock flags: the weekly scan writes them (Ruling CF-JOBS-4B)
  'DeadStockFlag',
  // merchant webhooks: endpoints and the delivery log (Ruling CF-JOBS-4B)
  'WebhookEndpoint',
  'WebhookDelivery',
  // the bulk AI / import job rows and the AI-written store content the jobs persist (Ruling CF-JOBS-4)
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
  // the carrier booking job claims and updates the shipment row (INFRA-CF-1, Ruling CF-JOBS-4)
  'Shipment',
  // catalogue import (#329) job / file / item rows and the Customer Intelligence hint log and per-store gate (#336) (Ruling INTEG-1)
  'CatalogImportJob',
  'CatalogImportFile',
  'CatalogImportItem',
  'CiHintLog',
  'CiStoreGate',
  // the per-store audit trail (NEON-ZERO N-10d): appended by services/audit-sink.ts, which only ever `create`s
  'AuditLog',
  // per-store analytics (Ruling NZ-AN-1): the gsc ingest upserts and the notification log write through the generic path; the counters use the analytics ops
  'SearchQueryDaily',
  'ProductDailyView',
  'QrScanDaily',
  'NotificationLog',
  'GscDailyMetric',
  // storefront wishlist and merchant bundles (NEON-ZERO-1 N-3, Ruling NZ-SF-4)
  'Wishlist',
  'WishlistItem',
  'Bundle',
  'BundleItem',
  // per-store admin CRUD (NEON-ZERO-1 N-11 group B, Ruling NZ-N11-1): merchant-edited config/marketing rows, never a stock column
  'CustomerGroup',
  // the platform tax-verification decision (NEON-ZERO group C, Ruling NZ-C-7)
  'StoreTaxProfile',
  // shopper address book, per store (Ruling NZ-SF-5)
  'Address',
  'CustomerAddress',
  'Coupon',
  'Promotion',
  'TaxRate',
  'StoreTaxDocument',
  'WholesaleApplication',
  'ProductModel',
  'ProductModelBinding',
  'StoreWhatsAppLink',
  'GoldRateSettings',
]);

/** Stock columns: never written through the generic path (a stock change is a locked money/stock section, D2). */
const STOCK_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Product: ['inventory'],
  ProductVariant: ['inventory'],
};

const WRITE_GUARD: WriteGuard = { writable: DO_WRITABLE_MODELS, stock: STOCK_COLUMNS };

/**
 * Named in-DO procedures for the few writes that are one SQL statement Prisma cannot express (the Postgres twin is a raw
 * `UPDATE ... jsonb ||`). They ride in the same atomic batch as the model ops, take typed args, and never accept SQL text.
 * Model `$proc`, op = the procedure name. Result = the procedure's return value.
 */
export const PROC_MODEL = '$proc';
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
type Proc = (sql: SqlRunner, args: Record<string, unknown>) => unknown;
export const AUDIT_MIN_PURGE_AGE_MS = 30 * 86_400_000;
export const DO_PROCS: Record<string, Proc> = {
  /** Replace the `details` JSON of ONE audit row of this store (the MCP denial-count flush). Returns rows changed. */
  auditSetDetails(sql, a) {
    const { id, storeId, details } = a as { id: unknown; storeId: unknown; details: unknown };
    if (typeof id !== 'string' || !id) throw procErr('id');
    if (typeof storeId !== 'string' || !storeId) throw procErr('storeId');
    if (!details || typeof details !== 'object' || Array.isArray(details)) throw procErr('details');
    const count = (details as { count?: unknown }).count;
    if (!Number.isInteger(count) || (count as number) < 1) throw procErr('details.count');
    const json = JSON.stringify(details);
    if (json.length > 16_384) throw procErr('details');
    // only the coalesced agent-denial rows carry a count: any other row (or one without `count`) is never rewritten
    sql.run(
      `UPDATE audit_logs SET details = ? WHERE id = ? AND store_id = ? AND action LIKE 'agent.%' AND json_extract(details, '$.count') IS NOT NULL`,
      [json, id, storeId]
    );
    return sql.all('SELECT changes() AS n', [])[0]?.n ?? 0;
  },
  /**
   * Customer -> group membership (NEON-ZERO N-11): the ONLY customers columns the admin path may write on a DO store is
   * `group_id` (assign / wholesale approve & revoke), so it is a named op and `Customer` stays out of the generic writer.
   * Runs inside the caller's `$transaction` batch next to its audit row. The group must belong to the same store.
   * Returns the row in the shape the services select (`id`, `groupId`, `group`), or throws CUSTOMER_NOT_FOUND / GROUP_NOT_FOUND.
   */
  customerSetGroup(sql, a) {
    const { storeId, customerId, groupId } = a as {
      storeId: unknown;
      customerId: unknown;
      groupId: unknown;
    };
    if (typeof storeId !== 'string' || !storeId) throw procErr('storeId');
    if (typeof customerId !== 'string' || !customerId) throw procErr('customerId');
    if (groupId !== null && (typeof groupId !== 'string' || !groupId)) throw procErr('groupId');
    const group = groupIn(sql, storeId, groupId);
    sql.run('UPDATE customers SET group_id = ?, updated_at = ? WHERE id = ? AND store_id = ?', [
      groupId,
      Date.now(),
      customerId,
      storeId,
    ]);
    if (sql.all('SELECT changes() AS n', [])[0]?.n !== 1)
      throw Object.assign(new Error('customer not found'), { code: 'CUSTOMER_NOT_FOUND' });
    return { id: customerId, groupId, group };
  },
  /** The wholesale-approval / identity-assign insert of a CRM row that is born inside a group. Same contract as above. */
  customerCreateInGroup(sql, a) {
    const r = a as Record<string, unknown>;
    const str = (k: string, nullable: boolean) => {
      const v = r[k];
      if (v === null || v === undefined) {
        if (nullable) return null;
        throw procErr(k);
      }
      if (typeof v !== 'string' || v.length > 320) throw procErr(k);
      return v;
    };
    const id = str('id', false) as string;
    const storeId = str('storeId', false) as string;
    const groupId = str('groupId', false) as string;
    const group = groupIn(sql, storeId, groupId);
    try {
      sql.run(
        'INSERT INTO customers (id, store_id, email, first_name, last_name, phone, user_id, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          storeId,
          str('email', true),
          str('firstName', false),
          str('lastName', false),
          str('phone', true),
          str('userId', true),
          groupId,
          Date.now(),
          Date.now(),
        ]
      );
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String((e as Error)?.message)))
        throw Object.assign(new Error('customer already exists'), { code: 'P2002' });
      throw e;
    }
    return { id, groupId, group };
  },
  /** Retention: delete rows older than `before` (epoch ms, at least 30 days ago) up to and including `upToId`. */
  auditPurge(sql, a) {
    const { before, upToId } = a as { before: unknown; upToId: unknown };
    if (typeof before !== 'number' || !Number.isFinite(before)) throw procErr('before');
    if (before > Date.now() - AUDIT_MIN_PURGE_AGE_MS)
      throw procErr('before (younger than 30 days)');
    if (typeof upToId !== 'string') throw procErr('upToId');
    sql.run('DELETE FROM audit_logs WHERE created_at < ? AND id <= ?', [before, upToId]);
    return sql.all('SELECT changes() AS n', [])[0]?.n ?? 0;
  },
  /** Erasure: null `user_id` on every audit row of one user (the row stays, the person goes). */
  auditUnlinkUser(sql, a) {
    const { userId } = a as { userId: unknown };
    if (typeof userId !== 'string' || !userId) throw procErr('userId');
    sql.run('UPDATE audit_logs SET user_id = NULL WHERE user_id = ?', [userId]);
    return sql.all('SELECT changes() AS n', [])[0]?.n ?? 0;
  },
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

function groupIn(
  sql: SqlRunner,
  storeId: string,
  groupId: unknown
): { id: string; name: string; nameAr: string | null } | null {
  if (groupId === null) return null;
  const g = sql.all('SELECT id, name, name_ar FROM customer_groups WHERE id = ? AND store_id = ?', [
    groupId,
    storeId,
  ])[0] as { id: string; name: string; name_ar: string | null } | undefined;
  if (!g) throw Object.assign(new Error('group not found'), { code: 'GROUP_NOT_FOUND' });
  return { id: g.id, name: g.name, nameAr: g.name_ar };
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
  if (!cols || value === null || typeof value !== 'object') return false;
  // fail CLOSED on a structure nested deeper than any real write (a deep value must not slip past a depth cut-off)
  if (depth > 6) return true;
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
    // the audit trail is APPEND-ONLY on the generic path: `create` and nothing else. The three narrow edits it needs
    // (count flush, retention purge, erasure unlink) are named procedures below (NEON-ZERO N-10d security review).
    if (q.model === 'AuditLog' && q.op !== 'create')
      return refuse(
        'AUDIT_APPEND_ONLY',
        `AuditLog.${String(q.op)} is not allowed on the generic write path`
      );
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
  // The EXECUTOR enforces the same rules at every write/link it makes (Ruling CF-R7-4): the static check above cannot see
  // which model a nested relation reaches, and a second parser of the same args is a parser differential. A client that
  // cannot bind the guard is refused (fail closed) rather than run unguarded.
  const bind = (lite as { $guarded?: (g: WriteGuard) => Record<string, unknown> }).$guarded;
  if (typeof bind !== 'function')
    return refuse('NO_WRITE_GUARD', 'client cannot enforce the write guard');
  lite = bind(WRITE_GUARD);
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
