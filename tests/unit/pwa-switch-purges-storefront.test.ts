/**
 * PW1: the phone-app switch decides whether the storefront links a manifest, and that lives in the store
 * record the layout resolves plus the edge HTML copy. Saving the switch must purge by slug/domain, not only
 * the manifest tag (NEVER-stale class: an install link that outlives the switch is the bug).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueMock = vi.fn();
const storeUpdateMock = vi.fn();
const revalidate = vi.fn();

vi.mock('@ebda/database', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any> = {
    prisma: { store: { findUnique: findUniqueMock, update: vi.fn() } },
    Prisma: {},
  };
  mod.withStore = (_id: string, fn: (tx: unknown) => unknown) => fn(mod.prisma);
  return mod;
});
vi.mock('@api/services/feature.service', () => ({ featureService: { isFeatureEnabled: vi.fn() } }));
vi.mock('@api/services/storage.service', () => ({ StorageService: { upload: vi.fn() } }));
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storeWritesToDo: async () => false,
  storeUpdate: (_db: unknown, args: unknown) => storeUpdateMock(args),
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: revalidate }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('PWAService.updateSettings purges the storefront', () => {
  beforeEach(() => {
    revalidate.mockClear();
    findUniqueMock.mockResolvedValue({
      name: 'Amelia',
      pwaSettings: {},
      slug: 'amelia',
      domain: 'ameliaaurum.com',
    });
    storeUpdateMock.mockResolvedValue({ pwaEnabled: false, pwaSettings: {} });
  });

  it('turning the switch off purges the store record and edge copy, plus the manifest tag', async () => {
    const { PWAService } = await import('@api/services/pwa.service');
    await PWAService.updateSettings('store-1', { pwaEnabled: false });
    expect(revalidate).toHaveBeenCalledWith({
      slug: 'amelia',
      domain: 'ameliaaurum.com',
      tags: ['pwa:store-1'],
    });
  });
});
