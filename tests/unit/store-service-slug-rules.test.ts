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

const findUnique = vi.fn();
const storeCreate = vi.fn();

vi.mock('@force/database', () => ({
  prisma: {
    store: {
      findUnique: (a: unknown) => findUnique(a),
      create: (a: unknown) => storeCreate(a),
    },
  },
  Prisma: {},
  withMoneyTx: vi.fn(),
  // StoreService.create writes the store's subscription row (SP5 plans engine) and
  // seeds the default 14% VAT TaxRate row, both in the new store's own scope.
  withStore: vi.fn(async (_storeId: string, fn: (tx: unknown) => unknown) =>
    fn({
      storeSubscription: { upsert: vi.fn().mockResolvedValue({}) },
      taxRate: { create: vi.fn().mockResolvedValue({}) },
    })
  ),
  StoreStatus: {},
  // the created store is returned with its owner row, read as the owner (identity-scoped)
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ user: { findUnique: async () => ({ id: 'owner-1', email: 'o@x.com' }) } }),
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

import { StoreService } from '@api/services/store.service';
import { assertStoreSlug, deriveStoreSlug } from '@api/lib/store-slug';

let taken: Set<string>;

beforeEach(() => {
  taken = new Set();
  findUnique.mockReset();
  findUnique.mockImplementation(async ({ where }: { where: { slug?: string; domain?: string } }) =>
    where.slug && taken.has(where.slug) ? { id: 'existing' } : null
  );
  storeCreate.mockReset();
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
