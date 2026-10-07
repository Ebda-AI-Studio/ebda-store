import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Issue 2212: `taxRatePercent` rides the cached `public:store:*` payloads
 * (Redis 120s + edge s-maxage/SWR), and no tax write busted them — a merchant
 * enabling a 5% rate had checkout display a total without it while
 * order-create charged it. Every TaxService write now busts the store's
 * public caches, AFTER the request's tenant transaction commits.
 */

const { mockBustById, mockDefer, rateRow } = vi.hoisted(() => ({
  rateRow: { id: 'rate-1', storeId: 'store-1', rate: 5, isActive: true },
  mockBustById: vi.fn().mockResolvedValue(undefined),
  // Outside a request, deferAfterTenantCommit runs the task inline.
  mockDefer: vi.fn((_name: string, run: () => Promise<unknown>) => run()),
}));

vi.mock('../store.service', () => ({ bustStoreCachesById: mockBustById }));
vi.mock('../../lib/after-tenant-commit', () => ({ deferAfterTenantCommit: mockDefer }));
vi.mock('../feature.service', () => ({ featureService: {} }));
vi.mock('../../lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@force/database', () => ({
  Prisma: {},
  prisma: {
    store: {
      update: vi.fn().mockResolvedValue({
        taxEnabled: true,
        taxIncludedInPrice: false,
        defaultTaxRate: null,
      }),
    },
    // updateSettings({ taxEnabled: true }) is gated on a VERIFIED profile (ruling TAX-2).
    storeTaxProfile: { findUnique: vi.fn().mockResolvedValue({ status: 'verified' }) },
    taxRate: {
      create: vi.fn().mockResolvedValue(rateRow),
      update: vi.fn().mockResolvedValue(rateRow),
      delete: vi.fn().mockResolvedValue(rateRow),
      findFirst: vi.fn().mockResolvedValue(rateRow),
    },
  },
}));

import { TaxService } from '../tax.service';

describe('TaxService writes bust the public store caches (issue 2212)', () => {
  beforeEach(() => vi.clearAllMocks());

  const writes: Array<[string, () => Promise<unknown>]> = [
    ['updateSettings', () => TaxService.updateSettings('store-1', { taxEnabled: true })],
    ['createRate', () => TaxService.createRate('store-1', { name: 'VAT', rate: 5 } as never)],
    ['updateRate', () => TaxService.updateRate('store-1', 'rate-1', { rate: 7 } as never)],
    ['deleteRate', () => TaxService.deleteRate('store-1', 'rate-1')],
    ['toggleRate', () => TaxService.toggleRate('store-1', 'rate-1')],
  ];

  it.each(writes)(
    '%s busts public:store:* for that store, deferred past the commit',
    async (_n, write) => {
      await write();
      expect(mockDefer).toHaveBeenCalledWith('tax.bustStoreCaches', expect.any(Function));
      expect(mockBustById).toHaveBeenCalledWith('store-1');
    }
  );

  it('reads do not bust', async () => {
    await TaxService.getRate('store-1', 'rate-1');
    expect(mockBustById).not.toHaveBeenCalled();
  });
});
