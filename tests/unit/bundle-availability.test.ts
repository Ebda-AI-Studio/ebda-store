import { describe, it, expect, vi } from 'vitest';
import {
  bundleAvailability,
  resolveBundle,
  listPurchasableBundles,
  describeBundleContents,
  UNTRACKED_AVAILABILITY_CAP,
} from '../../apps/api/src/services/bundle.service';
import { AppError } from '../../apps/api/src/middleware/error-handler';

const item = (quantity: number, availableStock: number, trackInventory = true) => ({
  quantity,
  availableStock,
  trackInventory,
});

/**
 * A minimal-but-complete mocked `bundle.findFirst` row: one untracked-free
 * product line (quantity 1, price 1000 fils, inventory 10 by default) plus
 * the bundle-level lifecycle fields the isPurchasable tests vary.
 */
const bundleRow = (overrides: {
  isActive?: boolean;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  inventory?: number;
  /** I2 (final review): a component's soft-delete/lifecycle state. Defaults
   * to a live, sellable product so every pre-existing test in this file
   * (written before I2) keeps its original meaning. */
  productDeletedAt?: Date | null;
  productStatus?: 'draft' | 'active' | 'archived';
  variantIsActive?: boolean;
  hasVariant?: boolean;
  /** P1 (zero-price drift): the pricing rule and the component's CURRENT
   * price, so a test can drive `computeBundlePrice` to 0. Defaults keep the
   * original fixture (a 1000-fils component sold at a fixed 1000) so every
   * pre-existing test in this file keeps its original meaning. */
  pricingType?: 'fixed_price' | 'percentage' | 'fixed';
  pricingValue?: number;
  productPrice?: number;
}) => ({
  id: 'bundle-1',
  storeId: 'store-a',
  name: 'Ramadan Box',
  nameAr: null,
  slug: 'ramadan-box',
  image: null,
  pricingType: overrides.pricingType ?? 'fixed_price',
  pricingValue: overrides.pricingValue ?? 1000,
  isActive: overrides.isActive ?? true,
  startsAt: overrides.startsAt ?? null,
  expiresAt: overrides.expiresAt ?? null,
  items: [
    {
      id: 'item-1',
      quantity: 1,
      variantId: overrides.hasVariant ? 'variant-1' : null,
      variant: overrides.hasVariant
        ? {
            price: overrides.productPrice ?? 1000,
            inventory: overrides.inventory ?? 10,
            isActive: overrides.variantIsActive ?? true,
          }
        : null,
      product: {
        price: overrides.productPrice ?? 1000,
        trackInventory: true,
        inventory: overrides.inventory ?? 10,
        variants: [],
        deletedAt: overrides.productDeletedAt ?? null,
        status: overrides.productStatus ?? 'active',
      },
    },
  ],
});

const makeClient = (row: ReturnType<typeof bundleRow> | null) =>
  ({ bundle: { findFirst: vi.fn().mockResolvedValue(row) } }) as any;

describe('bundleAvailability', () => {
  it('is limited by the scarcest component', () => {
    // Dates 40/1, Honey 12/1, Nuts 30/2 -> min(40, 12, 15) = 12
    expect(bundleAvailability([item(1, 40), item(1, 12), item(2, 30)])).toBe(12);
  });

  it('floors rather than rounds — 5 nuts cannot make 3 boxes of 2', () => {
    expect(bundleAvailability([item(2, 5)])).toBe(2);
  });

  it('is zero when any component is out of stock', () => {
    expect(bundleAvailability([item(1, 40), item(1, 0)])).toBe(0);
  });

  it('ignores components that do not track inventory', () => {
    expect(bundleAvailability([item(1, 7), item(1, 0, false)])).toBe(7);
  });

  it('is zero for a bundle with no items — never Infinity', () => {
    expect(bundleAvailability([])).toBe(0);
  });

  it('is unlimited (not zero) when every component is untracked', () => {
    // No component tracks inventory, so there is nothing to floor against —
    // the bundle is not "out of stock", it is unconstrained. Asserting the
    // named, JSON/DB/arithmetic-safe constant (not Number.MAX_SAFE_INTEGER)
    // keeps this test honest about what the function actually returns.
    const result = bundleAvailability([item(1, 0, false), item(2, 0, false)]);
    expect(result).toBe(UNTRACKED_AVAILABILITY_CAP);
    expect(result).not.toBe(0);
  });
});

describe('resolveBundle', () => {
  it('throws when the bundle does not belong to the given store', async () => {
    // The tenant-resolver rule: resolveBundle must filter by storeId in the
    // query and throw rather than fall back to any other store's bundle.
    // Modelled as a unit test against a mocked Prisma client (findFirst
    // scoped by { id, storeId } correctly returns null for a mismatched
    // store) — a real cross-tenant fixture would need integration-level DB
    // setup, out of reach for this unit test.
    const findFirst = vi.fn().mockResolvedValue(null);
    const fakeClient = { bundle: { findFirst } } as any;

    await expect(resolveBundle(fakeClient, 'store-a', 'bundle-owned-by-store-b')).rejects.toThrow(
      AppError
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bundle-owned-by-store-b', storeId: 'store-a' },
      })
    );
  });

  describe('isPurchasable', () => {
    const HOUR = 60 * 60 * 1000;

    it('is false for an inactive bundle, but the bundle still resolves', async () => {
      const client = makeClient(bundleRow({ isActive: false }));
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.isActive).toBe(false);
      expect(resolved.isPurchasable).toBe(false);
    });

    it('is false for an expired bundle', async () => {
      const client = makeClient(bundleRow({ expiresAt: new Date(Date.now() - HOUR) }));
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.isPurchasable).toBe(false);
    });

    it('is false for a not-yet-started bundle', async () => {
      const client = makeClient(bundleRow({ startsAt: new Date(Date.now() + HOUR) }));
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.isPurchasable).toBe(false);
    });

    it('is true when active, in-window, and available', async () => {
      const client = makeClient(
        bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 5,
        })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.available).toBeGreaterThan(0);
      expect(resolved.isPurchasable).toBe(true);
    });

    it('is false when active and in-window but available is 0', async () => {
      const client = makeClient(
        bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 0,
        })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.available).toBe(0);
      expect(resolved.isPurchasable).toBe(false);
    });

    // ── I2 (final review): a bundle must not keep selling a component that
    // was soft-deleted, drafted or archived out of the catalogue. The
    // RESTRICT FK never fires for these because product deletion is SOFT —
    // resolveBundle itself must check, and it must still RESOLVE (not
    // throw) so admin can open the bundle to repair the broken line.

    it('is false when a component product is soft-deleted, but the bundle still resolves', async () => {
      const client = makeClient(
        bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 5,
          productDeletedAt: new Date('2026-01-01T00:00:00Z'),
        })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.isPurchasable).toBe(false);
      expect(resolved.available).toBeGreaterThan(0); // stock alone is fine — the component itself is gone
    });

    it('is false when a component product is draft', async () => {
      const client = makeClient(
        bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 5,
          productStatus: 'draft',
        })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.isPurchasable).toBe(false);
    });

    it('is false when a component product is archived', async () => {
      const client = makeClient(
        bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 5,
          productStatus: 'archived',
        })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.isPurchasable).toBe(false);
    });

    it('is false when a line pins a deactivated variant, even though the parent product is fine', async () => {
      const client = makeClient(
        bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 5,
          hasVariant: true,
          variantIsActive: false,
        })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.isPurchasable).toBe(false);
    });

    it('stays true when every component is live, active and (if pinned) an active variant', async () => {
      const client = makeClient(
        bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 5,
          hasVariant: true,
          variantIsActive: true,
        })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.isPurchasable).toBe(true);
    });

    // ── P1 (this task): catalogue drift can price a bundle at 0.
    //
    // `componentSum` is recomputed from CURRENT component prices on every
    // read, so a `fixed` (fils-off) discount that was a real discount when
    // it was saved can outgrow its own components later — a sale, a bulk
    // edit or a CSV import drops the component prices and
    // `computeBundlePrice` clamps `componentSum - pricingValue` at 0. No
    // merchant error is needed and nothing downstream catches it: the
    // money-invariant guard in order.service.ts passes because
    // `allocateBundlePrice(lines, 0)` returns all zeros and 0 === the
    // resolved price. The box would ship, stock-decrementing, for nothing.

    it('is true for a `fixed` discount that is smaller than the components', async () => {
      // 20.000 of components, 5.000 off -> a 15.000 box. Nothing wrong here.
      const client = makeClient(
        bundleRow({ pricingType: 'fixed', pricingValue: 5000, productPrice: 20000 })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.componentSum).toBe(20000);
      expect(resolved.price).toBe(15000);
      expect(resolved.isPurchasable).toBe(true);
    });

    it('is FALSE once the components drift below the same `fixed` discount — the box would sell for 0', async () => {
      // The same bundle after the components are repriced to 4.500: the
      // 5.000 discount now swallows them whole.
      const client = makeClient(
        bundleRow({ pricingType: 'fixed', pricingValue: 5000, productPrice: 4500 })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.componentSum).toBe(4500);
      expect(resolved.price).toBe(0);
      // Everything else about the bundle is still fine — active, in window,
      // in stock, components live — so the zero price is the ONLY thing
      // that can stop the sale.
      expect(resolved.isActive).toBe(true);
      expect(resolved.available).toBeGreaterThan(0);
      expect(resolved.isPurchasable).toBe(false);
    });

    it('stays purchasable for a deliberately free kit — a 0 price over components that are themselves free', async () => {
      // The legitimate zero, and the reason the clause is
      // `price > 0 || componentSum === 0` rather than a bare `price > 0`:
      // a kit of free items is honestly worth 0. A merchant giving a kit
      // away prices it this way; they never express it as a 100%-off
      // amount, which save-time validation refuses.
      const client = makeClient(
        bundleRow({ pricingType: 'fixed_price', pricingValue: 0, productPrice: 0 })
      );
      const resolved = await resolveBundle(client, 'store-a', 'bundle-1');
      expect(resolved.componentSum).toBe(0);
      expect(resolved.price).toBe(0);
      expect(resolved.isPurchasable).toBe(true);
    });
  });
});

// ─── listPurchasableBundles / describeBundleContents (Task 10) ─────────────
//
// These back the two advertising surfaces (AI product feed, WBS catalogue
// bridge) — the contract under test is: only `isPurchasable` bundles are
// ever returned, and component NAMES (never per-component prices) are
// attached for surfaces that want to list contents.

const HOUR = 60 * 60 * 1000;

/**
 * Mocked client for `listPurchasableBundles`: `bundle.findMany` returns the
 * candidate id/updatedAt/description rows (what a real
 * `where: { storeId, isActive: true }` query would produce), `bundle.findFirst`
 * resolves each one by id (mirroring `resolveBundle`'s own query), and
 * `bundleItem.findMany` returns component names keyed by bundleId.
 */
function makeListClient(
  rows: Array<{
    id: string;
    updatedAt: Date;
    description?: string | null;
    descriptionAr?: string | null;
  }>,
  bundleRowsById: Record<string, ReturnType<typeof bundleRow> | null>,
  itemsByBundleId: Record<string, Array<{ name: string; nameAr: string | null }>> = {}
) {
  return {
    bundle: {
      findMany: vi.fn().mockResolvedValue(rows),
      findFirst: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(bundleRowsById[where.id] ?? null)
      ),
    },
    bundleItem: {
      findMany: vi.fn(({ where }: { where: { bundleId: { in: string[] } } }) => {
        const out: Array<{ bundleId: string; product: { name: string; nameAr: string | null } }> =
          [];
        for (const id of where.bundleId.in) {
          for (const p of itemsByBundleId[id] ?? []) {
            out.push({ bundleId: id, product: p });
          }
        }
        return Promise.resolve(out);
      }),
    },
  } as any;
}

const candidateRow = (
  id: string,
  overrides: Partial<{ description: string; descriptionAr: string }> = {}
) => ({
  id,
  updatedAt: new Date('2026-08-01T00:00:00Z'),
  description: overrides.description ?? null,
  descriptionAr: overrides.descriptionAr ?? null,
});

describe('listPurchasableBundles', () => {
  it('returns an empty array with no bundle-table queries when the store has no bundles', async () => {
    const client = makeListClient([], {});
    const result = await listPurchasableBundles(client, 'store-a');
    expect(result).toEqual([]);
    expect(client.bundleItem.findMany).not.toHaveBeenCalled();
  });

  it('excludes an inactive bundle', async () => {
    const client = makeListClient([candidateRow('b1')], {
      b1: bundleRow({ isActive: false }),
    });
    const result = await listPurchasableBundles(client, 'store-a');
    expect(result).toEqual([]);
  });

  it('excludes an expired bundle', async () => {
    const client = makeListClient([candidateRow('b1')], {
      b1: bundleRow({ expiresAt: new Date(Date.now() - HOUR) }),
    });
    const result = await listPurchasableBundles(client, 'store-a');
    expect(result).toEqual([]);
  });

  it('excludes a zero-availability bundle', async () => {
    const client = makeListClient([candidateRow('b1')], {
      b1: bundleRow({
        startsAt: new Date(Date.now() - HOUR),
        expiresAt: new Date(Date.now() + HOUR),
        inventory: 0,
      }),
    });
    const result = await listPurchasableBundles(client, 'store-a');
    expect(result).toEqual([]);
  });

  it('includes a purchasable bundle with component names attached, and drops one deleted between the id query and resolve', async () => {
    const client = makeListClient(
      [candidateRow('b1'), candidateRow('gone')],
      {
        b1: bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 5,
        }),
        gone: null, // deleted between the findMany and the resolve — silently dropped
      },
      // Keyed by the RESOLVED bundle id ('bundle-1', hardcoded in the
      // `bundleRow` fixture) — not the candidate-row id ('b1') — because
      // `bundleItem.findMany` in listPurchasableBundles is queried against
      // `resolved.map(b => b.id)`, i.e. resolveBundle's own output id.
      {
        'bundle-1': [
          { name: 'Dates', nameAr: 'تمر' },
          { name: 'Honey', nameAr: 'عسل' },
        ],
      }
    );
    const result = await listPurchasableBundles(client, 'store-a');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('bundle-1');
    expect(result[0].isPurchasable).toBe(true);
    expect(result[0].componentNames).toEqual([
      { name: 'Dates', nameAr: 'تمر' },
      { name: 'Honey', nameAr: 'عسل' },
    ]);
    // Batched — one bundleItem.findMany call for every surviving bundle,
    // not one per bundle.
    expect(client.bundleItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('includes a bundle whose components are all untracked as purchasable (UNTRACKED_AVAILABILITY_CAP, not zero)', async () => {
    const client = makeListClient([candidateRow('b1')], {
      b1: {
        ...bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
        }),
        items: [
          {
            id: 'item-1',
            quantity: 1,
            variantId: null,
            variant: null,
            product: {
              price: 1000,
              trackInventory: false,
              inventory: 0,
              variants: [],
              deletedAt: null,
              status: 'active',
            },
          },
        ],
      },
    });
    const result = await listPurchasableBundles(client, 'store-a');
    expect(result).toHaveLength(1);
    expect(result[0].available).toBe(UNTRACKED_AVAILABILITY_CAP);
    expect(result[0].isPurchasable).toBe(true);
  });

  it('never attaches per-component prices — only names', async () => {
    const client = makeListClient(
      [candidateRow('b1')],
      {
        b1: bundleRow({
          startsAt: new Date(Date.now() - HOUR),
          expiresAt: new Date(Date.now() + HOUR),
          inventory: 5,
        }),
      },
      { 'bundle-1': [{ name: 'Dates', nameAr: 'تمر' }] }
    );
    const result = await listPurchasableBundles(client, 'store-a');
    expect(JSON.stringify(result[0].componentNames)).not.toMatch(/price/i);
  });

  // P1: the AI product feed and the WBS catalogue bridge advertise whatever
  // this returns. A bundle whose `fixed` discount outgrew its components
  // must vanish from them at the same instant it stops being sellable — one
  // predicate governs both.
  it('excludes a bundle whose `fixed` discount has outgrown its components', async () => {
    const client = makeListClient([candidateRow('b1')], {
      b1: bundleRow({ pricingType: 'fixed', pricingValue: 5000, productPrice: 4500 }),
    });
    const result = await listPurchasableBundles(client, 'store-a');
    expect(result).toEqual([]);
  });

  // ── Mutation test — the isPurchasable filter itself (see file header) ────
  it('the isPurchasable filter is load-bearing: an inactive/expired/zero-stock bundle never reaches the returned array', async () => {
    // This test exists specifically so it can be red-lined by the mutation
    // check documented in the task report: comment out
    // `bundle.isPurchasable ? bundle : null` -> `bundle` in
    // listPurchasableBundles and this test (and the three exclusion tests
    // above) go red; restoring the guard turns them green again.
    const client = makeListClient([candidateRow('b1')], {
      b1: bundleRow({ isActive: false }),
    });
    const result = await listPurchasableBundles(client, 'store-a');
    expect(result.find(b => b.id === 'bundle-1')).toBeUndefined();
  });
});

describe('describeBundleContents', () => {
  it('uses the merchant-authored description/descriptionAr when set, ignoring component names', () => {
    const { description, descriptionAr } = describeBundleContents({
      description: 'A curated Ramadan gift box.',
      descriptionAr: 'علبة هدايا رمضانية مختارة.',
      componentNames: [{ name: 'Dates', nameAr: 'تمر' }],
    });
    expect(description).toBe('A curated Ramadan gift box.');
    expect(descriptionAr).toBe('علبة هدايا رمضانية مختارة.');
  });

  it('falls back to a generated "Includes: ..." list from component names', () => {
    const { description, descriptionAr } = describeBundleContents({
      description: null,
      descriptionAr: null,
      componentNames: [
        { name: 'Dates', nameAr: 'تمر' },
        { name: 'Honey', nameAr: 'عسل' },
      ],
    });
    expect(description).toBe('Includes: Dates, Honey');
    expect(descriptionAr).toBe('يشمل: تمر، عسل');
  });

  it('omits the Arabic listing when any component is missing an Arabic name (never a half-Arabic list)', () => {
    const { description, descriptionAr } = describeBundleContents({
      description: null,
      descriptionAr: null,
      componentNames: [
        { name: 'Dates', nameAr: 'تمر' },
        { name: 'Honey', nameAr: null },
      ],
    });
    expect(description).toBe('Includes: Dates, Honey');
    expect(descriptionAr).toBeUndefined();
  });

  it('returns undefined for both when there is no description and no components', () => {
    const { description, descriptionAr } = describeBundleContents({
      description: null,
      descriptionAr: null,
      componentNames: [],
    });
    expect(description).toBeUndefined();
    expect(descriptionAr).toBeUndefined();
  });

  it('never mentions a price', () => {
    const { description, descriptionAr } = describeBundleContents({
      description: null,
      descriptionAr: null,
      componentNames: [{ name: 'Dates 500g @ 3.500 KWD', nameAr: null }],
    });
    // Not a real-world name, but proves the function itself does no price
    // formatting/lookup — it only ever echoes the name strings it's given.
    expect(description).toBe('Includes: Dates 500g @ 3.500 KWD');
    expect(descriptionAr).toBeUndefined();
  });
});
