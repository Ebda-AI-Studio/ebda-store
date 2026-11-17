/**
 * Hotfix N-22 (security review 2026-11-02): every Postgres Store write reaches the D1 directory that lookups read.
 * Service-layer paths (storeUpdate / storeUpdateMany / full-row sync after create) against a REAL platform D1 schema on node:sqlite.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';

const pg = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  backend: 'pg' as 'pg' | 'do',
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  runInTenantContext: async (_id: string, fn: () => unknown) => fn(),
  onClosedTenantTxAccess: () => undefined,
  withStore: async (id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: async () => pg.rows.get(id) ?? null } }),
}));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async () => pg.backend,
  storeDo: () => ({}),
}));

import {
  lookupStore,
  storeIdBySlug,
  storeIdByDomain,
  storeIdsClaimingDomain,
} from '../../apps/api/src/lib/definer';
import { syncStoreDirectoryFromPg } from '../../apps/api/src/lib/store-directory-sync';
import { reconcileStoreDirectory } from '../../apps/api/src/lib/store-directory-reconcile';
import { withDeferredWork } from '../../apps/api/src/lib/after-tenant-commit';
import { copyStoreSettings } from '../../apps/api/src/lib/repo-factory';

let sqlite: DatabaseSync;
const d1Backend = () =>
  (
    sqlite.prepare('SELECT storage_backend FROM stores WHERE id=?').get(A) as {
      storage_backend: string;
    }
  ).storage_backend;
const asD1 = () => ({
  prepare: (sql: string) => ({
    bind: (...v: unknown[]) => {
      const run = async () => {
        await Promise.resolve();
        if (!/^\s*select/i.test(sql)) writes.push(sql);
        if (/^\s*select/i.test(sql)) return { results: sqlite.prepare(sql).all(...(v as never[])) };
        return { meta: { changes: Number(sqlite.prepare(sql).run(...(v as never[])).changes) } };
      };
      return {
        run,
        first: async () => ((await run()) as { results: unknown[] }).results[0] ?? null,
        all: run,
      };
    },
  }),
});
const A = '11111111-1111-4111-8111-111111111111';
const base = (over: Record<string, unknown> = {}) => ({
  id: A,
  name: 'Alpha',
  nameAr: null,
  slug: 'alpha',
  domain: null,
  ownerId: 'o1',
  status: 'active',
  plan: 'starter',
  logo: null,
  logoAr: null,
  favicon: null,
  currency: 'EGP',
  timezone: 'Africa/Cairo',
  createdAt: new Date(1000),
  updatedAt: new Date(1000),
  template: 'qamar',
  look: null,
  isDemo: false,
  domainStatus: null,
  pendingDomain: null,
  domainClaimedAt: null,
  domainVerifiedAt: null,
  domainProvider: null,
  emailSenderLocalPart: 'noreply',
  emailDomainId: null,
  emailDomainStatus: null,
  emailDomainVerifiedAt: null,
  billingSuspendedReason: null,
  billingSuspendedAt: null,
  deletedAt: null,
  ...over,
});

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    ['0001_init.sql', '0002_invariants.sql']
      .map(f =>
        fs.readFileSync(
          new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
          'utf8'
        )
      )
      .join('\n')
  );
  pg.rows.clear();
  pg.backend = 'pg';
  setCfBindings({ PLATFORM_DB: asD1() } as never);
});

/** Postgres commit is modelled by writing `pg.rows`; D1 must only ever follow a COMMITTED row. */
const commit = (over: Record<string, unknown>) => pg.rows.set(A, base(over));
const d1Status = () =>
  (sqlite.prepare('SELECT status FROM stores WHERE id=?').get(A) as { status: string }).status;
const d1Writes = () => writes.length;
const writes: string[] = [];

describe('directory dual-write (Postgres authoritative -> D1 lookups)', () => {
  beforeEach(() => {
    writes.length = 0;
  });
  it('create: a new store is resolvable by slug and id after the full-row sync (and 404 before)', async () => {
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    expect(await lookupStore({ slug: 'alpha' })).toEqual({ id: A, status: 'active' });
    expect(await storeIdBySlug('alpha')).toBe(A);
    expect(d1Backend()).toBe('pg');
  });
  it('suspend and activate: D1 equals the COMMITTED row (read back, not the patch)', async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    commit({ status: 'suspended' });
    await copyStoreSettings(A, { status: 'suspended' });
    expect(await lookupStore({ slug: 'alpha' }, ['active'])).toBeNull();
    expect(await lookupStore({ slug: 'alpha' }, ['active', 'suspended'])).toEqual({
      id: A,
      status: 'suspended',
    });
    commit({ status: 'active' });
    await copyStoreSettings(A, { status: 'active' });
    expect(await lookupStore({ slug: 'alpha' })).toEqual({ id: A, status: 'active' });
  });
  it('the mirror copies what Postgres committed, not what the caller asked for', async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    commit({ status: 'suspended' }); // the committed truth differs from the patch the caller passed
    await copyStoreSettings(A, { status: 'active' });
    expect(d1Status()).toBe('suspended');
  });
  it('soft delete, slug change, domain claim / verify / release', async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    commit({ deletedAt: new Date() });
    await copyStoreSettings(A, { deletedAt: new Date() });
    expect(await lookupStore({ id: A }, ['active', 'inactive', 'suspended'])).toBeNull();
    commit({ slug: 'renamed' });
    await copyStoreSettings(A, { slug: 'renamed' });
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
    expect((await lookupStore({ slug: 'renamed' }))?.id).toBe(A);
    commit({ slug: 'renamed', pendingDomain: 'shop.example.com', domainStatus: 'pending' });
    await copyStoreSettings(A, { pendingDomain: 'shop.example.com' });
    expect(await storeIdsClaimingDomain('shop.example.com')).toEqual([A]);
    expect(await lookupStore({ domain: 'shop.example.com' })).toBeNull();
    commit({ slug: 'renamed', domain: 'shop.example.com', domainStatus: 'active' });
    await copyStoreSettings(A, { domain: 'shop.example.com' });
    expect((await lookupStore({ domain: 'shop.example.com' }))?.id).toBe(A);
    expect(await storeIdByDomain('shop.example.com')).toBe(A);
    commit({ slug: 'renamed', domain: null, domainStatus: null });
    await copyStoreSettings(A, { domain: null });
    expect(await lookupStore({ domain: 'shop.example.com' })).toBeNull();
  });
  it('a patch with no D1 column touches nothing', async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    writes.length = 0;
    await copyStoreSettings(A, { theme: { a: 1 } });
    expect(d1Writes()).toBe(0);
  });
  it('a store gone from Postgres is removed from D1; unbound D1 is a no-op', async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    pg.rows.delete(A);
    await syncStoreDirectoryFromPg(A);
    expect(await lookupStore({ id: A })).toBeNull();
    clearCfBindings();
    await expect(syncStoreDirectoryFromPg(A)).resolves.toBeUndefined();
  });
  it('the D1 backend flag is never written by the mirror (D1 owns it)', async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    sqlite.prepare("UPDATE stores SET storage_backend='do' WHERE id=?").run(A);
    commit({ name: 'x' });
    await copyStoreSettings(A, { name: 'x' });
    expect(d1Backend()).toBe('do');
  });
});

describe('transaction boundary (security review of #384)', () => {
  beforeEach(() => {
    writes.length = 0;
  });
  const ctx = { storeId: A } as never;
  it('a transaction that ROLLS BACK leaves D1 untouched', async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    writes.length = 0;
    await expect(
      withDeferredWork(ctx, async () => {
        commit({ status: 'suspended' }); // visible only inside the doomed tx in real life
        await copyStoreSettings(A, { status: 'suspended' });
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect(d1Writes()).toBe(0);
    expect(d1Status()).toBe('active');
  });
  it('a transaction that COMMITS mirrors the committed row, and only after the commit', async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    writes.length = 0;
    await withDeferredWork(ctx, async () => {
      commit({ status: 'suspended' });
      await copyStoreSettings(A, { status: 'suspended' });
      expect(d1Writes()).toBe(0); // deferred, not run inside the transaction
    });
    expect(d1Status()).toBe('suspended');
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
  });
});

describe('reconciler (fail-closed)', () => {
  const alerts: string[] = [];
  const dirOf = () =>
    [...pg.rows.values()].map(r => ({
      id: r.id as string,
      slug: r.slug as string,
      status: r.status as string,
      plan: r.plan as string,
      hasDomain: !!r.domain,
      hasPendingDomain: !!r.pendingDomain,
    }));
  const run = () =>
    reconcileStoreDirectory({
      pgAll: async () => dirOf(),
      pgLive: async () => dirOf().filter(d => !pg.rows.get(d.id)!.deletedAt),
      alert: t => void alerts.push(t),
    });
  beforeEach(async () => {
    alerts.length = 0;
    commit({});
    await syncStoreDirectoryFromPg(A);
  });
  it('no drift: nothing corrected, no alert', async () => {
    const r = await run();
    expect(r).toMatchObject({ checked: 1, corrected: [], keptRestrictive: [] });
    expect(alerts).toEqual([]);
  });
  it('D1 less restrictive than Postgres (seeded drift): corrected to Postgres, alerted', async () => {
    commit({ status: 'suspended' }); // a mirror that never ran
    const r = await run();
    expect(r.corrected.map(c => c.id)).toEqual([A]);
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
    expect(alerts).toHaveLength(1);
  });
  it('Postgres deleted, D1 live: D1 becomes deleted', async () => {
    commit({ deletedAt: new Date() });
    await run();
    expect(await lookupStore({ id: A }, ['active', 'inactive', 'suspended'])).toBeNull();
  });
  it('D1 MORE restrictive than Postgres: kept (a repair never re-opens a store) and alerted', async () => {
    sqlite.prepare("UPDATE stores SET status='suspended' WHERE id=?").run(A);
    const r = await run();
    expect(r.keptRestrictive.map(c => c.id)).toEqual([A]);
    expect(d1Status()).toBe('suspended');
    expect(alerts).toHaveLength(1);
  });
  it('missing from D1 is inserted; a D1 row with no Postgres store is deleted', async () => {
    sqlite.prepare('DELETE FROM stores WHERE id=?').run(A);
    sqlite
      .prepare("INSERT INTO stores (id, name, slug, owner_id) VALUES ('ghost','g','ghost','o')")
      .run();
    const r = await run();
    expect(r.corrected.map(c => c.why).sort()).toEqual([
      'in D1, gone from Postgres',
      'missing from D1',
    ]);
    expect((await lookupStore({ slug: 'alpha' }))?.id).toBe(A);
    expect(await lookupStore({ id: 'ghost' })).toBeNull();
  });
});

describe('every creating path mirrors', () => {
  it('store.service.create and provisioning call syncStoreDirectoryFromPg after the creating write', () => {
    for (const f of [
      'apps/api/src/services/store.service.ts',
      'apps/api/src/services/provisioning.service.ts',
    ])
      expect(fs.readFileSync(f, 'utf8')).toContain('syncStoreDirectoryFromPg(');
  });
  it('the reconciler is on the hourly cron', () => {
    expect(fs.readFileSync('apps/api/src/cf/cron.ts', 'utf8')).toMatch(/store-directory-reconcile/);
  });
});

describe('a store on its Durable Object is never mirrored from Postgres (plan N-22)', () => {
  beforeEach(async () => {
    writes.length = 0;
    commit({});
    await syncStoreDirectoryFromPg(A);
    sqlite.prepare("UPDATE stores SET storage_backend='do', status='suspended' WHERE id=?").run(A);
    commit({ status: 'active' }); // stale Postgres row
    writes.length = 0;
  });
  it('copyStoreSettings does not schedule a mirror for a do store', async () => {
    pg.backend = 'do';
    await copyStoreSettings(A, { status: 'active' }).catch(() => undefined); // the DO stub is absent in this test
    expect(d1Writes()).toBe(0);
    expect(d1Status()).toBe('suspended');
  });
  it('the full-row sync leaves a do row alone', async () => {
    await syncStoreDirectoryFromPg(A);
    expect(d1Writes()).toBe(0);
    expect(d1Status()).toBe('suspended');
  });
  it('the reconciler skips do rows (no overwrite, no delete of a row Postgres does not know)', async () => {
    sqlite
      .prepare(
        "INSERT INTO stores (id, name, slug, owner_id, storage_backend) VALUES ('d-only','d','d-only','o','do')"
      )
      .run();
    const r = await reconcileStoreDirectory({
      pgAll: async () => [
        {
          id: A,
          slug: 'alpha',
          status: 'active',
          plan: 'starter',
          hasDomain: false,
          hasPendingDomain: false,
        },
      ],
      pgLive: async () => [{ id: A }],
      alert: () => undefined,
    });
    expect(r.corrected).toEqual([]);
    expect(r.keptRestrictive).toEqual([]);
    expect(d1Status()).toBe('suspended');
    expect(sqlite.prepare("SELECT COUNT(*) n FROM stores WHERE id='d-only'").get()).toMatchObject({
      n: 1,
    });
  });

  it('NEON-ZERO: with Postgres unreachable the tick never throws and reconciles D1 against the StoreDO only', async () => {
    sqlite.prepare("UPDATE stores SET status='active' WHERE id=?").run(A);
    const alerts: string[] = [];
    const down = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    // the DO says suspended: D1 (active) is less restrictive, so it is closed; the DO slug mismatch is alert-only
    const r = await reconcileStoreDirectory({
      pgAll: down,
      pgLive: down,
      doRecord: async () => ({ slug: 'alpha', status: 'suspended' }),
      alert: t => void alerts.push(t),
    });
    expect(r.postgresSkipped).toBe(true);
    expect(r.corrected.map(c => c.id)).toEqual([A]);
    expect(d1Status()).toBe('suspended');
    expect(alerts).toHaveLength(1);
    // an unreadable DO is reported, never thrown
    const r2 = await reconcileStoreDirectory({
      pgAll: down,
      pgLive: down,
      doRecord: async () => {
        throw new Error('DO unavailable');
      },
      alert: () => undefined,
    });
    expect(r2.alertOnly.map(c => c.id)).toEqual([A]);
  });

  it('PG says suspended or deleted for a do store: the RESTRICTIVE direction is applied (status / deleted_at only) and alerted (NZ-D14)', async () => {
    sqlite.prepare("UPDATE stores SET status='active' WHERE id=?").run(A);
    const alerts: string[] = [];
    const pgRow = (status: string) => [
      { id: A, slug: 'alpha', status, plan: 'starter', hasDomain: false, hasPendingDomain: false },
    ];
    let r = await reconcileStoreDirectory({
      pgAll: async () => pgRow('suspended'),
      pgLive: async () => [{ id: A }],
      alert: t => void alerts.push(t),
    });
    expect(r.corrected.map(c => c.id)).toEqual([A]);
    expect(d1Status()).toBe('suspended');
    expect(d1Backend()).toBe('do');
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
    expect(alerts).toHaveLength(1);
    // Postgres deleted: the D1 row gets a deleted_at and stops resolving
    sqlite.prepare("UPDATE stores SET status='active' WHERE id=?").run(A);
    r = await reconcileStoreDirectory({
      pgAll: async () => pgRow('active'),
      pgLive: async () => [],
      alert: t => void alerts.push(t),
    });
    expect(r.corrected).toHaveLength(1);
    expect(await lookupStore({ id: A }, ['active', 'inactive', 'suspended'])).toBeNull();
    expect(
      (
        sqlite.prepare('SELECT deleted_at FROM stores WHERE id=?').get(A) as {
          deleted_at: number | null;
        }
      ).deleted_at
    ).not.toBeNull();
  });
  it('RESOLVE-SWR-1: every store a repair CORRECTED has its read caches cleared (a repaired suspension must not keep resolving as active)', async () => {
    sqlite.prepare("UPDATE stores SET status='active' WHERE id=?").run(A);
    const busted: string[][] = [];
    const r = await reconcileStoreDirectory({
      pgAll: async () => [
        {
          id: A,
          slug: 'alpha',
          status: 'suspended',
          plan: 'starter',
          hasDomain: false,
          hasPendingDomain: false,
        },
      ],
      pgLive: async () => [],
      alert: () => undefined,
      bust: async ids => void busted.push(ids),
    });
    expect(r.corrected.map(c => c.id)).toEqual([A]);
    expect(busted).toEqual([[A]]);
    // nothing corrected, nothing busted
    busted.length = 0;
    await reconcileStoreDirectory({
      pgAll: async () => [],
      pgLive: async () => [],
      doRecord: async () => ({ slug: 'alpha', status: 'suspended' }),
      alert: () => undefined,
      bust: async ids => void busted.push(ids),
    });
    expect(busted.flat()).toEqual([]);
  });

  it('a do store ABSENT from Postgres: D1 untouched, alert only (never a delete)', async () => {
    const alerts: string[] = [];
    const r = await reconcileStoreDirectory({
      pgAll: async () => [],
      pgLive: async () => [],
      doRecord: async () => ({ slug: 'alpha', status: 'active' }),
      alert: t => void alerts.push(t),
    });
    expect(r.alertOnly.map(a => a.id)).toEqual([A]);
    expect(r.corrected).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM stores WHERE id=?').get(A)).toMatchObject({
      n: 1,
    });
    expect(alerts).toHaveLength(1);
  });

  it('NZ-D18: a domain moved A -> B (both flags stay true) is detected by VALUE and re-synced for a Postgres store', async () => {
    sqlite.prepare("UPDATE stores SET storage_backend='pg', status='active' WHERE id=?").run(A);
    commit({ domain: 'a.example.com', domainStatus: 'active' });
    await syncStoreDirectoryFromPg(A);
    commit({ domain: 'b.example.com', domainStatus: 'active' }); // Postgres moved it; the D1 mirror never ran
    const alerts: string[] = [];
    const r = await reconcileStoreDirectory({
      pgAll: async () => [
        {
          id: A,
          slug: 'alpha',
          status: 'active',
          plan: 'starter',
          hasDomain: true,
          hasPendingDomain: false,
        },
      ],
      pgLive: async () => [{ id: A }],
      pgDomains: async () => ({ domain: 'B.Example.com', pendingDomain: null }),
      alert: t => void alerts.push(t),
    });
    expect(r.corrected.map(c => c.id)).toEqual([A]);
    expect(r.corrected[0].why).toMatch(/domain values/);
    expect((await lookupStore({ domain: 'b.example.com' }))?.id).toBe(A);
    expect(await lookupStore({ domain: 'a.example.com' })).toBeNull();
    expect(alerts).toHaveLength(1);
  });
  it('NZ-D18: equal domains (case-insensitive) are not drift', async () => {
    sqlite.prepare("UPDATE stores SET storage_backend='pg' WHERE id=?").run(A);
    commit({ domain: 'a.example.com', domainStatus: 'active' });
    await syncStoreDirectoryFromPg(A);
    const r = await reconcileStoreDirectory({
      pgAll: async () => [
        {
          id: A,
          slug: 'alpha',
          status: 'active',
          plan: 'starter',
          hasDomain: true,
          hasPendingDomain: false,
        },
      ],
      pgLive: async () => [{ id: A }],
      pgDomains: async () => ({ domain: 'A.EXAMPLE.COM', pendingDomain: null }),
      alert: () => undefined,
    });
    expect(r.corrected).toEqual([]);
  });
  it('NZ-D21: a do store domain is NEVER compared with Postgres (stale by design): no alert, no Postgres read', async () => {
    sqlite
      .prepare("UPDATE stores SET domain='mine.example.com', domain_status='active' WHERE id=?")
      .run(A);
    let reads = 0;
    const r = await reconcileStoreDirectory({
      pgAll: async () => [
        {
          id: A,
          slug: 'alpha',
          status: 'active',
          plan: 'starter',
          hasDomain: true,
          hasPendingDomain: false,
        },
      ],
      pgLive: async () => [{ id: A }],
      pgDomains: async () => (reads++, { domain: 'stale.example.com', pendingDomain: null }),
      doRecord: async () => ({ slug: 'alpha', status: 'active' }),
      alert: () => undefined,
    });
    expect(reads).toBe(0);
    expect(r.alertOnly).toEqual([]);
    expect(r.corrected).toEqual([]);
    expect(sqlite.prepare('SELECT domain FROM stores WHERE id=?').get(A)).toMatchObject({
      domain: 'mine.example.com',
    });
  });
  it('NZ-D21: closing a do row for a deleted Postgres store never LOOSENS a stricter D1 status', async () => {
    sqlite.prepare("UPDATE stores SET status='suspended' WHERE id=?").run(A);
    await reconcileStoreDirectory({
      pgAll: async () => [
        {
          id: A,
          slug: 'alpha',
          status: 'active',
          plan: 'starter',
          hasDomain: false,
          hasPendingDomain: false,
        },
      ],
      pgLive: async () => [], // deleted in Postgres, status still `active` there
      alert: () => undefined,
    });
    expect(d1Status()).toBe('suspended');
    expect(
      (sqlite.prepare('SELECT deleted_at FROM stores WHERE id=?').get(A) as { deleted_at: unknown })
        .deleted_at
    ).not.toBeNull();
  });
});

describe('D1 stores vs DO store_profile mirror (template / look / name / nameAr, Ruling NZ-D8)', () => {
  beforeEach(async () => {
    commit({});
    await syncStoreDirectoryFromPg(A);
    sqlite.prepare("UPDATE stores SET storage_backend='do', status='suspended' WHERE id=?").run(A);
  });
  const pgOne = {
    id: A,
    slug: 'alpha',
    status: 'active',
    plan: 'starter',
    hasDomain: false,
    hasPendingDomain: false,
  };
  const down = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const inSync = {
    slug: 'alpha',
    status: 'suspended',
    name: 'Alpha',
    nameAr: null,
    template: 'qamar',
    look: null,
  };

  it('a DO whose template or look differs from D1 is re-pushed from D1 (D1 is authoritative) and alerted, in the Postgres tick', async () => {
    const pushed: Array<[string, Record<string, unknown>]> = [];
    const alerts: string[] = [];
    const r = await reconcileStoreDirectory({
      pgAll: async () => [{ ...pgOne, status: 'suspended' }],
      pgLive: async () => [{ id: A }],
      doRecord: async () => ({ ...inSync, template: 'souq', look: 'souq.atelier' }),
      repairMirror: async (id, f) => void pushed.push([id, f]),
      alert: t => void alerts.push(t),
    });
    expect(pushed).toEqual([[A, { template: 'qamar', look: null }]]);
    expect(r.corrected.map(c => c.id)).toEqual([A]);
    expect(r.corrected[0].why).toMatch(/template, look/);
    expect(alerts).toHaveLength(1);
  });

  it('an Arabic name that exists in D1 but not in the DO is re-pushed; an in-sync store is silent', async () => {
    sqlite.prepare("UPDATE stores SET name_ar='ألفا' WHERE id=?").run(A);
    const pushed: Array<Record<string, unknown>> = [];
    let r = await reconcileStoreDirectory({
      pgAll: down,
      pgLive: down,
      doRecord: async () => ({ ...inSync }),
      repairMirror: async (_id, f) => void pushed.push(f),
      alert: () => undefined,
    });
    expect(pushed).toEqual([{ nameAr: 'ألفا' }]);
    expect(r.corrected[0].why).toMatch(/nameAr/);
    pushed.length = 0;
    r = await reconcileStoreDirectory({
      pgAll: down,
      pgLive: down,
      doRecord: async () => ({ ...inSync, nameAr: 'ألفا' }),
      repairMirror: async (_id, f) => void pushed.push(f),
      alert: () => undefined,
    });
    expect(pushed).toEqual([]);
    expect(r.corrected).toEqual([]);
  });

  it('a merchant edit made mid-tick is never overwritten with the older D1 value, and raises no alert', async () => {
    const pushed: Array<Record<string, unknown>> = [];
    const alerts: string[] = [];
    let reads = 0;
    // First DO read (initial compare): DO is behind D1 'qamar'. Before the repair the merchant switches D1 to 'souq' and
    // the DO copy converges to it (the live write path), so the re-read finds nothing to repair.
    const r = await reconcileStoreDirectory({
      pgAll: down,
      pgLive: down,
      doRecord: async () => {
        reads++;
        if (reads === 1) return { ...inSync, template: 'jasmine' };
        sqlite.prepare("UPDATE stores SET template='souq' WHERE id=?").run(A);
        return { ...inSync, template: 'souq' };
      },
      repairMirror: async (_id, f) => void pushed.push(f),
      alert: t => void alerts.push(t),
    });
    expect(pushed).toEqual([]);
    expect(r.corrected).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('an edit that lands in D1 mid-tick repairs with the FRESH D1 value, not the stale one', async () => {
    const pushed: Array<Record<string, unknown>> = [];
    let reads = 0;
    await reconcileStoreDirectory({
      pgAll: down,
      pgLive: down,
      doRecord: async () => {
        reads++;
        if (reads === 2) sqlite.prepare("UPDATE stores SET template='souq' WHERE id=?").run(A);
        return { ...inSync, template: 'jasmine' };
      },
      repairMirror: async (_id, f) => void pushed.push(f),
      alert: () => undefined,
    });
    expect(pushed).toEqual([{ template: 'souq' }]);
  });

  it('a repair that fails is alert-only, never thrown', async () => {
    const r = await reconcileStoreDirectory({
      pgAll: down,
      pgLive: down,
      doRecord: async () => ({ ...inSync, template: 'souq' }),
      repairMirror: async () => {
        throw new Error('applySettings refused');
      },
      alert: () => undefined,
    });
    expect(r.alertOnly[0].why).toMatch(/could not be repaired/);
  });
});
