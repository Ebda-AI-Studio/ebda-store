import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { expectThrows, migrationFiles } from './helpers';

/**
 * Ruling BILL-NOTICE-1 (S2-13): on D1 a grace stage claim must not violate billing_reminders' CHECK, or the claim
 * (same transaction as the past_due decision) rolls the decision back and an unpaid store is never suspended.
 */
const files = migrationFiles('platform');
const M10 = files.find(f => f.endsWith('0010_billing_reminders_grace_kinds.sql'))!;
const OLD_CHECK = `CHECK ("kind" IN ('d7', 'd3', 'd1', 'd0', 'suspended'))`;
const NEW_CHECK_RE = /CHECK \("kind" IN \('d7', 'd3', 'd1', 'd0', 'suspended'[^)]*\)\)/;

/** Production's D1: 0001 as it was applied (old CHECK) and every migration before 0010. */
function production(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of files.filter(f => f < M10)) {
    let sql = fs.readFileSync(f, 'utf8');
    if (f.endsWith('0001_init.sql')) sql = sql.replace(NEW_CHECK_RE, OLD_CHECK);
    db.exec(sql);
  }
  db.exec(
    `INSERT INTO stores (id, name, slug, owner_id, template, status) VALUES ('s1','s1','s1','o','qamar','active')`
  );
  db.exec(
    `INSERT INTO plans (id, code, name_en, name_ar, limits) VALUES ('p1','growth','Growth','نمو','{}')`
  );
  return db;
}
const claim = (db: DatabaseSync, kind: string) =>
  db
    .prepare(
      `INSERT INTO billing_reminders (id, store_id, subscription_id, due_at, kind) VALUES (?, 's1', 'sub1', 1000, ?) ON CONFLICT DO NOTHING`
    )
    .run(`${kind}-${Math.random()}`, kind);

describe('D1 0010: billing_reminders accepts the grace stages (BILL-NOTICE-1)', () => {
  it('exists, after 0009', () => {
    expect(M10).toBeTruthy();
    expect(files.indexOf(M10)).toBe(files.length - 1);
  });

  it('production before 0010 REJECTS a grace stage (the defect: it rolls the past_due decision back)', () => {
    const db = production();
    expectThrows(() => claim(db, 'grace_start'), /CHECK constraint failed/);
    // the whole past_due transaction is undone with it
    db.exec(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status) VALUES ('sub1','s1','growth','active')`
    );
    db.exec('BEGIN');
    db.exec(`UPDATE store_subscriptions SET status = 'past_due' WHERE id = 'sub1'`);
    expectThrows(() => claim(db, 'grace_start'), /CHECK constraint failed/);
    db.exec('ROLLBACK');
    expect(db.prepare(`SELECT status FROM store_subscriptions WHERE id='sub1'`).get()).toEqual({
      status: 'active',
    });
  });

  it('after 0010 every stage claims once, a second claim is a no-op, and the past_due -> suspension path commits', () => {
    const db = production();
    claim(db, 'd7');
    db.exec(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status) VALUES ('sub1','s1','growth','active')`
    );
    db.exec(fs.readFileSync(M10, 'utf8'));
    expect(db.prepare(`SELECT count(*) AS n FROM billing_reminders`).get()).toEqual({ n: 1 });
    for (const kind of ['grace_start', 'grace_d1', 'suspended']) {
      expect(claim(db, kind).changes, kind).toBe(1);
      expect(claim(db, kind).changes, `${kind} again`).toBe(0);
    }
    db.exec('BEGIN');
    db.exec(`UPDATE store_subscriptions SET status = 'past_due' WHERE id = 'sub1'`);
    db.exec(`DELETE FROM billing_reminders WHERE kind = 'grace_start'`);
    expect(claim(db, 'grace_start').changes).toBe(1);
    db.exec('COMMIT');
    expect(db.prepare(`SELECT status FROM store_subscriptions WHERE id='sub1'`).get()).toEqual({
      status: 'past_due',
    });
    expectThrows(() => claim(db, 'bogus'), /CHECK constraint failed/);
  });

  it('is idempotent and keeps the unique + store indexes', () => {
    const db = production();
    db.exec(fs.readFileSync(M10, 'utf8'));
    db.exec(fs.readFileSync(M10, 'utf8'));
    const idx = (
      db.prepare(`PRAGMA index_list("billing_reminders")`).all() as { name: string }[]
    ).map(i => i.name);
    expect(idx).toContain('billing_reminders_subscription_id_due_at_kind_key');
    expect(idx).toContain('billing_reminders_store_id_idx');
  });
});
