/**
 * Review of #1109 / Ruling NZ-D15B: purging a store tombstones its `stores` row, it never deletes it, because Ebda's own billing and
 * payment-proof tables reference stores(id) ON DELETE CASCADE. Proven on the REAL platform D1 schema with foreign keys ON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_RECORDS_LAST_AT_SQL,
  PURGED_SLUG_PREFIX,
  isPurgedSlug,
  tombstoneStatements,
} from '../../apps/api/src/lib/store-tombstone';

const ROOT = path.resolve(__dirname, '../..');
function platform(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = path.join(ROOT, 'packages/cf-schema/migrations/platform');
  for (const f of fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort())
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  db.exec('PRAGMA foreign_keys = OFF'); // seeding only needs the columns under test; seed() turns enforcement ON before the statements under test
  return db;
}
const count = (db: DatabaseSync, sql: string, ...p: unknown[]) =>
  Number((db.prepare(sql).get(...(p as never[])) as { n: number }).n);

function insert(db: DatabaseSync, table: string, set: Record<string, unknown>) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }[];
  const VALID: Record<string, unknown> = {
    'merchant_api_keys.scopes': '[]',
    'instapay_receipts.kind': 'subscription',
    'billing_events.type': 'checkout',
    'billing_reminders.kind': 'd7',
  };
  // the first allowed value of every `CHECK ("col" IN ('a', 'b'))` of the table: a neutral placeholder would be rejected
  const ddl = String(
    (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql
  );
  const allowed: Record<string, string> = {};
  for (const m of ddl.matchAll(/CHECK \("(\w+)" IN \('([^']+)'/g)) allowed[m[1]!] = m[2]!;
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in set) row[c.name] = set[c.name];
    else if (c.name in allowed) row[c.name] = allowed[c.name];
    else if (`${table}.${c.name}` in VALID) row[c.name] = VALID[`${table}.${c.name}`];
    else if (c.name === 'id') row[c.name] = `${table}-${Math.random().toString(36).slice(2)}`;
    else if (c.notnull && c.dflt_value == null)
      row[c.name] = /INT/i.test(c.type) ? 1 : `x-${Math.random().toString(36).slice(2)}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${names.map(n => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`
  ).run(...(Object.values(row) as never[]));
}

const S = 'store-1';
function seed(db: DatabaseSync) {
  insert(db, 'stores', {
    id: S,
    name: 'Real Name',
    name_ar: 'اسم',
    slug: 'real-slug',
    domain: 'shop.example.com',
    logo: 'l.png',
    owner_id: 'owner-1',
    deleted_at: 1000,
    storage_backend: 'do',
  });
  for (const t of [
    'billing_events',
    'instapay_receipts',
    'manual_payment_claims',
    'store_subscriptions',
    'billing_reminders',
    'trust_requests',
    'ai_usage',
  ])
    insert(db, t, { store_id: S, created_at: 5_000 });
  insert(db, 'store_staff', { store_id: S, user_id: 'u1' });
  insert(db, 'merchant_api_keys', { store_id: S });
  insert(db, 'staff_invites', { store_id: S, email: 'a@b.c' });
  db.exec('PRAGMA foreign_keys = ON'); // from here ON DELETE CASCADE is live, exactly as on D1
}
const run = (db: DatabaseSync, now = 9_000) => {
  for (const st of tombstoneStatements(S, now)) db.prepare(st.sql).run(...(st.params as never[]));
};

describe('store tombstone (never a DELETE of the stores row)', () => {
  it("control: a plain DELETE of the store row CASCADES away Ebda's billing records (why this exists)", () => {
    const db = platform();
    seed(db);
    db.prepare('DELETE FROM stores WHERE id = ?').run(S);
    expect(count(db, 'SELECT count(*) n FROM billing_events')).toBe(0);
    expect(count(db, 'SELECT count(*) n FROM instapay_receipts')).toBe(0);
  });

  it('the tombstone keeps every billing / payment-proof / subscription row and removes the people and credentials', () => {
    const db = platform();
    seed(db);
    run(db);
    for (const t of [
      'billing_events',
      'instapay_receipts',
      'manual_payment_claims',
      'store_subscriptions',
      'billing_reminders',
      'trust_requests',
      'ai_usage',
    ])
      expect(count(db, `SELECT count(*) n FROM "${t}" WHERE store_id = ?`, S), t).toBe(1);
    for (const t of ['store_staff', 'merchant_api_keys', 'staff_invites'])
      expect(count(db, `SELECT count(*) n FROM "${t}" WHERE store_id = ?`, S), t).toBe(0);
  });

  it('the stores row stays, anonymised, soft-deleted, with the slug and domain released', () => {
    const db = platform();
    seed(db);
    run(db);
    const r = db.prepare('SELECT * FROM stores WHERE id = ?').get(S) as Record<string, unknown>;
    expect(r).toMatchObject({
      name: '[purged]',
      name_ar: null,
      slug: `${PURGED_SLUG_PREFIX}${S}`,
      domain: null,
      logo: null,
      status: 'inactive',
      owner_id: 'owner-1',
      deleted_at: 1000,
    });
    expect(isPurgedSlug(String(r.slug))).toBe(true);
    // the old slug and domain are free again for a new store
    insert(db, 'stores', {
      id: 'store-2',
      slug: 'real-slug',
      domain: 'shop.example.com',
      owner_id: 'owner-2',
    });
  });

  it('is idempotent and never resolves as a storefront (deleted_at kept)', () => {
    const db = platform();
    seed(db);
    run(db, 9_000);
    run(db, 99_000);
    expect(count(db, 'SELECT count(*) n FROM billing_events')).toBe(1);
    expect(
      (db.prepare('SELECT deleted_at AS d FROM stores WHERE id = ?').get(S) as { d: number }).d
    ).toBe(1000);
  });

  it('the platform-records date reads the latest of the three billing tables', () => {
    const db = platform();
    seed(db);
    insert(db, 'billing_events', { store_id: S, created_at: 7_777 });
    expect((db.prepare(PLATFORM_RECORDS_LAST_AT_SQL).get(S) as { last: number }).last).toBe(7_777);
    expect(
      (db.prepare(PLATFORM_RECORDS_LAST_AT_SQL).get('nobody') as { last: number | null }).last
    ).toBeNull();
  });
});

describe('the purge never hard-deletes a stores row (source guard)', () => {
  it('the purge adapters tombstone: no DELETE of stores, no retireStoreDirectoryRow, no STORE_SCOPED_TABLES delete loop', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'apps/api/src/lib/closed-store-purge-adapters.ts'),
      'utf8'
    );
    expect(src).toMatch(/tombstoneStatements/);
    expect(src).not.toMatch(/DELETE FROM "?stores"?/i);
    expect(src).not.toMatch(/retireStoreDirectoryRow/);
    expect(src).not.toMatch(/store_subscriptions/);
  });
});
