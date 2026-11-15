/**
 * SP4 — slug rules at the SERVICE layer (defence in depth behind the route's
 * zod check, and the only layer `ProvisioningService` goes through):
 *
 *  - an EXPLICIT slug is validated strictly and refused with a stable code;
 *  - a slug DERIVED from the store name is coerced into a legal, unreserved
 *    address ("Support" → `support-1`) instead of failing signup;
 *  - de-duplication suffixes never push a slug past 40 chars.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storeCreate = vi.fn();
const storeGate = vi.hoisted(() => vi.fn());

vi.mock('@ebda/database', () => ({
  prisma: {
    store: {
      findMany: async () => [], // owner holds no store yet -> plan gate passes
      create: (a: unknown) => storeCreate(a),
    },
  },
  Prisma: {},
  withMoneyTx: vi.fn(),
  // StoreService.create writes the store's subscription row (SP5 plans engine) and
  // seeds the default 14% VAT TaxRate row, both in the new store's own scope.
  withStore: vi.fn(async (_storeId: string, fn: (tx: unknown) => unknown) =>
    fn({
      storeSubscription: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      taxRate: { create: vi.fn().mockResolvedValue({}) },
    })
  ),
  StoreStatus: {},
  // the created store is returned with its owner row, read as the owner (identity-scoped)
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      user: { findUnique: async () => ({ id: 'owner-1', email: 'o@x.com' }) },
      // first store -> signup trial (Ruling EBDA-FUNNEL-7); `stores` is read as its owner
      store: { count: async () => 0 },
    }),
}));
// `stores` is under RLS (R-EBDA-005): slug / domain uniqueness probes are the
// `ebda_store_id_by_slug` / `ebda_store_id_by_domain` definers (an id, or null when free).
// R-TRIAL-ONCE-1: the used-trial marker lives in system_settings, not under test here
vi.mock('@api/services/billing/trial-eligibility', () => ({
  ownerEmailOf: async () => ({ email: 'o@x.com', unknown: false }),
  ownerHasUsedTrial: async () => false,
  markOwnerTrialUsed: async () => undefined,
}));
vi.mock('@api/lib/definer', async orig => ({
  ...(await orig<typeof import('@api/lib/definer')>()),
  storeIdBySlug: vi.fn(async (slug: string) => (taken.has(slug) ? 'existing' : null)),
  storeIdByDomain: vi.fn(async () => null),
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
}));
vi.mock('@api/lib/revalidate-storefront', () => ({ revalidateStorefront: vi.fn() }));
vi.mock('@api/lib/cors-cache', () => ({ bustCorsCache: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/services/storage.service', () => ({ StorageService: {} }));
vi.mock('@api/services/accounting/account.service', () => ({
  seedCoaForStore: vi.fn().mockResolvedValue(undefined),
}));

// Plan store-count gate (locked pricing): spied here, proven for real in plan-gates.test.ts.
vi.mock('@api/services/plan-limit.service', async orig => ({
  ...(await orig<typeof import('@api/services/plan-limit.service')>()),
  assertOwnerMayCreateStore: storeGate,
}));

import { StoreService } from '@api/services/store.service';
import { assertStoreSlug, deriveStoreSlug } from '@api/lib/store-slug';

let taken: Set<string>;

beforeEach(() => {
  taken = new Set();
  storeCreate.mockReset();
  storeGate.mockReset().mockResolvedValue(undefined);
  storeCreate.mockImplementation(async ({ data }: { data: { slug: string } }) => ({
    id: 'new-store',
    ...data,
  }));
});

async function createdSlug(input: { name: string; slug?: string }) {
  const store = await StoreService.create('owner-1', input);
  return store.slug as string;
}

describe('StoreService.create — explicit slug', () => {
  it.each(['support', 'app', 'api', 'www', 'orders', 'blog'])(
    'refuses the reserved slug %j with SLUG_RESERVED and writes nothing',
    async slug => {
      await expect(StoreService.create('owner-1', { name: 'Shop', slug })).rejects.toMatchObject({
        statusCode: 400,
        code: 'SLUG_RESERVED',
      });
      expect(storeCreate).not.toHaveBeenCalled();
    }
  );

  it.each(['paymob', 'ebda-support', 'p4ym0b'])(
    'refuses the protected brand %j with SLUG_PROTECTED unless overridden (SP5 task 4)',
    async slug => {
      await expect(StoreService.create('owner-1', { name: 'Shop', slug })).rejects.toMatchObject({
        statusCode: 400,
        code: 'SLUG_PROTECTED',
      });
      expect(storeCreate).not.toHaveBeenCalled();
      // super_admin support-claim override
      const store = await StoreService.create(
        'owner-1',
        { name: 'Shop', slug },
        { allowProtectedSlug: true }
      );
      expect(store.slug).toBe(slug);
    }
  );

  it('a name that derives a protected brand is refused, not suffixed', async () => {
    await expect(StoreService.create('owner-1', { name: 'Paymob' })).rejects.toMatchObject({
      code: 'SLUG_PROTECTED',
    });
  });

  it('refuses a malformed slug with its specific code', async () => {
    await expect(
      StoreService.create('owner-1', { name: 'Shop', slug: 'ab' })
    ).rejects.toMatchObject({ code: 'SLUG_TOO_SHORT' });
    await expect(
      StoreService.create('owner-1', { name: 'Shop', slug: 'Not_Valid' })
    ).rejects.toMatchObject({ code: 'SLUG_INVALID_CHARS' });
    expect(storeCreate).not.toHaveBeenCalled();
  });

  it('keeps a valid explicit slug as-is, and de-duplicates a taken one', async () => {
    expect(await createdSlug({ name: 'Amelia', slug: 'amelia' })).toBe('amelia');
    taken.add('amelia');
    expect(await createdSlug({ name: 'Amelia', slug: 'amelia' })).toBe('amelia-1');
  });
});

describe('StoreService.create — slug derived from the name', () => {
  it('a name that derives a reserved label gets a suffix instead of failing', async () => {
    expect(await createdSlug({ name: 'Support' })).toBe('support-1');
    expect(await createdSlug({ name: 'API' })).toBe('api-1');
    expect(await createdSlug({ name: 'Dashboard' })).toBe('dashboard-1');
  });

  it('a short name is padded to the 3-char minimum', async () => {
    const slug = await createdSlug({ name: 'Ab' });
    expect(slug.length).toBeGreaterThanOrEqual(3);
  });

  it('a long name is cut to 40 chars with no trailing hyphen', async () => {
    const slug = await createdSlug({
      name: 'The Most Wonderful Artisanal Handmade Jewellery Boutique In Cairo',
    });
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('an Arabic-only name still yields a legal slug', async () => {
    const slug = await createdSlug({ name: 'متجر الذهب' });
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slug.length).toBeGreaterThanOrEqual(3);
  });

  it('de-dup suffixes never push a slug past 40 characters', async () => {
    const base = 'a'.repeat(40);
    taken.add(base);
    const slug = await createdSlug({ name: 'x', slug: base });
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-1')).toBe(true);
  });
});

describe('slug helpers', () => {
  it('assertStoreSlug returns the slug or throws an AppError(400, SLUG_*)', () => {
    expect(assertStoreSlug('amelia')).toBe('amelia');
    expect(() => assertStoreSlug('support')).toThrowError(
      expect.objectContaining({ statusCode: 400, code: 'SLUG_RESERVED' })
    );
  });

  it('deriveStoreSlug always returns a format-valid slug', () => {
    for (const input of ['', 'a', '--', 'Hello World!!', 'x'.repeat(100), '٣٤٥']) {
      expect(deriveStoreSlug(input)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(deriveStoreSlug(input).length).toBeGreaterThanOrEqual(3);
      expect(deriveStoreSlug(input).length).toBeLessThanOrEqual(40);
    }
  });
});

describe('StoreService.create — plan store-count gate (maxStores 1/1/3)', () => {
  it('asks the gate about the owner BEFORE writing, and a refusal writes nothing', async () => {
    const refusal = Object.assign(new Error('402'), {
      statusCode: 402,
      code: 'PLAN_LIMIT_REACHED',
    });
    storeGate.mockRejectedValueOnce(refusal);
    await expect(StoreService.create('owner-1', { name: 'Second Shop' })).rejects.toBe(refusal);
    expect(storeGate).toHaveBeenCalledWith('owner-1');
    expect(storeCreate).not.toHaveBeenCalled();
  });

  it('a platform operator (super_admin route) is not plan-bound', async () => {
    await StoreService.create('owner-1', { name: 'Ops Shop' }, { platformOperator: true });
    expect(storeGate).not.toHaveBeenCalled();
    expect(storeCreate).toHaveBeenCalledTimes(1);
  });
});
