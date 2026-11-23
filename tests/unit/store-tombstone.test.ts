/**
 * Review of #1109 / Ruling NZ-D15B: purging a store tombstones its `stores` row, it never deletes it, because Ebda's own billing and
 * payment-proof tables reference stores(id) ON DELETE CASCADE. Proven on the REAL platform D1 schema with foreign keys ON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { validateStoreSlugFormat } from '../../packages/shared/src/hosts/slug';
import classification from '../../packages/cf-schema/erasure-classification.json';
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

// Review of #1109 (security, MEDIUM): the KEPT platform tables must not keep personal identifiers. Driven by the erasure
// classification, so a personal column added to a kept table later fails here until the tombstone handles it.
describe('no personal identifier survives on a kept platform table (drift guard from the classification)', () => {
  type Entry = { db: string; class: string; piiColumns: string[] };
  const CLS = classification as unknown as Record<string, Entry>;
  // columns that are personal-LOOKING but kept on purpose, each with the reason
  const KEPT_ON_PURPOSE: Record<string, string> = {
    'stores.owner_id':
      'opaque user id on the billing record that is kept (Ruling M-024); the identity service holds the person',
  };
  // a placeholder the CHECK constraints accept
  const SEED: Record<string, unknown> = {
    'store_subscriptions.payment_method_last4': '4242',
    'instapay_receipts.extracted': '{"payer":"PII-extracted"}',
  };
  const DELETED_BY_TOMBSTONE = new Set(['store_staff', 'merchant_api_keys', 'staff_invites']);

  it('every personal column of every store-keyed, kept table is cleared or replaced', () => {
    const probe = platform();
    const targets: Array<[string, string[]]> = [];
    for (const [key, e] of Object.entries(CLS)) {
      if (e.db !== 'd1' || e.class === 'no-pii') continue;
      const table = key.split(':')[1]!;
      if (DELETED_BY_TOMBSTONE.has(table) || table === 'stores') continue;
      const cols = (probe.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
        c => c.name
      );
      if (!cols.includes('store_id')) continue; // user-keyed tables (legal acceptances, sessions) are the user erasure engine's, not a store's
      targets.push([table, e.piiColumns.filter(c => c !== '*' && cols.includes(c))]);
    }
    expect(targets.map(([t]) => t).sort()).toEqual(
      expect.arrayContaining([
        'instapay_receipts',
        'manual_payment_claims',
        'store_subscriptions',
        'trust_requests',
      ])
    );
    const survivors: string[] = [];
    for (const [table, piiCols] of targets) {
      const db = platform();
      insert(db, 'stores', {
        id: S,
        slug: 'real',
        owner_id: 'o',
        deleted_at: 1,
        storage_backend: 'do',
      });
      insert(db, table, {
        store_id: S,
        ...Object.fromEntries(piiCols.map(c => [c, SEED[`${table}.${c}`] ?? `PII-${c}`])),
      });
      for (const st of tombstoneStatements(S, 9_000))
        db.prepare(st.sql).run(...(st.params as never[]));
      const row = db.prepare(`SELECT * FROM "${table}" WHERE store_id = ?`).get(S) as
        | Record<string, unknown>
        | undefined;
      if (!row) continue;
      for (const c of piiCols) {
        if (`${table}.${c}` in KEPT_ON_PURPOSE) continue;
        const v = row[c];
        if (typeof v === 'string' && (v.startsWith('PII-') || v === '4242' || v.includes('PII-')))
          survivors.push(`${table}.${c}`);
      }
    }
    expect(survivors, 'personal columns that survive the tombstone').toEqual([]);
  });

  it('the columns the classification names for these tables really exist (a renamed column cannot hide a survivor)', () => {
    const db = platform();
    for (const t of [
      'store_subscriptions',
      'instapay_receipts',
      'manual_payment_claims',
      'trust_requests',
    ]) {
      const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(
        c => c.name
      );
      for (const c of CLS[`d1:${t}`]!.piiColumns) expect(cols, `${t}.${c}`).toContain(c);
    }
  });

  it('amounts, references, dates, invoice numbers and plan survive (tax and accounting)', () => {
    const db = platform();
    insert(db, 'stores', {
      id: S,
      slug: 'real',
      owner_id: 'o',
      deleted_at: 1,
      storage_backend: 'do',
    });
    insert(db, 'instapay_receipts', {
      store_id: S,
      amount_minor: 149_000,
      reference: 'REF-1',
      reference_key: 'rk-1',
      payer_name: 'Mona',
    });
    insert(db, 'manual_payment_claims', {
      store_id: S,
      amount_minor: 149_000,
      payment_reference: 'PAY-1',
      payer_reference: 'mona@bank',
    });
    for (const st of tombstoneStatements(S, 9_000))
      db.prepare(st.sql).run(...(st.params as never[]));
    expect(
      db
        .prepare('SELECT amount_minor, reference, reference_key, payer_name FROM instapay_receipts')
        .get()
    ).toEqual({
      amount_minor: 149_000,
      reference: 'REF-1',
      reference_key: 'rk-1',
      payer_name: null,
    });
    expect(
      db
        .prepare(
          'SELECT amount_minor, payment_reference, payer_reference FROM manual_payment_claims'
        )
        .get()
    ).toMatchObject({ amount_minor: 149_000, payment_reference: 'PAY-1' });
    expect(
      String(
        (
          db.prepare('SELECT payer_reference AS p FROM manual_payment_claims').get() as {
            p: string;
          }
        ).p
      )
    ).toMatch(/^erased:/);
  });
});

describe('the tombstone slug lives outside the user-pickable namespace, and the order is safe (security review of #1109)', () => {
  it('no slug validator accepts the marker, so a merchant can never register or impersonate a tombstone', () => {
    expect(PURGED_SLUG_PREFIX).toContain('~');
    for (const slug of [
      `${PURGED_SLUG_PREFIX}${S}`,
      `${PURGED_SLUG_PREFIX}`,
      `${PURGED_SLUG_PREFIX}00000000-0000-4000-8000-000000000000`,
    ]) {
      expect(validateStoreSlugFormat(slug).ok, slug).toBe(false);
      expect(/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(slug), slug).toBe(false); // the directory's own SLUG_RE (lib/store-directory.ts)
      expect(isPurgedSlug(slug)).toBe(true);
    }
    // the old marker's SHAPE (`purged-...`) is an ordinary slug a merchant can register (a full uuid id would exceed the 40-char limit, but
    // that is a length accident, not a guarantee): the new marker does not depend on length, only on a character no validator allows
    expect(validateStoreSlugFormat('purged-abc').ok).toBe(true);
    expect(isPurgedSlug('purged-abc')).toBe(false);
  });

  it('the store is made unresolvable in the FIRST statement, and the rename is the LAST one', () => {
    const st = tombstoneStatements(S, 9_000);
    expect(st[0]!.sql).toMatch(/^UPDATE "stores" SET "status" = 'inactive', "deleted_at"/);
    expect(st[0]!.sql).not.toMatch(/"slug"/);
    const rename = st.findIndex(x => /"slug"\s*=/.test(x.sql));
    expect(rename).toBe(st.length - 1);
    expect(st.filter(x => /"slug"\s*=/.test(x.sql))).toHaveLength(1);
  });

  it('if the rename fails (a colliding slug), the store has already stopped resolving', () => {
    const db = platform();
    insert(db, 'stores', {
      id: S,
      slug: 'live-shop',
      owner_id: 'o',
      deleted_at: null,
      status: 'active',
      storage_backend: 'do',
    });
    // force a unique-slug collision on the tombstone slug (impossible through the validators, possible by hand)
    insert(db, 'stores', {
      id: 'other',
      slug: `${PURGED_SLUG_PREFIX}${S}`,
      owner_id: 'o2',
      storage_backend: 'do',
    });
    const st = tombstoneStatements(S, 9_000);
    let failedAt = -1;
    st.forEach((x, i) => {
      try {
        db.prepare(x.sql).run(...(x.params as never[]));
      } catch {
        failedAt = i;
      }
    });
    expect(failedAt).toBe(st.length - 1); // the rename is what failed
    expect(db.prepare('SELECT status, deleted_at AS d FROM stores WHERE id = ?').get(S)).toEqual({
      status: 'inactive',
      d: 9_000,
    });
  });
});
