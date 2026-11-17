/**
 * Ruling FOLD-ERASURE-1/2 (PDPL 151/2020, launch item FOLD-ERASURE): the export + erasure COVERAGE of the new storage is enforced, not
 * remembered. Both databases are read from their real migrations; every table the classification calls personal must be reachable
 * from the export/erase code that actually runs, or sit on an allowlist that states why. Behaviour is proven on the real D1 schema
 * (a subject row and a bystander row per table: the subject is exported and erased, the bystander is untouched). The wiring test
 * fails when the engine is not called from the flows (the old `scrubUserFromPlatform` was complete and called by nobody).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import classification from '../../packages/cf-schema/erasure-classification.json';
import { actorScrubPlan } from '../../packages/repo/src/platform-erasure';
import {
  INVITE_TABLE,
  STORE_SCOPED_TABLES,
  countPlatformSubject,
  eraseStorePlatformData,
  erasePlatformSubject,
  exportPlatformSubject,
  platformPlan,
  type D1Like,
} from '../../apps/api/src/cf/erasure/platform-subject';
import { STORE_DO_REGISTRY } from '../../apps/api/src/cf/erasure/registry';
import { merchantPiiPlan } from '../../apps/api/src/cf/erasure/merchant-anonymise';
import { stripComments } from './helpers/source-scan';

const ROOT = path.resolve(__dirname, '../..');
type Entry = { db: 'store-do' | 'd1'; class: string; action: string };
const CLS = classification as unknown as Record<string, Entry>;

function openPlatform(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // FKs off: the rows here only need the columns under test (D1 enforces them; the engine never relies on them)
  db.exec('PRAGMA foreign_keys = OFF');
  const dir = path.join(ROOT, 'packages/cf-schema/migrations/platform');
  for (const f of fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort())
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  return db;
}

/** D1 over node:sqlite: same prepare().bind().all/first/run + batch (atomic) surface the engine uses. */
function d1Of(db: DatabaseSync): D1Like {
  const stmt = (sql: string) => ({
    bind: (...v: unknown[]) => {
      const run = () => {
        const r = db.prepare(sql).run(...(v as never[]));
        return { meta: { changes: Number(r.changes) } };
      };
      return {
        all: async () => ({ results: db.prepare(sql).all(...(v as never[])) as never[] }),
        first: async () => (db.prepare(sql).get(...(v as never[])) as never) ?? null,
        run: async () => run(),
        _run: run,
      };
    },
  });
  return {
    prepare: stmt as never,
    batch: async stmts => {
      db.exec('BEGIN');
      try {
        const out = (stmts as Array<{ _run(): { meta: { changes: number } } }>).map(s => s._run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** Insert one row giving `set` and a neutral value for every other NOT NULL column without a default. */
function insert(db: DatabaseSync, table: string, set: Record<string, unknown>) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in set) row[c.name] = set[c.name];
    else if (c.name === 'id') row[c.name] = `${table}-${Math.random().toString(36).slice(2)}`;
    else if (`${table}.${c.name}` in VALID) row[c.name] = VALID[`${table}.${c.name}`];
    else if (c.notnull && c.dflt_value == null)
      row[c.name] = /INT/i.test(c.type) ? 1 : `x-${Math.random().toString(36).slice(2)}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO "${table}" (${names.map(n => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`
  ).run(...(Object.values(row) as never[]));
}
// values for NOT NULL columns whose CHECK constraint rejects a neutral placeholder
const VALID: Record<string, unknown> = {
  'legal_acceptances.source': 'signup',
  'merchant_api_keys.scopes': '[]',
  'instapay_receipts.kind': 'order',
  'trust_requests.kind': 'support',
};
const count = (db: DatabaseSync, table: string, where: string, ...v: unknown[]) =>
  Number(
    (
      db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`).get(...(v as never[])) as {
        n: number;
      }
    ).n
  );

const U = 'user-subject';
const B = 'user-bystander';
const EMAIL = 'Subject@Example.com';

describe('platform D1: user export + erasure covers every personal table', () => {
  const plan = platformPlan();
  const db0 = openPlatform();
  const d1Tables = (
    db0
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as {
      name: string;
    }[]
  ).map(r => r.name);

  // A personal-data table that no user-keyed code path reaches, with the reason it is safe and who owns it instead.
  const USER_ALLOWLIST: Record<string, string> = {
    stores:
      'retain: owner_id is a pseudonymous id on a billing record that is kept; an owner cannot be erased while they own stores (409 USER_OWNS_STORES), the store delete removes the store (M-024)',
    store_subscriptions:
      'store-keyed, not user-keyed: the card reference is removed by eraseStorePlatformData when the store is deleted (STORE_SCOPED_TABLES)',
  };

  it('every D1 table the classification calls personal is exported + erased by the engine, store-scoped, or allowlisted with a reason', () => {
    const personal = d1Tables.filter(t => CLS[`d1:${t}`]?.class !== 'no-pii');
    const reach = new Set<string>([
      ...Object.keys(plan.subject),
      ...Object.keys(plan.actor),
      INVITE_TABLE,
    ]);
    const unreached = personal.filter(t => !reach.has(t) && !(t in USER_ALLOWLIST));
    expect(unreached, 'personal D1 tables with no export/erase path').toEqual([]);
    for (const [t, why] of Object.entries(USER_ALLOWLIST)) {
      expect(why.length, `${t}: allowlist needs a reason`).toBeGreaterThan(20);
      expect(personal, `${t}: stale allowlist entry`).toContain(t);
      expect(
        reach.has(t) && !STORE_SCOPED_TABLES.includes(t as never),
        `${t}: reachable, drop the entry`
      ).toBe(false);
    }
  });

  it('every store-scoped table is real, personal-classified, and has a store_id', () => {
    for (const t of STORE_SCOPED_TABLES) {
      expect(CLS[`d1:${t}`]?.class, t).not.toBe('no-pii');
      const cols = (db0.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(
        c => c.name
      );
      expect(cols, t).toContain('store_id');
    }
  });

  const subjectTables = Object.entries(plan.subject);
  it.each(subjectTables)(
    'subject table %s: exported, erased, bystander untouched',
    async (table, cols) => {
      const db = openPlatform();
      const d1 = d1Of(db);
      for (const who of [U, B])
        insert(db, table, { ...Object.fromEntries(cols.map(c => [c, who])), store_id: 's1' });
      const exp = await exportPlatformSubject(d1, { userId: U, email: null });
      expect(exp[table]).toHaveLength(1);
      expect(JSON.stringify(exp)).not.toContain(B);
      expect(JSON.stringify(exp)).not.toContain('key_hash');
      await erasePlatformSubject(d1, { userId: U, email: null });
      expect(count(db, table, `"${cols[0]}" = ?`, U)).toBe(0);
      expect(count(db, table, `"${cols[0]}" = ?`, B)).toBe(1);
      expect(await countPlatformSubject(d1, { userId: U, email: null })).toBe(0);
      await erasePlatformSubject(d1, { userId: U, email: null }); // idempotent
    }
  );

  const actorTables = Object.entries(plan.actor);
  it.each(actorTables)(
    'actor table %s: id exported, replaced, row and bystander kept',
    async (table, cols) => {
      const db = openPlatform();
      const d1 = d1Of(db);
      for (const who of [U, B])
        insert(db, table, Object.fromEntries(Object.keys(cols).map(c => [c, who])));
      const exp = await exportPlatformSubject(d1, { userId: U, email: null });
      expect(exp[`${table}(actor)`]).toHaveLength(1);
      await erasePlatformSubject(d1, { userId: U, email: null });
      for (const [c, rep] of Object.entries(cols)) {
        expect(count(db, table, `"${c}" = ?`, U)).toBe(0);
        expect(count(db, table, `"${c}" = ?`, B)).toBe(1);
        if (rep !== null) expect(count(db, table, `"${c}" = ?`, rep)).toBeGreaterThanOrEqual(1);
      }
      expect(count(db, table, '1 = 1')).toBe(2);
    }
  );

  it('invitations are matched by address, case-insensitively: pending revoked, address overwritten, others untouched', async () => {
    const db = openPlatform();
    const d1 = d1Of(db);
    insert(db, 'staff_invites', { id: 'i1', email: EMAIL.toLowerCase(), status: 'pending' });
    insert(db, 'staff_invites', { id: 'i2', email: EMAIL, status: 'accepted' });
    insert(db, 'staff_invites', { id: 'i3', email: 'other@example.com', status: 'pending' });
    expect(
      (await exportPlatformSubject(d1, { userId: U, email: EMAIL }))[INVITE_TABLE]
    ).toHaveLength(2);
    await erasePlatformSubject(d1, { userId: U, email: EMAIL });
    expect(count(db, 'staff_invites', 'lower(email) = lower(?)', EMAIL)).toBe(0);
    expect(count(db, 'staff_invites', "id = 'i1' AND status = 'revoked'")).toBe(1);
    expect(count(db, 'staff_invites', "id = 'i2' AND status = 'accepted'")).toBe(1);
    expect(
      count(db, 'staff_invites', "id = 'i3' AND email = 'other@example.com' AND status = 'pending'")
    ).toBe(1);
  });

  it('an erase that leaves a row behind throws instead of reporting done', async () => {
    const db = openPlatform();
    insert(db, 'onesignal_subscriptions', { user_id: U });
    const real = d1Of(db);
    const lying: D1Like = { ...real, batch: async s => s.map(() => ({ meta: { changes: 0 } })) };
    await expect(erasePlatformSubject(lying, { userId: U, email: null })).rejects.toThrow(
      /incomplete/
    );
  });

  it('store deletion: staff, API keys, invitee addresses and the card reference of THAT store go; another store is untouched', async () => {
    const db = openPlatform();
    const d1 = d1Of(db);
    for (const s of ['s1', 's2']) {
      insert(db, 'store_staff', { store_id: s, user_id: `u-${s}` });
      insert(db, 'merchant_api_keys', { store_id: s, user_id: `u-${s}`, key_hash: `h-${s}` });
      insert(db, 'staff_invites', { store_id: s, email: `inv-${s}@example.com` });
      insert(db, 'stores', { id: s, owner_id: `o-${s}`, slug: s, name: s });
      insert(db, 'store_subscriptions', {
        store_id: s,
        provider_customer_id: `c-${s}`,
        payment_method_last4: '4242',
      });
    }
    await eraseStorePlatformData(d1, 's1');
    expect(count(db, 'store_staff', "store_id = 's1'")).toBe(0);
    expect(count(db, 'merchant_api_keys', "store_id = 's1'")).toBe(0);
    expect(
      count(db, 'staff_invites', "store_id = 's1' AND email LIKE 'erased-%@anonymized.invalid'")
    ).toBe(1);
    expect(
      count(
        db,
        'store_subscriptions',
        "store_id = 's1' AND provider_customer_id IS NULL AND payment_method_last4 IS NULL"
      )
    ).toBe(1);
    expect(count(db, 'store_staff', "store_id = 's2'")).toBe(1);
    expect(count(db, 'staff_invites', "store_id = 's2' AND email = 'inv-s2@example.com'")).toBe(1);
    expect(
      count(db, 'store_subscriptions', "store_id = 's2' AND provider_customer_id = 'c-s2'")
    ).toBe(1);
  });
});

describe('StoreDO: every personal table is reachable from an export and an erase path', () => {
  const doTables = Object.keys(CLS)
    .filter(k => k.startsWith('store-do:'))
    .map(k => k.slice('store-do:'.length));
  // classes that are deliberately NOT erased, each with the legal reason (Ruling RETENTION-1)
  const DO_ALLOWLIST: Record<string, string> = {};
  for (const [k, e] of Object.entries(CLS))
    if (e.db === 'store-do' && e.class === 'legal-retention')
      DO_ALLOWLIST[k.slice(9)] =
        'legal retention (Law 206/2020 Art. 37, Law 17/1999 Art. 26): kept, the person is anonymised on the linked order / customer rows';

  it('customer-pii -> customer registry (export + erase); merchant-pii -> merchant plan or actor scrub; the rest is legal retention', () => {
    const merchant = new Set(merchantPiiPlan().map(p => p.table));
    const actor = new Set(Object.keys(actorScrubPlan('store-do')));
    const unreached: string[] = [];
    for (const t of doTables) {
      const c = CLS[`store-do:${t}`];
      if (c.class === 'no-pii' || t in DO_ALLOWLIST) continue;
      const ok =
        c.class === 'customer-pii'
          ? STORE_DO_REGISTRY[t]?.kind === 'customer-pii'
          : merchant.has(t) || actor.has(t);
      if (!ok) unreached.push(`${t} (${c.class}/${c.action})`);
    }
    expect(unreached).toEqual([]);
  });
});

describe('the engine is wired into the flows (a complete function nobody calls is a gap)', () => {
  const src = (p: string) => stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8'));
  it.each([
    ['apps/api/src/services/platform/access-d1.ts', ['erasePlatformSubject(']],
    [
      'apps/api/src/services/platform/hub-user-data.ts',
      ['eraseUserAccess(', 'scrubActor(', 'exportPlatformSubject('],
    ],
    ['apps/api/src/routes/admin.routes.ts', ['eraseHubUserData(']],
    [
      'apps/api/src/services/auth.service.ts',
      ['eraseHubUserData(', 'exportHubUserPlatform(', 'exportIdentityUser(', 'eraseIdentityUser('],
    ],
    [
      'apps/api/src/services/store.service.ts',
      [
        'anonymiseDeletedStore(',
        'eraseStorePlatformData(',
        'paymentsErasurePort',
        "kind: 'merchant'",
      ],
    ],
    ['apps/api/src/cf/store-do/store-do.ts', ['scrubActor(', 'scrubUserFromStoreDo(']],
  ])('%s calls %j', (file, needles) => {
    const s = src(file);
    for (const n of needles) expect(s, `${file} must contain ${n}`).toContain(n);
  });
  it('the admin delete route calls the hub eraser on BOTH paths and no longer calls the bare access cleanup', () => {
    const s = src('apps/api/src/routes/admin.routes.ts');
    expect((s.match(/eraseHubUserData\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(s).not.toMatch(/\beraseUserAccess\(/);
  });
});
