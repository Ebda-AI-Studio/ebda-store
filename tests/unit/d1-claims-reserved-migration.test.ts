/**
 * Ruling AI-OVERSELL-1: D1 platform migration 0016 rebuilds manual_payment_claims so status may be 'reserved'. A table
 * rebuild on a live money table must lose nothing: same rows, same money, every index back, old statuses still valid.
 * The "before" table is the PRODUCTION definition (sqlite_master, 2026-11-17).
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const read = (f: string) =>
  fs.readFileSync(
    new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
    'utf8'
  );
const PROD_TABLE = `CREATE TABLE "manual_payment_claims" (
  "id" TEXT NOT NULL, "store_id" TEXT NOT NULL, "subscription_id" TEXT, "plan_code" TEXT NOT NULL,
  "billing_interval" TEXT NOT NULL, "amount_minor" INTEGER NOT NULL, "method" TEXT NOT NULL DEFAULT 'instapay',
  "payment_reference" TEXT NOT NULL, "payer_reference" TEXT NOT NULL, "proof_url" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending', "review_note" TEXT, "reviewed_by" TEXT, "reviewed_at" INTEGER,
  "billing_event_id" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  "updated_at" INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT "manual_payment_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manual_payment_claims_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "manual_payment_claims_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "manual_payment_claims_status_check" CHECK ("status" IN ('pending', 'confirmed', 'rejected')),
  CONSTRAINT "manual_payment_claims_method_check" CHECK ("method" IN ('instapay', 'bank', 'cash'))
);
CREATE UNIQUE INDEX "manual_payment_claims_method_payer_reference_key" ON "manual_payment_claims" ("method", "payer_reference");
CREATE INDEX "manual_payment_claims_store_id_created_at_idx" ON "manual_payment_claims" ("store_id", "created_at" DESC);
CREATE INDEX "manual_payment_claims_status_idx" ON "manual_payment_claims" ("status");`;

function prodLike() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(read('0001_init.sql'));
  db.exec('DROP TABLE "manual_payment_claims"');
  db.exec(PROD_TABLE);
  for (const id of ['s1', 's2'])
    db.prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, ?, ?, 'o')`).run(
      id,
      id,
      id
    );
  const ins = db.prepare(
    `INSERT INTO manual_payment_claims (id, store_id, subscription_id, plan_code, billing_interval, amount_minor, method, payment_reference, payer_reference, proof_url, status, review_note, reviewed_by, reviewed_at, billing_event_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run(
    'c1',
    's1',
    'sub1',
    'growth',
    'monthly',
    349000,
    'instapay',
    'EBD-A',
    '111',
    'r2/x',
    'pending',
    null,
    null,
    null,
    null,
    1,
    2
  );
  ins.run(
    'c2',
    's1',
    null,
    'basic',
    'yearly',
    1490000,
    'bank',
    'EBD-A',
    'b-22',
    null,
    'confirmed',
    'ok',
    'admin',
    3,
    'ev1',
    4,
    5
  );
  ins.run(
    'c3',
    's2',
    null,
    'addon:feature:loyalty',
    'monthly',
    24900,
    'cash',
    'EBD-B',
    'c-3',
    null,
    'rejected',
    'bad',
    'admin',
    6,
    null,
    7,
    8
  );
  return db;
}
const snapshot = (db: DatabaseSync) => ({
  rows: db.prepare('SELECT COUNT(*) n, SUM(amount_minor) money FROM manual_payment_claims').get(),
  all: db.prepare('SELECT * FROM manual_payment_claims ORDER BY id').all(),
});
const indexes = (db: DatabaseSync) =>
  (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'manual_payment_claims' AND sql IS NOT NULL ORDER BY name"
      )
      .all() as Array<{ name: string; sql: string }>
  ).map(r => ({ name: r.name, sql: r.sql.replace(/\s+/g, ' ') }));

describe('D1 0016: manual_payment_claims accepts status reserved, losing nothing', () => {
  it('rows, money and every column are identical before and after; every index is back', () => {
    const db = prodLike();
    const before = snapshot(db);
    const idxBefore = indexes(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO manual_payment_claims (id, store_id, plan_code, billing_interval, amount_minor, payment_reference, payer_reference, status) VALUES ('x', 's1', 'g', 'monthly', 1, 'r', 'p', 'reserved')`
        )
        .run()
    ).toThrow(/CHECK/);
    db.exec(read('0016_claims_reserved_status.sql'));
    expect(snapshot(db)).toEqual(before);
    expect(indexes(db)).toEqual(idxBefore);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const fk = db.prepare("PRAGMA foreign_key_list('manual_payment_claims')").all() as Array<{
      table: string;
      on_delete: string;
    }>;
    expect(fk).toMatchObject([{ table: 'stores', on_delete: 'CASCADE' }]);
  });

  it("the old statuses still pass, 'reserved' is now allowed, anything else is still refused", () => {
    const db = prodLike();
    db.exec(read('0016_claims_reserved_status.sql'));
    const add = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO manual_payment_claims (id, store_id, plan_code, billing_interval, amount_minor, payment_reference, payer_reference, status) VALUES (?, 's1', 'g', 'monthly', 1, 'r', ?, ?)`
        )
        .run(id, `p-${id}`, status);
    for (const s of ['pending', 'confirmed', 'rejected', 'reserved'])
      expect(() => add(`ok-${s}`, s)).not.toThrow();
    expect(() => add('bad', 'approved')).toThrow(/CHECK/);
    // the unique method+payer_reference key still holds
    expect(() => add('dup', 'pending') && add('dup2', 'pending')).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO manual_payment_claims (id, store_id, plan_code, billing_interval, amount_minor, payment_reference, payer_reference) VALUES ('d', 's1', 'g', 'monthly', 1, 'r', '111')`
        )
        .run()
    ).toThrow(/UNIQUE/);
    // the store FK still cascades
    db.prepare("DELETE FROM stores WHERE id = 's2'").run();
    expect(
      db.prepare("SELECT COUNT(*) n FROM manual_payment_claims WHERE store_id = 's2'").get()
    ).toEqual({ n: 0 });
  });

  it('a fresh D1 (0001 alone) already has the new CHECK', () => {
    expect(read('0001_init.sql')).toMatch(
      /"manual_payment_claims_status_check" CHECK \("status" IN \('pending', 'confirmed', 'rejected', 'reserved'\)\)/
    );
  });
});
