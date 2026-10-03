/**
 * #1950 — the UNMOCKED-service half of the mass-assignment guard.
 *
 * tests/unit/mass-assignment-prohibited-fields.test.ts asserts that prohibited
 * fields never reach the mocked `*Service` call. That leaves the service layer
 * itself unobserved: if `StoreService.update` ever spread its input into
 * `prisma.store.update({ data: { ...data } })`, a caller that forwarded an
 * over-wide object (a schema gaining `.passthrough()`, a new route skipping
 * Zod) would write `ownerId` / `plan` / `status` / credentials straight to the
 * row. This drives the REAL `StoreService.update` against a recording Prisma
 * stand-in and asserts on the `data` object Prisma is actually handed.
 */
import { describe, it, expect, vi } from 'vitest';

const { storeUpdate } = vi.hoisted(() => ({ storeUpdate: vi.fn() }));

vi.mock('@force/database', () => {
  const existing = {
    id: 'store-1',
    slug: 'store-one',
    domain: null,
    settings: {},
    heroImage: null,
  };
  return {
    Prisma: {},
    StoreStatus: { active: 'active', suspended: 'suspended' },
    withMoneyTx: vi.fn(),
    // store payloads carry row counts, read inside the store's own scope (`withStore`): zero here.
    withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
      fn({
        // the transaction client is the same fake client, plus the zero counts
        ...(await import('@force/database')).prisma,
        product: { count: async () => 0 },
        category: { count: async () => 0 },
        order: { count: async () => 0 },
      }),
    acrossStores: async (_fn: unknown, o?: { storeIds?: string[] }) =>
      (o?.storeIds ?? []).map(storeId => ({ storeId, value: { products: 0, orders: 0 } })),
    prisma: {
      store: {
        findUnique: vi.fn(async () => existing),
        update: storeUpdate.mockImplementation(async ({ data }: { data: object }) => ({
          ...existing,
          ...data,
        })),
      },
    },
  };
});

vi.mock('@api/services/redis.service', () => ({
  redis: { delete: vi.fn(), isAvailable: () => false, getClient: () => null },
}));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));
vi.mock('@api/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));
vi.mock('@api/lib/after-tenant-commit', () => ({ deferAfterTenantCommit: vi.fn() }));

import { StoreService } from '@api/services/store.service';

const PROHIBITED = [
  'id',
  'storeId',
  'ownerId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'plan',
  'status',
  'agentApiKey',
  'wbsApiKey',
  'metaAccessToken',
] as const;

describe('StoreService.update — Prisma `data` is enumerated, never spread (#1950)', () => {
  it('drops every prohibited field an over-wide caller forwards', async () => {
    const overWide = {
      name: 'Renamed',
      heroTitle: 'Hi',
      ...Object.fromEntries(PROHIBITED.map(k => [k, `evil-${k}`])),
    };

    await StoreService.update('store-1', overWide as never);

    expect(storeUpdate).toHaveBeenCalledTimes(1);
    const { data } = storeUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    // Positive control: the legitimate fields DID reach Prisma, so an empty
    // or skipped write cannot pass this test.
    expect(data.name).toBe('Renamed');
    expect(data.heroTitle).toBe('Hi');
    for (const key of PROHIBITED) {
      expect(data, `prisma.store.update data must not carry ${key}`).not.toHaveProperty(key);
    }
  });
});
