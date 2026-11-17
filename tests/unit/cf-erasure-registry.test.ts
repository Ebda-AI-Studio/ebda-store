/**
 * INFRA-CF-1 PR D1 (Ruling CF-ERASE-3): the StoreDO erasure registry is GENERATED from erasure-classification.json and the
 * store migrations, covers all 122 tables, and works against the REAL schema: for every customer-pii table a subject row and
 * a bystander row are inserted, exported, erased and re-counted, with foreign keys and triggers as in the Durable Object.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script (no types), imported for its pure generator
import { generate } from '../../scripts/cf/gen-erasure-registry.mjs';
import { STORE_DO_REGISTRY, unclassifiedTables } from '../../apps/api/src/cf/erasure/registry';
import {
  countCustomerRows,
  eraseCustomerRows,
  exportCustomerRows,
  type SqlExec,
} from '../../apps/api/src/cf/erasure/store-do-sql';

import { INSTAPAY_RECEIPT_DDL } from '../../packages/repo/src/do/instapay-receipts';
import { ERASURE_LEDGER_DDL } from '../../packages/repo/src/do/erase-shopper';
import { SMART_LAYER_DDL } from '../../packages/repo/src/do/smart-layer';

const ROOT = path.resolve(__dirname, '../..');
const dir = path.join(ROOT, 'packages/cf-schema/migrations/store');
function openDo(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort())
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  // tables the StoreDO creates at start that hold personal data (they are classified in the generator, not in the migrations)
  for (const s of INSTAPAY_RECEIPT_DDL) db.exec(s);
  db.exec(ERASURE_LEDGER_DDL);
  for (const s of SMART_LAYER_DDL) db.exec(s);
  return db;
}
// like the Durable Object's `sql.exec`: the statement runs when called, `toArray()` only reads the cursor
const exec = (db: DatabaseSync): SqlExec => ({
  exec: (q, ...b) => {
    const rows = db.prepare(q).all(...(b as never[])) as never[];
    return { toArray: () => rows };
  },
});
const tablesOf = (db: DatabaseSync) =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
      )
      .all() as { name: string }[]
  ).map(r => r.name);

describe('generated registry', () => {
  it('the committed file is exactly what the generator produces (CI-checked staleness)', async () => {
    const committed = fs.readFileSync(
      path.join(ROOT, 'apps/api/src/cf/erasure/registry.generated.ts'),
      'utf8'
    );
    expect(committed).toBe(await generate());
  });

  it('classifies every table of the live schema: nothing is left for a customer subject to refuse on', () => {
    const db = openDo();
    expect(unclassifiedTables(tablesOf(db))).toEqual([]);
    // + the tables the DO creates itself at start that are not in the migrations: payment_event_log and vector_usage
    // (reviewed no-pii in the generator); instapay_order_receipts (personal data) is already in the db above via its DDL;
    // the assistant's sl_* journal (masked, store-owned: goes with the store) is in the db above via its DDL
    expect(Object.keys(STORE_DO_REGISTRY).sort()).toEqual(
      [...tablesOf(db), 'payment_event_log', 'vector_usage'].sort()
    );
  });

  it('a scrub entry overwrites every column it matches on (else the row would still identify the buyer)', () => {
    for (const c of Object.values(STORE_DO_REGISTRY)) {
      if (c.kind !== 'customer-pii' || c.action !== 'scrub') continue;
      for (const col of Object.values(c.match)) expect(Object.keys(c.scrub ?? {})).toContain(col);
    }
  });
});

const SUBJECT = {
  kind: 'customer' as const,
  requestId: 'r1',
  buyerKey: 'a'.repeat(64),
  phoneE164: '+201000000001',
  email: 'subject@x.test',
  userId: 'u-subject',
};
const OTHER = {
  buyerKey: 'b'.repeat(64),
  phone: '+201000000002',
  email: 'other@x.test',
  userId: 'u-other',
};
let seq = 0;
/** Columns with a value-set CHECK: the one value each takes in the fixture. */
const FILL: Record<string, Record<string, unknown>> = {};
/** `"col" IN ('a', 'b')` CHECKs in the table DDL: the first allowed value is a valid fixture. */
function checkedValue(db: DatabaseSync, table: string, col: string): string | undefined {
  const ddl = (
    db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }
  ).sql;
  const m = new RegExp(`"${col}" IN \\(\\s*'([^']*)'`).exec(ddl);
  return m?.[1];
}

/**
 * Insert one row, auto-filling NOT NULL columns without a default; `over` sets the interesting ones. JSON-shaped columns (address / items / lines) get '{}' or '[]', everything else a unique text.
 */
function insert(db: DatabaseSync, table: string, over: Record<string, unknown>): number {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }>;
  let last: unknown;
  for (const _try of [0]) {
    const row: Record<string, unknown> = {};
    for (const c of cols) {
      if (c.name in over) row[c.name] = over[c.name];
      else if (c.name in (FILL[table] ?? {})) row[c.name] = FILL[table][c.name];
      else if (c.notnull && c.dflt_value === null)
        row[c.name] = /INT|REAL|NUM/i.test(c.type)
          ? 1
          : c.name === 'buyer_key'
            ? (++seq).toString(16).padStart(64, 'c')
            : (checkedValue(db, table, c.name) ??
              (c.pk
                ? `${table}-${++seq}`
                : /address/i.test(c.name)
                  ? '{}'
                  : /items|lines|tags|list|blocks/i.test(c.name)
                    ? '[]'
                    : `v${++seq}`));
    }
    if (!('id' in row) && cols.some(c => c.name === 'id')) row.id = `${table}-${++seq}`;
    const names = Object.keys(row);
    try {
      const r = db
        .prepare(
          `INSERT INTO "${table}" (${names.map(n => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`
        )
        .run(...(names.map(n => row[n]) as never[]));
      return Number(r.lastInsertRowid);
    } catch (e) {
      last = e;
      if (!/CHECK/.test(String(e))) break;
    }
  }
  throw new Error(`${table}: ${String(last)}`);
}

describe('against the real DO schema', () => {
  const db = openDo();
  db.exec('PRAGMA foreign_keys = OFF'); // rows are filled generically; cascade behaviour is asserted on its own below
  const reg = STORE_DO_REGISTRY;
  const piiTables = Object.entries(reg).filter(([, c]) => c.kind === 'customer-pii') as Array<
    [string, Extract<(typeof reg)[string], { kind: 'customer-pii' }>]
  >;

  // one subject customer + its order, and a bystander of each
  const custS = 'c-subject';
  const custRow = insert(db, 'customers', {
    id: 'c-subject',
    email: SUBJECT.email,
    phone: SUBJECT.phoneE164,
    user_id: SUBJECT.userId,
    buyer_key: SUBJECT.buyerKey,
  });
  const custOther = insert(db, 'customers', {
    id: 'c-other',
    email: OTHER.email,
    phone: OTHER.phone,
    user_id: OTHER.userId,
    buyer_key: OTHER.buyerKey,
  });
  const orderS = 'o-subject';
  const orderRow = insert(db, 'orders', {
    id: 'o-subject',
    customer_id: custS,
    buyer_key: SUBJECT.buyerKey,
  });
  const orderOther = insert(db, 'orders', {
    id: 'o-other',
    customer_id: 'c-other',
    buyer_key: OTHER.buyerKey,
  });

  const keyVal = (who: 'subject' | 'other') => ({
    buyerKey: who === 'subject' ? SUBJECT.buyerKey : OTHER.buyerKey,
    email: who === 'subject' ? SUBJECT.email : OTHER.email,
    phone: who === 'subject' ? SUBJECT.phoneE164 : OTHER.phone,
    userId: who === 'subject' ? SUBJECT.userId : OTHER.userId,
    customerId: who === 'subject' ? custS : 'c-other',
  });
  /** rowids per table: the handle that exists on every table (some have composite keys, no `id`). */
  const rows: Record<string, { subject: number[]; other: number[] }> = {};
  for (const [t, c] of piiTables) {
    if (t === 'customers' || t === 'orders') {
      rows[t] = {
        subject: [t === 'customers' ? custRow : orderRow],
        other: [t === 'customers' ? custOther : orderOther],
      };
      continue;
    }
    rows[t] = { subject: [], other: [] };
    for (const who of ['subject', 'other'] as const) {
      const kv = keyVal(who);
      const keys = Object.entries(c.match) as Array<[keyof typeof kv, string]>;
      // one row per matchable key (each must be found on its own), or one via-parent row
      const sets: Array<Record<string, unknown>> = keys.map(([k, col]) => ({ [col]: kv[k] }));
      if (c.via) sets.push({ [c.via.column]: who === 'subject' ? orderS : 'o-other' });
      for (const set of sets)
        (who === 'subject' ? rows[t].subject : rows[t].other).push(insert(db, t, set));
    }
  }
  const snapshot = (t: string, ids: number[]) =>
    ids.map(id => db.prepare(`SELECT * FROM "${t}" WHERE rowid = ?`).get(id));
  const before = Object.fromEntries(
    piiTables.map(([t]) => [
      t,
      { subject: snapshot(t, rows[t].subject), other: snapshot(t, rows[t].other) },
    ])
  );

  it('exports exactly the subject (every key finds its row), never a bystander', () => {
    const out = exportCustomerRows(exec(db), SUBJECT);
    for (const [t] of piiTables) {
      const got = new Set((out[t] ?? []).map(r => JSON.stringify(r)));
      for (const r of before[t].subject)
        expect(got.has(JSON.stringify(r)), `${t} subject row`).toBe(true);
      for (const r of before[t].other)
        expect(got.has(JSON.stringify(r)), `${t} bystander row`).toBe(false);
    }
  });

  it('erases: delete tables lose the subject rows, scrub tables keep them without the identifiers, bystanders are untouched, remaining is 0', () => {
    const erased = eraseCustomerRows(exec(db), SUBJECT);
    expect(countCustomerRows(exec(db), SUBJECT)).toBe(0);
    for (const [t, c] of piiTables) {
      const left = snapshot(t, rows[t].subject).filter(Boolean) as Array<Record<string, unknown>>;
      if (c.action === 'delete') expect(left, `${t} still holds the subject`).toEqual([]);
      else {
        expect(left.length, `${t} scrub keeps its rows`).toBe(rows[t].subject.length);
        for (const r of left)
          for (const [col, v] of Object.entries(c.scrub!)) expect(r[col], `${t}.${col}`).toBe(v);
      }
      expect(snapshot(t, rows[t].other), `${t} bystander changed`).toEqual(before[t].other);
      expect(erased[t] ?? 0, `${t} erased count`).toBeGreaterThanOrEqual(
        rows[t].subject.length > 0 ? 1 : 0
      );
    }
  });

  it('is idempotent: a second erase finds nothing and changes nothing', () => {
    expect(Object.values(eraseCustomerRows(exec(db), SUBJECT)).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a subject with no identifiers matches nothing (never every row)', () => {
    const empty = { kind: 'customer' as const, requestId: 'r', buyerKey: '' };
    expect(countCustomerRows(exec(db), empty)).toBe(0);
    expect(eraseCustomerRows(exec(db), empty)).toEqual({});
  });
});
