/**
 * Unit test: StoreService.updateTheme treats a null value as "delete this key"
 * (reset one look override back to the look default).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────
// vi.hoisted so these are initialised before the hoisted vi.mock factory runs.
const { updateMock, findUniqueMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock('@force/database', () => ({
  prisma: {
    store: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
  // Re-export Prisma namespace shape used for typing only.
  Prisma: {},
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
}));

vi.mock('@force/shared', async importOriginal => ({
  // Keep the real region config (REGION is read at import time by api config/services).
  ...(await importOriginal<typeof import('@force/shared')>()),
  slugify: (s: string) => s,
}));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  memoryCache: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));

vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: vi.fn(),
}));

import { StoreService } from '../../apps/api/src/services/store.service';

const STORE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StoreService.updateTheme: null deletes a key', () => {
  it('removes a stored key when the payload sends null for it (reset one override)', async () => {
    findUniqueMock.mockResolvedValue({
      id: STORE_ID,
      slug: 'demo',
      domain: null,
      theme: { accentColor: '#222222', fontFamily: 'Cairo' },
    });
    updateMock.mockImplementation(({ data }) =>
      Promise.resolve({ id: STORE_ID, slug: 'demo', ...data })
    );

    await StoreService.updateTheme(STORE_ID, { accentColor: null });

    const merged = updateMock.mock.calls[0][0].data.theme;
    expect('accentColor' in merged).toBe(false);
    expect(merged.fontFamily).toBe('Cairo');
  });

  it('does not store a null for a key that was never set', async () => {
    findUniqueMock.mockResolvedValue({ id: STORE_ID, slug: 'demo', domain: null, theme: {} });
    updateMock.mockImplementation(({ data }) =>
      Promise.resolve({ id: STORE_ID, slug: 'demo', ...data })
    );

    await StoreService.updateTheme(STORE_ID, { accentColor: null, primaryColor: '#ff6e01' });

    expect(updateMock.mock.calls[0][0].data.theme).toEqual({ primaryColor: '#ff6e01' });
  });
});
