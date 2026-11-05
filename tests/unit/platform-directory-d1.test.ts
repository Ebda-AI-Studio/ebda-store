/**
 * NEON-ZERO-1: the store directory resolves from D1 with NO Postgres. Runs the real cf-schema platform migration on a
 * real SQLite (node:sqlite, same engine family as D1) and drives lookupStore / storeIdBySlug / ... through `definer.ts`
 * with a PLATFORM_DB binding set and `prisma` poisoned: any Postgres call fails the test.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';

vi.mock('@ebda/database', () => {
  const boom = () => {
    throw new Error('POSTGRES TOUCHED');
  };
  return {
    prisma: new Proxy({}, { get: boom }),
    withSystemJob: boom,
    withStore: boom,
    withUser: boom,
  };
});

import {
  lookupStore,
  storeIdByDomain,
  storeIdBySlug,
  storeIdsClaimingDomain,
  publicStorePage,
  resolveStoreId,
} from '../../apps/api/src/lib/definer';

const sqlite = new DatabaseSync(':memory:');
// the D1 surface the directory uses, over node:sqlite
const d1 = {
  prepare(sql: string) {
    return {
      bind: (...v: unknown[]) => ({
        first: async () => (sqlite.prepare(sql).get(...(v as never[])) as never) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...(v as never[])) as never[] }),
      }),
    };
  },
};

const ins = (
  id: string,
  slug: string,
  o: {
    status?: string;
    domain?: string;
    ds?: string;
    pending?: string;
    deleted?: number;
    at?: number;
  } = {}
) =>
  sqlite
    .prepare(
      `INSERT INTO stores (id, name, slug, owner_id, status, domain, domain_status, pending_domain, deleted_at, created_at)
       VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      slug,
      slug,
      o.status ?? 'active',
      o.domain ?? null,
      o.ds ?? null,
      o.pending ?? null,
      o.deleted ?? null,
      o.at ?? 1
    );

beforeAll(() => {
  const dir = 'packages/cf-schema/migrations/platform';
  for (const f of ['0001_init.sql', '0002_invariants.sql'])
    sqlite.exec(readFileSync(`${dir}/${f}`, 'utf8'));
  ins('a', 'alpha', { domain: 'alpha.com', ds: 'active', at: 1 });
  ins('b', 'beta', {
    status: 'suspended',
    domain: 'beta.com',
    ds: 'pending',
    pending: 'beta.com',
    at: 2,
  });
  ins('c', 'gone', { deleted: 5, at: 3 });
  ins('d', 'dormant', { status: 'inactive', at: 4 });
  setCfBindings({ PLATFORM_DB: d1 } as never);
});
afterAll(() => clearCfBindings());

describe('store directory from D1 (no Postgres)', () => {
  it('resolves by slug, id and VERIFIED domain', async () => {
    expect(await lookupStore({ slug: 'alpha' })).toEqual({ id: 'a', status: 'active' });
    expect(await lookupStore({ id: 'a' })).toEqual({ id: 'a', status: 'active' });
    expect(await lookupStore({ domain: 'alpha.com' })).toEqual({ id: 'a', status: 'active' });
  });
  it('an unverified domain, an unknown slug, a deleted store and a wrong status are null (404), never PG', async () => {
    expect(await lookupStore({ domain: 'beta.com' }, ['active', 'suspended'])).toBeNull();
    expect(await lookupStore({ slug: 'nope' })).toBeNull();
    expect(await lookupStore({ slug: 'gone' }, ['active', 'inactive', 'suspended'])).toBeNull();
    expect(await lookupStore({ slug: 'dormant' }, ['active', 'suspended'])).toBeNull();
    expect(await lookupStore({ slug: 'beta' })).toBeNull();
    expect(await lookupStore({ slug: 'beta' }, ['active', 'suspended'])).toEqual({
      id: 'b',
      status: 'suspended',
    });
    expect(await lookupStore({})).toBeNull();
  });
  it('id wins over slug when both match different stores', async () => {
    expect(await lookupStore({ id: 'a', slug: 'beta' }, ['active', 'suspended'])).toEqual({
      id: 'a',
      status: 'active',
    });
  });
  it('slug / domain uniqueness probes count any status and deleted rows; claims read pending_domain', async () => {
    expect(await storeIdBySlug('gone')).toBe('c');
    expect(await storeIdBySlug('nope')).toBeNull();
    expect(await storeIdByDomain('alpha.com')).toBe('a');
    expect(await storeIdsClaimingDomain('beta.com')).toEqual(['b']);
  });
  it('host -> store (the public request resolver) is D1 too: active only, verified domain only, never PG', async () => {
    expect(await resolveStoreId({ slug: 'alpha' })).toBe('a');
    expect(await resolveStoreId({ domain: 'alpha.com' })).toBe('a');
    expect(await resolveStoreId({ domain: 'beta.com' })).toBeNull(); // unverified
    expect(await resolveStoreId({ slug: 'beta' })).toBeNull(); // suspended is not 'active'
    expect(await resolveStoreId({ slug: 'nope' })).toBeNull();
    expect(await resolveStoreId({})).toBeNull();
  });
  it('public page: active + live only, newest first, with the total', async () => {
    expect(await publicStorePage(0, 10)).toEqual({ ids: ['a'], total: 1 });
    expect(await publicStorePage(5, 10)).toEqual({ ids: [], total: 1 });
  });
  it('an unreadable D1 is a 503, never a fallback', async () => {
    setCfBindings({
      PLATFORM_DB: {
        prepare: () => ({
          bind: () => ({ first: async () => Promise.reject(new Error('d1 down')) }),
        }),
      },
    } as never);
    await expect(lookupStore({ slug: 'alpha' })).rejects.toMatchObject({ statusCode: 503 });
    setCfBindings({ PLATFORM_DB: d1 } as never);
  });
});
