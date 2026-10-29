/** Registry-driven export/erase over DO SQLite. Pure over a structural `sql`, so it unit-tests anywhere. */
import { STORE_DO_REGISTRY, type TableClass } from './registry';
import type { CustomerSubject } from './types';

export interface SqlExec {
  exec(q: string, ...b: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

type PiiClass = Extract<TableClass, { kind: 'customer-pii' }>;

type Clause = { clause: string; args: unknown[] };

/**
 * The WHERE that finds a subject in one table, or null when the subject carries nothing this table can be matched on.
 * `customerId` is matched through the customers rows the subject resolves to (email / phone / user / buyer key), and a
 * `via` table through its parent's match, so a child never needs a copy of the subject's identifiers.
 */
function where(reg: Registry, table: string, s: CustomerSubject, depth = 0): Clause | null {
  const c = reg[table];
  if (!c || c.kind !== 'customer-pii' || depth > 2) return null;
  const parts: string[] = [];
  const args: unknown[] = [];
  const direct: Array<[string | undefined, string | undefined]> = [
    [c.match.buyerKey, s.buyerKey],
    [c.match.email, s.email?.trim().toLowerCase()],
    [c.match.phone, s.phoneE164],
    [c.match.userId, s.userId],
  ];
  for (const [col, val] of direct)
    if (col && val) {
      parts.push(`${col} = ?`);
      args.push(val);
    }
  if (c.match.customerId) {
    const sub = where(reg, 'customers', s, depth + 1);
    if (sub) {
      parts.push(`${c.match.customerId} IN (SELECT id FROM customers WHERE ${sub.clause})`);
      args.push(...sub.args);
    }
  }
  if (c.via) {
    const sub = where(reg, c.via.table, s, depth + 1);
    if (sub) {
      parts.push(`${c.via.column} IN (SELECT id FROM ${c.via.table} WHERE ${sub.clause})`);
      args.push(...sub.args);
    }
  }
  return parts.length ? { clause: parts.join(' OR '), args } : null;
}

type Registry = Record<string, TableClass>;

/**
 * Erase order matters: a `via` table is handled BEFORE its parent (the parent's scrub would hide the subject from it)
 * and `customers` LAST (every `customerId` child resolves the subject through it).
 */
function piiTables(reg: Registry): Array<[string, PiiClass]> {
  const rank = (t: string, c: PiiClass) => (t === 'customers' ? 2 : c.via ? 0 : 1);
  return Object.entries(reg)
    .filter((e): e is [string, PiiClass] => e[1].kind === 'customer-pii')
    .sort((a, b) => rank(...a) - rank(...b) || (a[0] < b[0] ? -1 : 1));
}

/** The ids of the rows of `table` that match the subject (same WHERE as the erase), e.g. the subject's orders. */
export function matchedIds(
  sql: SqlExec,
  table: string,
  s: CustomerSubject,
  reg: Registry = STORE_DO_REGISTRY
): string[] {
  const w = where(reg, table, s);
  return w
    ? sql
        .exec(`SELECT id FROM ${table} WHERE ${w.clause}`, ...w.args)
        .toArray()
        .map(r => r.id as string)
    : [];
}

export function exportCustomerRows(
  sql: SqlExec,
  s: CustomerSubject,
  reg: Registry = STORE_DO_REGISTRY
) {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const [t, c] of piiTables(reg)) {
    const w = where(reg, t, s);
    tables[t] = w ? sql.exec(`SELECT * FROM ${t} WHERE ${w.clause}`, ...w.args).toArray() : [];
  }
  return tables;
}

export function countCustomerRows(
  sql: SqlExec,
  s: CustomerSubject,
  reg: Registry = STORE_DO_REGISTRY
): number {
  let n = 0;
  for (const [t, c] of piiTables(reg)) {
    const w = where(reg, t, s);
    if (w)
      n += sql.exec(`SELECT count(*) AS n FROM ${t} WHERE ${w.clause}`, ...w.args).toArray()[0]
        .n as number;
  }
  return n;
}

/** Caller wraps in transactionSync. Returns rows affected per table. */
export function eraseCustomerRows(
  sql: SqlExec,
  s: CustomerSubject,
  reg: Registry = STORE_DO_REGISTRY
): Record<string, number> {
  const out: Record<string, number> = {};
  // commerce_outcomes is append-only; its trigger lets buyer_key -> NULL only while do_flags.erasure = 1 (0002_invariants.sql).
  // The flag is raised for this erase and lowered after it (the caller's transactionSync also rolls it back on failure).
  const hasFlags =
    sql
      .exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'do_flags'")
      .toArray().length > 0;
  const flag = (v: 0 | 1) =>
    hasFlags &&
    sql.exec(
      "INSERT INTO do_flags (name, value) VALUES ('erasure', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
      v
    );
  flag(1);
  for (const [t, c] of piiTables(reg)) {
    const w = where(reg, t, s);
    if (!w) continue;
    const n = sql.exec(`SELECT count(*) AS n FROM ${t} WHERE ${w.clause}`, ...w.args).toArray()[0]
      .n as number;
    if (c.action === 'delete') sql.exec(`DELETE FROM ${t} WHERE ${w.clause}`, ...w.args);
    else {
      const cols = Object.entries(c.scrub ?? {});
      if (!cols.length) throw new Error(`${t}: scrub action without columns`);
      // Scrub the identifying columns themselves too, or the row would still match (and still identify).
      sql.exec(
        `UPDATE ${t} SET ${cols.map(([k]) => `${k} = ?`).join(', ')} WHERE ${w.clause}`,
        ...cols.map(([, v]) => v),
        ...w.args
      );
    }
    out[t] = n;
  }
  flag(0);
  return out;
}
