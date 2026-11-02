/**
 * Hotfix N-22 (security review 2026-11-02): every Postgres Store write reaches the D1 directory that lookups read.
 * Service-layer paths (storeUpdate / storeUpdateMany / full-row sync after create) against a REAL platform D1 schema on node:sqlite.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';

const pg = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: async (id: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: async () => pg.rows.get(id) ?? null } }),
}));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async () => 'pg',
  storeDo: () => ({}),
}));

import {
  lookupStore,
  storeIdBySlug,
  storeIdByDomain,
  storeIdsClaimingDomain,
} from '../../apps/api/src/lib/definer';
import {
  mirrorStoreDirectory,
  syncStoreDirectoryFromPg,
} from '../../apps/api/src/lib/store-directory-sync';
import { copyStoreSettings } from '../../apps/api/src/lib/repo-factory';

let sqlite: DatabaseSync;
const asD1 = () => ({
  prepare: (sql: string) => ({
    bind: (...v: unknown[]) => {
      const run = async () => {
        await Promise.resolve();
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
  setCfBindings({ PLATFORM_DB: asD1() } as never);
});

describe('directory dual-write (Postgres authoritative -> D1 lookups)', () => {
  it('create: a new store is resolvable by slug and id after the full-row sync (and 404 before)', async () => {
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    expect(await lookupStore({ slug: 'alpha' })).toEqual({ id: A, status: 'active' });
    expect(await storeIdBySlug('alpha')).toBe(A);
    expect(
      (
        sqlite.prepare('SELECT storage_backend FROM stores WHERE id=?').get(A) as {
          storage_backend: string;
        }
      ).storage_backend
    ).toBe('pg');
  });
  it('suspend and activate reach D1 through the storeUpdate chokepoint', async () => {
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    await copyStoreSettings(A, { status: 'suspended' });
    expect(await lookupStore({ slug: 'alpha' }, ['active'])).toBeNull();
    expect(await lookupStore({ slug: 'alpha' }, ['active', 'suspended'])).toEqual({
      id: A,
      status: 'suspended',
    });
    await copyStoreSettings(A, { status: 'active' });
    expect(await lookupStore({ slug: 'alpha' })).toEqual({ id: A, status: 'active' });
  });
  it('soft delete: a deleted store never resolves', async () => {
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    await copyStoreSettings(A, { deletedAt: new Date() });
    expect(await lookupStore({ id: A }, ['active', 'inactive', 'suspended'])).toBeNull();
  });
  it('slug change: the old slug 404s, the new one resolves', async () => {
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    await copyStoreSettings(A, { slug: 'renamed' });
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
    expect((await lookupStore({ slug: 'renamed' }))?.id).toBe(A);
  });
  it('domain claim, verify and release', async () => {
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    await copyStoreSettings(A, {
      pendingDomain: 'shop.example.com',
      domainStatus: 'pending',
      domainClaimedAt: new Date(),
    });
    expect(await storeIdsClaimingDomain('shop.example.com')).toEqual([A]);
    expect(await lookupStore({ domain: 'shop.example.com' })).toBeNull(); // unverified never resolves
    await copyStoreSettings(A, {
      domain: 'shop.example.com',
      domainStatus: 'active',
      pendingDomain: null,
      domainVerifiedAt: new Date(),
    });
    expect((await lookupStore({ domain: 'shop.example.com' }))?.id).toBe(A);
    expect(await storeIdByDomain('shop.example.com')).toBe(A);
    await copyStoreSettings(A, { domain: null, domainStatus: null, domainVerifiedAt: null });
    expect(await lookupStore({ domain: 'shop.example.com' })).toBeNull();
  });
  it('a patch with no D1 column writes nothing; a store missing from D1 is a loud 503; an operator value is refused', async () => {
    await expect(copyStoreSettings(A, { theme: { a: 1 } })).resolves.toBeUndefined();
    await expect(mirrorStoreDirectory(A, { status: 'suspended' })).rejects.toMatchObject({
      statusCode: 503,
    });
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    await expect(mirrorStoreDirectory(A, { name: { set: 'x' } })).rejects.toMatchObject({
      statusCode: 500,
    });
  });
  it('a store gone from Postgres is removed from D1; unbound D1 is a no-op', async () => {
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    pg.rows.delete(A);
    await syncStoreDirectoryFromPg(A);
    expect(await lookupStore({ id: A })).toBeNull();
    clearCfBindings();
    await expect(syncStoreDirectoryFromPg(A)).resolves.toBeUndefined();
  });
  it('the D1 backend flag is never written by the mirror (D1 owns it)', async () => {
    pg.rows.set(A, base());
    await syncStoreDirectoryFromPg(A);
    sqlite.prepare("UPDATE stores SET storage_backend='do' WHERE id=?").run(A);
    await syncStoreDirectoryFromPg(A);
    await copyStoreSettings(A, { name: 'x' });
    expect(
      (
        sqlite.prepare('SELECT storage_backend FROM stores WHERE id=?').get(A) as {
          storage_backend: string;
        }
      ).storage_backend
    ).toBe('do');
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
});
