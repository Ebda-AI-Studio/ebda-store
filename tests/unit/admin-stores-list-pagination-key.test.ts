/**
 * Super-admin /stores header ("N stores on the platform") reads `data.pagination.total`. The list service used to
 * return `meta`, so the header showed 0 while 7 stores were listed (QA 2026-11-23). Both backends must return `pagination`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../apps/api/src/lib/platform-hub', () => ({
  hubOnD1: vi.fn(async () => true),
  hubStorePage: vi.fn(async () => ({
    rows: [{ id: 's1', ownerId: 'o1' }],
    total: 7,
  })),
  hubOwners: vi.fn(async () => new Map()),
  hubFanout: vi.fn(async () => []),
}));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('../../apps/api/src/lib/repo-factory')>()),
  storeDb: vi.fn(),
}));

import { ProvisioningService } from '../../apps/api/src/services/provisioning.service';

describe('ProvisioningService.listStores pagination contract', () => {
  it('returns the real total under `pagination` (not page length, not `meta`)', async () => {
    const r = (await ProvisioningService.listStores({ page: 1, limit: 1 })) as unknown as {
      stores: unknown[];
      pagination?: { total: number; totalPages: number };
      meta?: unknown;
    };
    expect(r.pagination).toEqual({ page: 1, limit: 1, total: 7, totalPages: 7 });
    expect(r.meta).toBeUndefined();
  });
});
