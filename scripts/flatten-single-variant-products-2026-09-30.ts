/**
 * ONE-OFF, NOT YET APPLIED — Ahmad reviews the dry run and applies it.
 *
 * Turns every product that has exactly ONE variant into a plain (simple)
 * product. Owner report 2026-09-30 (pecannbee): a product whose only variant
 * is "Size: 380 Gram" shows a one-option picker and a disabled
 * "اختر الخيارات" button until the shopper taps the only option.
 *
 * WHAT "FLATTEN" DOES, per product, in ONE transaction:
 *   1. copies the variant's price, compareAtPrice, cost, stock, SKU, barcode,
 *      weight and backorder flag onto the product (image too, when the
 *      product has none) and sets products.has_variants = false;
 *   2. appends the option ("Size: 380 Gram" / "الحجم: 380 جرام") to the EN and
 *      AR descriptions unless that text is already there, so the size is not
 *      lost;
 *   3. moves every row that points at the variant (see REFERENCES below),
 *      then DELETES the variant row and the product's option axis;
 *   4. writes a zero-quantity `adjustment` InventoryHistory row
 *      (reference `flatten-variant:<variantId>`) — the units move from the
 *      variant row to the product row, the stock itself does not change.
 * Product caches are busted after commit (see CACHES).
 *
 * Ruling SVF-1 — the variant row is DELETED, not disabled. The inventory model
 * (docs/architecture/inventory-model.md, #2147) treats a product with ANY
 * variant row, disabled ones included, as a variant product: its stock is the
 * sum of its ACTIVE variants, so a product whose only variant is disabled has
 * stock 0 and is unorderable (effectiveInventory / ON_HAND_SQL /
 * STOCK_VALUE_SQL all key on "a variant row exists"). Soft-disabling would
 * therefore make these products worse, not simpler. Deleting is also exactly
 * what the platform's own "delete option" action does (VariantService.
 * deleteOption: deleteMany variants, delete option, hasVariants=false).
 * Cost if wrong: order lines lose the FK link to a variant row that no longer
 * exists; their snapshot (variant_name, sku, price, cost_price) is untouched.
 *
 * Ruling SVF-2 — order lines are only unlinked with --unlink-order-lines.
 * The brief said "do NOT hard-delete a variant that any order references".
 * Under SVF-1 that cannot be honoured and still flatten the product, so by
 * default such a product is BLOCKED and listed. With --unlink-order-lines,
 * order_items.variant_id is set to NULL (what the FK's ON DELETE SET NULL
 * would do anyway) and every unlinked id is saved in the backup so --restore
 * re-links it. A NULL variantId is also what the stock writers need after
 * flattening: a later cancel/return of that order restores units onto
 * products.inventory — the row that now holds the stock — instead of into a
 * variant row that no longer counts. Cost if wrong: a report that joins
 * order_items to product_variants shows those historical lines without a
 * variant; the line's own variant_name still names it.
 *
 * WHICH PRODUCTS: active (status='active'), not soft-deleted, exactly ONE
 * product_variants row counting disabled rows, and that row is ACTIVE.
 *   - more than one variant row (active or not) → skipped and listed;
 *   - one row that is DISABLED → skipped and listed: the merchant switched it
 *     off, so the product sells nothing today; flattening would put its units
 *     on sale, which is a merchant decision, not a data fix.
 *
 * REFERENCES (every FK to product_variants, from information_schema on prod
 * 2026-09-30 — 12 tables):
 *   order_items          SET NULL  → blocker, or unlinked with --unlink-order-lines
 *   cart_items           SET NULL  → re-pointed to the product line (variant_id NULL);
 *                                    merged into an existing product line if the cart
 *                                    already has one (the partial unique index allows
 *                                    only one NULL-variant line per cart+product)
 *   warehouse_stock      CASCADE   → the product-level shadow row per warehouse takes
 *                                    the variant row's quantity (the old product-level
 *                                    row shadowed products.inventory, which was not
 *                                    stock); the variant row is removed
 *   reorder_rules        CASCADE   → re-pointed to the product (variant_id NULL), or
 *                                    dropped if the product already has its own rule
 *   reorder_suggestions  CASCADE   → derived scan rows; backed up, removed with the variant
 *   deadstock_flags      CASCADE   → derived scan rows; backed up, removed with the variant
 *   product_variant_options CASCADE → removed with the variant (backed up)
 *   purchase_order_items RESTRICT  → blocker
 *   stock_adjustment_items RESTRICT → blocker
 *   backorder_lines      RESTRICT  → blocker
 *   bundle_items         RESTRICT  → blocker
 *   count_lines          NO ACTION → blocker
 * Wishlists and reviews reference the PRODUCT only; InventoryHistory has no
 * variant column. Nothing else stores a variant id relationally.
 *
 * CACHES (issue 2351): after a run that changed anything the script purges both
 * layers by default (`--no-bust-caches` opts out). The storefront TAG purge is an
 * outbound HTTPS call that needs no Redis (STOREFRONT_REVALIDATE_URL +
 * REVALIDATE_SECRET) — it is always attempted and awaited, because tagged
 * storefront fetches do not expire on their own. The Redis layer is cleared only
 * with a REDIS_URL; production Redis is private-network only, so from a laptop
 * those keys (120s TTL, feed 600s) are printed instead. Saving any product in the
 * admin runs the same invalidation for the whole store.
 *
 * BACKUP / RESTORE: every row a product's apply will touch is snapshotted inside
 * that product's own write transaction, under its row locks (issue 2350), and
 * written to scripts/backups/flatten-single-variant-<store>-<stamp>.json
 * (gitignored, mode 0600). `--restore <file>` rebuilds each product's option
 * axis and variant with their ORIGINAL ids, moves the product's CURRENT stock
 * back onto the variant (units sold since the flatten stay sold), restores
 * price/SKU/barcode/weight/description fields that still hold what the flatten
 * wrote, re-links the unlinked order lines and the reorder rules, and deletes
 * the image row the flatten created. Merged cart lines are not split back.
 *
 * Idempotent: a flattened product has no variant row, so it is no longer a
 * candidate; the apply re-plans each product under row locks inside its own
 * transaction. A restore skips a product that already has a variant again.
 *
 * Usage (repo root; DATABASE_URL = the target DB, owner role):
 *   npx tsx scripts/flatten-single-variant-products-2026-09-30.ts --store pecannbee
 *   npx tsx scripts/flatten-single-variant-products-2026-09-30.ts --all-stores
 *   npx tsx scripts/flatten-single-variant-products-2026-09-30.ts --store pecannbee --apply [--unlink-order-lines] [--keep-product-codes] [--only <productId,...>] [--no-bust-caches]
 *   npx tsx scripts/flatten-single-variant-products-2026-09-30.ts --restore <backup.json> [--apply] [--no-bust-caches]
 * Dry runs (the default, and --restore without --apply) run every read inside
 * a READ ONLY transaction, so they cannot write.
 */
import fs from 'fs';
import path from 'path';
import { prisma, withMoneyTx, type Prisma } from '@force/database';
import { localizeOptionName, localizeOptionValue } from '../apps/web/src/lib/option-localization';

type Tx = Prisma.TransactionClient;

// ─── transaction helper ──────────────────────────────────────────────────────

/**
 * One interactive transaction with the RLS bypass GUCs (same two settings as
 * `withRlsBypass`). `readOnly` makes it a READ ONLY transaction FIRST, so a
 * dry run is enforced by Postgres, not by the script's own care.
 */
export async function inTx<T>(readOnly: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withMoneyTx(
    prisma,
    async tx => {
      if (readOnly) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRaw`SET LOCAL app.bypass_rls = 'true'`;
      await tx.$executeRaw`SET LOCAL app.current_store_id = ''`;
      return fn(tx);
    },
    { timeout: 300_000, maxWait: 20_000 }
  );
}

// ─── description text ────────────────────────────────────────────────────────

export interface OptionPair {
  name: string;
  nameAr: string | null;
  value: string;
  valueAr: string | null;
}

const WEIGHT_UNITS = [
  'kilograms?',
  'kilos?',
  'kgs?',
  'milligrams?',
  'mg',
  'grams?',
  'grm?s?',
  'gms?',
  'g',
  'كيلوجرام',
  'كيلوغرام',
  'كيلو',
  'كجم',
  'كغ',
  'جرامات',
  'جرام',
  'غرام',
  'جم',
  'غ',
  'مجم',
];
const VOLUME_UNITS = [
  'milliliters?',
  'millilitres?',
  'mls?',
  'liters?',
  'litres?',
  'l',
  'مليلتر',
  'لتر',
  'مل',
];

function normaliseDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Does `text` already state this option value? True when it contains the
 * value verbatim (case/space-insensitive), OR the value's number followed by
 * any unit of the same kind — "80g" is already said by "Weight 80 G",
 * "80 Gram", "الوزن 80 غ" or "٨٠ جرام". A value with no number and no
 * verbatim match is not considered present.
 */
export function mentionsOptionValue(text: string | null | undefined, values: string[]): boolean {
  if (!text) return false;
  const hay = normaliseDigits(text).toLowerCase();
  const squash = (s: string) => s.replace(/\s+/g, '');
  for (const raw of values) {
    const v = normaliseDigits(raw).toLowerCase().trim();
    if (!v) continue;
    if (squash(hay).includes(squash(v))) return true;
    const m = v.match(/(\d+(?:[.,٫]\d+)?)/);
    if (!m) continue;
    const num = m[1].replace(/[.,٫]/g, '[.,٫]');
    const units = new RegExp(`(?:${WEIGHT_UNITS.join('|')})`, 'i').test(v)
      ? WEIGHT_UNITS
      : new RegExp(`\\d\\s*(?:${VOLUME_UNITS.join('|')})(?![a-z])`, 'i').test(v)
        ? VOLUME_UNITS
        : null;
    if (!units) continue;
    // Number not glued to a preceding digit/decimal (1 ≠ 11, 1 ≠ 2.1), then an
    // optional space, then a unit of the same kind not followed by a Latin letter.
    const re = new RegExp(`(?<![0-9.,٫])${num}\\s*(?:${units.join('|')})(?![a-z])`, 'i');
    if (re.test(hay)) return true;
  }
  return false;
}

/**
 * The line(s) to append to each description. Labels and values come from the
 * storefront's own option localisation (`apps/web/src/lib/option-localization`),
 * so the Arabic text reads exactly what the Arabic picker showed the shopper
 * ("Size" → "الحجم", "380 Gram" → "380 جرام"; a generic "Variant" axis is named
 * from its values, e.g. "Weight"/"الوزن").
 */
export function descriptionAdditions(
  options: OptionPair[],
  description: string | null,
  descriptionAr: string | null
): { en: string | null; ar: string | null } {
  const enLines: string[] = [];
  const arLines: string[] = [];
  for (const o of options) {
    const vals = [o.value];
    const enLabel = localizeOptionName(o.name, o.nameAr, false, vals);
    const arLabel = localizeOptionName(o.name, o.nameAr, true, vals);
    const enValue = localizeOptionValue(o.value, o.valueAr, false);
    const arValue = localizeOptionValue(o.value, o.valueAr, true);
    const known = [o.value, o.valueAr ?? '', arValue].filter(Boolean);
    if (!mentionsOptionValue(description, known)) enLines.push(`${enLabel}: ${enValue}`);
    if (!mentionsOptionValue(descriptionAr, known)) arLines.push(`${arLabel}: ${arValue}`);
  }
  return {
    en: enLines.length ? enLines.join('\n') : null,
    ar: arLines.length ? arLines.join('\n') : null,
  };
}

/** Append on its own paragraph (the PDP renders descriptions whitespace-pre-line). */
export function appendLine(existing: string | null, line: string | null): string | null {
  if (!line) return existing;
  const base = (existing ?? '').trimEnd();
  return base ? `${base}\n\n${line}` : line;
}

// ─── planning ────────────────────────────────────────────────────────────────

const PRODUCT_FIELDS = {
  id: true,
  storeId: true,
  name: true,
  nameAr: true,
  slug: true,
  status: true,
  deletedAt: true,
  price: true,
  compareAtPrice: true,
  costPrice: true,
  inventory: true,
  sku: true,
  barcode: true,
  weight: true,
  description: true,
  descriptionAr: true,
  hasVariants: true,
  allowBackorder: true,
  trackInventory: true,
  discountType: true,
  discountValue: true,
  updatedAt: true,
} as const;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof PRODUCT_FIELDS }>;

export interface RefCounts {
  orderItems: number;
  openOrderItems: number;
  cartItems: number;
  warehouseStock: number;
  reorderRules: number;
  reorderSuggestions: number;
  deadstockFlags: number;
  purchaseOrderItems: number;
  stockAdjustmentItems: number;
  backorderLines: number;
  bundleItems: number;
  countLines: number;
}

export interface ProductPlan {
  productId: string;
  name: string;
  nameAr: string | null;
  variantId: string;
  variantTitle: string;
  options: OptionPair[];
  before: {
    price: number;
    compareAtPrice: number | null;
    costPrice: number | null;
    inventory: number;
    sku: string | null;
    barcode: string | null;
    weight: number | null;
    allowBackorder: boolean;
  };
  after: {
    price: number;
    compareAtPrice: number | null;
    costPrice: number | null;
    inventory: number;
    sku: string | null;
    barcode: string | null;
    weight: number | null;
    allowBackorder: boolean;
    description: string | null;
    descriptionAr: string | null;
    discountType: ProductRow['discountType'];
    discountValue: number | null;
  };
  descAppend: { en: string | null; ar: string | null };
  addImage: string | null;
  refs: RefCounts;
  blockers: string[];
  warnings: string[];
}

export interface PlanOptions {
  /** Ruling SVF-2: unlink order lines (else a product with any is blocked). */
  unlinkOrderLines: boolean;
  /**
   * Keep the product's own SKU/barcode when it has one, instead of the
   * variant's. The brief says copy the variant's; on pecannbee most variant
   * SKUs are the product SKU plus a size suffix ("743" vs "743-1 Kg"), so a
   * re-import keyed on the old SKU would miss them — Ahmad's call.
   */
  keepProductCodes?: boolean;
}

const OPEN_ORDER_EXCLUDED = ['delivered', 'cancelled', 'refunded'];

async function countRefs(tx: Tx, variantId: string): Promise<RefCounts> {
  const rows = await tx.$queryRaw<Array<Record<keyof RefCounts, bigint>>>`
    SELECT
      (SELECT count(*) FROM order_items WHERE variant_id = ${variantId}) AS "orderItems",
      (SELECT count(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.variant_id = ${variantId}
          AND o.status::text <> ALL(${OPEN_ORDER_EXCLUDED}::text[])) AS "openOrderItems",
      (SELECT count(*) FROM cart_items WHERE variant_id = ${variantId}) AS "cartItems",
      (SELECT count(*) FROM warehouse_stock WHERE variant_id = ${variantId}) AS "warehouseStock",
      (SELECT count(*) FROM reorder_rules WHERE variant_id = ${variantId}) AS "reorderRules",
      (SELECT count(*) FROM reorder_suggestions WHERE variant_id = ${variantId}) AS "reorderSuggestions",
      (SELECT count(*) FROM deadstock_flags WHERE variant_id = ${variantId}) AS "deadstockFlags",
      (SELECT count(*) FROM purchase_order_items WHERE variant_id = ${variantId}) AS "purchaseOrderItems",
      (SELECT count(*) FROM stock_adjustment_items WHERE variant_id = ${variantId}) AS "stockAdjustmentItems",
      (SELECT count(*) FROM backorder_lines WHERE variant_id = ${variantId}) AS "backorderLines",
      (SELECT count(*) FROM bundle_items WHERE variant_id = ${variantId}) AS "bundleItems",
      (SELECT count(*) FROM count_lines WHERE variant_id = ${variantId}) AS "countLines"
  `;
  const r = rows[0];
  return Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, Number(v)])
  ) as unknown as RefCounts;
}

/** Store-level candidate ids + the products skipped by the selection rule. */
export async function selectCandidates(
  tx: Tx,
  storeId: string
): Promise<{
  candidateIds: string[];
  multi: Array<{ id: string; name: string; rows: number; active: number }>;
  singleDisabled: Array<{ id: string; name: string }>;
}> {
  const rows = await tx.$queryRaw<
    Array<{ id: string; name: string; rows: bigint; active: bigint }>
  >`
    SELECT p.id, p.name, count(v.id) AS rows, count(v.id) FILTER (WHERE v.is_active) AS active
    FROM products p JOIN product_variants v ON v.product_id = p.id
    WHERE p.store_id = ${storeId} AND p.deleted_at IS NULL AND p.status = 'active'
    GROUP BY p.id, p.name
    ORDER BY p.name
  `;
  const out = {
    candidateIds: [] as string[],
    multi: [] as Array<{ id: string; name: string; rows: number; active: number }>,
    singleDisabled: [] as Array<{ id: string; name: string }>,
  };
  for (const r of rows) {
    const n = Number(r.rows);
    const a = Number(r.active);
    if (n > 1) out.multi.push({ id: r.id, name: r.name, rows: n, active: a });
    else if (a === 0) out.singleDisabled.push({ id: r.id, name: r.name });
    else out.candidateIds.push(r.id);
  }
  return out;
}

/**
 * Plan one product. Returns null when it is not (or no longer) a candidate —
 * which is what makes a second apply a no-op.
 */
export async function planProduct(
  tx: Tx,
  productId: string,
  opts: PlanOptions
): Promise<ProductPlan | null> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: {
      ...PRODUCT_FIELDS,
      images: { select: { url: true } },
      variants: {
        include: { options: { include: { value: { include: { option: true } } } } },
      },
      options: true,
    },
  });
  if (!product || product.deletedAt || product.status !== 'active') return null;
  if (product.variants.length !== 1 || !product.variants[0].isActive) return null;
  const v = product.variants[0];

  const options: OptionPair[] = [...v.options]
    .sort((a, b) => a.value.option.position - b.value.option.position)
    .map(o => ({
      name: o.value.option.name,
      nameAr: o.value.option.nameAr,
      value: o.value.value,
      valueAr: o.value.valueAr,
    }));

  const refs = await countRefs(tx, v.id);
  const blockers: string[] = [];
  const warnings: string[] = [];

  const restrict: Array<[keyof RefCounts, string]> = [
    ['purchaseOrderItems', 'purchase-order line(s)'],
    ['stockAdjustmentItems', 'stock-adjustment line(s)'],
    ['backorderLines', 'backorder line(s)'],
    ['bundleItems', 'bundle component(s)'],
    ['countLines', 'stock-count line(s)'],
  ];
  for (const [k, label] of restrict) {
    if (refs[k] > 0) blockers.push(`${refs[k]} ${label} reference the variant (FK RESTRICT)`);
  }
  if (refs.orderItems > 0 && !opts.unlinkOrderLines) {
    blockers.push(
      `${refs.orderItems} order line(s) reference the variant (${refs.openOrderItems} on open orders) — needs --unlink-order-lines (Ruling SVF-2)`
    );
  }

  const newSku = opts.keepProductCodes ? (product.sku ?? v.sku) : (v.sku ?? product.sku);
  if (newSku && newSku !== product.sku) {
    const clash = await tx.product.findFirst({
      where: { storeId: product.storeId, sku: newSku, id: { not: product.id } },
      select: { name: true },
    });
    if (clash) blockers.push(`SKU "${newSku}" is already used by product "${clash.name}"`);
  }
  const newBarcode = opts.keepProductCodes
    ? (product.barcode ?? v.barcode)
    : (v.barcode ?? product.barcode);
  if (newBarcode && newBarcode !== product.barcode) {
    const dup = await tx.product.findFirst({
      where: { storeId: product.storeId, barcode: newBarcode, id: { not: product.id } },
      select: { name: true },
    });
    if (dup) warnings.push(`barcode ${newBarcode} is also on product "${dup.name}"`);
  }

  const newPrice = v.price ?? product.price;
  if (newPrice !== product.price) {
    warnings.push(
      `product price ${kwd(product.price)} → ${kwd(newPrice)} (the variant's; the storefront already shows and charges ${kwd(newPrice)})`
    );
  }
  if (product.compareAtPrice !== null && product.compareAtPrice !== v.compareAtPrice) {
    warnings.push(
      `compare-at ${kwd(product.compareAtPrice)} → ${v.compareAtPrice === null ? 'none' : kwd(v.compareAtPrice)} (the parent's was ignored on variant products)`
    );
  }
  if (product.inventory !== 0) {
    warnings.push(
      `parent inventory column held ${product.inventory} (not stock under the inventory model) — replaced by the variant's ${v.inventory}`
    );
  }
  if (product.discountType) {
    warnings.push(
      `admin discount (${product.discountType}) cleared — price now comes from the variant`
    );
  }
  if (v.imageUrl && product.images.length > 0 && !product.images.some(i => i.url === v.imageUrl)) {
    warnings.push('variant image not copied (product already has images)');
  }
  if (refs.warehouseStock > 0) {
    const ws = await tx.warehouseStock.aggregate({
      where: { variantId: v.id },
      _sum: { quantity: true },
    });
    if ((ws._sum.quantity ?? 0) !== v.inventory) {
      warnings.push(
        `warehouse shadow for the variant sums to ${ws._sum.quantity ?? 0}, stock is ${v.inventory} (pre-existing drift, carried as-is)`
      );
    }
  }

  const add = descriptionAdditions(options, product.description, product.descriptionAr);

  return {
    productId: product.id,
    name: product.name,
    nameAr: product.nameAr,
    variantId: v.id,
    variantTitle: v.title,
    options,
    before: {
      price: product.price,
      compareAtPrice: product.compareAtPrice,
      costPrice: product.costPrice,
      inventory: product.inventory,
      sku: product.sku,
      barcode: product.barcode,
      weight: product.weight,
      allowBackorder: product.allowBackorder,
    },
    after: {
      price: newPrice,
      // The parent's compareAtPrice is ignored on a variant product
      // (lib/product-pricing.ts), so the shopper sees the VARIANT's — keep that.
      compareAtPrice: v.compareAtPrice,
      costPrice: v.costPrice ?? product.costPrice,
      inventory: v.inventory,
      sku: newSku,
      barcode: newBarcode,
      weight: v.weight ?? product.weight,
      // isOrderable for a variant product = product flag OR any active variant's.
      allowBackorder: product.allowBackorder || v.allowBackorder,
      description: appendLine(product.description, add.en),
      descriptionAr: appendLine(product.descriptionAr, add.ar),
      discountType: product.discountType ? null : product.discountType,
      discountValue: product.discountType ? null : product.discountValue,
    },
    descAppend: add,
    addImage: v.imageUrl && product.images.length === 0 ? v.imageUrl : null,
    refs,
    blockers,
    warnings,
  };
}

// ─── backup ──────────────────────────────────────────────────────────────────

export interface ProductBackup {
  plan: ProductPlan;
  product: ProductRow;
  variant: Record<string, unknown>;
  variantOptions: Array<{ variantId: string; valueId: string }>;
  options: Array<Record<string, unknown>>;
  optionValues: Array<Record<string, unknown>>;
  orderItemIds: string[];
  cartItems: Array<Record<string, unknown>>;
  /** Product-level cart lines as they were BEFORE a merge (cart + qty). */
  cartBaseLines: Array<Record<string, unknown>>;
  warehouseStock: Array<Record<string, unknown>>;
  warehouseBaseRows: Array<Record<string, unknown>>;
  reorderRules: Array<Record<string, unknown>>;
  reorderSuggestions: Array<Record<string, unknown>>;
  deadstockFlags: Array<Record<string, unknown>>;
}

export async function snapshotProduct(tx: Tx, plan: ProductPlan): Promise<ProductBackup> {
  const product = await tx.product.findUniqueOrThrow({
    where: { id: plan.productId },
    select: PRODUCT_FIELDS,
  });
  const variant = await tx.productVariant.findUniqueOrThrow({ where: { id: plan.variantId } });
  const options = await tx.productOption.findMany({ where: { productId: plan.productId } });
  const optionValues = await tx.productOptionValue.findMany({
    where: { optionId: { in: options.map(o => o.id) } },
  });
  const variantOptions = await tx.productVariantOption.findMany({
    where: { variantId: plan.variantId },
  });
  const orderItemIds = (
    await tx.orderItem.findMany({ where: { variantId: plan.variantId }, select: { id: true } })
  ).map(o => o.id);
  const cartItems = await tx.cartItem.findMany({ where: { variantId: plan.variantId } });
  const cartBaseLines = await tx.cartItem.findMany({
    where: {
      productId: plan.productId,
      variantId: null,
      cartId: { in: cartItems.map(c => c.cartId) },
    },
  });
  const warehouseStock = await tx.warehouseStock.findMany({ where: { variantId: plan.variantId } });
  const warehouseBaseRows = await tx.warehouseStock.findMany({
    where: { productId: plan.productId, variantId: null },
  });
  const reorderRules = await tx.reorderRule.findMany({ where: { variantId: plan.variantId } });
  const reorderSuggestions = await tx.reorderSuggestion.findMany({
    where: { variantId: plan.variantId },
  });
  const deadstockFlags = await tx.deadStockFlag.findMany({ where: { variantId: plan.variantId } });
  return {
    plan,
    product,
    variant,
    variantOptions,
    options,
    optionValues,
    orderItemIds,
    cartItems,
    cartBaseLines,
    warehouseStock,
    warehouseBaseRows,
    reorderRules,
    reorderSuggestions,
    deadstockFlags,
  };
}

// ─── apply ───────────────────────────────────────────────────────────────────

export type ApplyResult =
  | { status: 'flattened'; imageId: string | null; backup: ProductBackup }
  | { status: 'skipped'; reason: string };

/**
 * Flatten one product. MUST run inside a write transaction. Locks the product
 * and variant rows, re-plans against the locked state, and refuses on any
 * blocker — so a concurrent change or a second run cannot double-apply.
 *
 * The restore snapshot is taken HERE, under the same locks and in the same
 * transaction as the writes (issue 2350). A snapshot taken earlier, in its own
 * read-only transaction, missed any order/cart/warehouse row that pointed at
 * the variant by the time the apply ran — the apply mutates by predicate
 * (`variantId = vId`), so such a row was unlinked but could never be
 * re-linked by `--restore`. Under the variant's FOR UPDATE lock no new row can
 * reference it (an FK insert/update needs FOR KEY SHARE on the parent, which
 * conflicts), so this snapshot is exactly the set the writes below touch.
 * `onSnapshot` runs before the first write (persist it there); the snapshot is
 * also returned on success.
 */
export async function applyProduct(
  tx: Tx,
  productId: string,
  opts: PlanOptions,
  onSnapshot?: (backup: ProductBackup) => void
): Promise<ApplyResult> {
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM product_variants WHERE product_id = ${productId} FOR UPDATE`;
  const plan = await planProduct(tx, productId, opts);
  if (!plan) return { status: 'skipped', reason: 'not a candidate (already flat, or changed)' };
  if (plan.blockers.length) return { status: 'skipped', reason: plan.blockers.join('; ') };
  const vId = plan.variantId;
  const backup = await snapshotProduct(tx, plan);
  onSnapshot?.(backup);

  // References first — the variant row goes last.
  if (opts.unlinkOrderLines) {
    await tx.orderItem.updateMany({ where: { variantId: vId }, data: { variantId: null } });
  }

  const cartLines = await tx.cartItem.findMany({ where: { variantId: vId } });
  for (const line of cartLines) {
    const base = await tx.cartItem.findFirst({
      where: { cartId: line.cartId, productId, variantId: null },
    });
    if (base) {
      await tx.cartItem.update({
        where: { id: base.id },
        data: { quantity: { increment: line.quantity } },
      });
      await tx.cartItem.delete({ where: { id: line.id } });
    } else {
      await tx.cartItem.update({ where: { id: line.id }, data: { variantId: null } });
    }
  }

  const wsRows = await tx.warehouseStock.findMany({ where: { variantId: vId } });
  for (const row of wsRows) {
    const base = await tx.warehouseStock.findFirst({
      where: { warehouseId: row.warehouseId, productId, variantId: null },
    });
    if (base) {
      await tx.warehouseStock.update({ where: { id: base.id }, data: { quantity: row.quantity } });
      await tx.warehouseStock.delete({ where: { id: row.id } });
    } else {
      await tx.warehouseStock.update({ where: { id: row.id }, data: { variantId: null } });
    }
  }

  const rules = await tx.reorderRule.findMany({ where: { variantId: vId } });
  for (const rule of rules) {
    const own = await tx.reorderRule.findFirst({
      where: { storeId: rule.storeId, productId, variantId: null },
    });
    if (own) await tx.reorderRule.delete({ where: { id: rule.id } });
    else await tx.reorderRule.update({ where: { id: rule.id }, data: { variantId: null } });
  }
  await tx.reorderSuggestion.deleteMany({ where: { variantId: vId } });
  await tx.deadStockFlag.deleteMany({ where: { variantId: vId } });

  // The product takes over the variant's commercial fields and its stock.
  await tx.product.update({
    where: { id: productId },
    data: {
      price: plan.after.price,
      compareAtPrice: plan.after.compareAtPrice,
      costPrice: plan.after.costPrice,
      inventory: plan.after.inventory,
      sku: plan.after.sku,
      barcode: plan.after.barcode,
      weight: plan.after.weight,
      allowBackorder: plan.after.allowBackorder,
      description: plan.after.description,
      descriptionAr: plan.after.descriptionAr,
      discountType: plan.after.discountType,
      discountValue: plan.after.discountValue,
      hasVariants: false,
    },
  });

  let imageId: string | null = null;
  if (plan.addImage) {
    const img = await tx.productImage.create({
      data: { productId, url: plan.addImage, alt: plan.name, position: 0 },
    });
    imageId = img.id;
  }

  // Variant row (its option junctions cascade), then the now-empty option axis.
  await tx.productVariant.delete({ where: { id: vId } });
  await tx.productOption.deleteMany({ where: { productId } });

  const product = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    select: { storeId: true },
  });
  await tx.inventoryHistory.create({
    data: {
      productId,
      storeId: product.storeId,
      type: 'adjustment',
      quantity: 0,
      previousStock: plan.after.inventory,
      newStock: plan.after.inventory,
      reason: `Single variant "${plan.variantTitle}" flattened onto the product — ${plan.after.inventory} unit(s) moved from the variant row to the product row; stock unchanged`,
      reference: `flatten-variant:${vId}`,
    },
  });

  return { status: 'flattened', imageId, backup };
}

// ─── restore ─────────────────────────────────────────────────────────────────

export interface BackupFile {
  kind: 'flatten-single-variant-products-2026-09-30';
  storeId: string;
  storeSlug: string;
  createdAt: string;
  unlinkOrderLines: boolean;
  keepProductCodes?: boolean;
  products: Array<ProductBackup & { createdImageId?: string | null }>;
}

export type RestoreResult =
  | { status: 'restored'; notes: string[] }
  | { status: 'skipped'; reason: string };

/** Undo one product's flatten. MUST run inside a write transaction. */
export async function restoreProduct(
  tx: Tx,
  b: BackupFile['products'][number]
): Promise<RestoreResult> {
  const productId = b.plan.productId;
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} FOR UPDATE`;
  const current = await tx.product.findUnique({
    where: { id: productId },
    select: { ...PRODUCT_FIELDS, _count: { select: { variants: true } } },
  });
  if (!current) return { status: 'skipped', reason: 'product no longer exists' };
  if (current._count.variants > 0) {
    return {
      status: 'skipped',
      reason: 'product has variants again (already restored, or edited)',
    };
  }
  if (await tx.productVariant.findUnique({ where: { id: b.plan.variantId } })) {
    return { status: 'skipped', reason: 'variant id already exists' };
  }
  const notes: string[] = [];
  const orig = b.product;

  // Fields go back only where they still hold what the flatten wrote; a value
  // the merchant changed since is kept (and noted).
  const data: Prisma.ProductUpdateInput = { hasVariants: true, inventory: 0 };
  const field = <K extends keyof ProductPlan['after'] & keyof ProductRow>(k: K) => {
    const cur = current[k] as unknown;
    if (JSON.stringify(cur) === JSON.stringify(b.plan.after[k])) {
      (data as Record<string, unknown>)[k] = orig[k];
    } else {
      notes.push(`${String(k)} kept (changed since the flatten)`);
    }
  };
  for (const k of [
    'price',
    'compareAtPrice',
    'costPrice',
    'sku',
    'barcode',
    'weight',
    'allowBackorder',
    'description',
    'descriptionAr',
    'discountType',
    'discountValue',
  ] as const) {
    field(k);
  }

  // Options and values with their original ids (nothing else references them).
  for (const o of b.options) {
    await tx.productOption.create({
      data: toCreate(o) as Prisma.ProductOptionUncheckedCreateInput,
    });
  }
  for (const v of b.optionValues) {
    await tx.productOptionValue.create({
      data: toCreate(v) as Prisma.ProductOptionValueUncheckedCreateInput,
    });
  }

  // The variant takes the product's CURRENT stock: what sold since stays sold.
  const variantData = toCreate(b.variant) as Prisma.ProductVariantUncheckedCreateInput;
  variantData.inventory = current.inventory;
  await tx.productVariant.create({ data: variantData });
  for (const vo of b.variantOptions) {
    await tx.productVariantOption.create({ data: vo });
  }
  if (current.inventory !== b.plan.after.inventory) {
    notes.push(
      `stock moved back is ${current.inventory} (was ${b.plan.after.inventory} at flatten)`
    );
  }

  // Order lines: re-link only the ones the flatten unlinked, still unlinked.
  if (b.orderItemIds.length) {
    const r = await tx.orderItem.updateMany({
      where: { id: { in: b.orderItemIds }, productId, variantId: null },
      data: { variantId: b.plan.variantId },
    });
    if (r.count !== b.orderItemIds.length) {
      notes.push(`${r.count}/${b.orderItemIds.length} order lines re-linked`);
    }
  }

  // Cart lines that were re-pointed (not merged) and are still a product line.
  for (const c of b.cartItems) {
    const wasMerged = b.cartBaseLines.some(bl => bl.cartId === c.cartId);
    if (wasMerged) {
      notes.push(`cart ${String(c.cartId)}: merged line left as a product line`);
      continue;
    }
    await tx.cartItem.updateMany({
      where: { id: String(c.id), productId, variantId: null },
      data: { variantId: b.plan.variantId },
    });
  }

  // Warehouse shadow: the variant row gets the product row's CURRENT quantity;
  // the product-level row returns to its backed-up quantity (or goes away).
  for (const w of b.warehouseStock) {
    const base = await tx.warehouseStock.findFirst({
      where: { warehouseId: String(w.warehouseId), productId, variantId: null },
    });
    const qty = base?.quantity ?? Number(w.quantity);
    const origBase = b.warehouseBaseRows.find(x => x.warehouseId === w.warehouseId);
    if (base && origBase && base.id === origBase.id) {
      await tx.warehouseStock.update({
        where: { id: base.id },
        data: { quantity: Number(origBase.quantity) },
      });
      await tx.warehouseStock.create({
        data: { ...(toCreate(w) as Prisma.WarehouseStockUncheckedCreateInput), quantity: qty },
      });
    } else if (base) {
      // The flatten re-pointed the variant's own row (same id).
      await tx.warehouseStock.update({
        where: { id: base.id },
        data: { variantId: b.plan.variantId, quantity: qty },
      });
    } else {
      await tx.warehouseStock.create({
        data: { ...(toCreate(w) as Prisma.WarehouseStockUncheckedCreateInput), quantity: qty },
      });
    }
  }

  for (const r of b.reorderRules) {
    const moved = await tx.reorderRule.updateMany({
      where: { id: String(r.id), productId, variantId: null },
      data: { variantId: b.plan.variantId },
    });
    if (moved.count === 0 && !(await tx.reorderRule.findUnique({ where: { id: String(r.id) } }))) {
      await tx.reorderRule.create({ data: toCreate(r) as Prisma.ReorderRuleUncheckedCreateInput });
    }
  }
  for (const s of b.reorderSuggestions) {
    await tx.reorderSuggestion.create({
      data: toCreate(s) as Prisma.ReorderSuggestionUncheckedCreateInput,
    });
  }
  for (const d of b.deadstockFlags) {
    await tx.deadStockFlag.create({
      data: toCreate(d) as Prisma.DeadStockFlagUncheckedCreateInput,
    });
  }

  if (b.createdImageId) {
    await tx.productImage.deleteMany({ where: { id: b.createdImageId, productId } });
  }

  await tx.product.update({ where: { id: productId }, data });
  await tx.inventoryHistory.create({
    data: {
      productId,
      storeId: current.storeId,
      type: 'adjustment',
      quantity: 0,
      previousStock: current.inventory,
      newStock: current.inventory,
      reason: `Flatten undone — ${current.inventory} unit(s) moved back from the product row to variant "${b.plan.variantTitle}"; stock unchanged`,
      reference: `unflatten-variant:${b.plan.variantId}`,
    },
  });
  return { status: 'restored', notes };
}

/** A backed-up row as create input: drop Prisma-managed timestamps' string form. */
function toCreate(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'updatedAt') continue;
    out[k] =
      typeof v === 'string' && /At$/.test(k) && !Number.isNaN(Date.parse(v)) ? new Date(v) : v;
  }
  return out;
}

// ─── caches ──────────────────────────────────────────────────────────────────

export function cachePurgeList(storeId: string): {
  redisPrefixes: string[];
  redisKeys: string[];
  tags: string[];
} {
  return {
    redisPrefixes: [
      `public:products:${storeId}:`,
      `public:product:${storeId}:`,
      `public:suggest:${storeId}:`,
      `admin:products:${storeId}:`,
    ],
    redisKeys: [
      `public:categories:${storeId}`,
      `admin:categories:${storeId}`,
      `public:bundles:v2:${storeId}`,
    ],
    tags: [`products:${storeId}`, `categories:${storeId}`, `bundles:${storeId}`],
  };
}

export interface BustDeps {
  /** Awaited storefront tag purge (needs no Redis). */
  revalidate: (opts: { tags: string[] }) => Promise<string>;
  /** Redis layer; only attempted when REDIS_URL is set. */
  clearRedis: (storeId: string) => Promise<void>;
  redisUrl: string | undefined;
  log: (line: string) => void;
}

async function defaultBustDeps(): Promise<BustDeps> {
  const { revalidateStorefrontNow } = await import('../apps/api/src/lib/revalidate-storefront');
  return {
    revalidate: revalidateStorefrontNow,
    clearRedis: async storeId => {
      const { clearProductsRedis } = await import('../apps/api/src/lib/public-cache');
      await clearProductsRedis(storeId);
    },
    redisUrl: process.env.REDIS_URL,
    log: line => console.log(line),
  };
}

const within10s = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout after 10s')), 10_000)),
  ]);

/**
 * Invalidate both cache layers after a flatten or restore (issue 2351).
 *
 * The two layers are independent, so they are gated independently:
 *  - the storefront's Next.js TAG cache is an outbound HTTPS purge that needs
 *    no Redis — always attempted, and awaited so the script knows it landed.
 *    It does NOT expire on its own: a missed purge keeps the old one-option
 *    picker rendering until something else revalidates the tag.
 *  - the Redis layer is attempted only with a REDIS_URL. Production Redis is
 *    private-network only, so from a laptop it is skipped; those keys expire
 *    within 120s (feed 600s).
 * On by default; `--no-bust-caches` opts out.
 */
export async function bustCaches(
  storeId: string,
  requested: boolean,
  deps?: BustDeps
): Promise<void> {
  const d = deps ?? (await defaultBustDeps());
  const list = cachePurgeList(storeId);
  const manualRedis = () => {
    d.log(`  Redis prefixes (SCAN+DEL): ${list.redisPrefixes.join('  ')}`);
    d.log(`  Redis keys (DEL):          ${list.redisKeys.join('  ')}`);
  };
  if (!requested) {
    d.log('caches: --no-bust-caches — nothing purged. Purge by hand:');
    manualRedis();
    d.log(`  storefront tags:           ${list.tags.join('  ')}`);
    d.log('  (the tag layer does NOT expire on its own; saving any product of this store in');
    d.log('   the admin runs the same invalidation for both layers.)');
    return;
  }

  const outcome = await d.revalidate({ tags: list.tags }).catch(() => 'failed');
  if (outcome === 'ok') {
    d.log(`caches: storefront tags purged (${list.tags.join(', ')})`);
  } else {
    d.log(
      `caches: storefront tag purge ${outcome} — set STOREFRONT_REVALIDATE_URL + REVALIDATE_SECRET, ` +
        `or save any product of this store in the admin. Tags: ${list.tags.join('  ')}`
    );
  }

  if (d.redisUrl) {
    try {
      await within10s(d.clearRedis(storeId));
      d.log('caches: Redis product keys cleared');
      return;
    } catch (err) {
      d.log(`caches: Redis clear failed (${(err as Error).message}) — purge by hand:`);
    }
  } else {
    d.log('caches: Redis not reachable from here (no REDIS_URL) — these expire within 120s');
    d.log('  (feed 600s), or purge by hand:');
  }
  manualRedis();
}

// ─── output ──────────────────────────────────────────────────────────────────

function kwd(fils: number | null): string {
  return fils === null ? '—' : (fils / 1000).toFixed(3);
}

function printPlan(p: ProductPlan): void {
  const opt = p.options.map(o => `${o.name}: ${o.value}`).join(', ') || p.variantTitle;
  const status = p.blockers.length ? 'BLOCKED' : 'ready';
  console.log(`\n[${status}] ${p.name}${p.nameAr ? ` / ${p.nameAr}` : ''}  (${p.productId})`);
  console.log(`  option     ${opt}`);
  console.log(
    `  price      ${kwd(p.after.price)}${p.after.compareAtPrice ? ` (compare-at ${kwd(p.after.compareAtPrice)})` : ''}   cost ${kwd(p.after.costPrice)}`
  );
  console.log(`  stock      ${p.after.inventory} (moves from the variant row to the product row)`);
  console.log(
    `  sku        ${p.before.sku ?? '—'} → ${p.after.sku ?? '—'}   barcode ${p.before.barcode ?? '—'} → ${p.after.barcode ?? '—'}`
  );
  console.log(
    `  desc EN    ${p.descAppend.en ? `+ "${p.descAppend.en.replace(/\n/g, ' | ')}"` : 'already states it — unchanged'}`
  );
  console.log(
    `  desc AR    ${p.descAppend.ar ? `+ "${p.descAppend.ar.replace(/\n/g, ' | ')}"` : 'already states it — unchanged'}`
  );
  if (p.addImage) console.log('  image      variant image becomes the product image');
  const r = p.refs;
  const moved = [
    r.orderItems ? `${r.orderItems} order line(s) (${r.openOrderItems} open)` : '',
    r.cartItems ? `${r.cartItems} cart line(s)` : '',
    r.warehouseStock ? `${r.warehouseStock} warehouse row(s)` : '',
    r.reorderRules ? `${r.reorderRules} reorder rule(s)` : '',
  ].filter(Boolean);
  if (moved.length) console.log(`  refs       ${moved.join(', ')}`);
  for (const w of p.warnings) console.log(`  note       ${w}`);
  for (const b of p.blockers) console.log(`  BLOCKER    ${b}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function runAllStores(): Promise<void> {
  const stores = await inTx(true, tx =>
    tx.store.findMany({ select: { id: true, slug: true }, orderBy: { slug: 'asc' } })
  );
  console.log(
    'store                 candidates  ready  blocked  (order-linked)  multi-variant  single-disabled'
  );
  for (const s of stores) {
    // One short READ ONLY transaction per product: over a WAN link a single
    // transaction for a whole store outlives the transaction timeout.
    const sel = await inTx(true, tx => selectCandidates(tx, s.id));
    let ready = 0;
    let blocked = 0;
    let orderLinked = 0;
    for (const id of sel.candidateIds) {
      const p = await inTx(true, tx => planProduct(tx, id, { unlinkOrderLines: false }));
      if (!p) continue;
      if (p.refs.orderItems > 0) orderLinked++;
      if (p.blockers.length) blocked++;
      else ready++;
    }
    const r = { sel, ready, blocked, orderLinked };
    if (!r.sel.candidateIds.length && !r.sel.multi.length && !r.sel.singleDisabled.length) continue;
    console.log(
      `${s.slug.padEnd(22)}${String(r.sel.candidateIds.length).padStart(10)}${String(r.ready).padStart(7)}${String(r.blocked).padStart(9)}${String(r.orderLinked).padStart(16)}${String(r.sel.multi.length).padStart(15)}${String(r.sel.singleDisabled.length).padStart(17)}`
    );
  }
  console.log(
    '\n(blocked counts assume no --unlink-order-lines; nothing was written — READ ONLY transactions)'
  );
}

async function runStore(
  slug: string,
  apply: boolean,
  unlinkOrderLines: boolean,
  keepProductCodes: boolean,
  only: string[] | null,
  bust: boolean
) {
  const store = await inTx(true, tx =>
    tx.store.findFirst({ where: { slug }, select: { id: true, slug: true } })
  );
  if (!store) throw new Error(`store "${slug}" not found`);
  const opts: PlanOptions = { unlinkOrderLines, keepProductCodes };

  const sel = await inTx(true, tx => selectCandidates(tx, store.id));
  const ids = only ? sel.candidateIds.filter(id => only.includes(id)) : sel.candidateIds;
  const plans: ProductPlan[] = [];
  for (const id of ids) {
    const p = await inTx(true, tx => planProduct(tx, id, opts));
    if (p) plans.push(p);
  }

  console.log(
    `store ${store.slug} (${store.id}) — ${apply ? 'APPLY' : 'DRY RUN (read-only transaction)'}${unlinkOrderLines ? ' --unlink-order-lines' : ''}${keepProductCodes ? ' --keep-product-codes' : ''}`
  );
  for (const p of plans) printPlan(p);
  if (sel.multi.length) {
    console.log(`\nskipped — more than one variant row (${sel.multi.length}):`);
    for (const m of sel.multi) console.log(`  ${m.name}  (${m.rows} rows, ${m.active} active)`);
  }
  if (sel.singleDisabled.length) {
    console.log(`\nskipped — the only variant is disabled (${sel.singleDisabled.length}):`);
    for (const m of sel.singleDisabled) console.log(`  ${m.name}`);
  }
  const ready = plans.filter(p => !p.blockers.length);
  const blocked = plans.filter(p => p.blockers.length);
  const descEn = plans.filter(p => p.descAppend.en).length;
  const descAr = plans.filter(p => p.descAppend.ar).length;
  const reasons = new Map<string, number>();
  for (const p of blocked) {
    for (const b of p.blockers) {
      const key = b.replace(/^\d+ /, '').replace(/\(\d+ on open orders\)/, '(n open)');
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
  console.log(
    `\nsummary: ${plans.length} candidate(s) · ${ready.length} ready · ${blocked.length} blocked · ${sel.multi.length} multi-variant skipped · ${sel.singleDisabled.length} single-disabled skipped`
  );
  console.log(
    `         of all candidates: description gets a line EN ${descEn}, AR ${descAr} · order lines to unlink (ready only): ${ready.reduce((s, p) => s + p.refs.orderItems, 0)} · cart lines to re-point (ready only): ${ready.reduce((s, p) => s + p.refs.cartItems, 0)}`
  );
  for (const [r, n] of reasons) console.log(`         blocked ×${n}: ${r}`);

  if (!apply) {
    console.log('\nDRY RUN — nothing was written.');
    return;
  }
  if (!ready.length) {
    console.log('\nnothing to apply.');
    return;
  }

  // Backup: each product's snapshot is taken INSIDE its apply transaction,
  // under the row locks, and written to the file before that transaction's
  // first write (issue 2350). A product whose transaction then skips or rolls
  // back is dropped from the file again.
  const dir = path.resolve(process.cwd(), 'scripts', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `flatten-single-variant-${store.slug}-${stamp}.json`);
  const backup: BackupFile = {
    kind: 'flatten-single-variant-products-2026-09-30',
    storeId: store.id,
    storeSlug: store.slug,
    createdAt: new Date().toISOString(),
    unlinkOrderLines,
    keepProductCodes,
    products: [],
  };
  const write = () => fs.writeFileSync(file, JSON.stringify(backup, null, 2), { mode: 0o600 });
  write();
  console.log(`\nbackup: ${file}`);

  let done = 0;
  for (const p of ready) {
    const slot: { entry?: BackupFile['products'][number] } = {};
    try {
      const res = await inTx(false, tx =>
        applyProduct(tx, p.productId, opts, snap => {
          slot.entry = { ...snap, createdImageId: null };
          backup.products.push(slot.entry);
          write(); // on disk before the first write of this transaction
        })
      );
      if (res.status === 'flattened' && slot.entry) {
        slot.entry.createdImageId = res.imageId;
        done++;
        console.log(`  flattened  ${p.name}`);
      } else {
        console.log(`  skipped    ${p.name}: ${res.reason}`);
      }
    } catch (err) {
      if (slot.entry) backup.products.splice(backup.products.indexOf(slot.entry), 1);
      console.log(`  FAILED     ${p.name}: ${(err as Error).message} (rolled back)`);
    }
    write(); // keep createdImageId current for --restore
  }
  console.log(
    `\napplied ${done}/${backup.products.length}. restore: npx tsx scripts/flatten-single-variant-products-2026-09-30.ts --restore ${file} --apply`
  );
  if (done) await bustCaches(store.id, bust);
}

async function runRestore(file: string, apply: boolean, bust: boolean): Promise<void> {
  const backup = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupFile;
  if (backup.kind !== 'flatten-single-variant-products-2026-09-30') {
    throw new Error('not a flatten-single-variant backup file');
  }
  console.log(
    `restore ${backup.storeSlug}: ${backup.products.length} product(s) — ${apply ? 'APPLY' : 'DRY RUN (read-only transaction)'}`
  );
  let done = 0;
  for (const b of backup.products) {
    if (!apply) {
      const state = await inTx(true, tx =>
        tx.product.findUnique({
          where: { id: b.plan.productId },
          select: { inventory: true, _count: { select: { variants: true } } },
        })
      );
      const verdict = !state
        ? 'product gone — would skip'
        : state._count.variants > 0
          ? 'has variants — would skip'
          : `would restore variant "${b.plan.variantTitle}" with stock ${state.inventory}, re-link ${b.orderItemIds.length} order line(s)`;
      console.log(`  ${b.plan.name}: ${verdict}`);
      continue;
    }
    try {
      const res = await inTx(false, tx => restoreProduct(tx, b));
      if (res.status === 'restored') {
        done++;
        console.log(
          `  restored   ${b.plan.name}${res.notes.length ? ` (${res.notes.join('; ')})` : ''}`
        );
      } else {
        console.log(`  skipped    ${b.plan.name}: ${res.reason}`);
      }
    } catch (err) {
      console.log(`  FAILED     ${b.plan.name}: ${(err as Error).message} (rolled back)`);
    }
  }
  if (!apply) {
    console.log('\nDRY RUN — nothing was written. Add --apply to restore.');
    return;
  }
  console.log(`\nrestored ${done}/${backup.products.length}.`);
  if (done) await bustCaches(backup.storeId, bust);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // Default ON (issue 2351); `--bust-caches` is still accepted and is a no-op.
  const bust = !process.argv.includes('--no-bust-caches');
  const restore = arg('--restore');
  const storeSlug = arg('--store');
  const onlyArg = arg('--only');
  if (restore) return runRestore(restore, apply, bust);
  if (process.argv.includes('--all-stores')) {
    if (apply) throw new Error('--all-stores reports counts only; apply one --store at a time');
    return runAllStores();
  }
  if (!storeSlug)
    throw new Error('--store <slug> is required (or --all-stores / --restore <file>)');
  return runStore(
    storeSlug,
    apply,
    process.argv.includes('--unlink-order-lines'),
    process.argv.includes('--keep-product-codes'),
    onlyArg ? onlyArg.split(',').map(s => s.trim()) : null,
    bust
  );
}

if (process.argv[1] && /flatten-single-variant-products-2026-09-30\.ts$/.test(process.argv[1])) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async err => {
      console.error(err instanceof Error ? err.message : err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
