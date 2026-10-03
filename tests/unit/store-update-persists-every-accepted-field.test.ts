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
  // #1518: pulled in transitively by importing `updateStoreSchema`
  // (store.routes.ts's heroCtaLink/settings.contact.addressUrl validators
  // call the real `isSafeUrl`). A permissive stub is fine — this file tests
  // the write whitelist, not URL-safety validation (that has its own
  // coverage elsewhere).
  isSafeUrl: (_url: unknown): _url is string => true,
  // issue 2411: updateStoreSchema validates `timezone` with isValidTimeZone.
  // Same contract as the real one (an IANA name the runtime can format in).
  isValidTimeZone: (z: unknown): z is string => {
    if (typeof z !== 'string' || z.trim() === '') return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: z });
      return true;
    } catch {
      return false;
    }
  },
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  // #1518: `getClient` was added when importing `updateStoreSchema` pulled in
  // the full store.routes.ts -> store-access.ts -> security.ts import chain,
  // which calls `redis.getClient()` at MODULE LOAD to build its rate
  // limiters. `makeRateLimitStore` treats a null client as "no Redis store" —
  // the same fallback it uses outside tests — so this is a safe stub, not a
  // behavior change.
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn(), getClient: vi.fn(() => null) },
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
// #1518: the schema itself, so this file's field list can be checked against
// it instead of drifting from it unnoticed — same pattern as
// `tests/unit/layout-schema-parity.test.ts` / `store-layout.routes.ts`'s
// exported `layoutSchema`.
import { updateStoreSchema } from '../../apps/api/src/routes/store.routes';

const STORE_ID = '11111111-1111-1111-1111-111111111111';

// Accepted by updateStoreSchema but unconditionally written by
// StoreService.update (top of its `data` object, no `!== undefined` guard —
// see store.service.ts:347-353) rather than through the
// `...(data.X !== undefined && { X: data.X })` whitelist spread this test
// class guards. `slug`/`domain` also drive their own collision-check
// branches (extra `prisma.store.findUnique` calls) that would need separate
// mock plumbing from the shared `it.each` below. Not exempt from the BUG —
// exempt from THIS test's mechanism, because they cannot silently fall
// through the whitelist spread the way returnWindowDays/locationsEnabled did.
const FIELDS_WRITTEN_UNCONDITIONALLY = new Set(['slug', 'domain', 'settings']);

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
  timezone: 'Asia/Dubai',
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

describe('timezone is validated at the edge (issue 2411)', () => {
  it('accepts an IANA zone', () => {
    expect(updateStoreSchema.safeParse({ timezone: 'Asia/Dubai' }).success).toBe(true);
  });

  it.each(['Mars/Olympus', 'not a zone', ''])('rejects %j instead of coercing it', bad => {
    expect(updateStoreSchema.safeParse({ timezone: bad }).success).toBe(false);
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

// #1518: EVERY_ACCEPTED_FIELD above was a hand-maintained object that never
// imported the schema — a field added to updateStoreSchema and forgotten
// here passed silently, exactly the returnWindowDays/locationsEnabled class
// this file exists to catch. This derives the required key set from the
// schema itself, so a new schema field fails THIS test immediately instead
// of shipping an untested write path.
describe('EVERY_ACCEPTED_FIELD stays in sync with updateStoreSchema', () => {
  it('every schema field (minus the unconditionally-written ones) has a test value', () => {
    const schemaKeys = Object.keys(updateStoreSchema.shape);
    const testedKeys = new Set(Object.keys(EVERY_ACCEPTED_FIELD));

    const missing = schemaKeys.filter(
      key => !FIELDS_WRITTEN_UNCONDITIONALLY.has(key) && !testedKeys.has(key)
    );

    expect(
      missing,
      'updateStoreSchema accepts these fields but EVERY_ACCEPTED_FIELD has no test value for ' +
        'them — add one (or, if the field is written unconditionally like slug/domain/settings, ' +
        'add it to FIELDS_WRITTEN_UNCONDITIONALLY with why)'
    ).toEqual([]);
  });

  it('does not test a field the schema no longer accepts (a stale entry hides nothing)', () => {
    const schemaKeys = new Set(Object.keys(updateStoreSchema.shape));
    const stale = Object.keys(EVERY_ACCEPTED_FIELD).filter(key => !schemaKeys.has(key));
    expect(
      stale,
      'these EVERY_ACCEPTED_FIELD keys are not in updateStoreSchema — remove them'
    ).toEqual([]);
  });

  it('has a .shape property (confirming it is a ZodObject — otherwise the checks above are vacuous)', () => {
    expect(updateStoreSchema.shape).toBeDefined();
    expect(Object.keys(updateStoreSchema.shape).length).toBeGreaterThan(0);
  });
});
