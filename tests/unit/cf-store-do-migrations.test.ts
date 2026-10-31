// INFRA-CF-1 PR C: the StoreDO schema runner (apps/api/src/cf/store-do/migrations.ts) on node:sqlite, so the upgrade path
// of a Phase 0 spike DO and the failure atomicity are covered without workerd. The real-DO run is
// apps/api/workers-do/store-do-schema.test.ts.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CORE_0001,
  MIGRATIONS,
  SCHEMA_VERSION,
  SPIKE_CORE_ID,
  runMigrations,
  type MigrationStorage,
} from '../../apps/api/src/cf/store-do/migrations';

function storage(db: DatabaseSync, failOn?: (q: string) => boolean): MigrationStorage {
  return {
    sql: {
      exec(q: string, ...b: unknown[]) {
        if (failOn?.(q)) throw new Error('boom');
        const rows = db.prepare(q).all(...(b as never[])) as Array<Record<string, unknown>>;
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
const tables = (db: DatabaseSync) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map(r => r.name);
const applied = (db: DatabaseSync) =>
  (db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map(r => r.id);

describe('StoreDO migrations', () => {
  it('a fresh database gets the full schema, every step recorded once, and a second run is a no-op', () => {
    const db = new DatabaseSync(':memory:');
    const s = storage(db);
    expect(runMigrations(s)).toEqual(MIGRATIONS.map(m => m.id));
    expect(tables(db).length).toBeGreaterThan(120);
    expect(applied(db)).toEqual(MIGRATIONS.map(m => m.id).sort());
    expect(SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].id);
    const snapshot = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    expect(runMigrations(s)).toEqual([]);
    expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      snapshot
    );
  });

  it('a Phase 0 spike database is upgraded: the thin tables go, the full ones replace them, history is kept', () => {
    const db = new DatabaseSync(':memory:');
    // what Phase 0 left behind: CORE_0001 applied + its _migrations row + a demo product
    db.exec(CORE_0001);
    db.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO _migrations VALUES (?, 1)').run(SPIKE_CORE_ID);
    db.exec(
      "INSERT INTO stores VALUES ('s','s','S','EGP',1,1); INSERT INTO products (id, store_id, name, slug, price, inventory, status, has_variants, created_at, updated_at) VALUES ('p','s','P','p',100,1,'active',0,1,1)"
    );
    expect(tables(db)).toContain('stores');

    const ran = runMigrations(storage(db));
    expect(ran).toEqual(MIGRATIONS.map(m => m.id));
    expect(applied(db)).toEqual([SPIKE_CORE_ID, ...MIGRATIONS.map(m => m.id)].sort());
    expect(tables(db)).not.toContain('stores'); // the thin spike table is gone (a store row lives in D1 now)
    const cols = (db.prepare('PRAGMA table_info(products)').all() as { name: string }[]).map(
      c => c.name
    );
    expect(cols).toContain('deleted_at'); // the full definition
    expect(db.prepare('SELECT count(*) AS n FROM products').get()).toEqual({ n: 0 }); // disposable demo rows
    expect(runMigrations(storage(db))).toEqual([]);
  });

  it('a fresh database never runs the spike drop (nothing to drop, and nothing it could damage)', () => {
    const drop = MIGRATIONS[0];
    expect(drop.statements(new Set())).toEqual([]);
    expect(drop.statements(new Set([SPIKE_CORE_ID])).length).toBeGreaterThan(0);
  });

  it('a step that fails midway is rolled back whole and NOT recorded, so the next start retries it', () => {
    const db = new DatabaseSync(':memory:');
    let n = 0;
    const flaky = storage(db, q => /^CREATE TABLE IF NOT EXISTS "products"/.test(q) && ++n === 1);
    expect(() => runMigrations(flaky)).toThrow('boom');
    expect(applied(db)).toEqual(['cf-0000_drop_spike_core']); // earlier step committed; cf-0001 not
    expect(tables(db)).not.toContain('abandoned_cart_configs'); // cf-0001's earlier statements rolled back
    expect(runMigrations(storage(db))).toEqual(MIGRATIONS.slice(1).map(m => m.id));
    expect(tables(db)).toContain('products');
  });
});
