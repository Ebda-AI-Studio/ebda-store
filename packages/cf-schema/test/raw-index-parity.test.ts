// Every raw Postgres unique/partial/expression index that was translated must keep its definition:
// same table, same uniqueness, same column list, equivalent WHERE. Regression for the bare-identifier
// rewrite that turned `(shipment_id)` into `(shipment_id = 1)`.
import { describe, expect, it } from 'vitest';
import { expectThrows, openDb, readJson } from './helpers';

type T = {
  name: string;
  table: string;
  db: 'store-do' | 'd1';
  unique: boolean;
  pgCols: string;
  pgWhere: string | null;
};
const manifest = readJson<{
  translatedIndexes: T[];
  rawInvariants: { kind: string; disposition: string }[];
}>('generated/manifest.json');
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/"/g, '')
    .replace(/\s+/g, '')
    .replace(/=true\b/g, '=1')
    .replace(/=false\b/g, '=0')
    .replace(/::\w+/g, '');
const dbs = { 'store-do': openDb('store'), d1: openDb('platform') };

describe('translated raw indexes match their Postgres originals', () => {
  it('count: one per placed raw index', () => {
    const placed = manifest.rawInvariants.filter(
      r => r.kind === 'index' && /^(store-do|d1):/.test(r.disposition)
    ).length;
    expect(manifest.translatedIndexes.length).toBe(placed);
    expect(placed).toBeGreaterThan(15);
  });

  for (const ix of manifest.translatedIndexes) {
    it(`${ix.db}.${ix.name}`, () => {
      const db = dbs[ix.db];
      const row = db
        .prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(ix.name) as { tbl_name: string; sql: string } | undefined;
      expect(row, 'index exists').toBeTruthy();
      expect(row!.tbl_name).toBe(ix.table);
      expect(/^CREATE UNIQUE/i.test(row!.sql)).toBe(ix.unique);
      const sql = row!.sql;
      const open = sql.indexOf('(', sql.indexOf(' ON '));
      let depth = 0;
      let close = open;
      for (let i = open; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        if (sql[i] === ')' && --depth === 0) {
          close = i;
          break;
        }
      }
      const m = [
        sql,
        sql.slice(open + 1, close),
        sql.slice(close + 1).replace(/^\s*WHERE\s+/, '') || undefined,
      ] as const;
      const pgCols = norm(ix.pgCols).replace(/public\./g, '');
      const sqCols = norm(m[1]);
      if (/^[a-z0-9_,]+$/.test(pgCols)) expect(sqCols).toBe(pgCols); // plain column list: identical, never rewritten
      expect(
        /=1\b/.test(sqCols) && !/=1\b/.test(pgCols),
        'no boolean rewrite inside the column list'
      ).toBe(false);
      const pgWhere = ix.pgWhere ? norm(ix.pgWhere) : null;
      expect(!!m[2]).toBe(!!pgWhere);
      if (
        pgWhere &&
        /^[a-z0-9_]+(isnull|isnotnull|=\d+|=')/.test(pgWhere) &&
        !/[~(#]/.test(pgWhere)
      )
        expect(norm(m[2]!)).toBe(pgWhere);
      if (ix.pgWhere && /^"?\w+"?$/.test(ix.pgWhere.trim()))
        expect(norm(m[2]!)).toBe(`${pgWhere}=1`);
    });
  }
});

describe('partial unique behaviour', () => {
  const db = dbs['store-do'];
  db.exec('PRAGMA foreign_keys = OFF');
  const pk = (id: string, shipment: string, status: string) =>
    db
      .prepare(
        `INSERT INTO shipment_pickups (id, store_id, shipment_id, carrier, pickup_date, address, idempotency_key, status) VALUES (?, 's1', ?, 'bosta', '2026-10-30', '{}', ?, ?)`
      )
      .run(id, shipment, `key-${id}-xxxx`, status);

  it('two different shipments may each hold an active pickup', () => {
    pk('p1', 'shipA', 'requested');
    pk('p2', 'shipB', 'requesting');
  });
  it('a second active pickup for the SAME shipment is refused; a failed one may be re-requested', () => {
    expectThrows(() => pk('p3', 'shipA', 'requesting'), /UNIQUE/);
    pk('p4', 'shipA', 'failed');
    pk('p5', 'shipA', 'cancelled');
  });
  it('one default customer group per store only', () => {
    const g = db.prepare(
      `INSERT INTO customer_groups (id, store_id, name, is_default) VALUES (?, ?, ?, ?)`
    );
    g.run('g1', 'sA', 'g1', 1);
    g.run('g2', 'sB', 'g2', 1);
    g.run('g3', 'sA', 'g3', 0);
    expectThrows(() => g.run('g4', 'sA', 'g4', 1), /UNIQUE/);
  });
});
