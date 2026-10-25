/** Registry-driven export/erase over DO SQLite. Pure over a structural `sql`, so it unit-tests anywhere. */
import { STORE_DO_REGISTRY, type TableClass } from './registry';
import type { CustomerSubject } from './types';

export interface SqlExec {
  exec(q: string, ...b: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

type PiiClass = Extract<TableClass, { kind: 'customer-pii' }>;

function where(c: PiiClass, s: CustomerSubject): { clause: string; args: unknown[] } | null {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [c.match.buyerKey, s.buyerKey],
    [c.match.email, s.email?.trim().toLowerCase()],
    [c.match.phone, s.phoneE164],
    [c.match.userId, s.userId],
  ];
  const used = pairs.filter(([col, val]) => col && val) as Array<[string, string]>;
  if (!used.length) return null;
  return { clause: used.map(([col]) => `${col} = ?`).join(' OR '), args: used.map(([, v]) => v) };
}

type Registry = Record<string, TableClass>;

const piiTables = (reg: Registry): Array<[string, PiiClass]> =>
  Object.entries(reg).filter((e): e is [string, PiiClass] => e[1].kind === 'customer-pii');

export function exportCustomerRows(
  sql: SqlExec,
  s: CustomerSubject,
  reg: Registry = STORE_DO_REGISTRY
) {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const [t, c] of piiTables(reg)) {
    const w = where(c, s);
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
    const w = where(c, s);
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
  for (const [t, c] of piiTables(reg)) {
    const w = where(c, s);
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
  return out;
}
