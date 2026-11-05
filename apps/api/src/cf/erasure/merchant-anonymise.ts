/**
 * Merchant (store) erasure by ANONYMISATION, never a wipe (Rulings NZ-D16, RETENTION-1, RETENTION-2).
 *
 * PDPL erasure must remove personal data but the law (Egypt Law 206/2020 Art. 37, Law 17/1999 Art. 26; Law 151/2020 legal-obligation
 * exemption) requires invoices, VAT, payment and e-invoice records to be kept for RETENTION_YEARS. So one call, in ONE StoreDO
 * transaction with the money gate, does:
 *   ANONYMISE (irreversible, rows kept)  buyer name / phone / email / address on orders, returns, shipments, reviews, audit logs,
 *                                         carts, wallet / loyalty transactions, commerce outcomes (the registry's customer-pii `scrub`
 *                                         tables) and the merchant's own contact and actor-id columns (merchant-pii columns)
 *   DELETE now                            account, cart, consent and marketing data (the registry's customer-pii `delete` tables:
 *                                         customers, addresses, wishlists, subscriptions, consents, campaign recipients, ...)
 *   KEEP untouched                        fiscal_documents, eta_receipts and every table the registry does not classify as personal
 *                                         (orders' money, VAT and payment rows, payments, refunds, journals)
 * There is NO deleteAll anywhere in this path (tests/unit/merchant-erasure.test.ts pins it).
 */
import { GENERATED_MERCHANT_PII_PLAN } from './registry.generated';
import { STORE_DO_REGISTRY, type TableClass } from './registry';
import type { SqlExec } from './store-do-sql';

type Registry = Record<string, TableClass>;
type PiiClass = Extract<TableClass, { kind: 'customer-pii' }>;

/** store-do tables the classification calls merchant-pii, with the columns to anonymise (generated; `retain` tables excluded). */
export const merchantPiiPlan = (): Array<{ table: string; columns: string[] }> =>
  GENERATED_MERCHANT_PII_PLAN;

const tableExists = (sql: SqlExec, t: string): boolean =>
  sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t).toArray()
    .length > 0;

/** Column -> NOT NULL? for one table. */
function notNull(sql: SqlExec, table: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of sql.exec(`PRAGMA table_info("${table}")`).toArray())
    out.set(r.name as string, Number(r.notnull) === 1);
  return out;
}

/** Order: `via` tables first, `customers` last (children resolve their parent through it), the rest alphabetical. */
function customerTables(reg: Registry): Array<[string, PiiClass]> {
  const rank = (t: string, c: PiiClass) => (t === 'customers' ? 2 : c.via ? 0 : 1);
  return Object.entries(reg)
    .filter((e): e is [string, PiiClass] => e[1].kind === 'customer-pii')
    .sort((a, b) => rank(...a) - rank(...b) || (a[0] < b[0] ? -1 : 1));
}

export interface MerchantErasureResult {
  anonymised: Record<string, number>;
  deleted: Record<string, number>;
  /** Rows still present in a DELETE-class table afterwards (must be 0). */
  remaining: number;
}

/** Caller wraps this, the money gate and the close flag in ONE `transactionSync`. */
export function anonymiseMerchantRows(
  sql: SqlExec,
  requestId: string,
  reg: Registry = STORE_DO_REGISTRY,
  plan: Array<{ table: string; columns: string[] }> = merchantPiiPlan()
): MerchantErasureResult {
  const token = `erased:${requestId.slice(0, 8)}`;
  const anonymised: Record<string, number> = {};
  const deleted: Record<string, number> = {};
  const count = (t: string) => Number(sql.exec(`SELECT count(*) AS n FROM "${t}"`).toArray()[0].n);

  // commerce_outcomes is append-only; its trigger lets buyer_key -> NULL only while do_flags.erasure = 1 (0002_invariants.sql).
  const hasFlags = tableExists(sql, 'do_flags');
  const flag = (v: 0 | 1) =>
    hasFlags &&
    sql.exec(
      "INSERT INTO do_flags (name, value) VALUES ('erasure', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
      v
    );
  flag(1);

  // 1) buyer data: anonymise first (so FKs to customers are released), then delete the account / cart / consent / marketing tables.
  const tables = customerTables(reg);
  for (const [t, c] of tables) {
    if (c.action !== 'scrub' || !tableExists(sql, t)) continue;
    const cols = Object.entries(c.scrub ?? {});
    if (!cols.length) throw new Error(`${t}: scrub action without columns`);
    anonymised[t] = count(t);
    sql.exec(
      `UPDATE "${t}" SET ${cols.map(([k]) => `"${k}" = ?`).join(', ')}`,
      ...cols.map(([, v]) => v)
    );
  }
  for (const [t, c] of tables) {
    if (c.action !== 'delete' || !tableExists(sql, t)) continue;
    deleted[t] = count(t);
    sql.exec(`DELETE FROM "${t}"`);
  }
  flag(0);

  // 2) the merchant's own contact details and actor ids: anonymise in place (NULL where allowed, a per-request token where NOT NULL)
  for (const { table, columns } of plan) {
    if (!tableExists(sql, table)) continue;
    const nn = notNull(sql, table);
    const sets = columns.filter(c => nn.has(c)).map(c => `"${c}" = ${nn.get(c) ? '?' : 'NULL'}`);
    if (!sets.length) continue;
    const args = columns.filter(c => nn.get(c) === true).map(() => token);
    anonymised[table] = count(table);
    sql.exec(`UPDATE "${table}" SET ${sets.join(', ')}`, ...args);
  }

  const remaining = tables
    .filter(([t, c]) => c.action === 'delete' && tableExists(sql, t))
    .reduce((n, [t]) => n + count(t), 0);
  return { anonymised, deleted, remaining };
}

export interface MerchantEraseDeps {
  sql: SqlExec;
  /** The synchronous money / flag surface of the same DO (`SyncSql`). */
  sync: import('@ebda-src/repo').SyncSql;
  transactionSync: <T>(fn: () => T) => T;
  scrubReceipts: (orderIds: string[]) => void;
  moneyInFlight: (db: import('@ebda-src/repo').SyncSql) => Record<string, number>;
  closeStore: (db: import('@ebda-src/repo').SyncSql) => void;
}

/**
 * The whole merchant erasure as ONE atomic DO step (Ruling NZ-D17): the money gate, the receipt scrub, the close and the
 * anonymisation share a single `transactionSync`, so money cannot start between the gate and the anonymisation, and a failure
 * anywhere rolls ALL of it back.
 */
export function eraseMerchantAtomically(
  d: MerchantEraseDeps,
  requestId: string
):
  | { refused: Record<string, number>; erased: Record<string, number>; remaining: number }
  | { refused?: undefined; erased: Record<string, number>; remaining: number } {
  return d.transactionSync(() => {
    const gate = d.moneyInFlight(d.sync);
    const inFlight = Object.values(gate).reduce((a, b) => a + b, 0);
    if (inFlight > 0) return { refused: gate, erased: {}, remaining: inFlight };
    d.scrubReceipts(
      d.sql
        .exec('SELECT id FROM orders')
        .toArray()
        .map(r => r.id as string)
    );
    d.closeStore(d.sync);
    const r = anonymiseMerchantRows(d.sql, requestId);
    return { erased: { ...r.anonymised, ...r.deleted }, remaining: r.remaining };
  });
}
