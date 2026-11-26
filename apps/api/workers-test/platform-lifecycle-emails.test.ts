/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

// Ported from tests/integration/lifecycle-emails.test.ts (Postgres, ebda_app RLS): the DATABASE guarantees of
// `store_lifecycle_emails` on the platform D1. The send-once / skip-reason / opt-out / failed-row pipeline is covered by
// tests/unit/lifecycle-emails.test.ts; tenant isolation of the log is the `store_id` predicate (the platform D1 has no RLS,
// every read is store-keyed: `d1-tenant-filter-guard.test.ts`). The Postgres-only super-admin referral counts
// (`referralSignupCounts`, a prisma user.count) are not reached on the hub (admin.routes `onHub` -> null) and are dropped.
const e = env as unknown as {
  PLATFORM_DB: {
    prepare(sql: string): {
      bind(...v: unknown[]): {
        run(): Promise<unknown>;
        first<T = Record<string, unknown>>(): Promise<T | null>;
        all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      };
    };
  };
  TEST_PLATFORM_MIGRATIONS: unknown[];
};
const db = e.PLATFORM_DB;
const run = (sql: string, ...v: unknown[]) =>
  db
    .prepare(sql)
    .bind(...v)
    .run();
const log = (store: string, kind: string, status = 'sent') =>
  run(
    'INSERT INTO store_lifecycle_emails (id, store_id, kind, status) VALUES (?1, ?2, ?3, ?4)',
    crypto.randomUUID(),
    store,
    kind,
    status
  );
const kinds = async (store: string) =>
  (
    await db
      .prepare('SELECT kind FROM store_lifecycle_emails WHERE store_id = ?1 ORDER BY kind')
      .bind(store)
      .all<{ kind: string }>()
  ).results.map(r => r.kind);

describe('store_lifecycle_emails on the platform D1', () => {
  beforeAll(async () => {
    await applyD1Migrations(db as never, e.TEST_PLATFORM_MIGRATIONS as never);
    for (const s of ['lc-a', 'lc-b', 'lc-del'])
      await run(
        'INSERT OR IGNORE INTO stores (id, name, slug, owner_id) VALUES (?1, ?1, ?1, ?2)',
        s,
        'owner-lc'
      );
  });

  it('the unique (store, kind) row is the send-once lock: a second row for one kind is refused, another store is unaffected', async () => {
    await log('lc-a', 'add_products');
    await expect(log('lc-a', 'add_products')).rejects.toThrow();
    await log('lc-b', 'add_products');
    expect(await kinds('lc-a')).toEqual(['add_products']);
    expect(await kinds('lc-b')).toEqual(['add_products']);
  });

  it('the database itself refuses an unknown kind and an unknown status', async () => {
    await expect(log('lc-a', 'not_a_kind')).rejects.toThrow();
    await expect(log('lc-a', 'share_link', 'maybe')).rejects.toThrow();
    for (const s of ['sent', 'skipped', 'failed'])
      await log('lc-b', `payment_shipping`, s).catch(() => {});
    expect((await kinds('lc-a')).includes('not_a_kind')).toBe(false);
  });

  it("the log is store-keyed: store A's read never returns store B's rows", async () => {
    await log('lc-b', 'test_order');
    expect(await kinds('lc-a')).toEqual(['add_products']);
    expect((await kinds('lc-b')).sort()).toEqual([
      'add_products',
      'payment_shipping',
      'test_order',
    ]);
  });

  it('deleting the store removes its log (FK cascade) and only its own', async () => {
    await log('lc-del', 'add_products');
    await log('lc-del', 'share_link');
    await run('DELETE FROM stores WHERE id = ?1', 'lc-del');
    expect(await kinds('lc-del')).toEqual([]);
    expect((await kinds('lc-b')).length).toBeGreaterThan(0);
  });
});
