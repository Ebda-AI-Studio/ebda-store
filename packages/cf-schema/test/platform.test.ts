// Task 1.2: the D1 platform schema.
import { describe, expect, it } from 'vitest';
import { expectThrows, openDb, readJson, tableNames } from './helpers';

type Manifest = {
  databases: Record<string, { tables: number; columnCounts: Record<string, number> }>;
};
const manifest = readJson<Manifest>('generated/manifest.json');

describe('D1 platform schema', () => {
  const db = openDb('platform', 2);

  it('creates the manifest tables only: 23 models + entity_index + platform_audit_log, no identity table', () => {
    expect(tableNames(db)).toEqual(Object.keys(manifest.databases.d1.columnCounts).sort());
    expect(tableNames(db).length).toBe(25);
    for (const t of ['users', 'refresh_tokens', 'verification_tokens', 'passkey_credentials'])
      expect(tableNames(db)).not.toContain(t);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('stores.storage_backend defaults to pg and only accepts pg or do (backend selector, task 2.4)', () => {
    const cols = db.prepare(`PRAGMA table_info("stores")`).all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const c = cols.find(x => x.name === 'storage_backend');
    expect(c).toMatchObject({ notnull: 1, dflt_value: "'pg'" });
    const cmd = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'stores'`).get() as {
      sql: string;
    };
    expect(cmd.sql).toContain(`CHECK ("storage_backend" IN ('pg', 'do'))`);
  });

  it('has the directory keys: unique stores.slug and stores.domain, slug_redirects, entity_index(kind,id)', () => {
    const idx = (t: string) =>
      (db.prepare(`PRAGMA index_list("${t}")`).all() as { name: string; unique: number }[]).filter(
        i => i.unique
      );
    expect(idx('stores').length).toBeGreaterThanOrEqual(2);
    db.prepare(`INSERT INTO entity_index (kind, id, store_id) VALUES ('order', 'o1', 's1')`).run();
    expectThrows(
      () =>
        db
          .prepare(`INSERT INTO entity_index (kind, id, store_id) VALUES ('order', 'o1', 's2')`)
          .run(),
      /UNIQUE|PRIMARY/
    );
    expectThrows(
      () =>
        db
          .prepare(`INSERT INTO entity_index (kind, id, store_id) VALUES ('bogus', 'o2', 's2')`)
          .run(),
      /CHECK/
    );
  });

  describe('billing_events is append-only (section 2.6)', () => {
    const store = () =>
      db
        .prepare(
          `INSERT OR IGNORE INTO stores (id, name, slug, owner_id, status, plan, currency, timezone, template, is_demo) VALUES ('sb', 'n', 'sb', 'o', 'active', 'free', 'EGP', 'Africa/Cairo', 'qamar', 0)`
        )
        .run();
    const ev = (id: string, status = 'pending') =>
      db
        .prepare(
          `INSERT INTO billing_events (id, store_id, type, amount_minor, provider, idempotency_key, status) VALUES (?, 'sb', 'checkout', 5000, 'kashier', ?, ?)`
        )
        .run(id, `k-${id}`, status);

    it('refuses a direct delete, refuses changing money columns, lets pending settle, makes succeeded final', () => {
      store();
      ev('e1');
      expectThrows(
        () => db.prepare(`DELETE FROM billing_events WHERE id = 'e1'`).run(),
        /append-only/
      );
      expectThrows(
        () => db.prepare(`UPDATE billing_events SET amount_minor = 1 WHERE id = 'e1'`).run(),
        /append-only/
      );
      db.prepare(`UPDATE billing_events SET status = 'succeeded' WHERE id = 'e1'`).run();
      expectThrows(
        () => db.prepare(`UPDATE billing_events SET status = 'failed' WHERE id = 'e1'`).run(),
        /succeeded charge/
      );
      db.prepare(`UPDATE billing_events SET status = 'refunded' WHERE id = 'e1'`).run();
      expectThrows(
        () => db.prepare(`UPDATE billing_events SET status = 'succeeded' WHERE id = 'e1'`).run(),
        /refunded charge/
      );
    });

    it('still lets the store-delete cascade remove its events', () => {
      store();
      ev('e2');
      db.prepare(`DELETE FROM stores WHERE id = 'sb'`).run();
      expect(
        db.prepare(`SELECT count(*) c FROM billing_events WHERE store_id = 'sb'`).get()
      ).toEqual({ c: 0 });
    });
  });
});
