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
  // a store's payment gateway configuration; `credentials` is ciphertext written by the route (Ruling NEON-ZERO-2)
  'PaymentConfig',
  // the encrypted agent (MCP) write key of a store: ciphertext only, written by the agent-credential route (Ruling NZ-AGENT-KEY-1)
  'StoreCredential',
  'ShippingCarrierConfig', // the provider connection-test result lives on this row (Test connection re-run for a DO store)
  // the store's VAT registration profile and its evidence rows (Ruling NEON-ZERO-2; status transitions stay in TaxProfileService)
  'StoreTaxProfile',
  // the VAT rates the order tax sums (ruling TAX-1); the admin CRUD writes the table checkout reads (Ruling NEON-ZERO-2)
  'TaxRate',
  'StoreTaxDocument',
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
  // a carrier pickup request (claim -> carrier call -> requested / cancelled); the partial unique index keeps one active
  'ShipmentPickup',
  // merchant shipping zones and per-area rates (NEON-ZERO-1 group A, Ruling NZ-A-1)
  'ShippingZone',
  'ShippingAreaRate',
  // reorder suggestions: the merchant dismisses / accepts them (NEON-ZERO-1 group A, Ruling NZ-A-1)
  'ReorderSuggestion',
  // suppliers (NEON-ZERO-1 group A, Ruling NZ-A-1)
  'Supplier',
  // per-product reorder thresholds the merchant sets by hand (M-107); the reorder scan only reads them
  'ReorderRule',
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
  // shopper address book (Ruling NZ-SF-5) and the platform tax-verification decision (group C, Ruling NZ-C-7: StoreTaxProfile)
  // per-store admin CRUD (NEON-ZERO-1 N-11 group B, Ruling NZ-N11-1): merchant-edited config/marketing rows, never a stock column
  'CustomerGroup',
  'Address',
  'StoreTaxProfile',
  'CustomerAddress',
  'Coupon',
  'Promotion',
  'TaxRate',
  'StoreTaxDocument',
  'WholesaleApplication',
  'ProductModel',
  'ProductModelBinding',
  'StoreWhatsAppLink',
  // the shopper's WhatsApp / SMS marketing consents (storefront opt-in, account settings, unsubscribe link; P1 2026-11-09)
  'StoreWhatsAppConsent',
  'SmsMarketingConsent',
  'GoldRateSettings',
  // feature-gated admin subsystems a merchant turns on (Ruling NZ-FEAT-1): warehouse rows (never their stock: `warehouse_stock`
  // moves only in the stock ops), the affiliate programme config, affiliates, their audit events and click/referral rows
  // (never a balance or a commission: those move only in the affiliate money ops, see the locked columns below)
  'Warehouse',
  'AffiliateConfig',
  'Affiliate',
  'AffiliateEvent',
  'AffiliateReferral',
  // finance admin (Ruling NZ-FEAT-1): the chart of accounts rows a merchant adds / disables, the manual FX rate log and the bank
  // statement import + match state. NEVER the ledger: JournalEntry / JournalLine are written only by the journal money ops
  'Account',
  'FxRateEntry',
  'BankStatement',
  'BankTransaction',
]);

/** Stock columns: never written through the generic path (a stock change is a locked money/stock section, D2). */
const STOCK_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Product: ['inventory'],
  ProductVariant: ['inventory'],
  // money columns, same lock (Ruling NZ-FEAT-1): an affiliate's balances and a referral's commission move only in the
  // affiliateCommission / affiliateReverse / affiliatePayout money ops (one transactionSync section each)
  Affiliate: ['totalEarned', 'totalPaid', 'pendingBalance'],
  // the referral's lifecycle is what the commission / reversal ops key on (`converted` + no commission -> claim,
  // `commission_paid` -> reverse, by `order_id`): only `registerClick` creates it (status defaults to `clicked`), and the
  // order link is the `affiliateReferralLink` procedure (clicked + unlinked only)
  AffiliateReferral: ['commissionAmount', 'status', 'orderId'],
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
  /**
   * Ebda Chat saves a delivery address for a buyer known only by `buyerKey` (WA-RPC-4). Find-or-create the store's CRM row for that
   * key (deterministic id `wa-<buyerKey>` + INSERT OR IGNORE, so a race or replay makes ONE row; no phone, name or email is invented),
   * then add the address unless an identical one exists (idempotent). Runs in one DO section, tenant-scoped by `storeId`.
   */
  waSaveAddress(sql, a) {
    const { storeId, buyerKey, label, area, street } = a as Record<string, unknown>;
    if (typeof storeId !== 'string' || !storeId) throw procErr('storeId');
    if (typeof buyerKey !== 'string' || !/^[0-9a-f]{64}$/.test(buyerKey)) throw procErr('buyerKey');
    if (label !== null && label !== undefined && (typeof label !== 'string' || label.length > 40))
      throw procErr('label');
    if (typeof area !== 'string' || !area || area.length > 120) throw procErr('area');
    if (typeof street !== 'string' || !street || street.length > 240) throw procErr('street');
    const now = Date.now();
    const lab = (label as string | null | undefined) ?? null;
    let customerId = sql.all(
      'SELECT id FROM customers WHERE store_id = ? AND buyer_key = ? ORDER BY created_at, id LIMIT 1',
      [storeId, buyerKey]
    )[0]?.id as string | undefined;
    if (!customerId) {
      customerId = `wa-${buyerKey}`;
      sql.run(
        "INSERT OR IGNORE INTO customers (id, store_id, first_name, last_name, buyer_key, created_at, updated_at) VALUES (?, ?, 'WhatsApp', 'customer', ?, ?, ?)",
        [customerId, storeId, buyerKey, now, now]
      );
    }
    const same = sql.all(
      'SELECT id, label, area, street FROM customer_addresses WHERE customer_id = ? AND area = ? AND street = ? AND label IS ? LIMIT 1',
      [customerId, area, street, lab]
    )[0];
    if (same)
      return {
        id: same.id,
        label: same.label ?? null,
        area: same.area,
        street: same.street,
        created: false,
      };
    const id = crypto.randomUUID();
    sql.run(
      'INSERT INTO customer_addresses (id, customer_id, label, street, area, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      [id, customerId, lab, street, area, now, now]
    );
    return { id, label: lab, area, street, created: true };
  },
  /** The saved addresses of the CRM row keyed by `buyerKey` (WA-RPC-4), newest first, at most 10. Read-only; `customers.buyer_key` is not a Prisma field, so it is a named op. */
  waAddresses(sql, a) {
    const { storeId, buyerKey } = a as Record<string, unknown>;
    if (typeof storeId !== 'string' || !storeId) throw procErr('storeId');
    if (typeof buyerKey !== 'string' || !/^[0-9a-f]{64}$/.test(buyerKey)) throw procErr('buyerKey');
    return sql
      .all(
        'SELECT a.id AS id, a.label AS label, a.area AS area, a.street AS street FROM customer_addresses a JOIN customers c ON c.id = a.customer_id WHERE c.store_id = ? AND c.buyer_key = ? ORDER BY a.created_at DESC, a.id LIMIT 10',
        [storeId, buyerKey]
      )
      .map(r => ({ id: r.id, label: r.label ?? null, area: r.area, street: r.street }));
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
  /**
   * Affiliate delete on a DO store (Ruling NZ-FEAT-1): the money check IS the delete. Only an affiliate that never earned,
   * holds nothing and was never paid (`total_paid` rises with every payout) is deleted; the FK cascade then removes its clicks
   * and events. A commission landing first makes this a no-op (0), never a lost balance. Returns rows deleted.
   */
  affiliateDeleteIfClean(sql, a) {
    const { id, storeId } = a as { id: unknown; storeId: unknown };
    if (typeof id !== 'string' || !id) throw procErr('id');
    if (typeof storeId !== 'string' || !storeId) throw procErr('storeId');
    sql.run(
      `DELETE FROM affiliates WHERE id = ? AND store_id = ? AND pending_balance = 0 AND total_earned = 0 AND total_paid = 0
         AND NOT EXISTS (SELECT 1 FROM affiliate_payouts p WHERE p.affiliate_id = affiliates.id)`,
      [id, storeId]
    );
    return sql.all('SELECT changes() AS n', [])[0]?.n ?? 0;
  },
  /**
   * The order link of a referral (Ruling NZ-FEAT-1): only a still-`clicked`, still-unlinked referral of this store becomes
   * `converted` for `orderId`. Returns rows changed (0 = someone else linked it first).
   */
  affiliateReferralLink(sql, a) {
    const { id, storeId, orderId, convertedAt } = a as Record<string, unknown>;
    if (typeof id !== 'string' || !id) throw procErr('id');
    if (typeof storeId !== 'string' || !storeId) throw procErr('storeId');
    if (typeof orderId !== 'string' || !orderId) throw procErr('orderId');
    if (typeof convertedAt !== 'number' || !Number.isFinite(convertedAt))
      throw procErr('convertedAt');
    sql.run(
      `UPDATE affiliate_referrals SET order_id = ?, status = 'converted', converted_at = ?
        WHERE id = ? AND store_id = ? AND status = 'clicked' AND order_id IS NULL`,
      [orderId, convertedAt, id, storeId]
    );
    return sql.all('SELECT changes() AS n', [])[0]?.n ?? 0;
  },
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
    const { productId, baseline, writes, extra, fillOnly } = a as {
      fillOnly?: unknown;
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
      // Fill-only (Ruling NEVER-OVERWRITE-1): same predicate as aiMayWriteOver in ai-autofill.service.ts.
      const cur = row[c];
      const blank = cur === null || cur === undefined || String(cur).trim() === '';
      const nm = String(row.name ?? '').trim();
      const placeholder = field === 'name' && nm !== '' && nm === String(row.name_ar ?? '').trim();
      if (sources[field] === 'human' || changed || (fillOnly !== false && !blank && !placeholder)) {
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
  /**
   * The role of the authenticated caller, set by the API Worker from the verified access token (never from a request body).
   * Only the tax-profile review guard reads it: the DO is reachable only through the API's service binding.
   */
  actorRole?: string;
}

/** The Postgres trigger `tax_profile_review_guard`, reproduced on the DO (Ruling NEON-ZERO-2). */
const TAX_REVIEW_STATUSES = new Set(['verified', 'rejected', 'revoked']);
const TAX_EDITABLE_STATUSES = new Set(['none', 'rejected', 'revoked']);
type TaxRow = {
  store_id: string;
  status: string;
  tax_registration_number: unknown;
  legal_name: unknown;
};
const taxState = (sql: SqlRunner) => ({
  profiles: new Map(
    (
      sql.all(
        'SELECT store_id, status, tax_registration_number, legal_name FROM store_tax_profiles',
        []
      ) as TaxRow[]
    ).map(r => [r.store_id, r])
  ),
  docs: (sql.all('SELECT id FROM store_tax_documents ORDER BY id', []) as Array<{ id: string }>)
    .map(r => r.id)
    .join(','),
});
/**
 * Compares the state before and after a batch that touched the VAT profile. Runs inside the batch's transaction, so a refusal
 * rolls everything back. By STATE DIFF, not by parsing the ops, so no nested write shape can step around it:
 *  - a move INTO verified / rejected / revoked, or an edit of a verified identity (TRN, legal name): super_admin only;
 *  - evidence documents added or removed while the profile is not editable (pending / verified): super_admin only.
 */
function assertTaxProfileGuard(
  sql: SqlRunner,
  before: ReturnType<typeof taxState>,
  actorRole: string | undefined
): void {
  if (actorRole === 'super_admin') return;
  const after = taxState(sql);
  for (const [storeId, now] of after.profiles) {
    const old = before.profiles.get(storeId);
    const oldStatus = old?.status ?? 'none';
    if (now.status !== oldStatus && TAX_REVIEW_STATUSES.has(now.status))
      throw new Error(`tax profile: only a super_admin may set status ${now.status}`);
    if (
      old &&
      old.status === 'verified' &&
      now.status === 'verified' &&
      (now.tax_registration_number !== old.tax_registration_number ||
        now.legal_name !== old.legal_name)
    )
      throw new Error('tax profile: a verified identity is changed only by a super_admin');
  }
  if (after.docs !== before.docs)
    for (const now of after.profiles.values())
      if (!TAX_EDITABLE_STATUSES.has(now.status))
        throw new Error(
          'tax profile: evidence of a pending or verified profile is changed only by a super_admin'
        );
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
  if (m.actorRole !== undefined && (typeof m.actorRole !== 'string' || m.actorRole.length > 32))
    return refuse('BAD_ACTOR', 'actorRole');
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
    // deleting an affiliate cascades its payouts, referrals and events (DO FKs), a warehouse its warehouse_stock: money / stock
    // history. Neither is deleted on the generic path; the affiliate goes through `affiliateDeleteIfClean` (Ruling NZ-FEAT-1).
    if (
      (q.model === 'Affiliate' || q.model === 'Warehouse') &&
      (q.op === 'delete' || q.op === 'deleteMany')
    )
      return refuse(
        'DELETE_REFUSED',
        `${q.model}.${String(q.op)} is not allowed on the generic write path`
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
      const taxBefore = m.ops.some(
        q => q.model === 'StoreTaxProfile' || q.model === 'StoreTaxDocument'
      )
        ? taxState(sql)
        : null;
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
      if (taxBefore) assertTaxProfileGuard(sql, taxBefore, m.actorRole);
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
