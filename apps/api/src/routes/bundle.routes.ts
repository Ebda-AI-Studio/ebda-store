/**
 * Product Bundles — admin CRUD + a public read endpoint.
 *
 * Same shape as promotion.routes.ts / coupon.routes.ts: mounted at the bare
 * '/stores' prefix in routes/index.ts, so Express does NOT populate
 * req.params.storeId at the mount level — every route below declares its
 * own '/:storeId/...' path, and `router.param('storeId', tenantContext)`
 * fires after Express resolves the param for the matched route, opening the
 * per-request tenant transaction that every `prisma.*` call below runs
 * inside (see tenant-context.ts). Do NOT call `runInTenantContext` or
 * `prisma.$transaction` again inside a handler — the ambient transaction
 * already covers the whole request, and `$transaction` is not proxied to it
 * (see @ebda/database's `hasTenantContext` doc comment).
 *
 * Every route (including the public one) is gated on the `bundles` feature,
 * which is in NO plan baseline (see plan-baselines.ts) — a store only gets
 * it via a super-admin StoreFeature override.
 *
 * Pricing/allocation math lives in `@ebda/shared` (Task 2); the resolved,
 * priced bundle shape (componentSum/price/available/isPurchasable) lives in
 * `services/bundle.service.ts` (Task 3) via `resolveBundle`. This file is
 * persistence + admin-time validation only.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { storeDb, storeRepo, storeWriter } from '../lib/repo-factory';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import { searchNameIds } from '../services/product-search.service';
import logger from '../lib/logger';
import {
  computeBundlePrice,
  isAllocatable,
  nearestAllocatablePrice,
  type BundleLine,
  type BundlePricingType,
} from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { publicLimiter, publicTenantLimiter } from '../middleware/security';
import { tenantContext } from '../middleware/tenant-context';
import { AppError } from '../middleware/error-handler';
import { retailUnitPrice } from '../lib/cart-pricing';
import {
  resolveBundle,
  compareBundleComponents,
  withinSaleWindow,
  listBundleSavingsForProducts,
  type ResolvedBundle,
} from '../services/bundle.service';
import { invalidateStoreProductCaches, bundlesCacheKey, getCached } from '../lib/public-cache';
import { scheduleBundleBoundary } from '../lib/storefront-purge-jobs';

/** Most bundles the public storefront list serves (newest first). */
export const PUBLIC_BUNDLE_LIST_CAP = 200;

const router = Router();

// See file header — mirrors promotion.routes.ts / coupon.routes.ts exactly.
router.param('storeId', tenantContext);

/** Middleware chain shared across every admin route in this file. */
const adminMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('bundles'),
];

// A bundle component count is bounded the same way scopeProductIds is on
// promotions/coupons (max 500) — but a bundle is a physical kit a merchant
// hand-assembles, not a marketing scope, so a far smaller cap is the
// realistic ceiling and keeps `allocateBundlePrice`'s O(lines) work trivial.
const MAX_BUNDLE_ITEMS = 50;

interface BundleItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

const bundleItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullish(),
  // Mirrors the DB CHECK ("quantity" >= 1 AND "quantity" <= 1000) added in
  // Task 2 — that constraint exists because a quantity < 1 made
  // `allocateBundlePrice` hang and a huge one burned CPU. Validating here is
  // the FIRST of three defences (this schema, the DB CHECK, and
  // `assertValidLines` inside `@ebda/shared`), not the only one.
  quantity: z.number().int().min(1).max(1000),
});

const bundleBaseSchema = z.object({
  name: z.string().min(1).max(150),
  nameAr: z.string().max(150).nullish(),
  // Same bilingual-slug shape as category.routes.ts's createCategorySchema.
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9\u0600-\u06FF-]+$/),
  description: z.string().max(2000).nullish(),
  descriptionAr: z.string().max(2000).nullish(),
  image: z.string().url().nullish(),
  pricingType: z.enum(['fixed_price', 'percentage', 'fixed']),
  pricingValue: z.number().int().min(0),
  isActive: z.boolean().optional(),
  startsAt: z.coerce.date().nullish(),
  expiresAt: z.coerce.date().nullish(),
  items: z.array(bundleItemSchema).min(1).max(MAX_BUNDLE_ITEMS),
});

// P2-2 (final review) is enforced in `resolveBundleLines`, and P2-d (scoped
// re-review) moved this pricing-range check the same way, NOT as a schema
// refine: the error handler flattens every ZodError to
// `message: 'Invalid request data'` and buries the real text in `details`,
// which the admin bundle editor does not render — so a refine would reject
// correctly and tell the merchant nothing they can act on (Ruling FW-3's
// exact reasoning, which this pricing-range check had NOT yet applied).
// Doing it as an `AppError` also covers every path into it (create, update,
// and any future caller) from one place.
export const createSchema = bundleBaseSchema;
export const updateSchema = bundleBaseSchema.partial();

/**
 * `pricingValue` for 'percentage' is basis points (`computeBundlePrice`
 * divides by 10000) — reject a value that could never mean a real discount
 * (e.g. 50000 = "500% off") at the edge, before it reaches
 * `computeBundlePrice`'s own clamp-to-[0, componentSum], which would
 * silently floor it to a free bundle instead of telling the merchant they
 * mistyped it.
 *
 * Written as an EXHAUSTIVE switch over `BundlePricingType`, not an early
 * `!== 'percentage'` return: this guard and its sibling
 * `assertPriceWithinComponentSum` below each used to cover exactly ONE
 * member, which left the third ('fixed') unguarded — a bundle could be
 * saved with an amount-off discount larger than its own components and sell
 * for 0. The `never` default makes a fourth member a COMPILE error here
 * rather than another silently unguarded branch.
 */
function assertPricingValueInRange(pricingType: BundlePricingType, pricingValue: number): void {
  switch (pricingType) {
    case 'percentage':
      if (pricingValue <= 10000) return;
      break;
    case 'fixed_price':
    case 'fixed':
      // Both are piastres, and their only ceiling is the component sum — which
      // isn't known until the components resolve, so it is enforced in
      // `assertPriceWithinComponentSum` instead of here.
      return;
    default: {
      const unhandled: never = pricingType;
      throw new Error(`unhandled BundlePricingType: ${String(unhandled)}`);
    }
  }
  throw new AppError(
    422,
    'PRICING_VALUE_OUT_OF_RANGE',
    'percentage pricingValue is basis points and must be between 0 and 10000 (100%)',
    { pricingValue }
  );
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(255).optional(),
});

/**
 * Resolves each component to its CURRENT store-scoped unit price (via the
 * same `retailUnitPrice` fallback the cart/resolveBundle use, so a bundle
 * never charges a different price for a component than buying it standalone
 * would) and builds the `BundleLine[]` + `componentSum` the pricing/
 * allocation functions need.
 *
 * Tenant-safe: the product lookup filters by `storeId`, so a productId that
 * belongs to another store resolves to "not found" here — never leaking
 * that the product exists elsewhere, and never letting a merchant bundle a
 * competitor's catalog.
 */
/**
 * The bundle clients of a store (NEON-ZERO-1 N-3, Ruling NZ-SF-4): a Durable Object store's bundles live in its DO, a Postgres
 * store's are the unchanged `prisma` proxy (so the request transaction and its nested writes are untouched). Typed as `prisma`
 * because the two backends answer the same Prisma shape.
 */
const bundleDb = async (storeId: string) => (await storeDb(storeId)) as unknown as typeof prisma;
const bundleWriter = async (storeId: string) =>
  (await storeWriter(storeId)) as unknown as typeof prisma;
const bundlesOnDo = async (storeId: string) => (await storeRepo(storeId)).backend === 'do';

async function resolveBundleLines(
  storeId: string,
  items: BundleItemInput[]
): Promise<{ lines: BundleLine[]; componentSum: number }> {
  // Fetched BEFORE the duplicate-component check below (P2-e, scoped
  // re-review) so that check can name the product, not just echo its uuid.
  const productIds = [...new Set(items.map(i => i.productId))];
  const products = await (
    await storeDb(storeId)
  ).product.findMany({
    where: { id: { in: productIds }, storeId },
    select: {
      id: true,
      name: true,
      price: true,
      pricingMode: true,
      variants: { select: { id: true, price: true, pricingMode: true } },
    },
  });
  const productsById = new Map(products.map(p => [p.id, p]));

  // Ruling B5-19: a gold-rate product cannot be a bundle component. A bundle price is fixed while its
  // parts drift with the rate, so BUNDLE_PRICE_NOT_ALLOCATABLE would fire daily. Sell the set as one product.
  for (const item of items) {
    const p = productsById.get(item.productId);
    const v = item.variantId ? p?.variants.find(x => x.id === item.variantId) : undefined;
    if (p && (v?.pricingMode ?? p.pricingMode) === 'gold_rate')
      throw new AppError(
        409,
        'GOLD_IN_BUNDLE',
        `"${p.name}" is priced by the gold rate and cannot be part of a bundle. Sell the set as one product.`,
        { messageAr: 'القطعة دي بتتسعّر بسعر الدهب ومينفعش تبقى جوه باقة. بيع الطقم كمنتج واحد.' }
      );
  }

  // Same rule as `noDuplicateComponents` on the schemas, enforced again here
  // so it holds for EVERY path into this resolver — and, unlike a Zod refine,
  // with a message that actually reaches the merchant: the error handler
  // flattens a ZodError to `message: 'Invalid request data'` and buries the
  // real text in `details`, which the admin bundle editor does not render.
  const seenComponents = new Set<string>();
  for (const item of items) {
    const componentKey = `${item.productId}::${item.variantId ?? ''}`;
    if (seenComponents.has(componentKey)) {
      // P2-e: name the product, not its uuid — the merchant sees named
      // rows in the editor and has no way to match a raw id back to one.
      // Falls back to the id only for a productId that doesn't resolve to
      // this store's catalogue at all (a separate defect, INVALID_PRODUCT
      // below, but this duplicate check runs first and must not throw a
      // confusing "Product undefined" for that case).
      const name = productsById.get(item.productId)?.name ?? item.productId;
      throw new AppError(
        400,
        'DUPLICATE_BUNDLE_COMPONENT',
        `"${name}" appears twice in this bundle — use the quantity field instead of a second line`
      );
    }
    seenComponents.add(componentKey);
  }

  // Canonical component order — the SAME order `resolveBundle` uses at
  // checkout (see `compareBundleComponents`). Without it this validated in
  // request order while checkout validated in Postgres row order, and
  // `isAllocatable` is order-sensitive: a bundle the admin screen accepted
  // could 409 `BUNDLE_PRICE_NOT_ALLOCATABLE` at checkout.
  const orderedItems = [...items].sort((a, b) =>
    compareBundleComponents(
      { productId: a.productId, variantId: a.variantId ?? null },
      { productId: b.productId, variantId: b.variantId ?? null }
    )
  );

  const lines: BundleLine[] = orderedItems.map((item, index) => {
    const product = productsById.get(item.productId);
    if (!product) {
      throw new AppError(
        400,
        'INVALID_PRODUCT',
        // Unlike INVALID_VARIANT/VARIANT_REQUIRED (P2-e), there is no name to
        // print here: the lookup is what failed. Say plainly what is wrong and
        // keep the id, which is the only identifying detail that exists.
        `A selected product is not in this store's catalogue (${item.productId}) — remove it from the bundle`
      );
    }
    let variant: { id: string; price: number | null } | undefined;
    if (item.variantId) {
      variant = product.variants.find(v => v.id === item.variantId);
      if (!variant) {
        throw new AppError(
          400,
          'INVALID_VARIANT',
          // Same class as P2-e: `product` is resolved here, so name it. The
          // variant id stays in the message because there is no variant to
          // read a title from — it is the thing that could not be found.
          `"${product.name}" has no variant ${item.variantId} — pick one of its current variants`
        );
      }
    } else if (product.variants.length > 0) {
      // P1-3 (final review): a component on a VARIANT product must pin a
      // variant. `products.inventory` is unused (and stays 0) once a product
      // has variants — the real stock lives on the variant rows — so a line
      // with a null variantId reads availability from the variant SUM
      // (`effectiveInventory`) and then decrements the parent column at
      // checkout. The variant stock never moves, the variants stay "in
      // stock", and the merchant oversells them. The admin picker already
      // forces a variant choice (BundleItemPicker); nothing on the server
      // did, so a direct API POST — or a product that GAINS variants after
      // being bundled — walked straight into it. Reject the shape here; the
      // rows already written before this check fail closed at read time via
      // `isPurchasable` (see bundle.service.ts).
      throw new AppError(
        400,
        'VARIANT_REQUIRED',
        // P2-e: name the product, not its uuid — `product` is already
        // resolved here, so this costs nothing extra.
        `"${product.name}" has variants — pick which variant this bundle includes`
      );
    }
    return {
      key: `${index}`,
      unitPrice: retailUnitPrice({ variant, product }),
      quantity: item.quantity,
    };
  });

  const componentSum = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  return { lines, componentSum };
}

/**
 * P2-5 (final review): `computeBundlePrice` clamps a `fixed_price` to
 * `Math.min(price, componentSum)`. A merchant who typed 15.000 for a kit
 * whose components sum to 14.500 therefore got a bundle that quietly sells
 * at 14.500 — the number they typed was rejected and nothing told them. The
 * admin preview uses the same function so the figure shown is at least
 * honest, but the merchant never learns their price was overridden.
 * `assertPricingValueInRange` already guards the percentage case at the edge
 * this way; `fixed_price` needs `componentSum`, which is only known once the
 * components resolve, so the check lives here rather than there.
 *
 * A price EQUAL to componentSum is fine (a bundle at no discount is a
 * legitimate, if pointless, configuration) — only ABOVE it is unrepresentable.
 *
 * P1 (this task) extended the same guard to 'fixed' (piastres OFF the component
 * sum), which was the one member of `BundlePricingType` no save-time guard
 * covered. `computeBundlePrice` clamps `componentSum - pricingValue` with
 * `Math.max(0, …)`, so a 20.000 discount on a 14.500 kit was accepted and
 * quietly sold the box for 0 — the same mistake the semantically identical
 * `fixed_price: 15000` was already rejected for. The threshold differs by
 * one piastre on purpose: for 'fixed_price' the VALUE IS the price, so
 * `value === componentSum` is a real (zero-discount) price; for 'fixed' the
 * value is subtracted, so `value === componentSum` leaves 0 — a 100%-off
 * amount-off discount, which is never a legitimate configuration. A
 * merchant who genuinely wants to give the kit away prices it directly
 * (`fixed_price: 0`) over components that are themselves free — see
 * `isPurchasable`'s zero-price clause in bundle.service.ts.
 */
function assertPriceWithinComponentSum(
  pricingType: BundlePricingType,
  pricingValue: number,
  componentSum: number
): void {
  switch (pricingType) {
    case 'fixed_price':
      if (pricingValue <= componentSum) return;
      throw new AppError(
        422,
        'PRICE_ABOVE_COMPONENT_SUM',
        "A bundle can't cost more than its components — lower the price or add components.",
        { componentSum }
      );
    case 'fixed':
      if (pricingValue < componentSum) return;
      throw new AppError(
        422,
        'PRICE_ABOVE_COMPONENT_SUM',
        "A discount can't be worth as much as the components — lower the discount or add components.",
        { componentSum }
      );
    case 'percentage':
      // Bounded by `assertPricingValueInRange`'s 0–10000 basis points, which
      // runs before the components are even fetched.
      return;
    default: {
      const unhandled: never = pricingType;
      throw new Error(`unhandled BundlePricingType: ${String(unhandled)}`);
    }
  }
}

/**
 * `resolveBundle`, but returns `null` instead of throwing on a 404. A list
 * endpoint queries candidate ids and then resolves each one separately —
 * without this, a bundle deleted between those two steps would 404 (or
 * 500) the WHOLE list response instead of just being absent from it.
 */
async function tryResolveBundle(storeId: string, id: string): Promise<ResolvedBundle | null> {
  try {
    return await resolveBundle(await bundleDb(storeId), storeId, id);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return null;
    throw err;
  }
}

// GET /:storeId/bundles - list (admin)
router.get(
  '/:storeId/bundles',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, search } = listQuerySchema.parse(req.query);
      // Manual tri-state parse (not z.coerce.boolean(), which coerces the
      // STRING "false" to `true`) — same style as PromotionService.list's
      // caller in promotion.routes.ts.
      const isActive =
        req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined;
      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = { storeId };
      if (isActive !== undefined) where.isActive = isActive;
      if (search) {
        // Arabic-normalised name + nameAr word-AND (product-search.service searchNameIds).
        if (await bundlesOnDo(storeId)) {
          // The Postgres search is a raw SQL fold over `bundles`; a DO store filters its own rows by every word in the name
          // or the Arabic name (no Arabic digit / hamza folding there), never by ids from a table it does not have.
          const words = search.trim().split(/\s+/).filter(Boolean).slice(0, 8);
          where.AND = words.map(w => ({
            OR: [{ name: { contains: w } }, { nameAr: { contains: w } }],
          }));
        } else {
          where.id = { in: await searchNameIds('bundles', storeId, search) };
        }
      }

      const [rows, total] = await Promise.all([
        (await bundleWriter(storeId)).bundle.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        }),
        (await bundleWriter(storeId)).bundle.count({ where }),
      ]);

      // Small per-store admin list (bounded by `limit`, max 100) — resolving
      // each row through the same `resolveBundle` the detail/public routes
      // use keeps pricing/availability computation in ONE place rather than
      // duplicating its math here for a bulk query.
      const bundles = (await Promise.all(rows.map(r => tryResolveBundle(storeId, r.id)))).filter(
        (b): b is ResolvedBundle => b !== null
      );

      res.json({
        success: true,
        data: { bundles, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /:storeId/bundles/:id - get one (admin)
router.get(
  '/:storeId/bundles/:id',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const resolved = await resolveBundle(await bundleDb(storeId), storeId, id);

      // The admin editor needs to know WHICH products/variants make up the
      // bundle to prefill the form — `resolveBundle`'s `lines` are keyed by
      // BundleItem id for pricing/allocation, not by productId, so fetch the
      // raw component rows alongside it.
      const items = await (
        await bundleWriter(storeId)
      ).bundleItem.findMany({
        where: { bundleId: id },
        select: {
          id: true,
          productId: true,
          variantId: true,
          quantity: true,
          product: {
            select: {
              name: true,
              nameAr: true,
              images: { take: 1, orderBy: { position: 'asc' }, select: { url: true } },
            },
          },
          // `titleAr` added in fix round 1 (RULING T9-b): the admin editor
          // is bilingual and picks by locale the same way it does for
          // `product.name`/`nameAr` two lines up — a variant-pinned line
          // was previously stuck showing the English title even in the
          // Arabic admin because this select never asked for its Arabic
          // twin.
          variant: { select: { title: true, titleAr: true } },
        },
      });

      res.json({ success: true, data: { bundle: { ...resolved, items } } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Creates a bundle: the one write path of POST /:storeId/bundles, also called by the Ebda Store assistant (`bundle_create`).
 * Validates the price against the component sum, writes the bundle and its components atomically, then busts the product caches.
 */
export async function createBundle(storeId: string, data: z.infer<typeof createSchema>) {
  assertPricingValueInRange(data.pricingType, data.pricingValue);

  const { lines, componentSum } = await resolveBundleLines(storeId, data.items);
  assertPriceWithinComponentSum(data.pricingType, data.pricingValue, componentSum);
  const price = computeBundlePrice(componentSum, data.pricingType, data.pricingValue);

  // The point of this task: an unrepresentable price is rejected at SAVE
  // time with a suggested nearest value, so the edge case reaches the
  // merchant while configuring rather than a customer at checkout.
  //
  // RULING T9-a: this used to be a bespoke `res.status(422).json({
  // error: 'price_not_allocatable', suggested })` body — the ONE route
  // in this app that didn't use the standard `{ success, error: {
  // code, message, details } }` envelope. That forced its one admin
  // consumer (apps/admin's bundle editor) to bypass `apiPost`/`apiPut`
  // with a raw `apiFetch` + a hand-rolled parser just to read
  // `suggested` back out. Routing it through `AppError` instead keeps
  // every error response in this app on one shape; `suggested` now
  // travels in `details`, the same field Zod validation errors use for
  // structured extra data.
  if (!isAllocatable(lines, price)) {
    throw new AppError(
      422,
      'PRICE_NOT_ALLOCATABLE',
      "This price can't be split exactly across the bundle's components.",
      { suggested: nearestAllocatablePrice(lines, price, componentSum) }
    );
  }

  const bundleData = {
    storeId,
    name: data.name,
    nameAr: data.nameAr ?? null,
    slug: data.slug,
    description: data.description ?? null,
    descriptionAr: data.descriptionAr ?? null,
    image: data.image ?? null,
    pricingType: data.pricingType,
    pricingValue: data.pricingValue,
    isActive: data.isActive ?? true,
    startsAt: data.startsAt ?? null,
    expiresAt: data.expiresAt ?? null,
  };
  const componentRows = data.items.map(item => ({
    productId: item.productId,
    variantId: item.variantId ?? null,
    quantity: item.quantity,
  }));
  let created: { id: string };
  if (await bundlesOnDo(storeId)) {
    // The Durable Object takes the bundle and its components as ONE atomic batch (no nested relation writes there).
    const dw = await storeWriter(storeId);
    const id = randomUUID();
    await dw.$transaction([
      dw.bundle.create({ data: { id, ...bundleData } as never }),
      dw.bundleItem.createMany({
        data: componentRows.map(r => ({ bundleId: id, ...r })) as never,
      }),
    ]);
    created = { id };
  } else {
    created = await prisma.bundle.create({
      data: { ...bundleData, items: { create: componentRows } },
      select: { id: true },
    });
  }

  const bundle = await resolveBundle(await bundleDb(storeId), storeId, created.id);
  // Task 10: the AI product feed caches bundle data (getCached, under
  // the same `public:products:${storeId}:` prefix product writes bust)
  // — a new bundle must invalidate it the same way a new product does,
  // or it silently won't appear in the feed for up to the cache TTL.
  // Also clears the bundle-list Redis key and purges `bundles:<storeId>`
  // in the SAME outbound request — a separate bundles-only purge
  // here was a second purge POST per write (issue 2202).
  await invalidateStoreProductCaches(storeId);
  return bundle;
}

// POST /:storeId/bundles - create (admin)
router.post(
  '/:storeId/bundles',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createSchema.parse(req.body);
      const bundle = await createBundle(storeId, data);
      await scheduleBundleBoundary(storeId);
      res.status(201).json({ success: true, data: { bundle } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Updates a bundle: the one write path of PUT /:storeId/bundles/:id, also called by the Ebda Store assistant (`bundle_set_active`).
 * Re-validates the price against the CURRENT component prices, writes the patch, then busts the product caches.
 */
export async function updateBundle(
  storeId: string,
  id: string,
  data: z.infer<typeof updateSchema>
) {
  const existing = await (
    await bundleWriter(storeId)
  ).bundle.findFirst({
    where: { id, storeId },
    include: { items: true },
  });
  if (!existing) {
    throw new AppError(404, 'NOT_FOUND', 'Bundle not found for this store');
  }

  // Revalidate against the CURRENT pricingType/pricingValue (merged with
  // whatever the request changed) and the CURRENT component prices —
  // even an update that only touches `name` re-checks allocatability,
  // because a component's price can drift after creation (same live
  // pricing `resolveBundle` reads at every request) and silently make a
  // previously-valid bundle price un-allocatable.
  const pricingType = (data.pricingType ?? existing.pricingType) as BundlePricingType;
  const pricingValue = data.pricingValue ?? existing.pricingValue;
  assertPricingValueInRange(pricingType, pricingValue);
  const itemInputs: BundleItemInput[] =
    data.items ??
    existing.items.map(i => ({
      productId: i.productId,
      variantId: i.variantId,
      quantity: i.quantity,
    }));

  const { lines, componentSum } = await resolveBundleLines(storeId, itemInputs);
  assertPriceWithinComponentSum(pricingType, pricingValue, componentSum);
  const price = computeBundlePrice(componentSum, pricingType, pricingValue);

  // See RULING T9-a in the POST handler above — same standard-envelope
  // AppError, same `details.suggested` shape.
  if (!isAllocatable(lines, price)) {
    throw new AppError(
      422,
      'PRICE_NOT_ALLOCATABLE',
      "This price can't be split exactly across the bundle's components.",
      { suggested: nearestAllocatablePrice(lines, price, componentSum) }
    );
  }

  const scalarPatch = {
    ...(data.name !== undefined && { name: data.name }),
    ...(data.nameAr !== undefined && { nameAr: data.nameAr }),
    ...(data.slug !== undefined && { slug: data.slug }),
    ...(data.description !== undefined && { description: data.description }),
    ...(data.descriptionAr !== undefined && { descriptionAr: data.descriptionAr }),
    ...(data.image !== undefined && { image: data.image }),
    ...(data.pricingType !== undefined && { pricingType: data.pricingType }),
    ...(data.pricingValue !== undefined && { pricingValue: data.pricingValue }),
    ...(data.isActive !== undefined && { isActive: data.isActive }),
    ...(data.startsAt !== undefined && { startsAt: data.startsAt }),
    ...(data.expiresAt !== undefined && { expiresAt: data.expiresAt }),
  };
  if (await bundlesOnDo(storeId)) {
    // Durable Object: no nested relation writes, so the component wipe + rewrite and the update are ONE atomic batch.
    const dw = await storeWriter(storeId);
    await dw.$transaction([
      ...(data.items ? [dw.bundleItem.deleteMany({ where: { bundleId: id } })] : []),
      dw.bundle.update({ where: { id, storeId }, data: scalarPatch as never }),
      ...(data.items
        ? [
            dw.bundleItem.createMany({
              data: data.items.map(item => ({
                bundleId: id,
                productId: item.productId,
                variantId: item.variantId ?? null,
                quantity: item.quantity,
              })) as never,
            }),
          ]
        : []),
    ]);
  } else
    await (
      await bundleWriter(storeId)
    ).bundle.update({
      where: { id, storeId },
      data: {
        ...scalarPatch,
        // Full replace — simplest correct semantics for a small,
        // merchant-edited component list (avoids reconciling adds/removes/
        // quantity-changes against existing BundleItem rows).
        //
        // The wipe is NESTED in this update, never a standalone
        // `prisma.bundleItem.deleteMany` run ahead of it, so the wipe and the
        // rewrite fail together by construction.
        //
        // Accuracy note, because the original justification for this shape was
        // wrong and is worth not re-deriving: the ambient tenant transaction
        // (`middleware/tenant-context.ts:75`) does commit on every status <500
        // and roll back only on 5xx — but on THIS route no 4xx is reachable
        // between the wipe and the update. Every 4xx-throwing check
        // (`resolveBundleLines`, `assertPriceWithinComponentSum`, the
        // allocatable guard) runs earlier, and a raw Prisma error here is not
        // mapped (`throwIfBundleFkViolation` is never called in this file), so
        // P2002/P2003 reach `next(error)` as a 500 and DO roll back. The
        // standalone form was therefore correct — but correct only by
        // statement ordering. This nested form is correct structurally, so
        // adding a 4xx mapping to this route later cannot silently open a
        // data-loss window. Do NOT split them back out, and do NOT wrap this
        // in `prisma.$transaction` — see the file header.
        //
        // Prisma runs the nested deleteMany before the nested create, which
        // matters here: BundleItem is @@unique([bundleId, productId,
        // variantId]), so re-sending an unchanged component would otherwise
        // collide with its own surviving row.
        ...(data.items && {
          items: {
            deleteMany: {},
            create: data.items.map(item => ({
              productId: item.productId,
              variantId: item.variantId ?? null,
              quantity: item.quantity,
            })),
          },
        }),
      },
    });

  const bundle = await resolveBundle(await bundleDb(storeId), storeId, id);
  // See the POST handler above — the same feed-cache invalidation gap.
  // Also clears the bundle-list Redis key and purges `bundles:<storeId>`
  // in the SAME outbound request — a separate bundles-only purge
  // here was a second purge POST per write (issue 2202).
  await invalidateStoreProductCaches(storeId);
  return bundle;
}

// PUT /:storeId/bundles/:id - update (admin)
router.put(
  '/:storeId/bundles/:id',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateSchema.parse(req.body);

      const bundle = await updateBundle(storeId, id, data);
      await scheduleBundleBoundary(storeId);
      res.json({ success: true, data: { bundle } });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /:storeId/bundles/:id - deactivate (admin)
//
// DECISION: this never hard-deletes the row. `cart_bundles.bundle_id` is
// ON DELETE CASCADE from `bundles` — a hard delete would silently vanish
// the bundle line from every live customer cart with no error surfaced to
// that shopper (they'd just find it gone next time they open the cart).
// `Bundle.isActive` already exists as the exact lifecycle switch
// `isPurchasable` (resolveBundle) checks — reusing it costs nothing and
// removes the cascade risk entirely: a cart/order that already reference
// the bundle keep referencing a real (but unpurchasable-going-forward) row,
// and `resolveBundle` still resolves it for admin to review or reactivate.
// There is deliberately no hard-delete endpoint in this task.
router.delete(
  '/:storeId/bundles/:id',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const existing = await (
        await bundleWriter(storeId)
      ).bundle.findFirst({
        where: { id, storeId },
        select: { id: true },
      });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'Bundle not found for this store');
      }

      await (
        await bundleWriter(storeId)
      ).bundle.update({ where: { id, storeId }, data: { isActive: false } });
      // See the POST handler above — the same feed-cache invalidation gap;
      // a deactivated bundle must stop being purchasable there too, not just
      // in `resolveBundle`'s live-read callers.
      // Also clears the bundle-list Redis key and purges `bundles:<storeId>`
      // in the SAME outbound request — a separate bundles-only purge
      // here was a second purge POST per write (issue 2202).
      await invalidateStoreProductCaches(storeId);
      await scheduleBundleBoundary(storeId);

      res.json({
        success: true,
        data: {
          message:
            'Bundle deactivated. It no longer sells, but existing cart/order references are preserved.',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: list purchasable bundles for a store's storefront.
// GET /public/:storeId/bundles
//
// Unauthenticated (storefront shoppers, including guests) — same posture as
// promotion.routes.ts's preview endpoint: rate-limited instead of
// authenticate/authorize, and still feature-gated (`requireFeature`
// resolves storeId from this route's own `:storeId` param). `router.param`
// above still wraps this route since it declares its own ':storeId'.
router.get(
  '/public/:storeId/bundles',
  publicLimiter,
  publicTenantLimiter,
  requireFeature('bundles'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      // #1565: was an uncached N+1 on a hot storefront path — one
      // `findMany` for candidate ids, then one `tryResolveBundle` PER
      // candidate, on every request. Cached under its own
      // `bundlesCacheKey`, which `invalidateStoreProductCaches` also clears
      // (so every product/stock write busts it — a bundle's price and
      // availability derive from its components) — including every bundle
      // write, which calls it too (issue 2202). Same 120s TTL and
      // staleness class as the public product list this mirrors.
      const bundles = await getCached(bundlesCacheKey(storeId), 120, async () => {
        const candidates = await (
          await bundleWriter(storeId)
        ).bundle.findMany({
          where: { storeId, isActive: true },
          orderBy: { createdAt: 'desc' },
          // Store-scale bundle counts are small (a merchant hand-curates
          // these kits) — this caps the pathological case (a bulk-import
          // bug, or a store scripted well past "hand-curated") from turning
          // one storefront request into an unbounded fan-out of
          // `tryResolveBundle` calls below. One row past the cap is fetched
          // so a store that hits it is LOGGED rather than silently truncated.
          take: PUBLIC_BUNDLE_LIST_CAP + 1,
          select: { id: true },
        });
        if (candidates.length > PUBLIC_BUNDLE_LIST_CAP) {
          logger.warn(
            { storeId, cap: PUBLIC_BUNDLE_LIST_CAP },
            'public bundle list truncated: store has more active bundles than the cap'
          );
        }
        const rows = candidates.slice(0, PUBLIC_BUNDLE_LIST_CAP);

        // Resolving each candidate through `resolveBundle` — the one place
        // componentSum/price/available/isPurchasable are computed — is
        // preferable to duplicating that math in a bulk query here.
        const resolved = (await Promise.all(rows.map(r => tryResolveBundle(storeId, r.id)))).filter(
          (b): b is ResolvedBundle => b !== null
        );

        // Every bundle sellable on everything BUT the clock, with its window —
        // never `pricingType`/`pricingValue` (see the doc comment on
        // `ResolvedBundle` in bundle.service.ts). The window itself is applied
        // below, per request: crossing `startsAt`/`expiresAt` is not a write,
        // so a cached `isPurchasable` would advertise an expired bundle (or
        // hide a just-started one) for up to the TTL (issue 2111).
        return resolved
          .filter(b => b.sellableIgnoringWindow)
          .map(b => ({
            id: b.id,
            name: b.name,
            nameAr: b.nameAr,
            slug: b.slug,
            image: b.image,
            price: b.price,
            componentSum: b.componentSum,
            available: b.available,
            startsAt: b.startsAt,
            expiresAt: b.expiresAt,
          }));
      });

      const now = new Date();
      res.json({
        success: true,
        data: {
          bundles: bundles
            .filter(b => withinSaleWindow(b, now))
            .map(({ startsAt: _s, expiresAt: _e, ...publicFields }) => publicFields),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: the bundles that give a saving on a product (PDP line) or on a set of products
// (the routine "add all"), Phase B3.
// GET /public/:storeId/bundle-savings?productIds=<uuid>[,<uuid>...]   (1..5 ids)
//
// CACHE CLASS: NEVER-stale for price. A saving is money, so it is computed from `resolveBundle`
// (the cart's own bundle price) on every request and answered `no-store`; there is no Redis layer,
// no edge copy and no invalidation to forget. Same posture/gating as the list route below.
const bundleSavingsQuerySchema = z.object({
  productIds: z
    .string()
    .max(400)
    .transform(v =>
      v
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().uuid()).min(1).max(5)),
});
router.get(
  '/public/:storeId/bundle-savings',
  publicLimiter,
  publicTenantLimiter,
  requireFeature('bundles'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productIds } = bundleSavingsQuerySchema.parse({ productIds: req.query.productIds });
      const savings = await listBundleSavingsForProducts(
        await bundleDb(storeId),
        storeId,
        productIds
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data: { savings } });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: single bundle detail, by slug, for the storefront
// /bundles/<slug> page.
// GET /public/:storeId/bundles/:slug
//
// Same gating/posture as the list route directly above (unauthenticated,
// rate-limited, feature-gated). Unlike the list route this does NOT filter
// on `isPurchasable` — a bundle the merchant deliberately turned OFF
// (`isActive: false`) 404s here exactly like an unpublished
// (draft/archived) product does at `ProductService.getPublicBySlug`, but a
// bundle that's merely expired / not-yet-started / out of stock / missing a
// live component still resolves so the storefront page can render it in an
// "unavailable" state — mirroring how an out-of-stock but published PRODUCT
// still 200s from `GET /public/products/:slugOrId` and renders with an OOS
// label instead of 404ing. Selling surfaces (the add-to-cart action) still
// gate on `isPurchasable`, same as everywhere else `resolveBundle` is used.
router.get(
  '/public/:storeId/bundles/:slug',
  publicLimiter,
  publicTenantLimiter,
  requireFeature('bundles'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, slug } = req.params;

      // #1565 — same fix as the list route above: cached under the same
      // `public:products:${storeId}:` prefix every bundle write already busts.
      const bundle = await getCached(
        // v2: the value holds `sellableIgnoringWindow` + the window, not a
        // pre-applied `isPurchasable` (issue 2111) — a v1 entry must be a miss.
        `public:products:${storeId}:bundles:v2:${slug}`,
        120,
        async () => {
          const row = await (
            await bundleWriter(storeId)
          ).bundle.findFirst({
            where: { storeId, slug },
            select: { id: true, isActive: true, description: true, descriptionAr: true },
          });

          if (!row || !row.isActive) {
            throw new AppError(404, 'NOT_FOUND', 'Bundle not found for this store');
          }

          const resolved = await resolveBundle(await bundleDb(storeId), storeId, row.id);

          // "What's inside" by component NAME only — never per-component
          // allocated prices (see `ResolvedBundle`'s doc comment on
          // `pricingType`/`pricingValue`, which this response also omits).
          const items = await (
            await bundleWriter(storeId)
          ).bundleItem.findMany({
            where: { bundleId: row.id },
            select: { product: { select: { name: true, nameAr: true, audience: true } } },
          });
          // B2B I1: a bundle holding a wholesale-only product does not exist for the anonymous storefront (no names leak).
          if (items.some(i => i.product.audience === 'wholesale_only')) {
            throw new AppError(404, 'NOT_FOUND', 'Bundle not found for this store');
          }

          return {
            id: resolved.id,
            name: resolved.name,
            nameAr: resolved.nameAr,
            slug: resolved.slug,
            image: resolved.image,
            description: row.description,
            descriptionAr: row.descriptionAr,
            price: resolved.price,
            componentSum: resolved.componentSum,
            available: resolved.available,
            // Window applied per request below (issue 2111).
            sellableIgnoringWindow: resolved.sellableIgnoringWindow,
            startsAt: resolved.startsAt,
            expiresAt: resolved.expiresAt,
            componentNames: items.map(i => ({ name: i.product.name, nameAr: i.product.nameAr })),
          };
        }
      );

      const { sellableIgnoringWindow, startsAt, expiresAt, ...publicFields } = bundle;
      res.json({
        success: true,
        data: {
          bundle: {
            ...publicFields,
            isPurchasable: sellableIgnoringWindow && withinSaleWindow({ startsAt, expiresAt }),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
