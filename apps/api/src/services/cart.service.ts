/**
 * Cart service.
 *
 * A cart holds two independent line kinds: `CartItem` (a single product/
 * variant) and, as of Task 5 of the product-bundles feature, `CartBundle`
 * (a bundle, at a store-defined discount over its component prices). A
 * bundle is NEVER expanded into `cart_items` — `cart_items` carries two
 * PARTIAL UNIQUE INDEXES, `(cart_id, product_id, COALESCE(note,''))` WHERE
 * `variant_id IS NULL` and `(cart_id, product_id, variant_id, COALESCE(note,''))`
 * WHERE `variant_id IS NOT NULL` (migration 20261016000500_personalisation) —
 * so expanding a bundle into that table would violate one of those indexes
 * the moment a customer already had one of the bundle's own products in
 * their cart, 500ing on a live store. `CartBundle` is its own table for
 * exactly this reason; expansion into orderable component lines happens
 * once, at order creation (Task 6), never here. Bundle prices are NEVER
 * cached on the `CartBundle` row — every read recomputes via
 * `resolveBundle` from the CURRENT component prices/stock.
 */
import { prisma, Prisma, hasTenantContext } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { lineAllowsBackorder } from '../lib/effective-inventory';
import { VARIANT_REQUIRED_MESSAGE } from '../lib/variant-required';
import { featureService } from './feature.service';
import { retryOnWriteConflict } from '../lib/db-retry';
import { withSavepoint } from '../lib/savepoint';
import { PriceResolver } from './price-resolver.service';
import { goldQuoteKey, goldQuotesForLines } from './gold-rate/gate';
import { publicGoldPricingForLines } from './gold-rate/public';
import { canSeeWholesaleOnly } from '../lib/audience';
import { ANONYMOUS_BUYER, type BuyerIdentity } from '../lib/buyer-identity';
import { STOREFRONT_PRODUCT_SELECT } from './product.service';
import { resolveBundle, type ResolvedBundle } from './bundle.service';
import {
  storeDb,
  storeRepo,
  storeWriter,
  type StoreReads,
  type StoreRepo,
} from '../lib/repo-factory';
import { activePersonalisation, cleanNote, stripNote, type Resolved } from '@ebda/shared';

// Bilingual VARIANT_REQUIRED copy lives with the other line writers' guard;
// re-exported for the cart's tests.
export { VARIANT_REQUIRED_MESSAGE };

/**
 * Resolve a customer's personalisation note against the product's config.
 * Off / no config → the note is dropped (null) so it can never split a line
 * on a product that does not take one. On → required and maxLength enforced
 * here, server-side; the PDP's disabled button is only a convenience.
 * Returns the error code instead of throwing so the bulk sync can skip a line.
 */
export function resolveLineNote(
  personalisation: unknown,
  raw: unknown
): { note: string | null } | { error: 'PERSONALISATION_REQUIRED' | 'PERSONALISATION_TOO_LONG' } {
  const cfg = activePersonalisation(personalisation);
  if (!cfg) return { note: null };
  // Length is checked on the full (stripped, trimmed) text BEFORE the 200 cap:
  // capping first silently cut a 250-char note to 200 and accepted it when
  // maxLength was 200.
  const full = stripNote(raw);
  if (!full) return cfg.required ? { error: 'PERSONALISATION_REQUIRED' } : { note: null };
  if (full.length > cfg.maxLength) return { error: 'PERSONALISATION_TOO_LONG' };
  return { note: cleanNote(full) };
}

/**
 * A bundle line in a cart response. Priced live — `unitPrice`/`total`/
 * `available` are recomputed from `resolveBundle` on EVERY read (never
 * cached on the `CartBundle` row), so a component price/stock change moves
 * this line before the customer pays. `id` is the `CartBundle` row id
 * (what `DELETE /cart/bundles/:id` takes); `bundleId` is the catalog
 * `Bundle` id — kept distinct the same way `CartItem`'s row `id` is
 * distinct from its `productId`.
 */
export interface CartBundleView {
  id: string;
  bundleId: string;
  name: string;
  nameAr: string | null;
  image: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  available: number;
}

/**
 * `resolveBundle`, but returns `null` instead of throwing on a 404.
 *
 * A `CartBundle` row references a bundle that should always resolve — the
 * admin DELETE route never hard-deletes (see bundle.routes.ts), it only
 * flips `isActive`, which `resolveBundle` deliberately still resolves
 * through. This is defense-in-depth for any other anomaly (e.g. a row left
 * over from a data migration): one bad reference is dropped from the
 * cart's bundle list instead of 500ing the customer's entire cart read.
 * Mirrors the same-named helper in bundle.routes.ts.
 */
async function tryResolveCartBundle(
  storeId: string,
  bundleId: string
): Promise<ResolvedBundle | null> {
  try {
    return await resolveBundle(
      (await storeDb(storeId)) as unknown as typeof prisma,
      storeId,
      bundleId
    );
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Retry budget for a write running on the AMBIENT request transaction.
 *
 * `retryOnWriteConflict` defaults to 4 retries with exponential backoff from a
 * 20ms base — roughly 20+40+80+160ms plus jitter. On the standalone path those
 * sleeps happen BETWEEN transactions and cost nothing but latency. On the
 * ambient path they happen INSIDE the request's interactive transaction, which
 * holds its Neon pooler connection and every row lock it has taken for the
 * whole duration — including the `carts` row, which is locked until the
 * response is flushed. Concurrent mutations of one hot cart already queue
 * behind each other for a full request; adding a third of a second of sleep to
 * the losing side pushes toward P2028 (`runInTenantContext` allows only
 * maxWait: 10000) rather than the 500s the retry was added to prevent.
 *
 * One immediate re-run is the right budget here because the only recoverable
 * case on this path is a same-cart P2002 whose winner has BY DEFINITION
 * already committed its row: the re-read sees it and merges the quantity.
 * Backoff buys nothing against an opponent that has already finished.
 */
const AMBIENT_TX_RETRY = { retries: 1, baseDelayMs: 5 } as const;

const WRITE_OPS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/**
 * The transaction surface a line writer takes (`writeLine(tx)`), for a store on its Durable Object (Ruling CF-R2-1): reads go
 * to the DO read client, writes to the DO write client. There is no interactive transaction there; the line writers already
 * tolerate that, because on Postgres they run at Read Committed and recover a lost race by re-running (P2002: the re-read
 * sees the winner's row and merges with `{ increment }`; P2025: the line is gone, take the create branch).
 */
function doTx(repo: StoreRepo, dry = false): Prisma.TransactionClient {
  const surface = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) =>
          dry && WRITE_OPS.has(op)
            ? () => Promise.resolve(undefined) // the validation pass: every check runs, nothing is written
            : (
                (WRITE_OPS.has(op) ? repo.writer : repo.db) as never as Record<
                  string,
                  Record<string, unknown>
                >
              )[model][op],
      }
    );
  return new Proxy({}, { get: (_t, model: string) => surface(model) }) as Prisma.TransactionClient;
}

/**
 * P2025 = the row a by-id `update`/`delete` targeted no longer exists. Every
 * line write below reads the line first (scoped to this cart) and then writes
 * it by id, and nothing locks the row in between: a second tap on the
 * quantity stepper or a "remove" racing it can delete the line in that window.
 * EBDA-API-2B (2026-09-12, `PUT /public/cart/items/:id`) was exactly that —
 * a 500 for a line the customer had just removed. Duck-typed on `.code` for
 * the same reason as `lib/db-retry.ts` (instanceof breaks under the mocked
 * `@ebda/database`).
 */
function isLineGone(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2025';
}

/**
 * Deleting a line that a concurrent request already deleted is a no-op.
 *
 * Every by-id line write whose P2025 is swallowed or re-mapped MUST run
 * inside `withSavepoint()` (issues 2009/2011): on the store-scoped mount
 * (`/stores/:storeId/cart`, under `tenantContext`) the request is ONE
 * transaction, and if the failed statement reached Postgres, every later
 * statement (the `cart.update` that follows) would die with 25P02. The
 * savepoint makes the recovery correct by construction; off the ambient
 * transaction (`/public/cart`) it is a pass-through.
 */
function ignoreLineGone(err: unknown): void {
  if (!isLineGone(err)) throw err;
}

// The add paths (addItem / addItems / addBundle) hit the same window from the
// other side: their merge branch increments a line by id, and if that line was
// removed after their `findFirst`, the UPDATE finds nothing. They pass 'P2025'
// to `retryOnWriteConflict` so the re-run reads again, sees no line, and takes
// the create branch.

// Shared include fragment to avoid repetition. `product` uses the
// storefront-safe select (T-H2) — this is a PUBLIC guest-cart surface
// (cart.routes.ts has no `authenticate`), so an `include` here would
// leak costPrice/aiFieldSources/barcode/etc. straight into the response.
// Module-level (not per-call) so `CartService.view`'s read-only lookup uses
// the EXACT same shape as `getOrCreate`'s — a hand-copied second literal is
// how the two silently drift.
const CART_INCLUDE = {
  items: {
    include: {
      product: {
        select: {
          ...STOREFRONT_PRODUCT_SELECT,
          images: { take: 1, orderBy: { position: 'asc' } },
          // B2B minimum order quantity: public product data (it is shown on the PDP), needed to flag a line `belowMoq`.
          moq: true,
          // Read ONLY to derive the line's `unavailable` flag (#1766) and
          // stripped before the cart leaves this service — see computeTotals.
          deletedAt: true,
        },
      },
      variant: { select: { id: true, title: true, titleAr: true, price: true } },
    },
  },
  // Raw rows only — `bundleId`/`quantity` is all we need. Display fields
  // (name/image) and every priced field come from `resolveBundle` below,
  // recomputed live rather than joined from a possibly-stale Bundle row.
  bundles: true,
} as const;

type CartWithIncludes = Prisma.CartGetPayload<{ include: typeof CART_INCLUDE }>;

export class CartService {
  /**
   * Price a cart's items + bundles into the shape every read/write path
   * returns. Factored out of `getOrCreate` so `view` (#1661 — a read-only
   * lookup that must NOT create a Cart row on a miss) prices an
   * already-fetched cart identically instead of re-deriving the math.
   */
  private static async computeTotals(
    storeId: string,
    cart: CartWithIncludes,
    buyer: BuyerIdentity = ANONYMOUS_BUYER,
    opts: { skipPricing?: boolean } = {}
  ) {
    // #1766 — a line whose product the merchant soft-deleted is flagged
    // `unavailable` and priced OUT of the subtotal. `OrderService.create`
    // refuses the whole order while any such line remains
    // (PRODUCT_NO_LONGER_AVAILABLE, the same `deletedAt: null` test), so the
    // cart must neither show it as a normal line nor promise a total that
    // includes something that can never be bought. The raw `deletedAt` stays
    // inside this service; the public payload carries only the boolean.
    const items = cart.items.map(item => {
      const { deletedAt, ...product } = item.product;
      return { ...item, product, unavailable: deletedAt != null };
    });

    // Every available loose line is priced by the ONE resolver for this buyer (Ruling B3b/B4): the variant price (or the
    // product's), then tiers / the buyer's group price / MOQ. Unavailable (soft-deleted) lines are NOT handed to the resolver,
    // so they cannot carry a cart over a tier (review I4); bundles are priced separately below and never count (B8b).
    // The cart stores quantity only; this price is derived on every read, so a tier edit or a revoked approval shows at once.
    const resolver = opts.skipPricing ? null : await PriceResolver.forBuyer(storeId, buyer);
    const priced = await (resolver?.priceCart(
      items
        .filter(item => !item.unavailable)
        .map(item => ({
          key: item.id,
          product: {
            id: item.productId,
            price: item.product.price,
            moq: (item.product as { moq?: number | null }).moq ?? null,
          },
          variant: item.variant
            ? { id: (item as { variantId: string }).variantId, price: item.variant.price }
            : null,
          qty: item.quantity,
        }))
    ) ?? Promise.resolve(new Map<string, Resolved>()));
    // Gold pieces: the storefront-safe pricing facts per line (karat, weight, today's rate, when). One
    // query for the whole cart; fixed-price lines are absent.
    const goldByLine = opts.skipPricing
      ? new Map<string, never>()
      : await publicGoldPricingForLines(
          prisma as unknown as Prisma.TransactionClient,
          storeId,
          items
            .filter(i => !i.unavailable)
            .map(i => ({
              productId: i.productId,
              variantId: (i as { variantId?: string | null }).variantId ?? null,
            }))
        );
    const pricedItems = items.map(item => {
      const r = priced.get(item.id);
      if (!r) return item;
      // Ruling B5-17: a gold line carries the price it was added at; when the current base price differs
      // the cart says so and the checkout shows "السعر اتحدّث" until the shopper acknowledges.
      const quoted = (item as { quotedUnitPrice?: number | null }).quotedUnitPrice ?? null;
      const currentBase = item.variant?.price ?? item.product.price;
      const goldChanged = quoted !== null && quoted !== currentBase;
      return {
        ...item,
        ...(goldChanged ? { priceChanged: true, previousUnitPrice: quoted } : {}),
        ...(goldByLine.get(
          goldQuoteKey(item.productId, (item as { variantId?: string | null }).variantId ?? null)
        )
          ? {
              goldPricing: goldByLine.get(
                goldQuoteKey(
                  item.productId,
                  (item as { variantId?: string | null }).variantId ?? null
                )
              ),
            }
          : {}),
        // Server-resolved display values: the cart / checkout render THESE and never multiply a price client-side.
        unitPrice: r.unitMinor,
        lineTotal: r.unitMinor * item.quantity,
        listPrice: r.listMinor,
        priceSource: r.source,
        priceTierMinQty: r.tierMinQty,
        // The highest price break this buyer could reach (null = none): the storefront stepper must be able to get there.
        priceLadderTopMinQty: r.ladder.length > 0 ? r.ladder[r.ladder.length - 1]!.minQty : null,
        belowMoq: r.belowMoq,
        moqRequired: r.moqRequired,
      };
    });
    const itemsSubtotal = pricedItems.reduce(
      (sum, item) => ('lineTotal' in item ? sum + item.lineTotal : sum),
      0
    );

    // Bundles are NEVER expanded into cart_items (see cart-bundles.test.ts —
    // that would collide with the partial unique indexes on that table the
    // moment a bundle contained a product the customer already had). Each
    // bundle stays its own `CartBundle` row and is priced fresh here via
    // `resolveBundle`, which recomputes componentSum/price/available from
    // the CURRENT product/variant rows — never a cached price — so a
    // component price change between add-to-cart and this read is reflected
    // before the customer pays.
    // `cart.bundles ?? []`: a real Prisma read with `bundles: true` always
    // returns an array (empty when there are none) — the fallback exists so
    // pre-existing unit tests that mock a bare `{ id, items }` cart object
    // (predating this task) don't throw on `.map` of `undefined`.
    const resolvedBundles = await Promise.all(
      (cart.bundles ?? []).map(async (cb): Promise<CartBundleView | null> => {
        const resolved = await tryResolveCartBundle(storeId, cb.bundleId);
        if (!resolved) return null;
        return {
          id: cb.id,
          bundleId: cb.bundleId,
          name: resolved.name,
          nameAr: resolved.nameAr,
          image: resolved.image,
          quantity: cb.quantity,
          unitPrice: resolved.price,
          total: resolved.price * cb.quantity,
          available: resolved.available,
        };
      })
    );
    const bundles = resolvedBundles.filter((b): b is CartBundleView => b !== null);
    const bundlesSubtotal = bundles.reduce((sum, b) => sum + b.total, 0);

    return { ...cart, items: pricedItems, bundles, subtotal: itemsSubtotal + bundlesSubtotal };
  }

  /**
   * Read-only cart lookup (#1661). Unlike `getOrCreate`, a miss returns the
   * empty-cart shape instead of inserting a Cart row — `view_cart` (MCP) is
   * an anonymous READ, so it must not be a write amplifier: an unauthenticated
   * caller could otherwise mint unbounded Cart rows just by probing cartIds.
   */
  static async view(
    storeId: string,
    sessionId: string,
    customerId?: string,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER
  ) {
    const cart = await (
      await storeDb(storeId)
    ).cart.findFirst({
      where: {
        storeId,
        OR: [{ sessionId }, ...(customerId ? [{ customerId }] : [])],
      },
      include: CART_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });

    if (!cart) {
      return {
        items: [] as Awaited<ReturnType<typeof CartService.computeTotals>>['items'],
        bundles: [] as CartBundleView[],
        subtotal: 0,
      };
    }

    return this.computeTotals(storeId, cart, buyer);
  }

  static async getOrCreate(
    storeId: string,
    sessionId: string,
    customerId?: string,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER,
    /**
     * `skipPricing`: return the cart lines WITHOUT running the resolver. For a caller that prices the lines itself with
     * the real buyer (OrderService.create), so no throw-away anonymous pricing pass (tier + feature queries) is run.
     */
    opts: { skipPricing?: boolean } = {}
  ) {
    // Try to find an existing cart for this session (or customer).
    //
    // orderBy: updatedAt desc — when a customer logs in mid-session,
    // BOTH their fresh session cart AND their older customer cart may
    // match the OR clause. Without an explicit order, Postgres returns
    // either at random which can resurrect an empty stale cart and
    // cause a spurious EMPTY_CART on POST /orders. Returning the
    // most-recently-touched cart matches the user's mental model
    // ("my current cart") and prevents the test-order-cancel flakiness.
    const repo = await storeRepo(storeId);
    let cart = await repo.db.cart.findFirst({
      where: {
        storeId,
        OR: [{ sessionId }, ...(customerId ? [{ customerId }] : [])],
      },
      include: CART_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });

    if (!cart) {
      try {
        // Attempt to create — a concurrent request may have already created one,
        // in which case we catch the unique constraint violation and fall back to
        // a findFirst so we never return two carts for the same session.
        //
        // `withSavepoint` is what makes that fallback REACHABLE. Store-scoped
        // requests run inside the one interactive transaction
        // `middleware/tenant-context.ts` opens, and a failed INSERT aborts a
        // Postgres transaction outright — so without the savepoint the
        // `findFirst` below died with 25P02 ("current transaction is aborted")
        // and the request 500'd on the very race this catch block was written
        // to absorb.
        //
        // The race is routine, not exotic. It USED to fire even for a strictly
        // SEQUENTIAL customer: `tenantContext` committed the ambient
        // transaction on `res.on('finish')`, i.e. AFTER the response had been
        // flushed, so the NEXT request could begin before the previous
        // request's cart row was visible. That half is fixed at the source —
        // `middleware/request-transaction.ts` now commits before it answers.
        // What remains, and what this catch block is still for, is genuine
        // CONCURRENCY: two requests on one session in flight at once, where
        // the second's `findFirst` sees nothing and its `create` then collides
        // with the winner on `(store_id, session_id)`. Commit-before-respond
        // does nothing for that. See tests/integration/cart-session-race.test.ts.
        cart = await withSavepoint(() =>
          repo.writer.cart.create({
            data: {
              storeId,
              sessionId,
              customerId,
            },
            include: CART_INCLUDE,
          })
        );
      } catch (err) {
        // P2002 = Prisma unique constraint violation
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const existing = await repo.db.cart.findFirst({
            where: {
              storeId,
              OR: [{ sessionId }, ...(customerId ? [{ customerId }] : [])],
            },
            include: CART_INCLUDE,
          });
          if (!existing) {
            throw err; // Unexpected — re-throw
          }
          cart = existing;
        } else {
          throw err;
        }
      }
    }

    return this.computeTotals(storeId, cart, buyer, opts);
  }

  static async addItem(
    storeId: string,
    sessionId: string,
    productId: string,
    quantity: number = 1,
    customerId?: string,
    variantId?: string,
    rawNote?: string | null,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER
  ) {
    // Get or create cart first (outside transaction since getOrCreate has its own retry logic)
    const cart = await this.getOrCreate(storeId, sessionId, customerId, buyer);

    // Resolve the backorder feature flag before entering the transaction.
    // When disabled, per-product allowBackorder flags are ignored — out-of-stock
    // items are rejected at the cart level, preventing backorder lines from
    // ever reaching order creation.
    const backorderFeatureEnabled = await featureService.isFeatureEnabled(
      storeId,
      'inventory.backorder'
    );

    // Wrap the inventory check + cart item creation in a serializable transaction
    // to prevent a TOCTOU race where two concurrent addItem calls both pass the
    // inventory check before either has written. Note: the definitive inventory
    // lock happens at order creation time (SELECT ... FOR UPDATE in order.service),
    // but this transaction reduces the window for overselling at cart level.
    //
    // Serializable isolation aborts conflicting transactions with P2034 under
    // concurrency (e.g. many shoppers adding the same hot product at once). The
    // retry wrapper turns those transient conflicts into a brief backoff+retry
    // instead of a 500 — without it a load test surfaced ~18% failures on a hot
    // product. Business errors (INSUFFICIENT_INVENTORY, NOT_FOUND) are not P2034
    // so they propagate immediately and are never retried.
    // Perform the line write. Extracted so it can run either on the ambient
    // tenant transaction or in its own — see the branch below.
    const writeLine = async (tx: Prisma.TransactionClient) => {
      // Verify product exists, is active, and is NOT soft-deleted.
      // `status: 'active'` alone is not enough: `ProductService.delete` sets
      // `deletedAt` and nothing else (product.service.ts:999-1002), so a
      // deleted product keeps `status: 'active'`. This is the PRIMARY
      // add-to-cart path — the bulk `addItems` sibling below had the same hole.
      const product = await tx.product.findFirst({
        where: { id: productId, storeId, status: 'active', deletedAt: null },
        // Variant count for the VARIANT_REQUIRED gate below. Every variant row,
        // disabled ones included: a product whose variants are all disabled is
        // still a variant product, not a plain SKU.
        include: { _count: { select: { variants: true } } },
      });

      if (!product) {
        throw new AppError(404, 'NOT_FOUND', 'Product not found or unavailable');
      }
      // B2B-7b: a wholesale-only product is a 404 for anyone who is not an approved wholesale buyer (no existence oracle).
      if (product.audience === 'wholesale_only' && !(await canSeeWholesaleOnly(storeId, buyer))) {
        throw new AppError(404, 'NOT_FOUND', 'Product not found or unavailable');
      }

      // A product with variants is bought as ONE of its variants, never as the
      // bare parent (C-01, 2026-10-15). Without this gate a quick-add with no
      // variantId fell back to the parent's `inventory` column, which the
      // inventory model holds at 0 for a variant product: an in-stock sized
      // product failed as "not enough inventory", and with backorder on it
      // wrote a SIZELESS line that checkout then sold. The storefront card is
      // only a hint; this is the gate.
      if (!variantId && product._count.variants > 0) {
        throw new AppError(400, 'VARIANT_REQUIRED', VARIANT_REQUIRED_MESSAGE.en, {
          messageEn: VARIANT_REQUIRED_MESSAGE.en,
          messageAr: VARIANT_REQUIRED_MESSAGE.ar,
        });
      }

      // The note is part of the line identity: (cart, product, variant, note).
      const resolvedNote = resolveLineNote(product.personalisation, rawNote);
      if ('error' in resolvedNote) {
        throw new AppError(
          400,
          resolvedNote.error,
          resolvedNote.error === 'PERSONALISATION_REQUIRED'
            ? 'Personalisation text is required for this product'
            : 'Personalisation text is too long'
        );
      }
      const note = resolvedNote.note;

      // Resolve the chosen variant — it must belong to this product and
      // be active. Variant stock overrides the product column; backorder is the
      // variant flag OR the product flag (lineAllowsBackorder),
      // and the line is keyed by (cartId, productId, variantId) so each
      // variant is its own row (order.service already reads variantId).
      let variant: { id: string; inventory: number; allowBackorder: boolean } | null = null;
      if (variantId) {
        variant = await tx.productVariant.findFirst({
          where: { id: variantId, productId, isActive: true },
          select: { id: true, inventory: true, allowBackorder: true },
        });
        if (!variant) {
          throw new AppError(404, 'NOT_FOUND', 'Variant not found or unavailable');
        }
      }

      const availableInventory = variant ? variant.inventory : product.inventory;
      // Variant inherits the product flag — the shared rule (X-02 fix round).
      const effectiveAllowBackorder = lineAllowsBackorder(
        product,
        variant,
        backorderFeatureEnabled
      );

      // Same product+variant+note line if it already exists (null variantId for
      // base-product lines merges only with other base-product lines; `note: null`
      // matches IS NULL, which agrees with the COALESCE(note,'') unique index
      // because cleanNote never stores an empty string).
      const existingItem = await tx.cartItem.findFirst({
        where: { cartId: cart.id, productId, variantId: variantId ?? null, note },
      });

      if (existingItem) {
        const newQuantity = existingItem.quantity + quantity;

        if (
          product.trackInventory &&
          availableInventory < newQuantity &&
          !effectiveAllowBackorder
        ) {
          throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
        }

        // `increment`, not the absolute `newQuantity` computed above.
        // `newQuantity` comes from a read that another request can invalidate
        // before this UPDATE takes the row lock: two concurrent adds of one
        // more unit both read quantity=1, both wrote 2, and one add vanished
        // from the customer's cart with a 201 in front of it. `increment`
        // compiles to `SET quantity = quantity + n`, evaluated against the row
        // as it stands when the lock is granted, so both adds land.
        // `newQuantity` stays the basis of the inventory check above, which is
        // explicitly advisory (the authoritative oversell guard is the atomic
        // decrement in order.service).
        await tx.cartItem.update({
          where: { id: existingItem.id },
          data: { quantity: { increment: quantity } },
        });
      } else {
        if (product.trackInventory && availableInventory < quantity && !effectiveAllowBackorder) {
          throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
        }

        // A concurrent add of the same line to the SAME cart can lose the
        // (cartId, productId, variantId) unique race → P2002. Under
        // Serializable that surfaced as P2034 and was retried; under Read
        // Committed it's P2002, so the retry wrapper below is told to retry
        // P2002 too — on the re-run findFirst sees the winner's row and the
        // existing-branch above merges the quantity.
        // Ruling B5-17: a gold line stores the price the SERVER shows right now as its quote (never a client
        // value); a fixed-price line stores none. A quantity change later leaves it untouched.
        const quote = (
          await goldQuotesForLines(tx, storeId, [{ productId, variantId: variantId ?? null }])
        ).get(goldQuoteKey(productId, variantId ?? null));
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            productId,
            variantId: variantId ?? null,
            note,
            quantity,
            ...(quote ?? {}),
          },
        });
      }
    };

    const repo = await storeRepo(storeId);
    if (repo.backend === 'do') {
      // Durable Object store (Ruling CF-R2-1): no interactive transaction; a lost same-line race is P2002 and the re-run's
      // read sees the winner's row and merges, exactly as on the Postgres ambient path.
      await retryOnWriteConflict(() => writeLine(doTx(repo)), {
        label: 'cart.addItem(do)',
        extraRetryCodes: ['P2002', 'P2025'],
        ...AMBIENT_TX_RETRY,
      });
    } else if (hasTenantContext()) {
      // Already inside the request-scoped tenant transaction opened by
      // `tenantContext` middleware. Opening a nested $transaction here would
      // run on a DIFFERENT connection that cannot see the cart this request
      // just created — `getOrCreate` writes through the tenant proxy, and that
      // outer transaction does not commit until the response finishes. The FK
      // on cart_items.cart_id then pointed at an invisible row → P2003, a 500
      // on the FIRST add-to-cart of a session (a GET /cart first masked it by
      // committing the cart in an earlier request). Prisma has no nested
      // interactive transactions in any case.
      //
      // The outer transaction supplies atomicity here. The isolation level
      // below is not applied on this path, which is acceptable for the same
      // reason the comment there gives: this check is advisory and the
      // authoritative oversell guard is the atomic decrement in order.service.
      //
      // The same P2002 the `else` branch retries can happen here (two requests
      // adding the SAME line to the SAME cart), and it needs the SAME recovery
      // — but the tx belongs to the request, so re-running the whole thing is
      // not an option. `withSavepoint` scopes the failed INSERT's rollback so
      // the request transaction survives it (without it the retry would run
      // against an ABORTED transaction and every statement would throw 25P02),
      // and the re-run's `findFirst` then sees the winner's committed row and
      // merges the quantity — exactly the recovery the create's comment above
      // describes.
      await retryOnWriteConflict(
        () => withSavepoint(() => writeLine(prisma as unknown as Prisma.TransactionClient)),
        {
          label: 'cart.addItem(ambient-tx)',
          extraRetryCodes: ['P2002', 'P2025'],
          ...AMBIENT_TX_RETRY,
        }
      );
    } else {
      // No tenant context (crons, scripts, tests) — own transaction as before.
      await retryOnWriteConflict(
        () =>
          prisma.$transaction(writeLine, {
            // Advisory cart-level check only — the authoritative inventory lock
            // is the atomic decrement at order creation (order.service). Read
            // Committed avoids the spurious P2034 storm where concurrent adds of
            // the SAME product (each writing its OWN cart row) conflicted purely
            // because they read the same product.inventory row under Serializable.
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            // Money-safe tx defaults (mirrors withMoneyTx): Prisma's 2s maxWait
            // fires P2028 on the Neon pooler under checkout burst → 500. Bump to
            // the withMoneyTx values so a brief lock wait retries instead of
            // aborting. (withMoneyTx itself can't carry isolationLevel, so we
            // set its maxWait/timeout inline and keep Read Committed.)
            maxWait: 10000,
            timeout: 30000,
          }),
        { label: 'cart.addItem', extraRetryCodes: ['P2002', 'P2025'] }
      );
    }

    // Track activity for abandonment detection
    await (
      await storeWriter(storeId)
    ).cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId, buyer);
  }

  /**
   * "متابعة" on the price-updated notice (Ruling B5-17): every gold line's quote becomes the CURRENT
   * base price, so the checkout may proceed. The values come from the database, never the client.
   * Returns how many lines were re-quoted.
   */
  static async acknowledgePrices(
    storeId: string,
    sessionId: string,
    customerId?: string
  ): Promise<{ acknowledged: number }> {
    const repo = await storeRepo(storeId);
    const cart = await repo.db.cart.findFirst({
      where: { storeId, OR: [{ sessionId }, ...(customerId ? [{ customerId }] : [])] },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (!cart) return { acknowledged: 0 };
    const lines = await repo.db.cartItem.findMany({
      where: { cartId: cart.id, quotedUnitPrice: { not: null } },
      select: {
        id: true,
        quotedUnitPrice: true,
        product: { select: { price: true } },
        variant: { select: { price: true } },
      },
    });
    const now = new Date();
    let acknowledged = 0;
    for (const l of lines) {
      const current = l.variant?.price ?? l.product.price;
      if (current === l.quotedUnitPrice) continue;
      await repo.writer.cartItem.updateMany({
        where: { id: l.id, cartId: cart.id },
        data: { quotedUnitPrice: current, quotedAt: now },
      });
      acknowledged++;
    }
    return { acknowledged };
  }

  /**
   * Add a bundle to the cart — as its OWN `CartBundle` row, never expanded
   * into `cart_items`. Expanding here would collide with the partial unique
   * indexes on `cart_items` the moment the bundle contained a product the
   * customer already had in their cart standalone (see the regression test
   * in tests/integration/cart-bundles.test.ts). Component-level expansion
   * happens once, at order creation (Task 6) — never in the cart.
   *
   * Returns a discriminated result instead of throwing for the two
   * BUSINESS-rule refusals (`bundle_not_purchasable` / `insufficient_stock`)
   * so the route can respond with the flat `{ error: '<code>' }` 422 body
   * the cart-bundles test suite expects — a convention independent of
   * bundle.routes.ts's admin-CRUD errors (which moved onto the standard
   * AppError envelope in RULING T9-a; this cart-facing shape is
   * unaffected), and still kept separate from the generic `AppError`
   * envelope (`{ success:false, error:{code,...} }`) that a genuine 404
   * (wrong store / unknown bundle, still thrown via `resolveBundle` below
   * and left to propagate) goes through.
   */
  static async addBundle(
    storeId: string,
    sessionId: string,
    bundleId: string,
    quantity: number = 1,
    customerId?: string,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER
  ): Promise<
    | { ok: true; cart: Awaited<ReturnType<typeof CartService.getOrCreate>> }
    | { ok: false; error: 'bundle_not_purchasable' | 'insufficient_stock' }
  > {
    const cart = await this.getOrCreate(storeId, sessionId, customerId, buyer);

    // Recomputed from CURRENT component prices/stock — resolveBundle never
    // caches. Throws AppError(404) for a bundle that isn't this store's;
    // that propagates to the route's catch-all `next(error)` unchanged,
    // same as every other cross-tenant 404 in this codebase.
    const repo = await storeRepo(storeId);
    const resolved = await resolveBundle(repo.db as unknown as typeof prisma, storeId, bundleId);

    if (!resolved.isPurchasable) {
      return { ok: false, error: 'bundle_not_purchasable' };
    }

    // Read-check-write for the (cartId, bundleId) line. Mirrors addItem's
    // writeLine: under the ambient tenant transaction (cart.routes.ts's
    // mount always opens one — see tenant-context.ts) this runs inline on
    // the SAME connection; standalone callers (scripts/tests with no tenant
    // context) get their own transaction. `resolved.available` is a
    // snapshot taken just above — same advisory-only posture addItem
    // documents: the authoritative oversell guard is order creation's
    // atomic decrement, not this check.
    const writeBundleLine = async (
      tx: Prisma.TransactionClient
    ): Promise<{ ok: true } | { ok: false; error: 'insufficient_stock' }> => {
      const existing = await tx.cartBundle.findFirst({ where: { cartId: cart.id, bundleId } });
      const targetQuantity = (existing?.quantity ?? 0) + quantity;

      if (targetQuantity > resolved.available) {
        return { ok: false, error: 'insufficient_stock' };
      }

      if (existing) {
        // Atomic increment, not the absolute `targetQuantity` — same
        // lost-update reason as addItem's merge above.
        await tx.cartBundle.update({
          where: { id: existing.id },
          data: { quantity: { increment: quantity } },
        });
      } else {
        await tx.cartBundle.create({ data: { cartId: cart.id, bundleId, quantity } });
      }
      return { ok: true };
    };

    // Ambient-tx path: same treatment as addItem's. A concurrent add of the
    // SAME bundle to the SAME cart loses the `(cart_id, bundle_id)` unique
    // race as P2002, which would abort the request transaction outright —
    // `withSavepoint` confines that rollback so the retry can re-read the
    // winner's row and merge the quantity instead of 500ing the customer.
    const result =
      repo.backend === 'do'
        ? await retryOnWriteConflict(() => writeBundleLine(doTx(repo)), {
            label: 'cart.addBundle(do)',
            extraRetryCodes: ['P2002', 'P2025'],
            ...AMBIENT_TX_RETRY,
          })
        : hasTenantContext()
          ? await retryOnWriteConflict(
              () =>
                withSavepoint(() => writeBundleLine(prisma as unknown as Prisma.TransactionClient)),
              {
                label: 'cart.addBundle(ambient-tx)',
                extraRetryCodes: ['P2002', 'P2025'],
                ...AMBIENT_TX_RETRY,
              }
            )
          : await retryOnWriteConflict(
              () =>
                prisma.$transaction(writeBundleLine, {
                  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
                  maxWait: 10000,
                  timeout: 30000,
                }),
              { label: 'cart.addBundle', extraRetryCodes: ['P2002', 'P2025'] }
            );

    if (!result.ok) {
      return result;
    }

    await (
      await storeWriter(storeId)
    ).cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return { ok: true, cart: await this.getOrCreate(storeId, sessionId, customerId, buyer) };
  }

  /** Remove one bundle line (by its `CartBundle` row id) from the cart. */
  static async removeBundle(
    storeId: string,
    sessionId: string,
    cartBundleId: string,
    customerId?: string,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER
  ) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId, buyer);

    const bundle = await (
      await storeDb(storeId)
    ).cartBundle.findFirst({
      where: { id: cartBundleId, cartId: cart.id },
    });
    if (!bundle) {
      throw new AppError(404, 'NOT_FOUND', 'Cart bundle not found');
    }

    await withSavepoint(async () =>
      (await storeWriter(storeId)).cartBundle.delete({ where: { id: cartBundleId } })
    ).catch(ignoreLineGone);

    await (
      await storeWriter(storeId)
    ).cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId, buyer);
  }

  static async addItems(
    storeId: string,
    sessionId: string,
    items: Array<{ productId: string; quantity: number; variantId?: string; note?: string | null }>,
    customerId?: string,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER
  ) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId, buyer);

    if (items.length === 0) {
      return cart;
    }

    // Resolve the backorder feature flag before the transaction (same reason as addItem).
    const backorderFeatureEnabled = await featureService.isFeatureEnabled(
      storeId,
      'inventory.backorder'
    );

    const productIds = items.map(i => i.productId);
    // `deletedAt: null` alongside `status: 'active'`, because soft delete does
    // NOT change status: `ProductService.delete` sets `deletedAt` and nothing
    // else (product.service.ts:999-1002), so a deleted product is still
    // `status: 'active'` and was resolvable here. A customer could add a
    // product the merchant had deleted to their cart and only discover it at
    // order creation — the same defect the audit reported one step later.
    const repo = await storeRepo(storeId);
    const products = await repo.db.product.findMany({
      where: { id: { in: productIds }, storeId, status: 'active', deletedAt: null },
      select: {
        id: true,
        inventory: true,
        trackInventory: true,
        allowBackorder: true,
        personalisation: true,
        audience: true,
        _count: { select: { variants: true } },
      },
    });
    if (
      products.some(p => p.audience === 'wholesale_only') &&
      !(await canSeeWholesaleOnly(storeId, buyer))
    ) {
      // B2B-7b: treat wholesale-only products as missing for a non-member (same 404 as an unknown product).
      for (const p of products.filter(p => p.audience === 'wholesale_only')) {
        products.splice(products.indexOf(p), 1);
      }
    }
    const productById = new Map(products.map(p => [p.id, p]));

    // Resolve any chosen variants up front (must belong to one of these products
    // and be active). Variant stock overrides the product column; backorder
    // inherits the product flag (lineAllowsBackorder).
    const variantIds = items.map(i => i.variantId).filter((v): v is string => !!v);
    const variants = variantIds.length
      ? await repo.db.productVariant.findMany({
          where: { id: { in: variantIds }, productId: { in: productIds }, isActive: true },
          // productId: the ownership check below (a variant must belong to ITS line's product).
          select: { id: true, productId: true, inventory: true, allowBackorder: true },
        })
      : [];
    const variantById = new Map(variants.map(v => [v.id, v]));
    // A line is (product, variant, note) — two notes on one item are two lines.
    const lineKey = (productId: string, variantId?: string | null, note?: string | null) =>
      JSON.stringify([productId, variantId ?? null, note ?? null]);

    // Resolve each note against its product's config BEFORE aggregating, so two
    // payload lines whose raw notes clean to the same text merge. A line that
    // breaks the product's rule (required-but-empty, too long) is SKIPPED, the
    // same way an invalid variant is below: this is the guest→login sync, and
    // failing the whole request would lose the customer's entire cart because
    // the merchant tightened one product's rule since the add.
    const resolvedItems = items.flatMap(item => {
      const product = productById.get(item.productId);
      if (!product) return [];
      // A variant product with no variant chosen is skipped, the same way an
      // invalid variant is below (the VARIANT_REQUIRED gate in addItem, applied
      // with this path's skip-don't-fail policy — Ruling FU46-W1a-2).
      if (!item.variantId && product._count.variants > 0) return [];
      // The variant must belong to THIS line's product. The lookup above only
      // proves it belongs to SOME product in the payload, so `[{A, vB}, {B}]`
      // wrote an (A, vB) line carrying B's size, stock and price (W1a review #1).
      // Skipped, like an invalid variant; store id + code only in the log. A
      // variant the lookup did not return (disabled, deleted, or not of any
      // product in the payload) logs its own code: a disabled size is a normal
      // catalogue change, a mismatch is a malformed or tampered payload.
      if (item.variantId) {
        const found = variantById.get(item.variantId);
        if (!found) {
          logger.warn(
            { storeId, code: 'VARIANT_UNAVAILABLE' },
            '[cart.addItems] skipped a line whose variant is disabled or gone'
          );
          return [];
        }
        if (found.productId !== item.productId) {
          logger.warn(
            { storeId, code: 'VARIANT_PRODUCT_MISMATCH' },
            '[cart.addItems] skipped a line whose variant is not its product'
          );
          return [];
        }
      }
      const r = resolveLineNote(product.personalisation, item.note);
      return 'error' in r ? [] : [{ ...item, note: r.note }];
    });

    // #1790: aggregate the payload by lineKey BEFORE the write loop. Without
    // this, two lines in the SAME sync payload for a product/variant with no
    // existing cart row both read "no existing" off the map below (which is
    // only populated from the DB, once, before the loop starts) and both
    // reach `tx.cartItem.create`, colliding on the cart's unique index. This
    // way the loop below sees each product/variant line at most once, with
    // its quantities already summed — matching the "one line per
    // product+variant" invariant the cart's own unique index enforces.
    const aggregatedItems = Array.from(
      resolvedItems
        .reduce((acc, item) => {
          const key = lineKey(item.productId, item.variantId, item.note);
          const merged = acc.get(key);
          if (merged) {
            merged.quantity += item.quantity;
          } else {
            acc.set(key, { ...item });
          }
          return acc;
        }, new Map<string, { productId: string; quantity: number; variantId?: string; note: string | null }>())
        .values()
    );

    // Extracted so BOTH paths run the same body — the ambient one inline on the
    // request transaction, the standalone one inside its own. Leaving this
    // inline is what let `addItems` keep the defect `addItem` and `addBundle`
    // were both fixed for.
    const writeItems = async (tx: Prisma.TransactionClient, lines = aggregatedItems) => {
      const existingItems = await tx.cartItem.findMany({
        where: { cartId: cart.id, productId: { in: productIds } },
      });
      const existingByLine = new Map(
        existingItems.map(i => [lineKey(i.productId, i.variantId, i.note), i])
      );

      for (const item of lines) {
        const product = productById.get(item.productId);
        if (!product) continue;
        // A chosen-but-invalid variant is skipped, not silently dropped to
        // the base product (which would be the wrong cart line).
        if (item.variantId && !variantById.has(item.variantId)) continue;
        const variant = item.variantId ? variantById.get(item.variantId)! : null;

        const existing = existingByLine.get(lineKey(item.productId, item.variantId, item.note));
        const targetQuantity = (existing?.quantity ?? 0) + item.quantity;

        const availableInventory = variant ? variant.inventory : product.inventory;
        const effectiveAllowBackorder = lineAllowsBackorder(
          product,
          variant,
          backorderFeatureEnabled
        );

        if (
          product.trackInventory &&
          availableInventory < targetQuantity &&
          !effectiveAllowBackorder
        ) {
          throw new AppError(
            400,
            'INSUFFICIENT_INVENTORY',
            `Not enough inventory for product ${item.productId}`
          );
        }

        if (existing) {
          // Atomic increment, not the absolute `targetQuantity` — same
          // lost-update reason as addItem's merge (a bulk sync racing a
          // manual add is the concrete case here).
          await tx.cartItem.update({
            where: { id: existing.id },
            data: { quantity: { increment: item.quantity } },
          });
        } else {
          // Same-cart unique race → P2002, retried at the tx level (see
          // addItem + the extraRetryCodes below).
          const quote = (
            await goldQuotesForLines(tx, storeId, [
              { productId: item.productId, variantId: item.variantId ?? null },
            ])
          ).get(goldQuoteKey(item.productId, item.variantId ?? null));
          await tx.cartItem.create({
            data: {
              cartId: cart.id,
              productId: item.productId,
              variantId: item.variantId ?? null,
              note: item.note,
              quantity: item.quantity,
              ...(quote ?? {}),
            },
          });
        }
      }
    };

    if (repo.backend === 'do') {
      // Durable Object store (Ruling CF-R2-1): see addItem. The aggregated payload carries each line once, so a retry after a
      // P2002 on the Nth line must not re-apply `{ increment }` to the lines before it (a transaction would have rolled them
      // back), so every line is first CHECKED in a write-less pass (INSUFFICIENT_INVENTORY refuses the whole payload, as the
      // Postgres transaction does) and then written ONE line at a time, each with its own re-read-and-merge retry.
      await writeItems(doTx(repo, true));
      for (const item of aggregatedItems)
        await retryOnWriteConflict(() => writeItems(doTx(repo), [item]), {
          label: 'cart.addItems(do)',
          extraRetryCodes: ['P2002', 'P2025'],
          ...AMBIENT_TX_RETRY,
        });
    } else if (hasTenantContext()) {
      // Already inside the request-scoped tenant transaction opened by
      // `tenantContext` middleware, exactly as in `addItem`. `getOrCreate`
      // above writes the new `carts` row through the tenant proxy, and that
      // outer transaction does not commit until the response finishes.
      // `$transaction` is deliberately NOT proxied (packages/database
      // `isProxiedProp` rejects every `$`-prefixed name but the raw helpers),
      // so a nested one runs on a DIFFERENT connection that cannot see that
      // cart — and `tx.cartItem.create` then violated the
      // `cart_items.cart_id` FK with P2003. P2003 is in neither
      // `RETRYABLE_CODES` nor the `extraRetryCodes` below, so all attempts
      // failed and it surfaced as a 500; `tenantContext` rolls back on a 5xx,
      // discarding the cart row too, so a client retry reproduced it
      // identically instead of self-healing.
      //
      // Reachable at `POST /stores/:storeId/cart/sync`, mounted under
      // `tenantContext` with no `authenticate`. The first-party storefront
      // calls the sibling `/public/cart/sync`, which is mounted OUTSIDE
      // tenantContext and therefore always took the safe branch — which is
      // why this survived three separate reports without a production 500.
      //
      // `withSavepoint` is load-bearing here for a second reason beyond
      // addItem's: this body writes a LOOP of lines, so a P2002 on the fifth
      // item cannot be undone by rolling back a transaction we do not own.
      // Without the savepoint the retry would re-apply `{ increment }` to the
      // four lines that already succeeded and silently double them.
      await retryOnWriteConflict(
        () => withSavepoint(() => writeItems(prisma as unknown as Prisma.TransactionClient)),
        {
          label: 'cart.addItems(ambient-tx)',
          extraRetryCodes: ['P2002', 'P2025'],
          ...AMBIENT_TX_RETRY,
        }
      );
    } else {
      // No tenant context (the public storefront route, crons, scripts,
      // tests) — own transaction as before.
      await retryOnWriteConflict(
        () =>
          prisma.$transaction(writeItems, {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            // Money-safe tx defaults (mirrors withMoneyTx) — see addItem above.
            maxWait: 10000,
            timeout: 30000,
          }),
        { label: 'cart.addItems', extraRetryCodes: ['P2002', 'P2025'] }
      );
    }

    await (
      await storeWriter(storeId)
    ).cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId, buyer);
  }

  static async updateItem(
    storeId: string,
    sessionId: string,
    itemId: string,
    quantity: number,
    customerId?: string,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER
  ) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId, buyer);

    // Resolve the backorder feature flag before the inventory check.
    const backorderFeatureEnabled = await featureService.isFeatureEnabled(
      storeId,
      'inventory.backorder'
    );

    const repo = await storeRepo(storeId);
    const item = await repo.db.cartItem.findFirst({
      where: { id: itemId, cartId: cart.id },
      // The variant is REQUIRED here, not a nicety: for a variant line the
      // parent product's `inventory` column is not stock (see
      // lib/effective-inventory.ts). Selecting only `product` is what made
      // every quantity change on a variant product throw.
      include: {
        product: true,
        variant: { select: { id: true, inventory: true, allowBackorder: true } },
      },
    });

    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Cart item not found');
    }

    if (quantity <= 0) {
      await withSavepoint(() => repo.writer.cartItem.delete({ where: { id: itemId } })).catch(
        ignoreLineGone
      );
    } else {
      // Variant lines are authoritative on the VARIANT row; only a
      // variant-less line falls back to the product column. Mirrors
      // `addItem` (~:151) and `validate` (~:285), which have always done this.
      const stockHolder = item.variant ?? item.product;
      // `??` never fell back (a variant's false is not nullish): one shared rule.
      const effectiveAllowBackorder = lineAllowsBackorder(
        item.product,
        item.variant,
        backorderFeatureEnabled
      );
      if (
        item.product.trackInventory &&
        stockHolder.inventory < quantity &&
        !effectiveAllowBackorder
      ) {
        throw new AppError(400, 'INSUFFICIENT_INVENTORY', 'Not enough inventory');
      }

      await withSavepoint(() =>
        repo.writer.cartItem.update({
          where: { id: itemId },
          data: { quantity },
        })
      ).catch((err: unknown) => {
        // Removed concurrently (see isLineGone): the same 404 the
        // `findFirst` guard above answers, not a 500.
        if (isLineGone(err)) throw new AppError(404, 'NOT_FOUND', 'Cart item not found');
        throw err;
      });
    }

    // Track activity for abandonment detection
    await (
      await storeWriter(storeId)
    ).cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId, buyer);
  }

  static async removeItem(
    storeId: string,
    sessionId: string,
    itemId: string,
    customerId?: string,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER
  ) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId, buyer);

    const repo = await storeRepo(storeId);
    const item = await repo.db.cartItem.findFirst({
      where: { id: itemId, cartId: cart.id },
    });

    if (!item) {
      throw new AppError(404, 'NOT_FOUND', 'Cart item not found');
    }

    await withSavepoint(() => repo.writer.cartItem.delete({ where: { id: itemId } })).catch(
      ignoreLineGone
    );

    // Track activity for abandonment detection
    await (
      await storeWriter(storeId)
    ).cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId, buyer);
  }

  static async clear(
    storeId: string,
    sessionId: string,
    customerId?: string,
    /** Who the prices are for (lib/buyer-identity.ts); default anonymous = retail + public tiers. */
    buyer: BuyerIdentity = ANONYMOUS_BUYER
  ) {
    const cart = await this.getOrCreate(storeId, sessionId, customerId, buyer);

    const w = await storeWriter(storeId);
    await w.cartItem.deleteMany({
      where: { cartId: cart.id },
    });
    // Bundles live in their own table (see the file header) — clearing the
    // cart must clear both, or a "cleared" cart would still show its bundle
    // lines and a non-zero subtotal.
    await w.cartBundle.deleteMany({
      where: { cartId: cart.id },
    });

    // Track activity for abandonment detection
    await (
      await storeWriter(storeId)
    ).cart.update({
      where: { id: cart.id, storeId },
      data: { lastActivityAt: new Date() },
    });

    return this.getOrCreate(storeId, sessionId, customerId, buyer);
  }

  static async mergeGuestCart(storeId: string, guestSessionId: string, customerId: string) {
    const repo = await storeRepo(storeId);
    const [guestCart, userCart] = await Promise.all([
      repo.db.cart.findFirst({
        where: { storeId, sessionId: guestSessionId, customerId: null },
        include: { items: true, bundles: true },
      }),
      repo.db.cart.findFirst({
        where: { storeId, customerId },
        include: { items: true, bundles: true },
      }),
    ]);

    // `guestCart.bundles ?? []`: pre-existing unit tests in tests/unit/cart.test.ts
    // mock a bare `{ id, items }` cart object that predates the CartBundle table
    // and carries no `bundles` field.
    const guestBundles = guestCart?.bundles ?? [];

    if (!guestCart || (guestCart.items.length === 0 && guestBundles.length === 0)) {
      return userCart;
    }

    // No cart of their own yet: PROMOTE the guest cart rather than create a
    // second one.
    //
    // `carts` carries a FULL unique index on `(store_id, session_id)` —
    // `carts_store_id_session_id_key`, not partial and not conditioned on
    // `customer_id`. The early return above guarantees `guestCart` exists with
    // this exact `(storeId, guestSessionId)`, and it is not deleted until the
    // end of this function. So creating a row with the same pair was not a
    // lost race: it was a 100% collision on every call down this branch, and
    // inside the ambient tenant transaction it aborts the whole request — so
    // the two merge loops below and the guest-cart delete were unreachable
    // here too.
    //
    // Promotion is also simply the right operation. The merge loops have
    // nothing to merge when there is no user cart, and the delete would be
    // deleting the row we want to keep.
    //
    // Why this was never seen: `mergeGuestCart` has no HTTP route, and the
    // only real-DB test always pre-creates a `userCart`, so this branch had
    // never executed against the real index. The unit tests mock Prisma,
    // where a unique index does not exist.
    if (!userCart) {
      await repo.writer.cart.update({
        where: { id: guestCart.id, storeId },
        data: { customerId },
      });
      return this.loadMergedCart(storeId, guestCart.id);
    }

    const targetCart = userCart;

    // Merge items — match on productId, variantId AND note so a red-large variant
    // and a red-small variant (same product, different variants), or "Sara" and
    // "Omar" on the same abaya, stay as separate lines instead of merging into one.
    for (const guestItem of guestCart.items) {
      const existingItem = userCart?.items.find(
        item =>
          item.productId === guestItem.productId &&
          (item.variantId ?? null) === (guestItem.variantId ?? null) &&
          (item.note ?? null) === (guestItem.note ?? null)
      );

      if (existingItem) {
        // Atomic increment — `userCart` was read before this loop, and the
        // customer's other tab can add to that same line while the merge runs.
        await repo.writer.cartItem.update({
          where: { id: existingItem.id },
          data: { quantity: { increment: guestItem.quantity } },
        });
      } else {
        await repo.writer.cartItem.create({
          data: {
            cartId: targetCart.id,
            productId: guestItem.productId,
            variantId: guestItem.variantId ?? null,
            note: guestItem.note ?? null,
            quantity: guestItem.quantity,
            // what the shopper was shown stays what they were shown (Ruling B5-17)
            quotedUnitPrice: guestItem.quotedUnitPrice ?? null,
            quotedAt: guestItem.quotedAt ?? null,
          },
        });
      }
    }

    // Merge bundles — match on bundleId. `cart_bundles` has a UNIQUE
    // (cart_id, bundle_id) index (same trap `cart_items`' partial unique
    // indexes exist to avoid — see the file header): if the user's own cart
    // already carries this bundle, the guest's line MUST increment that
    // row's quantity rather than INSERT a second one, or this merge itself
    // would violate the index it exists to protect.
    for (const guestBundle of guestBundles) {
      const existingBundle = userCart?.bundles?.find(b => b.bundleId === guestBundle.bundleId);

      if (existingBundle) {
        // Atomic increment — same reason as the item merge above.
        await repo.writer.cartBundle.update({
          where: { id: existingBundle.id },
          data: { quantity: { increment: guestBundle.quantity } },
        });
      } else {
        await repo.writer.cartBundle.create({
          data: {
            cartId: targetCart.id,
            bundleId: guestBundle.bundleId,
            quantity: guestBundle.quantity,
          },
        });
      }
    }

    // Delete guest cart (cascades to its own CartItem/CartBundle rows).
    await repo.writer.cart.delete({ where: { id: guestCart.id, storeId } });

    return this.loadMergedCart(storeId, targetCart.id);
  }

  /**
   * Re-read a merged cart with the storefront-safe shape.
   *
   * Extracted so the promote-in-place branch and the merge branch cannot
   * return two different shapes — a duplicated include is exactly how that
   * drifts.
   */
  private static async loadMergedCart(storeId: string, cartId: string) {
    return (await storeDb(storeId)).cart.findUnique({
      where: { id: cartId, storeId },
      include: {
        items: {
          include: {
            product: {
              select: {
                ...STOREFRONT_PRODUCT_SELECT,
                images: { take: 1, orderBy: { position: 'asc' } },
              },
            },
          },
        },
        bundles: true,
      },
    });
  }
}
