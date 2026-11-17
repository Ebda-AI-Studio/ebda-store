// Task 1.2: the D1 platform schema.
import { afterAll, describe, expect, it } from 'vitest';
import { expectThrows, openDb, readJson, tableNames } from './helpers';

type Manifest = {
  databases: Record<string, { tables: number; columnCounts: Record<string, number> }>;
};
const manifest = readJson<Manifest>('generated/manifest.json');

describe('D1 platform schema', () => {
  const db = openDb('platform', 2);

  it('creates the manifest tables only: 30 models + entity_index + platform_audit_log, no identity table', () => {
    expect(tableNames(db)).toEqual(Object.keys(manifest.databases.d1.columnCounts).sort());
    expect(tableNames(db).length).toBe(32);
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

  describe('store_subscriptions.past_due_since (WA-GRACE-1, mirrors the Postgres trigger)', () => {
    const sub = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO store_subscriptions (id, store_id, plan_code, status) VALUES (?, ?, 'business', ?)`
        )
        .run(id, `st-${id}`, status);
    afterAll(() => {
      db.exec('PRAGMA foreign_keys = ON');
    });
    const since = (id: string) =>
      (
        db.prepare(`SELECT past_due_since AS v FROM store_subscriptions WHERE id = ?`).get(id) as {
          v: number | null;
        }
      ).v;

    it('is set on the first past_due, kept by a retry, cleared on recovery, set again on a new episode', () => {
      db.exec('PRAGMA foreign_keys = OFF');
      sub('p1', 'active');
      expect(since('p1')).toBeNull();
      db.prepare(`UPDATE store_subscriptions SET status = 'past_due' WHERE id = 'p1'`).run();
      const first = since('p1');
      expect(first).toBeGreaterThan(0);
      db.prepare(
        `UPDATE store_subscriptions SET status = 'past_due', dunning_attempts = 2 WHERE id = 'p1'`
      ).run();
      expect(since('p1')).toBe(first);
      db.prepare(`UPDATE store_subscriptions SET status = 'active' WHERE id = 'p1'`).run();
      expect(since('p1')).toBeNull();
      db.prepare(`UPDATE store_subscriptions SET status = 'past_due' WHERE id = 'p1'`).run();
      expect(since('p1')).toBeGreaterThanOrEqual(first!);
    });

    it('an insert that is already past_due gets a date; any other status stays null', () => {
      db.exec('PRAGMA foreign_keys = OFF');
      sub('p2', 'past_due');
      expect(since('p2')).toBeGreaterThan(0);
      sub('p3', 'trialing');
      expect(since('p3')).toBeNull();
    });
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

  describe('billing_grants is append-only (FOUNDING-1, CF-LAST-2)', () => {
    const grant = (id: string, o: Record<string, unknown> = {}) => {
      const r = { status: 'pending', ...o };
      db.prepare(
        `INSERT INTO billing_grants (id, kind, beneficiary_id, idempotency_key, status, applied_at, period_end_before, period_end_after, revoked_at, revoke_reason)
         VALUES (?, 'founding', 'b1', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        `k-${id}`,
        r.status as string,
        (r.applied_at as number) ?? null,
        (r.before as number) ?? null,
        (r.after as number) ?? null,
        (r.revoked_at as number) ?? null,
        (r.reason as string) ?? null
      );
    };
    const upd = (sql: string) => () => db.prepare(sql).run();

    it('refuses every delete and every change of an identity, source or money column', () => {
      grant('g1');
      expectThrows(upd(`DELETE FROM billing_grants WHERE id = 'g1'`), /delete refused/);
      for (const set of [
        `kind = 'referral_referrer'`,
        `beneficiary_id = 'b2'`,
        `counterpart_id = 'c'`,
        `value_minor = 5`,
        `source_event_id = 'e'`,
        `source_store_id = 's'`,
        `idempotency_key = 'other'`,
        `created_at = 1`,
      ])
        expectThrows(upd(`UPDATE billing_grants SET ${set} WHERE id = 'g1'`), /immutable column/);
    });

    it('pending -> applied needs the period bookkeeping; pending -> revoked needs reason and none', () => {
      grant('g2');
      expectThrows(
        upd(`UPDATE billing_grants SET status = 'applied' WHERE id = 'g2'`),
        /period bookkeeping/
      );
      expectThrows(
        upd(`UPDATE billing_grants SET status = 'pending', applied_at = 1 WHERE id = 'g2'`),
        /no period bookkeeping/
      );
      expectThrows(
        upd(`UPDATE billing_grants SET status = 'revoked' WHERE id = 'g2'`),
        /needs revoked_at/
      );
      expectThrows(
        upd(
          `UPDATE billing_grants SET status = 'revoked', revoked_at = 1, revoke_reason = 'x', applied_at = 1 WHERE id = 'g2'`
        ),
        /without period bookkeeping/
      );
      expectThrows(
        upd(`UPDATE billing_grants SET revoked_at = 1 WHERE id = 'g2'`),
        /belong to a revoked grant/
      );
      db.prepare(
        `UPDATE billing_grants SET status = 'applied', applied_at = 1, period_end_before = 2, period_end_after = 3 WHERE id = 'g2'`
      ).run();
    });

    it('an applied grant can only be revoked, with its bookkeeping untouched', () => {
      grant('g3', { status: 'applied', applied_at: 1, before: 2, after: 3 });
      expectThrows(
        upd(`UPDATE billing_grants SET period_end_after = 9 WHERE id = 'g3'`),
        /can only be revoked/
      );
      expectThrows(
        upd(`UPDATE billing_grants SET applied_at = 9 WHERE id = 'g3'`),
        /can only be revoked/
      );
      expectThrows(
        upd(
          `UPDATE billing_grants SET status = 'revoked', revoked_at = 5, revoke_reason = 'r', restored_at = 6 WHERE id = 'g3'`
        ),
        /can only be revoked/
      );
      db.prepare(
        `UPDATE billing_grants SET status = 'revoked', revoked_at = 5, revoke_reason = 'r' WHERE id = 'g3'`
      ).run();
    });

    it('a revoked grant is final except restored_at, set once', () => {
      grant('g4', { status: 'revoked', revoked_at: 5, reason: 'r' });
      for (const set of [
        `status = 'applied', applied_at = 1, period_end_before = 2, period_end_after = 3, revoked_at = NULL, revoke_reason = NULL`,
        `revoke_reason = 'other'`,
        `revoked_at = 6`,
        `applied_at = 1`,
      ])
        expectThrows(upd(`UPDATE billing_grants SET ${set} WHERE id = 'g4'`), /revoked|applied/);
      db.prepare(`UPDATE billing_grants SET restored_at = 7 WHERE id = 'g4'`).run();
      expectThrows(upd(`UPDATE billing_grants SET restored_at = 8 WHERE id = 'g4'`), /final/);
    });
  });
});
