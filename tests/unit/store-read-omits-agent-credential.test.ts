/**
 * A wide store read must never carry the agent (MCP) write credential.
 *
 * `Store.agentApiKey` holds the AES-256-GCM ciphertext of the per-store agent
 * key. Prisma returns EVERY scalar column by default, so the three
 * `StoreService` reads that hand a whole Store row to a caller —
 * `GET /stores/:id`, the admin store list, and the slug read that also writes
 * the row into a 120s Redis cache — shipped the ciphertext to the browser the
 * moment the column was added. The parent PR (#1617) caught it in its
 * blast-radius sweep and added `omit: { agentApiKey: true }` at all three
 * boundaries; nothing then asserted it, so the next `include`/`select` refactor
 * could quietly put it back.
 *
 * This is the assertion. It reads the ARGUMENTS handed to Prisma rather than
 * the returned row, because a mocked client does not apply `omit` — and because
 * the argument is the thing that would be deleted. The end-to-end proof that
 * the live endpoint does not return it lives in
 * `tests/integration/mcp/agent-key-admin-api.test.ts`.
 *
 * `getBySlug` additionally writes its result to Redis, so a leak there is not
 * one response — it is a cached one, served to everyone for the TTL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findUniqueMock, findManyMock, countMock, redisGetMock, redisSetMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findManyMock: vi.fn(),
  countMock: vi.fn(),
  redisGetMock: vi.fn(),
  redisSetMock: vi.fn(),
}));

vi.mock('@force/database', () => ({
  prisma: {
    store: {
      findUnique: findUniqueMock,
      findMany: findManyMock,
      count: countMock,
      update: vi.fn(),
    },
  },
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
  ...(await importOriginal<typeof import('@force/shared')>()),
  slugify: (s: string) => s,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: redisGetMock, set: redisSetMock },
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
const STORE_ROW = { id: STORE_ID, slug: 'acme', name: 'Acme' };

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue(STORE_ROW);
  findManyMock.mockResolvedValue([STORE_ROW]);
  countMock.mockResolvedValue(1);
  // Force the DB path in getBySlug rather than a cache hit.
  redisGetMock.mockResolvedValue(null);
});

describe('StoreService omits the agent credential at every wide read', () => {
  it('getById asks Prisma to omit agentApiKey', async () => {
    await StoreService.getById(STORE_ID);
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ omit: { agentApiKey: true } })
    );
  });

  it('list asks Prisma to omit agentApiKey', async () => {
    await StoreService.list({});
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ omit: { agentApiKey: true } })
    );
  });

  it('getBySlug asks Prisma to omit agentApiKey BEFORE writing the row to Redis', async () => {
    await StoreService.getBySlug('acme');
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ omit: { agentApiKey: true } })
    );
    // Whatever was cached is what every subsequent reader gets for 120s.
    expect(redisSetMock).toHaveBeenCalled();
    expect(JSON.stringify(redisSetMock.mock.calls[0])).not.toContain('agentApiKey');
  });
});
