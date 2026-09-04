/**
 * Every field PUT /stores/:id accepts must actually reach the database.
 *
 * StoreService.update builds its Prisma `data` as an explicit column whitelist.
 * That whitelist drifted from `updateStoreSchema` and three fields fell through
 * it — accepted by the route, declared on the service's own type, and written
 * nowhere:
 *
 *   returnWindowDays, returnFeesPaidBy   the admin saw "Saved", the column
 *                                        stayed NULL, and the value came back
 *                                        blank on reload. With it NULL,
 *                                        merchantReturnPolicyJsonLd() returns
 *                                        null forever, so the entire
 *                                        return-policy feature was dead.
 *   locationsEnabled                     the toggle appeared to work because
 *                                        the tab sets state optimistically;
 *                                        after a reload it was off again and
 *                                        the public locations route kept 404ing.
 *
 * Typing the fields did nothing — a whitelist omits what it omits. So this test
 * asserts the ROUND TRIP rather than the shape: hand update() every field the
 * schema accepts, and require each one to appear in what Prisma is asked to
 * write. A field added to the schema and forgotten here fails immediately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, findUniqueMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
}));

vi.mock('@force/database', () => ({
  prisma: { store: { findUnique: findUniqueMock, update: updateMock } },
  Prisma: {},
  withMoneyTx: vi.fn(),
}));
vi.mock('@force/shared', () => ({ slugify: (s: string) => s }));
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

/** Everything `updateStoreSchema` accepts, with a distinguishable value each. */
const EVERY_ACCEPTED_FIELD = {
  name: 'New Name',
  heroTitle: 'Hero',
  heroTitleAr: 'بطل',
  heroSubtitle: 'Sub',
  heroSubtitleAr: 'فرعي',
  heroCtaText: 'Shop',
  heroCtaTextAr: 'تسوق',
  heroCtaLink: '/products',
  heroImage: 'https://example.com/a.png',
  blogEnabled: true,
  locationsEnabled: true,
  returnWindowDays: 14,
  returnFeesPaidBy: 'merchant',
} as const;

function written() {
  return (updateMock.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue({
    id: STORE_ID,
    slug: 'demo',
    domain: null,
    settings: {},
    heroImage: null,
  });
  updateMock.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: STORE_ID, slug: 'demo', ...data })
  );
});

describe('the write reaches the database for every accepted field', () => {
  it.each(Object.entries(EVERY_ACCEPTED_FIELD))('persists %s', async (field, value) => {
    await StoreService.update(STORE_ID, { [field]: value } as never);
    expect(
      written(),
      `${field} is accepted by the route but never reaches Prisma — a silent no-op the admin reports as "Saved"`
    ).toHaveProperty(field, value);
  });

  it('persists them all together, not just one at a time', async () => {
    await StoreService.update(STORE_ID, { ...EVERY_ACCEPTED_FIELD } as never);
    for (const [field, value] of Object.entries(EVERY_ACCEPTED_FIELD)) {
      expect(written()).toHaveProperty(field, value);
    }
  });
});

describe('null and zero are values, not absence', () => {
  // A falsy guard would drop exactly the two values that matter most: null is
  // how the admin CLEARS a declared policy, and 0 means "returns not accepted".
  it('persists a null returnWindowDays (clearing a declared policy)', async () => {
    await StoreService.update(STORE_ID, { returnWindowDays: null } as never);
    expect(written()).toHaveProperty('returnWindowDays', null);
  });

  it('persists a null returnFeesPaidBy', async () => {
    await StoreService.update(STORE_ID, { returnFeesPaidBy: null } as never);
    expect(written()).toHaveProperty('returnFeesPaidBy', null);
  });

  it('persists returnWindowDays of 0 ("returns not accepted")', async () => {
    await StoreService.update(STORE_ID, { returnWindowDays: 0 } as never);
    expect(written()).toHaveProperty('returnWindowDays', 0);
  });

  it('persists locationsEnabled set to false', async () => {
    await StoreService.update(STORE_ID, { locationsEnabled: false } as never);
    expect(written()).toHaveProperty('locationsEnabled', false);
  });
});

describe('a field the caller did not send is left alone', () => {
  it('does not write keys absent from the payload', async () => {
    await StoreService.update(STORE_ID, { name: 'Only Name' } as never);
    const data = written();
    expect(data).not.toHaveProperty('returnWindowDays');
    expect(data).not.toHaveProperty('locationsEnabled');
    expect(data).not.toHaveProperty('heroTitle');
  });
});
