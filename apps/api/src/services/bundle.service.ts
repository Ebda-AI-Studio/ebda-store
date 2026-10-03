/**
 * Bundle read service: derived availability + a resolved bundle ready for
 * pricing/allocation.
 *
 * Availability is DERIVED on every read, never stored — inventory is a
 * NEVER-stale class value (products.inventory / product_variants.inventory
 * move through orders, bulk edit, import, returns, etc.), so a cached count
 * would drift the moment stock moved through any path other than this one.
 */
import type { DbClient } from '@force/database';
import { computeBundlePrice, type BundleLine, type BundlePricingType } from '@force/shared';
import { AppError } from '../middleware/error-handler';
import { cartLineUnitPrice } from '../lib/cart-pricing';
import { effectiveInventory } from '../lib/effective-inventory';

export interface AvailabilityItem {
  quantity: number;
  trackInventory: boolean;
  availableStock: number;
}

/**
 * Availability reported for a bundle whose components all opt out of
 * inventory tracking. Deliberately a plain, small-enough integer rather than
 * Number.MAX_SAFE_INTEGER: this value is multiplied by bundle quantities,
 * serialised into cart responses, and compared against int4 columns, and a
 * sentinel that is also an arithmetic operand breaks somewhere far from here
 * (MAX_SAFE_INTEGER * a price loses precision silently, and it exceeds
 * Postgres int4 by ~4.2 million times). 1,000,000 is far above any real
 * stock level and cannot overflow when multiplied by a bundle quantity,
 * which the DB bounds at 1000. Exported so later tasks compare against this
 * constant rather than re-deriving the magic number.
 */
export const UNTRACKED_AVAILABILITY_CAP = 1_000_000;

/**
 * How many whole bundles the component stock can make: min(floor(stock/qty))
 * over the components that track inventory.
 *
 * An empty bundle returns 0, not Infinity: `Math.min()` of nothing is
 * Infinity, which would make a contentless bundle infinitely purchasable.
 * A bundle whose components are ALL untracked also has nothing to floor
 * against, so it returns `UNTRACKED_AVAILABILITY_CAP` (effectively
 * unlimited) rather than 0 — untracked stock is not the same thing as no
 * stock.
 */
export function bundleAvailability(items: AvailabilityItem[]): number {
  if (items.length === 0) return 0;

  let min = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (!item.trackInventory) continue;
    min = Math.min(min, Math.floor(item.availableStock / item.quantity));
  }

  return min === Number.POSITIVE_INFINITY ? UNTRACKED_AVAILABILITY_CAP : Math.max(0, min);
}

/**
 * Canonical component order.
 *
 * P2-1 (final review): `allocateBundlePrice` breaks fractional-remainder
 * ties by input index, and its residual-round eligibility test is
 * order-sensitive — so `isAllocatable` can answer differently for the same
 * bundle depending on the order its lines arrive in. Admin save-time
 * validation built lines in REQUEST order while checkout built them in
 * whatever order Postgres happened to return rows, which meant a bundle the
 * admin screen accepted could 409 `BUNDLE_PRICE_NOT_ALLOCATABLE` at
 * checkout. Both sides now sort by the component's own identity — the one
 * key both have before the BundleItem ids exist — so the two verdicts
 * always agree. (`orderBy: { id: 'asc' }` on the read below makes the DB
 * order itself deterministic; it cannot make it equal to request order,
 * because BundleItem ids are random uuids.)
 *
 * Never violates a money invariant either way: the allocation always sums to
 * the bundle price. This only fixes WHICH component absorbs a 1-piastre
 * remainder, and stops the two surfaces disagreeing about whether a price is
 * representable at all.
 */
export function compareBundleComponents(
  a: { productId: string; variantId: string | null },
  b: { productId: string; variantId: string | null }
): number {
  if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
  const av = a.variantId ?? '';
  const bv = b.variantId ?? '';
  if (av !== bv) return av < bv ? -1 : 1;
  return 0;
}

export interface ResolvedBundle {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  image: string | null;
  /**
   * `pricingType`/`pricingValue` are included for admin display and
   * re-quoting (e.g. "15% off", or re-editing the discount in the bundle
   * editor) — they must NOT be spread into a public storefront response,
   * which should expose the already-computed `price` instead.
   */
  pricingType: BundlePricingType;
  pricingValue: number;
  componentSum: number;
  price: number;
  available: number;
  lines: BundleLine[];
  /** Pass-through of the bundle row's own lifecycle flags — see `isPurchasable`. */
  isActive: boolean;
  startsAt: Date | null;
  expiresAt: Date | null;
  /**
   * Derived: whether a selling surface (cart/checkout/storefront) may sell
   * this bundle right now — `isActive` AND within `[startsAt, expiresAt]`
   * (both bounds inclusive: a bundle is purchasable AT the instant of
   * `startsAt` and AT the instant of `expiresAt`, not strictly between them)
   * AND `available >= 1` AND every component is itself sellable AND the
   * derived `price` is not a zero it never meant (`price > 0`, unless
   * `componentSum` is itself 0 — see the clause in `resolveBundle`).
   *
   * `resolveBundle` deliberately does NOT filter out an inactive or expired
   * bundle — it still resolves and returns it — because admin must be able
   * to load a disabled/expired bundle to edit it; a resolver that refused
   * would make the edit screen unable to open the very bundle a merchant is
   * trying to fix. Every SELLING surface must gate on `isPurchasable`
   * itself; `resolveBundle` only exposes the state, it does not enforce it.
   */
  isPurchasable: boolean;
  /**
   * `isPurchasable` WITHOUT the `[startsAt, expiresAt]` clause — every input
   * that only changes through a WRITE (which busts the caches). A cached
   * surface stores this plus the window and applies `withinSaleWindow` at
   * READ time, because crossing a window boundary is not a write and nothing
   * would invalidate a cached `isPurchasable` (issue 2111).
   */
  sellableIgnoringWindow: boolean;
}

/**
 * The time half of `isPurchasable`: inside `[startsAt, expiresAt]`, both
 * bounds inclusive. Accepts ISO strings too, because a value that went
 * through `getCached`'s JSON round-trip comes back as one.
 */
export function withinSaleWindow(
  w: { startsAt?: Date | string | null; expiresAt?: Date | string | null },
  now: Date = new Date()
): boolean {
  const t = now.getTime();
  return (
    (w.startsAt == null || new Date(w.startsAt).getTime() <= t) &&
    (w.expiresAt == null || t <= new Date(w.expiresAt).getTime())
  );
}
/**
 * Seconds until the nearest FUTURE `startsAt`/`expiresAt` across `windows`
 * (Infinity when none) — how long a response computed at `now` stays exact
 * with respect to bundle sale windows. Used to cap edge caching on a cached
 * advertising surface (the AI product feed, issues 2327 / 2328).
 */
export function nextSaleWindowBoundarySeconds(
  windows: Array<{ startsAt?: Date | string | null; expiresAt?: Date | string | null }>,
  now: Date = new Date()
): number {
  const t = now.getTime();
  let next = Infinity;
  for (const w of windows) {
    for (const bound of [w.startsAt, w.expiresAt]) {
      if (bound == null) continue;
      const at = new Date(bound).getTime();
      if (at > t && at < next) next = at;
    }
  }
  return next === Infinity ? Infinity : Math.ceil((next - t) / 1000);
}

/**
 * Load a bundle for `storeId` with everything the cart/checkout/admin need:
 * its component lines (priced through `cartLineUnitPrice`, the same
 * variant-vs-parent fallback the cart uses, so a bundle never charges a
 * different price for a component than buying it standalone would), the
 * derived `price` (via `computeBundlePrice`), the derived `available` count,
 * and the derived `isPurchasable` lifecycle gate (see its doc comment on
 * `ResolvedBundle` — selling surfaces MUST check it; this resolver does not
 * filter on it so admin can still load a disabled/expired bundle to edit).
 *
 * `client` is typed `DbClient` (`@force/database`'s own alias for "the app
 * client or an interactive-transaction client") — the same DI shape as
 * `LoyaltyService.redeemPoints` / `setOrderStatusGuarded` elsewhere in this
 * package — so a caller (e.g. checkout) can resolve a bundle inside the same
 * transaction that later writes the order/cart rows. Pass the imported
 * `prisma` singleton for standalone use.
 *
 * Tenant-resolver rule: filters by `storeId` in the query itself and throws
 * (never defaults to the first store, never silently returns another
 * tenant's bundle) when no row matches both `id` and `storeId` — same
 * pattern as `setOrderStatusGuarded` in shipping-carrier.service.ts and
 * `PromotionService.getById`.
 */
export async function resolveBundle(
  client: DbClient,
  storeId: string,
  bundleId: string
): Promise<ResolvedBundle> {
  const bundle = await client.bundle.findFirst({
    where: { id: bundleId, storeId },
    include: {
      items: {
        // Deterministic read order — see `compareBundleComponents`. Without
        // it, two reads of the same bundle can hand `allocateBundlePrice`
        // its lines in different orders.
        orderBy: { id: 'asc' },
        include: {
          product: {
            select: {
              price: true,
              trackInventory: true,
              inventory: true,
              variants: { select: { inventory: true, isActive: true } },
              deletedAt: true,
              status: true,
            },
          },
          variant: { select: { price: true, inventory: true, isActive: true } },
        },
      },
    },
  });

  if (!bundle) {
    throw new AppError(404, 'NOT_FOUND', 'Bundle not found for this store');
  }

  // Canonical order, shared with admin save-time validation — see
  // `compareBundleComponents`.
  const orderedItems = [...bundle.items].sort(compareBundleComponents);

  const lines: BundleLine[] = orderedItems.map(item => ({
    key: item.id,
    unitPrice: cartLineUnitPrice({ variant: item.variant, product: item.product }),
    quantity: item.quantity,
  }));

  const componentSum = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const price = computeBundlePrice(
    componentSum,
    bundle.pricingType as BundlePricingType,
    bundle.pricingValue
  );

  const availabilityItems: AvailabilityItem[] = orderedItems.map(item => ({
    quantity: item.quantity,
    trackInventory: item.product.trackInventory,
    // A line that pins a specific variant is limited by THAT variant's own
    // stock, not the product's variant sum; a line with no variantId (a
    // variant-less product) reads the product's effective stock.
    availableStock: item.variantId
      ? (item.variant?.inventory ?? 0)
      : effectiveInventory(item.product),
  }));
  const available = bundleAvailability(availabilityItems);

  // Captured once so the three checks below (and any future ones) agree on
  // "now" — calling `new Date()` per-check risks a boundary instant passing
  // one check and failing another as real time advances between them.
  const now = new Date();
  // I2 (final review): the RESTRICT FK never fires for a soft-deleted or
  // draft/archived component, because product deletion is SOFT — so a
  // bundle would otherwise keep selling and decrementing a component the
  // merchant already removed from the catalogue, with no warning. Every
  // component (and, when a line pins one, its variant) must be a live,
  // sellable row for the bundle itself to be sellable. This falls out of
  // `isPurchasable` rather than throwing, per Ruling T3-a, so admin can
  // still open the bundle to see and fix the broken line.
  const allComponentsPurchasable = bundle.items.every(item => {
    if (item.product.deletedAt !== null || item.product.status !== 'active') return false;
    if (item.variantId && item.variant?.isActive === false) return false;
    // P1-3 (final review): a line on a VARIANT product that pins no variant
    // is an unsellable shape, not a sellable one. `products.inventory` is
    // unused once a product has variants (see effective-inventory.ts), so
    // this line would report availability from the variant SUM and then
    // decrement the parent column at checkout — the variant stock never
    // moves and the merchant oversells it. `resolveBundleLines` now rejects
    // the shape at write time; this is the read-time half, which is what
    // catches the realistic case: a SIMPLE product that later gains
    // variants, long after it was bundled. Failing closed here (rather than
    // throwing) keeps Ruling T3-a's promise that admin can still open the
    // bundle to fix the broken line.
    if (!item.variantId && item.product.variants.length > 0) return false;
    return true;
  });

  // P1 (this task): a zero price is only ever sellable when the components
  // are themselves free. `componentSum` is recomputed from CURRENT component
  // prices on EVERY read, so a `fixed` (piastres-off) discount that was smaller
  // than the components when it was saved can outgrow them later — a sale, a
  // bulk edit or a CSV import drops component prices, `computeBundlePrice`
  // clamps `componentSum - pricingValue` at 0, and the box then sells for
  // nothing while its stock-decrementing goods still ship. Nothing downstream
  // catches it: the money-invariant guard in order.service.ts passes because
  // `allocateBundlePrice(lines, 0)` returns all zeros and 0 === the resolved
  // price. Save-time validation cannot cover it either — the drift happens
  // long after the save (`assertPriceWithinComponentSum` in bundle.routes.ts
  // is the save-time half; this is the read-time half).
  //
  // `componentSum === 0` is the ONE legitimate zero: a kit whose components
  // are all free is honestly worth 0, and a merchant who wants to give a kit
  // away makes it that way (or prices it `fixed_price: 0` over free
  // components). A zero price with a NON-zero componentSum is always either
  // drift or a 100%-off discount, and neither should silently sell.
  const priceIsSellable = price > 0 || componentSum === 0;

  const sellableIgnoringWindow =
    bundle.isActive && available >= 1 && allComponentsPurchasable && priceIsSellable;
  const isPurchasable = sellableIgnoringWindow && withinSaleWindow(bundle, now);

  return {
    id: bundle.id,
    name: bundle.name,
    nameAr: bundle.nameAr,
    slug: bundle.slug,
    image: bundle.image,
    pricingType: bundle.pricingType as BundlePricingType,
    pricingValue: bundle.pricingValue,
    componentSum,
    price,
    available,
    lines,
    isActive: bundle.isActive,
    startsAt: bundle.startsAt,
    expiresAt: bundle.expiresAt,
    isPurchasable,
    sellableIgnoringWindow,
  };
}

/**
 * A purchasable bundle plus the small set of extra display fields the
 * read-only advertising surfaces (AI product feed, WBS catalogue bridge)
 * need but `ResolvedBundle` doesn't carry: `updatedAt` (freshness, mirrors
 * `FeedProductInput.updatedAt`) and `componentNames` (for a human-readable
 * "what's inside" line — see `describeBundleContents`).
 *
 * Deliberately does NOT add per-component prices anywhere on this shape —
 * see the `ResolvedBundle` doc comment on `pricingType`/`pricingValue` for
 * why an advertising surface must never expose the internal allocation.
 */
export interface PurchasableBundleSummary extends ResolvedBundle {
  updatedAt: Date;
  description: string | null;
  descriptionAr: string | null;
  componentNames: Array<{ name: string; nameAr: string | null }>;
}

/**
 * Every bundle a store is currently allowed to SELL, for a read-only
 * advertising surface that lists a bundle as a sibling of a product entry
 * (AI product feed, WBS catalogue bridge). Reuses `resolveBundle` — the one
 * place `price`/`available`/`isPurchasable` is computed — rather than
 * re-deriving that math here, and filters to `isPurchasable` the same way
 * `GET /public/:storeId/bundles` in bundle.routes.ts does.
 *
 * A bundle deleted between the id query and the resolve (same race
 * `tryResolveBundle` in bundle.routes.ts guards against) is silently
 * dropped rather than failing the whole list.
 */
export async function listPurchasableBundles(
  client: DbClient,
  storeId: string,
  now: Date = new Date()
): Promise<PurchasableBundleSummary[]> {
  return (await listSellableBundles(client, storeId)).filter(b => withinSaleWindow(b, now));
}

/**
 * `listPurchasableBundles` WITHOUT the sale-window clause: every bundle that
 * is sellable at SOME instant, carrying its `startsAt`/`expiresAt` so the
 * caller applies `withinSaleWindow` per request. For a CACHED surface (the AI
 * product feed, issues 2327 / 2328): crossing a window boundary is not a write
 * and busts no cache, so a cached `isPurchasable` would keep advertising an
 * expired bundle (and hide one whose window just opened) until the TTL.
 */
export async function listSellableBundles(
  client: DbClient,
  storeId: string
): Promise<PurchasableBundleSummary[]> {
  const rows = await client.bundle.findMany({
    where: { storeId, isActive: true },
    select: { id: true, updatedAt: true, description: true, descriptionAr: true },
  });
  if (rows.length === 0) return [];

  const rowById = new Map(rows.map(r => [r.id, r]));

  const resolved = (
    await Promise.all(
      rows.map(async row => {
        try {
          const bundle = await resolveBundle(client, storeId, row.id);
          return bundle.sellableIgnoringWindow ? bundle : null;
        } catch (err) {
          if (err instanceof AppError && err.statusCode === 404) return null;
          throw err;
        }
      })
    )
  ).filter((b): b is ResolvedBundle => b !== null);

  if (resolved.length === 0) return [];

  // Component names only — never per-component prices (see doc comment
  // above). One batched query for every surviving bundle rather than N
  // queries inside the map above.
  const items = await client.bundleItem.findMany({
    where: { bundleId: { in: resolved.map(b => b.id) } },
    select: { bundleId: true, product: { select: { name: true, nameAr: true } } },
  });
  const namesByBundle = new Map<string, Array<{ name: string; nameAr: string | null }>>();
  for (const item of items) {
    const list = namesByBundle.get(item.bundleId) ?? [];
    list.push({ name: item.product.name, nameAr: item.product.nameAr });
    namesByBundle.set(item.bundleId, list);
  }

  return resolved.map(b => {
    const row = rowById.get(b.id);
    return {
      ...b,
      updatedAt: row?.updatedAt ?? new Date(),
      description: row?.description ?? null,
      descriptionAr: row?.descriptionAr ?? null,
      componentNames: namesByBundle.get(b.id) ?? [],
    };
  });
}

/**
 * Human-readable "what's inside" text for a bundle advertised as a single
 * sellable item: the merchant's own `description`/`descriptionAr` when set,
 * else a generated "Includes: A, B, C" listing built from component NAMES
 * only. Never includes a per-component price — see `ResolvedBundle`'s doc
 * comment on `pricingType`/`pricingValue` for why that must stay internal.
 *
 * Arabic contents are only generated when EVERY component has an Arabic
 * name — a partially-Arabic list ("يشمل: تمر, Nuts") reads as a bug, not a
 * bilingual feature.
 */
export function describeBundleContents(
  bundle: Pick<PurchasableBundleSummary, 'description' | 'descriptionAr' | 'componentNames'>
): { description?: string; descriptionAr?: string } {
  const names = bundle.componentNames.map(c => c.name).filter(Boolean);
  const namesAr = bundle.componentNames.map(c => c.nameAr).filter((n): n is string => Boolean(n));

  const description =
    bundle.description ?? (names.length ? `Includes: ${names.join(', ')}` : undefined);
  const descriptionAr =
    bundle.descriptionAr ??
    (namesAr.length > 0 && namesAr.length === bundle.componentNames.length
      ? `يشمل: ${namesAr.join('، ')}`
      : undefined);

  return { description, descriptionAr };
}
