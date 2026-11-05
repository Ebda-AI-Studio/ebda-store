/**
 * Ruling NZ-PG-1: `storeDirectory()` is answered from D1 wherever the platform D1 is bound. The D1 listing pages through the
 * WHOLE directory (keyset, no cap); a filter that reads a per-store switch makes the resolver read that store's DO, a filter
 * that does not never touches a DO; an unreadable DO keeps the store; with no D1 bound the resolver answers undefined (the
 * Postgres definer stays the answer in Node / tests / local dev).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bound: true,
  d1Calls: [] as Array<{ sql: string; params: unknown[] }>,
  rows: [] as Array<Record<string, unknown>>,
  switches: {} as Record<
    string,
    { accountingEnabled: boolean; aiFeaturesEnabled: boolean; loyaltyEnabled: boolean } | 'throw'
  >,
  doReads: [] as string[],
}));
vi.mock('@api/lib/platform-directory', () => ({ platformDb: () => (h.bound ? {} : undefined) }));
vi.mock('@api/services/platform/billing-d1', () => ({
  fromMs: (n: number | null) => (n === null ? null : new Date(n)),
  d1All: async (sql: string, ...params: unknown[]) => {
    h.d1Calls.push({ sql, params });
    const after = String(params[0] ?? '');
    return h.rows.filter(r => String(r.id) > after).slice(0, 1000);
  },
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async (id: string) => ({
    store: {
      findUnique: async () => {
        h.doReads.push(id);
        const s = h.switches[id];
        if (s === 'throw') throw new Error('DO unreachable');
        return s ?? null;
      },
    },
  }),
}));
vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { d1DirectoryEntries } from '@api/services/platform/directory-entries';
import { listDirectoryStores } from '@api/services/platform/directory-d1';

const row = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `store-${String(i).padStart(5, '0')}`,
  name: `n${i}`,
  name_ar: null,
  slug: `s${i}`,
  status: 'active',
  plan: 'starter',
  owner_id: 'o',
  is_demo: 0,
  storage_backend: 'do',
  deleted_at: null,
  has_domain: 1,
  has_pending_domain: 0,
  ...extra,
});

beforeEach(() => {
  h.bound = true;
  h.d1Calls = [];
  h.doReads = [];
  h.switches = {};
  h.rows = [row(1), row(2), row(3)];
});

describe('NZ-PG-1: the store directory from D1', () => {
  it('no D1 bound: undefined (the Postgres definer answers)', async () => {
    h.bound = false;
    expect(await d1DirectoryEntries({ includeDeleted: false })).toBeUndefined();
    expect(h.d1Calls).toHaveLength(0);
  });

  it('pages through every store (more than one page, more than the old 500 cap), none cut', async () => {
    h.rows = Array.from({ length: 2503 }, (_, i) => row(i));
    const all = await listDirectoryStores();
    expect(all).toHaveLength(2503);
    expect(h.d1Calls).toHaveLength(3); // 1000 + 1000 + 503
    expect(all[2502].id).toBe('store-02502');
    expect(all[0]).toMatchObject({
      hasDomain: true,
      hasPendingDomain: false,
      storageBackend: 'do',
    });
  });

  it('maps the entry the definer returned (domain flags, status, plan)', async () => {
    h.rows = [row(1, { has_domain: 0, has_pending_domain: 1, status: 'suspended', plan: 'free' })];
    const [e] = (await d1DirectoryEntries({ includeDeleted: false }))!;
    expect(e).toMatchObject({
      id: 'store-00001',
      status: 'suspended',
      plan: 'free',
      hasDomain: false,
      hasPendingDomain: true,
    });
  });

  it('a filter that does not read a switch never touches a DO', async () => {
    h.rows = [row(1), row(2, { status: 'inactive' })];
    const out = await d1DirectoryEntries({
      includeDeleted: false,
      filter: s => s.status === 'active',
    });
    expect(out!.map(s => s.id)).toEqual(['store-00001']);
    expect(h.doReads).toEqual([]);
  });

  it('a filter that reads a switch asks the store DO and decides on the real value', async () => {
    h.switches = {
      'store-00001': { accountingEnabled: true, aiFeaturesEnabled: true, loyaltyEnabled: false },
      'store-00002': { accountingEnabled: false, aiFeaturesEnabled: true, loyaltyEnabled: false },
      'store-00003': { accountingEnabled: true, aiFeaturesEnabled: false, loyaltyEnabled: false },
    };
    const out = await d1DirectoryEntries({
      includeDeleted: false,
      filter: s => s.accountingEnabled && s.aiFeaturesEnabled,
    });
    expect(out!.map(s => s.id)).toEqual(['store-00001']);
    expect(out![0]).toMatchObject({ accountingEnabled: true, aiFeaturesEnabled: true });
    expect(h.doReads.sort()).toEqual(['store-00001', 'store-00002', 'store-00003']);
  });

  it('an unreadable DO keeps the store (the job gate decides); the others are still decided', async () => {
    h.switches = {
      'store-00001': 'throw',
      'store-00002': { accountingEnabled: false, aiFeaturesEnabled: true, loyaltyEnabled: false },
      'store-00003': { accountingEnabled: true, aiFeaturesEnabled: true, loyaltyEnabled: false },
    };
    const out = await d1DirectoryEntries({
      includeDeleted: false,
      filter: s => s.accountingEnabled,
    });
    expect(out!.map(s => s.id)).toEqual(['store-00001', 'store-00003']);
  });

  it('includeDeleted lists soft-deleted stores too (no deleted_at predicate)', async () => {
    await d1DirectoryEntries({ includeDeleted: true });
    expect(h.d1Calls[0].sql).not.toContain('deleted_at IS NULL');
    h.d1Calls = [];
    await d1DirectoryEntries({ includeDeleted: false });
    expect(h.d1Calls[0].sql).toContain('deleted_at IS NULL');
  });
});
