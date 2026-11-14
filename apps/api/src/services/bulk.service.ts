import { isFreeActiveProduct, PRICE_REQUIRED_MESSAGE } from '../lib/sellable-price';
import { prisma, Prisma, ProductStatus, SlugEntityType, withMoneyTx } from '@ebda/database';
import { storeDb, storeMoney, storeWriter } from '../lib/repo-factory';
import logger from '../lib/logger';
import {
  AI_AUTOFILL_FIELD_NAMES,
  SEARCH_TERMS_MAX_LENGTH,
  cleanSearchTerms,
  csvField,
  GOLD_KARATS,
  minorToDecimalString,
  mgToGramsString,
  parseBarcodeInput,
  parseGramsToMg,
  slugifyWithFallback,
  type GoldKarat,
} from '@ebda/shared';
import { GoldRateService } from './gold-rate/gold-rate.service';
import { fillMissingAfterImport, lockStoreBarcodes } from './barcode.service';
import { AppError } from '../middleware/error-handler';
import { recordSlugRedirect } from './slug-redirect.service';
import { stampHumanEdits } from './ai-autofill.service';
import { assertWithinLimit } from './plan-limit.service';
import { PRODUCT_SEARCH_MAX_LIMIT, searchProductIds } from './product-search.service';
import { requestStoreReindex } from '../lib/search/reindex';
import {
  bundleFkViolationKind,
  planBundlePinnedVariantSkips,
  throwIfBundleFkViolation,
} from '../lib/bundle-fk-errors';

/** The AI-writable product fields + their provenance map, read before an import update. */
const AI_PROVENANCE_SELECT = Object.fromEntries(
  [...AI_AUTOFILL_FIELD_NAMES, 'aiFieldSources'].map(f => [f, true])
) as Prisma.ProductSelect;

/**
 * The AI-writable fields an import row actually SETS (non-empty). An imported value is a
 * merchant edit, so `stampHumanEdits` makes a changed one 'human' and the autopilot never
 * replaces it (search program P1: it now writes search words too). Blank cells are left out
 * on purpose: an import blank keeps its documented meaning (search words: leave alone; other
 * fields: clear) without also locking the field against the autopilot.
 */
function importedAiValues(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    AI_AUTOFILL_FIELD_NAMES.filter(
      f => typeof fields[f] === 'string' && (fields[f] as string).trim()
    ).map(f => [f, fields[f]])
  );
}

interface ProductImportRow {
  name: string;
  nameAr?: string;
  slug?: string;
  description?: string;
  descriptionAr?: string;
  price: number; // In piastres
  compareAtPrice?: number;
  costPrice?: number;
  /** Gold-rate pricing (B5): 'gold_rate' | 'fixed' | blank; karat; grams (<= 2 decimals). */
  pricing_mode?: string;
  gold_karat?: string | number;
  gold_weight_g?: string | number;
  sku?: string;
  barcode?: string;
  inventory?: number;
  lowStockThreshold?: number;
  trackInventory?: boolean;
  weight?: number;
  status?: ProductStatus;
  featured?: boolean;
  isNew?: boolean;
  categories?: string; // Comma-separated category names
  tags?: string; // Comma-separated tag names
  images?: string; // Comma-separated image URLs
  metaTitle?: string;
  metaTitleAr?: string;
  metaDescription?: string;
  metaDescriptionAr?: string;
  // Extra shopper words, comma-separated (cleaned + capped via cleanSearchTerms).
  searchTerms?: string;
  // Variant columns (OSOSS-style). A row with a non-empty parentSku is a
  // variant of the product whose `sku` equals parentSku — see classifyRow.
  parentSku?: string;
  option1Name?: string;
  option1Value?: string;
  option2Name?: string;
  option2Value?: string;
  option3Name?: string;
  option3Value?: string;
  // Meta columns written by the CSV converter (csv-import.ts): the row's
  // 1-based number in the file the merchant actually uploaded, and a reason
  // the converter already rejected it. Absent on hand-written template CSVs.
  sourceRow?: string;
  _error?: string;
}

interface ImportResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  variantsCreated: number;
  errors: Array<{ row: number; error: string }>;
}

/**
 * A parsed variant row, grouped under its parent product by parentSku.
 * Numeric fields are already in piastres / ints (the xlsx converter pre-multiplies
 * price; CSV callers pass piastres directly).
 */
export interface VariantImportRow {
  parentSku: string;
  sku?: string;
  barcode?: string;
  price?: number;
  compareAtPrice?: number;
  costPrice?: number;
  inventory?: number;
  weight?: number;
  imageUrl?: string;
  option1Name?: string;
  option1Value?: string;
  option2Name?: string;
  option2Value?: string;
  option3Name?: string;
  option3Value?: string;
}

export interface CollectedOption {
  name: string;
  values: string[]; // distinct, first-seen order
}

/** A row is a variant when it carries a non-empty parentSku, else a base product. */
export function classifyRow(row: { parentSku?: string }): 'base' | 'variant' {
  return row.parentSku && String(row.parentSku).trim() ? 'variant' : 'base';
}

/**
 * Collect the distinct option axes + values across a product's variant rows,
 * preserving first-seen order for both axis and value (stable variant titles).
 */
export function collectOptions(variants: VariantImportRow[]): CollectedOption[] {
  const order: string[] = [];
  const byName = new Map<string, CollectedOption>();
  for (const v of variants) {
    for (const i of [1, 2, 3] as const) {
      const name = (v[`option${i}Name`] as string | undefined)?.toString().trim();
      const value = (v[`option${i}Value`] as string | undefined)?.toString().trim();
      if (!name || !value) continue;
      if (!byName.has(name)) {
        byName.set(name, { name, values: [] });
        order.push(name);
      }
      const opt = byName.get(name)!;
      if (!opt.values.includes(value)) opt.values.push(value);
    }
  }
  return order.map(n => byName.get(n)!);
}

/** Variant title = option values joined by " / " (e.g. "1 Kg" or "S / Red"). */
export function buildVariantTitle(values: string[]): string {
  return values.join(' / ');
}

/**
 * Create a product's options, option values, variants and the variant↔value
 * junction rows INSIDE the given transaction client, then flag the product as
 * having variants. We deliberately do NOT call variant.service here — it uses
 * its own prisma connection, which would create the variants outside this
 * transaction and break atomicity if the batch rolls back.
 *
 * Replace-semantics: any existing options/variants for the product are cleared
 * first (mirrors how categories/tags/images are replaced on re-import).
 */
export async function createVariantsForProductTx(
  tx: Prisma.TransactionClient,
  storeId: string,
  productId: string,
  variants: VariantImportRow[],
  userId?: string | null
): Promise<number> {
  if (variants.length === 0) return 0;

  // Remember what the merchant entered on the existing option values BEFORE the replace below
  // clears them: the sheet carries only option names and values, so the Arabic twins and the B0
  // swatches (hex / photo) are keyed by `name|value` and written back onto the recreated rows.
  // Without this a re-import silently wipes every swatch (and Arabic option label) of the store.
  const prior = await tx.productOption.findMany({
    where: { productId },
    select: {
      name: true,
      nameAr: true,
      values: {
        select: { value: true, valueAr: true, swatchHex: true, swatchImageUrl: true },
      },
    },
  });
  const priorOptionAr = new Map(prior.map(o => [o.name, o.nameAr]));
  const priorValue = new Map(
    prior.flatMap(o => o.values.map(v => [`${o.name}|${v.value}`, v] as const))
  );

  // BARCODE-1: a re-import replaces the variants, so a row with no barcode column must keep the
  // code the variant already had (it may be on a printed label). Matched by sku, else by title.
  const priorAll = await tx.productVariant.findMany({
    where: { productId },
    select: { sku: true, title: true, barcode: true, inventory: true },
  });
  const priorVariants = priorAll.filter(v => v.barcode !== null);
  const priorBarcodeBySku = new Map(
    priorVariants.filter(v => v.sku).map(v => [v.sku as string, v.barcode as string])
  );
  const priorBarcodeByTitle = new Map(priorVariants.map(v => [v.title, v.barcode as string]));
  const typedInThisImport = new Set(variants.map(v => v.barcode).filter(Boolean) as string[]);
  const carriedBarcodes = new Set<string>();
  const carryBarcode = (sku: string | null, title: string): string | null => {
    const code = (sku ? priorBarcodeBySku.get(sku) : undefined) ?? priorBarcodeByTitle.get(title);
    if (!code || typedInThisImport.has(code) || carriedBarcodes.has(code)) return null;
    carriedBarcodes.add(code);
    return code;
  };

  // Clear existing options/variants (cascades to values + junction rows).
  //
  // P1-4 (final review): `bundle_items.variant_id` is ON DELETE RESTRICT, so
  // this delete raises P2003 for any variant a bundle pins. The import plan
  // above already skips such products (see `planBundlePinnedVariantSkips`),
  // which is what keeps the rest of the batch alive; this catch is the
  // residual race — a bundle created between that read and this write — and
  // turns the global handler's generic "A referenced record does not exist"
  // into something that names the constraint that fired.
  // INV-AUDIT-3: the replaced variants take their units with them; each is a movement to zero (the DO import writes the same)
  const replaced = priorAll.filter(v => v.inventory !== 0);
  if (replaced.length > 0)
    await tx.inventoryHistory.createMany({
      data: replaced.map(r => ({
        productId,
        storeId,
        type: 'adjustment' as const,
        quantity: -r.inventory,
        previousStock: r.inventory,
        newStock: 0,
        reason: 'Variant replaced by bulk import',
        createdBy: userId ?? null,
      })),
    });
  try {
    await tx.productVariant.deleteMany({ where: { productId } });
  } catch (err) {
    throwIfBundleFkViolation(err);
    throw err;
  }
  await tx.productOption.deleteMany({ where: { productId } });

  // 1) Options, batched. Correlate created rows back by `name` (distinct per
  // product per collectOptions) rather than assuming createManyAndReturn
  // preserves input order.
  const collected = collectOptions(variants);
  const createdOptions =
    collected.length > 0
      ? await tx.productOption.createManyAndReturn({
          data: collected.map((opt, oi) => ({
            productId,
            name: opt.name,
            nameAr: priorOptionAr.get(opt.name) ?? null,
            position: oi,
          })),
        })
      : [];
  const optionIdByName = new Map(createdOptions.map(o => [o.name, o.id]));
  const nameByOptionId = new Map(createdOptions.map(o => [o.id, o.name]));

  // 2) Option values, batched. Correlate by (optionId, value) — distinct per
  // option per collectOptions — into the same `name|value` -> valueId map
  // the junction-building step below expects.
  const valueRows: Array<{
    optionId: string;
    value: string;
    valueAr: string | null;
    swatchHex: string | null;
    swatchImageUrl: string | null;
    position: number;
  }> = [];
  for (const opt of collected) {
    const optionId = optionIdByName.get(opt.name)!;
    opt.values.forEach((value, vi) => {
      const kept = priorValue.get(`${opt.name}|${value}`);
      valueRows.push({
        optionId,
        value,
        valueAr: kept?.valueAr ?? null,
        swatchHex: kept?.swatchHex ?? null,
        swatchImageUrl: kept?.swatchImageUrl ?? null,
        position: vi,
      });
    });
  }
  const createdValues =
    valueRows.length > 0
      ? await tx.productOptionValue.createManyAndReturn({ data: valueRows })
      : [];
  const valueIdByKey = new Map<string, string>();
  for (const row of createdValues) {
    const name = nameByOptionId.get(row.optionId);
    if (name) valueIdByKey.set(`${name}|${row.value}`, row.id);
  }

  // 3) Variants, batched. Correlate by `position` (the original array index,
  // unique per created variant — matches the pre-batch loop's `vi`).
  const variantPairsByPosition = new Map<number, Array<{ name: string; value: string }>>();
  const variantRows: Array<{
    productId: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    price: number | null;
    compareAtPrice: number | null;
    costPrice: number | null;
    inventory: number;
    weight: number | null;
    imageUrl: string | null;
    position: number;
  }> = [];
  for (let vi = 0; vi < variants.length; vi++) {
    const v = variants[vi];
    const pairs: Array<{ name: string; value: string }> = [];
    for (const i of [1, 2, 3] as const) {
      const name = (v[`option${i}Name`] as string | undefined)?.toString().trim();
      const value = (v[`option${i}Value`] as string | undefined)?.toString().trim();
      if (name && value) pairs.push({ name, value });
    }
    if (pairs.length === 0) continue; // malformed variant row — skip

    variantRows.push({
      productId,
      title: buildVariantTitle(pairs.map(p => p.value)),
      sku: v.sku || null,
      barcode: v.barcode || carryBarcode(v.sku || null, buildVariantTitle(pairs.map(p => p.value))),
      price: v.price ?? null,
      compareAtPrice: v.compareAtPrice ?? null,
      costPrice: v.costPrice ?? null,
      inventory: v.inventory ?? 0,
      weight: v.weight ?? null,
      imageUrl: v.imageUrl || null,
      position: vi,
    });
    variantPairsByPosition.set(vi, pairs);
  }

  const createdVariants =
    variantRows.length > 0
      ? await tx.productVariant.createManyAndReturn({ data: variantRows })
      : [];
  const variantIdByPosition = new Map(createdVariants.map(v => [v.position, v.id]));
  const opening = createdVariants.filter(v => v.inventory !== 0);
  if (opening.length > 0)
    await tx.inventoryHistory.createMany({
      data: opening.map(v => ({
        productId,
        storeId,
        type: 'initial' as const,
        quantity: v.inventory,
        previousStock: 0,
        newStock: v.inventory,
        reason: 'Initial stock from bulk import',
        createdBy: userId ?? null,
      })),
    });

  // 4) Junction rows, batched in a single createMany.
  const junctionRows: Array<{ variantId: string; valueId: string }> = [];
  for (const [position, pairs] of variantPairsByPosition) {
    const variantId = variantIdByPosition.get(position);
    if (!variantId) continue;
    for (const p of pairs) {
      const valueId = valueIdByKey.get(`${p.name}|${p.value}`);
      if (!valueId) continue;
      junctionRows.push({ variantId, valueId });
    }
  }
  if (junctionRows.length > 0) {
    await tx.productVariantOption.createMany({ data: junctionRows });
  }

  // 5) We bypass variant.service, so we own the hasVariants flag.
  await tx.product.update({ where: { id: productId, storeId }, data: { hasVariants: true } });
  return createdVariants.length;
}

/**
 * The product columns an import row sets (shared by the Postgres batch and the Durable Object batch, so both write the same
 * thing). A blank barcode on an update, and blank search words, leave the stored value alone.
 */
function buildProductFields(row: ProductImportRow, slug: string, existing: { id: string } | null) {
  // Blank = leave alone (bulk cannot clear; documented in the import help).
  const cleanedSearchTerms = cleanSearchTerms(row.searchTerms);
  const productFields = {
    name: row.name,
    nameAr: row.nameAr || null,
    slug,
    description: row.description || null,
    descriptionAr: row.descriptionAr || null,
    price: parseInt(String(row.price)),
    compareAtPrice: row.compareAtPrice ? parseInt(String(row.compareAtPrice)) : null,
    costPrice: row.costPrice ? parseInt(String(row.costPrice)) : null,
    sku: row.sku || null,
    // BARCODE-1: blank = leave alone on update (a code may be on a printed label).
    ...(row.barcode || !existing ? { barcode: row.barcode || null } : {}),
    inventory: row.inventory ? parseInt(String(row.inventory)) : 0,
    lowStockThreshold: row.lowStockThreshold ? parseInt(String(row.lowStockThreshold)) : 5,
    trackInventory: row.trackInventory !== undefined ? String(row.trackInventory) === 'true' : true,
    weight: row.weight ? parseFloat(String(row.weight)) : null,
    status: (row.status as ProductStatus) || 'draft',
    featured: row.featured !== undefined ? String(row.featured) === 'true' : false,
    isNew: row.isNew !== undefined ? String(row.isNew) === 'true' : false,
    metaTitle: row.metaTitle || null,
    metaTitleAr: row.metaTitleAr || null,
    metaDescription: row.metaDescription || null,
    metaDescriptionAr: row.metaDescriptionAr || null,
    // A blank/absent column leaves curated search words alone on
    // update (older exports have no such column) and is null on create.
    ...(cleanedSearchTerms ? { searchTerms: cleanedSearchTerms } : {}),
  };
  return productFields;
}

interface ExportOptions {
  status?: ProductStatus;
  category?: string;
  search?: string;
  includeDeleted?: boolean;
}

export class BulkService {
  /**
   * Export products to CSV format
   */
  static async exportProducts(storeId: string, options?: ExportOptions): Promise<string> {
    const where: Prisma.ProductWhereInput = {
      storeId,
    };

    if (options?.status) {
      where.status = options.status;
    }

    if (!options?.includeDeleted) {
      where.deletedAt = null;
    }

    if (options?.search) {
      // Arabic-normalised names/terms/descriptions + SKU (product-search.service).
      where.id = {
        in: await searchProductIds(storeId, options.search, {
          scope: 'admin',
          includeDeleted: !!options.includeDeleted,
          limit: PRODUCT_SEARCH_MAX_LIMIT,
        }),
      };
    }

    // Hard ceiling to prevent OOM on very large stores.
    // Most stores have well under 10,000 products.
    const products = await (
      await storeDb(storeId)
    ).product.findMany({
      where,
      include: {
        images: { orderBy: { position: 'asc' } },
        categories: { include: { category: true } },
        tags: { include: { tag: true } },
        variants: {
          orderBy: { position: 'asc' },
          include: { options: { include: { value: { include: { option: true } } } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    // CSV headers
    const headers = [
      'id',
      'name',
      'nameAr',
      'slug',
      'description',
      'descriptionAr',
      'price',
      'compareAtPrice',
      'costPrice',
      'sku',
      'barcode',
      'inventory',
      'lowStockThreshold',
      'trackInventory',
      'weight',
      'status',
      'featured',
      'isNew',
      'categories',
      'tags',
      'images',
      'metaTitle',
      'metaTitleAr',
      'metaDescription',
      'metaDescriptionAr',
      'searchTerms',
      'parentSku',
      'option1Name',
      'option1Value',
      'option2Name',
      'option2Value',
      'option3Name',
      'option3Value',
      // Gold-rate pricing (B5): 'gold_rate' | blank; karat 24|21|18; grams with up to 2 decimals.
      'pricing_mode',
      'gold_karat',
      'gold_weight_g',
    ];

    const blanks = (n: number) => Array(n).fill('');
    // Prices are exported as EGP decimals ("250.50") — the same unit the import
    // reads — so an exported file re-imports to identical prices. Never raw
    // piastres: that would silently re-import 100x too high.
    const egp = (minor: number | null | undefined) =>
      minor === null || minor === undefined ? '' : minorToDecimalString(minor);

    // Build CSV rows — one base row per product, then one row per variant
    // (parentSku = product.sku) so the export round-trips back through import.
    const rows = products.flatMap(product => {
      const categories = product.categories.map(c => c.category.name).join(',');
      const tags = product.tags.map(t => t.tag.name).join(',');
      const images = product.images.map(i => i.url).join(',');

      const baseRow = [
        product.id,
        csvField(product.name),
        csvField(product.nameAr || ''),
        product.slug,
        csvField(product.description || ''),
        csvField(product.descriptionAr || ''),
        egp(product.price),
        egp(product.compareAtPrice || null),
        egp(product.costPrice || null),
        csvField(product.sku || ''),
        csvField(product.barcode || ''),
        product.inventory,
        product.lowStockThreshold,
        product.trackInventory,
        product.weight || '',
        product.status,
        product.featured,
        product.isNew,
        csvField(categories),
        csvField(tags),
        csvField(images),
        csvField(product.metaTitle || ''),
        csvField(product.metaTitleAr || ''),
        csvField(product.metaDescription || ''),
        csvField(product.metaDescriptionAr || ''),
        csvField(product.searchTerms || ''),
        ...blanks(7), // parentSku + option{1,2,3}Name/Value — empty on base rows
        product.pricingMode === 'gold_rate' ? 'gold_rate' : '',
        product.goldKarat ?? '',
        product.goldWeightMg ? mgToGramsString(product.goldWeightMg) : '',
      ].join(',');

      const variantRows = product.variants.map(variant => {
        // Up to 3 option axes, ordered by the option's position.
        const opts = variant.options
          .map(o => o.value)
          .sort((a, b) => a.option.position - b.option.position)
          .slice(0, 3);
        const optionCols: string[] = [];
        for (let i = 0; i < 3; i++) {
          optionCols.push(
            opts[i] ? csvField(opts[i].option.name) : '',
            opts[i] ? csvField(opts[i].value) : ''
          );
        }
        return [
          '', // id (new variant on re-import)
          ...blanks(5), // name..descriptionAr (inherited from parent)
          egp(variant.price),
          egp(variant.compareAtPrice),
          egp(variant.costPrice),
          csvField(variant.sku || ''),
          csvField(variant.barcode || ''),
          variant.inventory,
          '', // lowStockThreshold
          product.trackInventory,
          variant.weight ?? '',
          product.status,
          '', // featured
          '', // isNew
          '', // categories (inherited)
          '', // tags
          csvField(variant.imageUrl || ''),
          ...blanks(5), // meta fields + searchTerms (inherited)
          csvField(product.sku || ''), // parentSku
          ...optionCols, // option1Name/Value, option2..., option3...
          ...blanks(3), // pricing_mode, gold_karat, gold_weight_g (product-level only)
        ].join(',');
      });

      return [baseRow, ...variantRows];
    });

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Get CSV template for product import
   */
  static getImportTemplate(): string {
    const headers = [
      'name',
      'nameAr',
      'slug',
      'description',
      'descriptionAr',
      'price',
      'compareAtPrice',
      'costPrice',
      'sku',
      'barcode',
      'inventory',
      'lowStockThreshold',
      'trackInventory',
      'weight',
      'status',
      'featured',
      'isNew',
      'categories',
      'tags',
      'images',
      'metaTitle',
      'metaTitleAr',
      'metaDescription',
      'metaDescriptionAr',
      'searchTerms',
      'parentSku',
      'option1Name',
      'option1Value',
      'option2Name',
      'option2Value',
      'option3Name',
      'option3Value',
      // Gold-rate pricing (B5): 'gold_rate' | blank; karat 24|21|18; grams with up to 2 decimals.
      'pricing_mode',
      'gold_karat',
      'gold_weight_g',
    ];

    // Example row
    const exampleRow = [
      'Product Name',
      'اسم المنتج',
      'product-slug',
      'Product description goes here',
      'وصف المنتج هنا',
      '250.50', // price in EGP (two decimals at most)
      '300', // Compare at price in EGP
      '180', // Cost price in EGP
      'SKU-001',
      '1234567890123',
      '100',
      '10',
      'true',
      '0.5',
      'active',
      'false',
      'true',
      '"Category 1,Category 2"',
      '"tag1,tag2"',
      '"https://example.com/image1.jpg,https://example.com/image2.jpg"',
      'SEO Title',
      'عنوان SEO',
      'SEO Description',
      'وصف SEO',
      '"جزمة, كوتشي, 3abaya"', // searchTerms — extra words shoppers type
      '', // parentSku — empty on a base product row
      '', // option1Name
      '', // option1Value
      '',
      '',
      '',
      '',
      '', // pricing_mode (gold_rate or blank)
      '', // gold_karat
      '', // gold_weight_g
    ].join(',');

    // Example VARIANT row: a 1 Kg size of the product above (parentSku = its
    // sku). Name/description/categories are inherited from the parent; the
    // variant carries its own sku/price/barcode/inventory + the option value.
    const exampleVariantRow = [
      '', // name (inherited)
      '', // nameAr
      '', // slug
      '', // description
      '', // descriptionAr
      '275', // variant price in EGP
      '', // compareAtPrice
      '', // costPrice
      'SKU-001-1KG', // variant sku
      '1234567890128', // variant barcode (valid EAN-13 check digit)
      '40', // variant inventory
      '', // lowStockThreshold
      'true', // trackInventory
      '1', // weight
      'active',
      'false',
      'false',
      '', // categories (inherited)
      '', // tags
      '', // images (inherited unless variant has its own)
      '',
      '',
      '',
      '',
      '', // searchTerms (inherited)
      'SKU-001', // parentSku → links to the base product above
      'Size', // option1Name
      '1 Kg', // option1Value
      '',
      '',
      '',
      '',
      '', // pricing_mode (gold_rate or blank)
      '', // gold_karat
      '', // gold_weight_g
    ].join(',');

    return `${headers.join(',')}\n${exampleRow}\n${exampleVariantRow}`;
  }

  /**
   * Import products from CSV data.
   *
   * Batched approach: pre-loads existing products, categories and tags for the
   * store into Maps, collects all create/update operations, then executes them
   * inside a single prisma.$transaction to minimise round-trips (~7500 queries
   * down to ~50 for a 500-row import).
   */
  static async importProducts(
    storeId: string,
    csvData: string,
    options: { updateExisting: boolean } = { updateExisting: true },
    userId?: string
  ): Promise<ImportResult> {
    const result: ImportResult = {
      total: 0,
      created: 0,
      updated: 0,
      failed: 0,
      variantsCreated: 0,
      errors: [],
    };

    // A store on its Durable Object (Ruling IMPORT-DO-1): every read and the category / tag creation go to the DO through
    // the repo, and each batch of Phase 4 is ONE DO section instead of the interactive Postgres transaction. For a
    // Postgres store `db` is `prisma` and nothing below changes.
    const money = await storeMoney(storeId);
    const db = money ? await storeDb(storeId) : prisma;
    const writer = await storeWriter(storeId);

    // Split into records respecting quoted fields that may contain embedded
    // newlines (e.g. a product description with line breaks). A naive
    // split('\n') shatters such records into broken rows.
    // A UTF-8 BOM (Excel "CSV UTF-8") would otherwise glue itself to the first
    // header and the `name` column would silently stop matching.
    const lines = this.splitCsvRecords(
      csvData.charCodeAt(0) === 0xfeff ? csvData.slice(1) : csvData
    ).filter(line => line.trim());
    if (lines.length < 2) {
      throw new AppError(
        400,
        'INVALID_CSV',
        'CSV file must have a header row and at least one data row'
      );
    }

    const headers = this.parseCSVLine(lines[0]);
    const dataRows = lines.slice(1);
    result.total = dataRows.length;

    // ---- Phase 1: Pre-load existing data for fast in-memory lookups ----

    const existingProducts = await db.product.findMany({
      where: { storeId, deletedAt: null },
      select: { id: true, sku: true, slug: true },
    });

    // Maps for O(1) lookups by sku and slug
    const productBySku = new Map<string, { id: string; sku: string | null; slug: string }>();
    const productBySlug = new Map<string, { id: string; sku: string | null; slug: string }>();
    for (const p of existingProducts) {
      if (p.sku) productBySku.set(p.sku, p);
      productBySlug.set(p.slug, p);
    }

    // Ruling B5-13: a gold-rate product's price is the repricer's. A row for one may repeat its
    // CURRENT price (an export edited and re-imported) but never change it or add a compare-at
    // price: that row fails with a clear error and the other rows import.
    const goldPrice = new Map<string, number>();
    for (const g of await db.product.findMany({
      where: { storeId, pricingMode: 'gold_rate', deletedAt: null },
      select: { id: true, price: true },
    }))
      goldPrice.set(g.id, g.price);

    // Pre-load all existing slugs into a Set for fast unique-slug generation
    const existingSlugs = new Set(existingProducts.map(p => p.slug));

    const existingCategories = await db.category.findMany({
      where: { storeId },
      select: { id: true, name: true, slug: true },
    });
    const categoryByName = new Map<string, string>();
    const existingCategorySlugs = new Set<string>();
    for (const c of existingCategories) {
      categoryByName.set(c.name, c.id);
      existingCategorySlugs.add(c.slug);
    }

    const existingTags = await db.tag.findMany({
      where: { storeId },
      select: { id: true, name: true },
    });
    const tagByName = new Map<string, string>();
    for (const t of existingTags) {
      tagByName.set(t.name, t.id);
    }

    // ---- Phase 2: Parse rows and collect operations ----

    // Collect new categories and tags that need to be created
    const newCategoryNames = new Set<string>();
    const newTagNames = new Set<string>();

    // #1029: mirrors `existingSlugs` below, but for SKU. `productBySku` is
    // preloaded from the DB ONCE, before this loop — it never sees a sibling
    // row this same import is about to create. Without tracking SKUs seen
    // so far in THIS import, two rows sharing the same NEW sku both read
    // `existing: null` and both reach the Phase 4 batch insert, which fails
    // the whole batch on the (storeId, sku) unique index (P2002).
    //
    // Keyed sku → the product the row writes it ONTO (an existing id, or a
    // per-row marker for a create). Phase 4 writes `sku` on BOTH branches,
    // so an UPDATE claiming a sku is a collision just like a create is
    // (issue 2048): two rows slug-matched to two different existing products
    // both taking sku X, or an update + a create sharing X, abort the whole
    // withMoneyTx batch. Only the SAME product re-asserting its sku is safe.
    const skuClaimedBy = new Map<string, string>();

    // BARCODE-1: validate every barcode in the file before anything is written, so one bad or
    // duplicate code fails ITS ROW instead of aborting a whole batch on the unique index.
    // `barcodeHeldBy`: code -> product ids that hold it in the DB (a product, or the parent of a
    // variant). `barcodeClaimedBy`: code -> who in THIS file takes it.
    const barcodeHeldBy = new Map<string, Set<string>>();
    const barcodeClaimedBy = new Map<string, string>();
    {
      const wanted = new Set<string>();
      for (const line of dataRows) {
        const raw = this.mapRowToObject(headers, this.parseCSVLine(line)).barcode;
        const parsed = raw ? parseBarcodeInput(String(raw)) : null;
        if (parsed?.ok) wanted.add(parsed.value);
      }
      if (wanted.size > 0) {
        const codes = [...wanted];
        // Serialise with every other barcode writer in this store until the request commits. A store on its Durable Object
        // has no advisory lock (no Postgres): the partial unique barcode indexes refuse a duplicate (Ruling BARCODE-DO-1).
        if (!money)
          await lockStoreBarcodes(
            prisma as unknown as Parameters<typeof lockStoreBarcodes>[0],
            storeId
          );
        const heldProducts = await db.product.findMany({
          where: { storeId, barcode: { in: codes }, deletedAt: null },
          select: { id: true, barcode: true },
        });
        const heldVariants = await db.productVariant.findMany({
          where: { barcode: { in: codes }, product: { storeId, deletedAt: null } },
          select: { productId: true, barcode: true },
        });
        for (const h of [
          ...heldProducts.map(p => ({ id: `p:${p.id}`, barcode: p.barcode })),
          ...heldVariants.map(v => ({ id: `v:${v.productId}`, barcode: v.barcode })),
        ]) {
          if (!h.barcode) continue;
          const set = barcodeHeldBy.get(h.barcode) ?? new Set<string>();
          set.add(h.id);
          barcodeHeldBy.set(h.barcode, set);
        }
      }
    }
    /** Returns the normalised barcode, undefined when blank, or an error message for the row. */
    const checkBarcode = (
      raw: unknown,
      claimant: string,
      /** Who may already hold it: a product row only its own product code, a variant row only
       *  variants of its parent (they are replaced by this import). */
      allowedHolder: string | undefined
    ): { value?: string; error?: string } => {
      const text = raw === undefined || raw === null ? '' : String(raw).trim();
      if (!text) return {};
      const parsed = parseBarcodeInput(text);
      if (!parsed.ok) {
        return {
          error:
            parsed.reason === 'check-digit'
              ? `Barcode "${text}" has a wrong check digit (EAN-13 and UPC-A codes must be exact)`
              : `Barcode "${text}" is not valid (${parsed.reason})`,
        };
      }
      const claimedBy = barcodeClaimedBy.get(parsed.value);
      if (claimedBy !== undefined && claimedBy !== claimant) {
        return { error: `Duplicate barcode "${parsed.value}" within this import` };
      }
      const held = barcodeHeldBy.get(parsed.value);
      if (held && ![...held].every(id => id === allowedHolder)) {
        return {
          error: `Barcode "${parsed.value}" already belongs to another product in this store`,
        };
      }
      barcodeClaimedBy.set(parsed.value, claimant);
      return { value: parsed.value };
    };

    // Parsed row data for Phase 3
    interface ParsedRow {
      rowIndex: number;
      row: ProductImportRow;
      slug: string;
      existing: { id: string; sku: string | null; slug: string } | null;
    }
    const validRows: ParsedRow[] = [];

    // Variant rows (identified by parentSku) grouped under their parent sku.
    // Consumed in Phase 4 as each parent product is created/updated; any
    // leftover groups (parent already in the store) are reconciled after.
    const variantsByParent = new Map<string, VariantImportRow[]>();
    const toFils = (v: unknown): number | undefined => {
      if (v === undefined || v === null || String(v).trim() === '') return undefined;
      const n = parseInt(String(v), 10);
      return Number.isFinite(n) ? n : undefined;
    };

    for (let i = 0; i < dataRows.length; i++) {
      let rowIndex = i + 2; // 1-based, accounting for header
      try {
        const values = this.parseCSVLine(dataRows[i]);
        const row = this.mapRowToObject(headers, values);

        // Converted CSVs (Shopify) carry the row's number in the uploaded file
        // so errors point at what the merchant sees, and rows the converter
        // already rejected are reported here — per row, never aborting the file.
        const sourceRow = Number.parseInt(String(row.sourceRow ?? ''), 10);
        if (Number.isFinite(sourceRow) && sourceRow > 0) rowIndex = sourceRow;
        if (row._error) {
          result.failed++;
          result.errors.push({ row: rowIndex, error: String(row._error) });
          continue;
        }

        // Variant rows are handled separately — they inherit name/desc/etc.
        // from their parent and only contribute option + variant-level data.
        if (classifyRow(row) === 'variant') {
          const parentSku = String(row.parentSku).trim();
          if (!row.option1Name || !row.option1Value) {
            result.failed++;
            result.errors.push({
              row: rowIndex,
              error: 'Variant row requires option1Name and option1Value',
            });
            continue;
          }
          // A fractional/garbled variant price used to fall through toFils() as
          // undefined and silently inherit the parent's price. Fail the row.
          const badVariantAmount = (['price', 'compareAtPrice', 'costPrice'] as const).find(k => {
            const v = row[k];
            return v !== undefined && String(v).trim() !== '' && !/^\d+$/.test(String(v).trim());
          });
          if (badVariantAmount) {
            result.failed++;
            result.errors.push({
              row: rowIndex,
              error: `Variant ${badVariantAmount} "${row[badVariantAmount]}" must be a whole number of piastres (internal format; the upload converter should have produced it)`,
            });
            continue;
          }
          // QA-PRICE-ZERO-1: an explicit variant price of 0 is a free variant (blank inherits the product's price).
          if (
            row.price !== undefined &&
            String(row.price).trim() !== '' &&
            Number(String(row.price).trim()) === 0
          ) {
            result.failed++;
            result.errors.push({
              row: rowIndex,
              error: `${PRICE_REQUIRED_MESSAGE.messageEn} (variant price)`,
            });
            continue;
          }
          const variantBarcode = checkBarcode(
            row.barcode,
            `variant:${parentSku}:${rowIndex}`,
            productBySku.get(parentSku) ? `v:${productBySku.get(parentSku)!.id}` : undefined
          );
          if (variantBarcode.error) {
            result.failed++;
            result.errors.push({ row: rowIndex, error: variantBarcode.error });
            continue;
          }
          const variant: VariantImportRow = {
            parentSku,
            sku: row.sku?.toString().trim() || undefined,
            barcode: variantBarcode.value,
            price: toFils(row.price),
            compareAtPrice: toFils(row.compareAtPrice),
            costPrice: toFils(row.costPrice),
            inventory: toFils(row.inventory),
            weight:
              row.weight !== undefined && String(row.weight).trim() !== ''
                ? parseFloat(String(row.weight))
                : undefined,
            imageUrl: row.images ? String(row.images).split(',')[0].trim() : undefined,
            option1Name: row.option1Name,
            option1Value: row.option1Value,
            option2Name: row.option2Name,
            option2Value: row.option2Value,
            option3Name: row.option3Name,
            option3Value: row.option3Value,
          };
          const list = variantsByParent.get(parentSku) ?? [];
          list.push(variant);
          variantsByParent.set(parentSku, list);
          continue;
        }

        // Validate required fields
        if (!row.name) {
          result.failed++;
          result.errors.push({ row: rowIndex, error: 'Name is required' });
          continue;
        }

        // Integer piastres only: parseInt("12.5") is 12, which would silently
        // store a wrong price. A decimal here is a template mistake — reject it.
        if (row.price === undefined || !/^\d+$/.test(String(row.price).trim())) {
          result.failed++;
          result.errors.push({
            row: rowIndex,
            error:
              'Price is required and must be a whole number of piastres (internal format; the upload converter should have produced it)',
          });
          continue;
        }

        // Search words: over-long raw input is a row error (same 400-not-500
        // contract as the product routes); the stored value is always the
        // cleaned + capped form so the DB CHECK can never fire.
        if (row.searchTerms && String(row.searchTerms).length > SEARCH_TERMS_MAX_LENGTH) {
          result.failed++;
          result.errors.push({
            row: rowIndex,
            error: `Search words must be at most ${SEARCH_TERMS_MAX_LENGTH} characters`,
          });
          continue;
        }

        // Generate slug if not provided
        const baseSlug = row.slug || this.generateSlug(row.name);

        // Check if product exists (by SKU or slug) using pre-loaded Maps
        let existing: { id: string; sku: string | null; slug: string } | null = null;
        if (row.sku) {
          existing = productBySku.get(row.sku) ?? null;
        }
        if (!existing) {
          existing = productBySlug.get(baseSlug) ?? null;
        }

        if (existing && !options.updateExisting) {
          result.failed++;
          result.errors.push({
            row: rowIndex,
            error: `Product with SKU "${row.sku}" or slug "${baseSlug}" already exists`,
          });
          continue;
        }

        if (existing && goldPrice.has(existing.id)) {
          const incoming = parseInt(String(row.price), 10);
          const compare = row.compareAtPrice != null && String(row.compareAtPrice).trim() !== '';
          if (incoming !== goldPrice.get(existing.id) || compare) {
            result.failed++;
            result.errors.push({
              row: rowIndex,
              error: `"${row.name}" is priced by the gold rate: its price (and compare-at price) cannot be changed by import. Edit its karat, weight or making charge instead.`,
            });
            continue;
          }
        }

        // Gold-rate pricing columns (B5): validate before the batch so a bad row fails alone.
        const rowPricingMode = String(row.pricing_mode ?? '')
          .trim()
          .toLowerCase();

        // QA-PRICE-ZERO-1: a row that would leave an ACTIVE product at price 0 fails alone (a draft row may be 0; a gold
        // row is priced by the repricer).
        if (
          isFreeActiveProduct({
            status: String(row.status ?? '').trim() || 'draft',
            price: parseInt(String(row.price), 10),
            pricingMode:
              rowPricingMode === 'gold_rate' || (existing && goldPrice.has(existing.id))
                ? 'gold_rate'
                : 'fixed',
          })
        ) {
          result.failed++;
          result.errors.push({ row: rowIndex, error: PRICE_REQUIRED_MESSAGE.messageEn });
          continue;
        }
        if (rowPricingMode !== '' && rowPricingMode !== 'gold_rate' && rowPricingMode !== 'fixed') {
          result.failed++;
          result.errors.push({
            row: rowIndex,
            error: `pricing_mode must be "gold_rate", "fixed" or blank (got "${rowPricingMode}")`,
          });
          continue;
        }
        if (rowPricingMode === 'gold_rate') {
          const k = Number(String(row.gold_karat ?? '').trim());
          const mg = parseGramsToMg(String(row.gold_weight_g ?? ''));
          if (!(GOLD_KARATS as readonly number[]).includes(k) || mg === null) {
            result.failed++;
            result.errors.push({
              row: rowIndex,
              error: `"${row.name}": gold_karat must be 24, 21 or 18 and gold_weight_g a weight in grams with up to 2 decimals`,
            });
            continue;
          }
        }

        // #1029 / issue 2048: a row claiming a SKU an earlier row in this
        // same import already claimed for a DIFFERENT product — fail this row
        // instead of letting both reach the batch write. Two rows updating the
        // same existing product to the same SKU are not a collision.
        if (row.sku) {
          const target = existing?.id ?? `new:${rowIndex}`;
          const claimedBy = skuClaimedBy.get(row.sku);
          if (claimedBy !== undefined && claimedBy !== target) {
            result.failed++;
            result.errors.push({
              row: rowIndex,
              error: `Duplicate SKU "${row.sku}" within this import`,
            });
            continue;
          }
          skuClaimedBy.set(row.sku, target);
        }

        if (row.barcode) {
          const checked = checkBarcode(
            row.barcode,
            existing?.id ?? `new:${rowIndex}`,
            existing?.id
          );
          if (checked.error) {
            result.failed++;
            result.errors.push({ row: rowIndex, error: checked.error });
            continue;
          }
          row.barcode = checked.value;
        }

        // Ensure unique slug using the in-memory Set (avoid DB round-trip)
        let uniqueSlug = baseSlug;
        if (!existing || existing.slug !== baseSlug) {
          let counter = 1;
          while (existingSlugs.has(uniqueSlug)) {
            if (counter > 100) throw new Error('Too many slug collisions');
            uniqueSlug = `${baseSlug}-${counter}`;
            counter++;
          }
          existingSlugs.add(uniqueSlug);
        } else {
          // Updating existing product -- keep its current slug
          uniqueSlug = existing.slug;
        }

        validRows.push({ rowIndex, row, slug: uniqueSlug, existing });

        // Collect category/tag names that don't exist yet
        if (row.categories) {
          const names = String(row.categories)
            .split(',')
            .map(c => c.trim())
            .filter(Boolean);
          for (const name of names) {
            if (!categoryByName.has(name)) newCategoryNames.add(name);
          }
        }
        if (row.tags) {
          const names = String(row.tags)
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);
          for (const name of names) {
            if (!tagByName.has(name)) newTagNames.add(name);
          }
        }
      } catch (error) {
        result.failed++;
        result.errors.push({
          row: rowIndex,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // ---- Phase 2.5: drop variant rows a bundle would block ----
    //
    // P1-4 (final review). Re-importing a product's variants is
    // replace-semantics: `createVariantsForProductTx` deletes the existing
    // variant rows first. `bundle_items.variant_id` is ON DELETE RESTRICT, so
    // if a bundle pins one of them Postgres raises P2003 INSIDE the batch
    // transaction — the batch rolls back and every unrelated product in the
    // same CSV is lost with it, reported as the global handler's generic "A
    // referenced record does not exist". Detect it here instead, before any
    // write, and skip only the affected parent's variant rows: its own
    // product row and every other row in the file still import.
    const parentIdBySku = new Map<string, string>();
    for (const parentSku of variantsByParent.keys()) {
      const existingParent = productBySku.get(parentSku);
      if (existingParent) parentIdBySku.set(parentSku, existingParent.id);
    }
    // #1560: `productBySku` is keyed by the DB's CURRENT sku for each
    // existing product — it misses a parent row that Phase 2 matched via
    // SLUG instead (existing product, sku changing/being added in this same
    // import). `validRows` already resolved SKU-or-slug per row, so trust
    // that resolution too: any row whose own sku is a parentSku this file's
    // variant rows reference, and that Phase 2 matched to a real existing
    // product, is a parent this bundle-pinned-variant check must not miss.
    for (const parsed of validRows) {
      const rowSku = parsed.row.sku?.toString().trim();
      if (rowSku && parsed.existing && variantsByParent.has(rowSku)) {
        parentIdBySku.set(rowSku, parsed.existing.id);
      }
    }
    if (parentIdBySku.size > 0) {
      const pinned = await db.bundleItem.findMany({
        where: { productId: { in: [...parentIdBySku.values()] }, variantId: { not: null } },
        select: { productId: true, bundle: { select: { name: true } } },
      });
      for (const skip of planBundlePinnedVariantSkips(parentIdBySku, pinned)) {
        const skipped = variantsByParent.get(skip.parentSku) ?? [];
        variantsByParent.delete(skip.parentSku);
        result.failed += skipped.length;
        result.errors.push({ row: 0, error: skip.message });
      }
    }

    // ---- Phase 2.9: plan ceiling for the WHOLE batch (SP5) ----
    // Counted once, here, BEFORE Phase 3 writes anything (categories, tags) and
    // before any product row: an over-limit import is rejected whole with a 402
    // rather than creating the first N rows and failing the rest. Only rows
    // that CREATE a product count; updates of existing products do not.
    const newProductCount = validRows.filter(r => !r.existing).length;
    if (newProductCount > 0) {
      await assertWithinLimit(storeId, 'maxProducts', { delta: newProductCount });
    }

    // ---- Phase 3: Batch-create new categories and tags ----

    // Track the IDs of categories/tags this run created so we can clean
    // up orphans at the end. Phase 3 runs OUTSIDE the per-batch product
    // transaction (it has to — categories/tags are referenced by every
    // batch), so a Phase-4 batch failure used to leave dangling rows
    // with no products attached. We collect the new IDs here and prune
    // any that never got linked at the bottom of the function.
    const createdCategoryIds = new Set<string>();
    const createdTagIds = new Set<string>();

    if (newCategoryNames.size > 0) {
      // Generate unique slugs for new categories using the in-memory set
      const categoryData: Array<{ storeId: string; name: string; slug: string }> = [];
      for (const name of newCategoryNames) {
        let slug = this.generateSlug(name);
        let counter = 1;
        while (existingCategorySlugs.has(slug)) {
          if (counter > 100) throw new Error('Too many category slug collisions');
          slug = `${this.generateSlug(name)}-${counter}`;
          counter++;
        }
        existingCategorySlugs.add(slug);
        categoryData.push({ storeId, name, slug });
      }

      await writer.category.createMany({ data: categoryData, skipDuplicates: true });

      // Re-fetch to get generated IDs
      const newCats = await db.category.findMany({
        where: { storeId, name: { in: [...newCategoryNames] } },
        select: { id: true, name: true },
      });
      for (const c of newCats) {
        categoryByName.set(c.name, c.id);
        createdCategoryIds.add(c.id);
      }
    }

    if (newTagNames.size > 0) {
      const tagData = [...newTagNames].map(name => ({ storeId, name }));
      await writer.tag.createMany({ data: tagData, skipDuplicates: true });

      // Re-fetch to get generated IDs
      const newTags = await db.tag.findMany({
        where: { storeId, name: { in: [...newTagNames] } },
        select: { id: true, name: true },
      });
      for (const t of newTags) {
        tagByName.set(t.name, t.id);
        createdTagIds.add(t.id);
      }
    }

    // ---- Phase 4: Batch create/update products inside a transaction ----
    // Process in batches to avoid overly large transactions
    const BATCH_SIZE = 50;

    for (let batchStart = 0; batchStart < validRows.length; batchStart += BATCH_SIZE) {
      const batch = validRows.slice(batchStart, batchStart + BATCH_SIZE);
      // Variants created in this batch — only folded into the result after the
      // transaction commits, so a rollback doesn't leave a phantom count.
      let batchVariants = 0;
      // Gold specs to apply once the batch commits: the gold service runs its own money transaction.
      const goldApply: Array<{
        rowIndex: number;
        productId: string;
        mode: 'gold_rate' | 'fixed';
        karat: GoldKarat;
        weightMg: number | null;
      }> = [];

      try {
        if (money) {
          // ONE Durable Object section for the whole batch (Ruling IMPORT-DO-1): products, stock, links and variants commit
          // together or not at all, like the interactive transaction below. Optimistic counts are undone by the catch.
          const plan = batch.map(({ rowIndex, row, slug, existing }) => {
            const productFields = buildProductFields(row, slug, existing);
            const names = (v: unknown) =>
              String(v)
                .split(',')
                .map(c => c.trim())
                .filter(Boolean);
            const sku = productFields.sku;
            if (existing) result.updated++;
            else result.created++;
            return {
              rowIndex,
              existingId: existing?.id ?? null,
              existingSlug: existing?.slug ?? null,
              slug,
              fields: productFields as Record<string, unknown>,
              imported: importedAiValues(productFields as Record<string, unknown>),
              categoryIds: row.categories
                ? names(row.categories)
                    .map(n => categoryByName.get(n))
                    .filter((id): id is string => !!id)
                : null,
              tagIds: row.tags
                ? names(row.tags)
                    .map(n => tagByName.get(n))
                    .filter((id): id is string => !!id)
                : null,
              imageUrls: row.images ? names(row.images) : null,
              variants: sku && variantsByParent.has(sku) ? variantsByParent.get(sku)! : null,
            };
          });
          const applied = await money.importBatch({
            rows: plan,
            aiFields: [...AI_AUTOFILL_FIELD_NAMES],
            userId: userId ?? null,
          });
          for (const p of plan) if (p.variants) variantsByParent.delete(String(p.fields.sku));
          batchVariants += applied.variantsCreated;
          const productIdByRow = new Map(applied.products.map(p => [p.rowIndex, p.productId]));
          for (const { rowIndex, row } of batch) {
            const goldMode = String(row.pricing_mode ?? '')
              .trim()
              .toLowerCase();
            const existing = batch.find(b => b.rowIndex === rowIndex)!.existing;
            if (goldMode === 'gold_rate' || (goldMode === 'fixed' && existing)) {
              goldApply.push({
                rowIndex,
                productId: productIdByRow.get(rowIndex)!,
                mode: goldMode,
                karat: Number(String(row.gold_karat ?? '').trim()) as GoldKarat,
                weightMg: parseGramsToMg(String(row.gold_weight_g ?? '')),
              });
            }
          }
          // slug redirects are platform data (D1/Postgres): recorded after the commit, idempotent, never fail the import
          for (const r of applied.renames) {
            try {
              await recordSlugRedirect(prisma, storeId, SlugEntityType.PRODUCT, r.from, r.to);
            } catch (err) {
              logger.error(
                { err, storeId, fromSlug: r.from },
                '[IMPORT] slug redirect not recorded'
              );
            }
          }
        } else
          await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
            for (const { rowIndex, row, slug, existing } of batch) {
              try {
                const productFields = buildProductFields(row, slug, existing);

                let productId: string;

                const imported = importedAiValues(productFields as Record<string, unknown>);

                if (existing) {
                  // Update existing product
                  const current = (await tx.product.findUnique({
                    where: { id: existing.id, storeId },
                    select: { ...AI_PROVENANCE_SELECT, inventory: true },
                  })) as Record<string, unknown> | null;
                  await tx.product.update({
                    where: { id: existing.id, storeId },
                    data: {
                      ...productFields,
                      aiFieldSources: stampHumanEdits(
                        (current?.aiFieldSources as Record<string, 'ai' | 'human'>) ?? {},
                        current ?? {},
                        imported
                      ),
                    },
                  });
                  productId = existing.id;
                  result.updated++;
                  // INV-AUDIT-3: an import UPDATE that changes stock is a movement (the DO import writes the same row)
                  const prevStock = (current?.inventory as number | undefined) ?? 0;
                  if (prevStock !== productFields.inventory)
                    await tx.inventoryHistory.create({
                      data: {
                        productId,
                        storeId,
                        type: 'adjustment',
                        quantity: productFields.inventory - prevStock,
                        previousStock: prevStock,
                        newStock: productFields.inventory,
                        reason: 'Stock set by bulk import',
                        createdBy: userId ?? null,
                      },
                    });

                  // The incoming row's slug may differ from the product's current
                  // one (e.g. a re-export from a source system with a different
                  // handle) -- Phase 2 already decided to write it, so this is a
                  // live rename exactly like a manual edit. Record old -> new so
                  // the previously-indexed handle 301s instead of 404ing.
                  if (existing.slug !== slug) {
                    await recordSlugRedirect(
                      tx,
                      storeId,
                      SlugEntityType.PRODUCT,
                      existing.slug,
                      slug
                    );
                  }
                } else {
                  // Create new product
                  const created = await tx.product.create({
                    data: {
                      store: { connect: { id: storeId } },
                      ...productFields,
                      aiFieldSources: stampHumanEdits({}, {}, imported),
                    },
                  });
                  productId = created.id;

                  // Create inventory history entry for initial stock
                  if (productFields.inventory > 0) {
                    await tx.inventoryHistory.create({
                      data: {
                        productId,
                        storeId,
                        type: 'initial',
                        quantity: productFields.inventory,
                        previousStock: 0,
                        newStock: productFields.inventory,
                        reason: 'Initial stock from bulk import',
                        createdBy: userId,
                      },
                    });
                  }

                  result.created++;
                }

                // Handle categories: delete existing links, then bulk create new ones
                if (row.categories) {
                  const categoryNames = String(row.categories)
                    .split(',')
                    .map(c => c.trim())
                    .filter(Boolean);

                  await tx.productCategory.deleteMany({ where: { productId } });

                  const categoryLinks = categoryNames
                    .map(name => {
                      const categoryId = categoryByName.get(name);
                      return categoryId ? { productId, categoryId } : null;
                    })
                    .filter(
                      (link): link is { productId: string; categoryId: string } => link !== null
                    );

                  if (categoryLinks.length > 0) {
                    await tx.productCategory.createMany({
                      data: categoryLinks,
                      skipDuplicates: true,
                    });
                  }
                }

                // Handle tags: delete existing links, then bulk create new ones
                if (row.tags) {
                  const tagNames = String(row.tags)
                    .split(',')
                    .map(t => t.trim())
                    .filter(Boolean);

                  await tx.productTag.deleteMany({ where: { productId } });

                  const tagLinks = tagNames
                    .map(name => {
                      const tagId = tagByName.get(name);
                      return tagId ? { productId, tagId } : null;
                    })
                    .filter((link): link is { productId: string; tagId: string } => link !== null);

                  if (tagLinks.length > 0) {
                    await tx.productTag.createMany({ data: tagLinks, skipDuplicates: true });
                  }
                }

                // Handle images: delete existing, then bulk create new ones
                if (row.images) {
                  const imageUrls = String(row.images)
                    .split(',')
                    .map(u => u.trim())
                    .filter(Boolean);

                  await tx.productImage.deleteMany({ where: { productId } });

                  if (imageUrls.length > 0) {
                    await tx.productImage.createMany({
                      data: imageUrls.map((url, position) => ({ productId, url, position })),
                    });
                  }
                }

                // Attach any variant rows that referenced this product's sku.
                // Created in the SAME transaction so a batch rollback also
                // rolls back the variants.
                if (productFields.sku && variantsByParent.has(productFields.sku)) {
                  const made = await createVariantsForProductTx(
                    tx,
                    storeId,
                    productId,
                    variantsByParent.get(productFields.sku)!,
                    userId
                  );
                  batchVariants += made;
                  variantsByParent.delete(productFields.sku); // mark consumed
                }
                const goldMode = String(row.pricing_mode ?? '')
                  .trim()
                  .toLowerCase();
                if (goldMode === 'gold_rate' || (goldMode === 'fixed' && existing)) {
                  goldApply.push({
                    rowIndex,
                    productId,
                    mode: goldMode,
                    karat: Number(String(row.gold_karat ?? '').trim()) as GoldKarat,
                    weightMg: parseGramsToMg(String(row.gold_weight_g ?? '')),
                  });
                }
              } catch (error) {
                // Re-throw to roll back the batch transaction; per-row errors
                // are only possible for validation issues caught in Phase 2.
                throw Object.assign(error instanceof Error ? error : new Error('Unknown error'), {
                  __rowIndex: rowIndex,
                });
              }
            }
          });
        // Transaction committed — safe to count this batch's variants.
        result.variantsCreated += batchVariants;
        for (const g of goldApply) {
          if (!userId) {
            result.errors.push({
              row: g.rowIndex,
              error: 'Imported, but gold pricing needs a signed-in user and was not applied',
            });
            continue;
          }
          try {
            if (g.mode === 'fixed') {
              await GoldRateService.setProductPricing(
                storeId,
                g.productId,
                { product: { pricingMode: 'fixed' } },
                { userId }
              );
              continue;
            }
            // Keep the making charge and margin a gold product already has; a new one starts at none.
            const cur = await db.product.findFirst({
              where: { id: g.productId, storeId },
              select: { makingChargeType: true, makingChargeValue: true, goldMarginBps: true },
            });
            await GoldRateService.setProductPricing(
              storeId,
              g.productId,
              {
                product: {
                  pricingMode: 'gold_rate',
                  karat: g.karat,
                  weightMg: g.weightMg,
                  makingChargeType:
                    (cur?.makingChargeType as 'fixed' | 'per_gram' | null) ?? 'per_gram',
                  makingChargeValue: cur?.makingChargeValue ?? 0,
                  marginBps: cur?.goldMarginBps ?? 0,
                },
              },
              { userId }
            );
          } catch (e) {
            result.errors.push({
              row: g.rowIndex,
              error: `Imported, but gold pricing was not applied: ${e instanceof Error ? e.message : 'unknown error'}`,
            });
          }
        }
      } catch (error) {
        // If the batch transaction fails, mark all rows in the batch as failed
        const doRow = error instanceof Error ? /^row (\d+): ([\s\S]*)$/.exec(error.message) : null;
        const rowIndex = doRow
          ? Number(doRow[1])
          : error && typeof error === 'object' && '__rowIndex' in error
            ? (error as { __rowIndex: number }).__rowIndex
            : batch[0].rowIndex;
        const message = doRow ? doRow[2] : error instanceof Error ? error.message : 'Unknown error';

        // Undo optimistic counts from within the rolled-back transaction
        for (const item of batch) {
          // Reset any counts that were incremented inside the transaction
          if (item.existing) {
            if (result.updated > 0) result.updated--;
          } else {
            if (result.created > 0) result.created--;
          }
          result.failed++;
          result.errors.push({
            row: item.rowIndex,
            error:
              item.rowIndex === rowIndex
                ? message
                : `Rolled back (batch failure at row ${rowIndex})`,
          });
        }
      }
    }

    // Reconcile variant groups whose parent product was NOT in this file but
    // already exists in the store. Each runs in its own transaction.
    for (const [parentSku, variants] of variantsByParent.entries()) {
      const existing = productBySku.get(parentSku);
      if (!existing) {
        result.failed += variants.length;
        result.errors.push({
          row: 0,
          error: `Variant parent sku not found in file or store: ${parentSku}`,
        });
        continue;
      }
      try {
        if (money) {
          const r = await money.importVariants({
            productId: existing.id,
            variants,
            userId: userId ?? null,
          });
          result.variantsCreated += r.variantsCreated;
        } else
          await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
            const made = await createVariantsForProductTx(
              tx,
              storeId,
              existing.id,
              variants,
              userId
            );
            result.variantsCreated += made;
          });
      } catch (error) {
        result.failed += variants.length;
        result.errors.push({
          row: 0,
          error: `Failed to create variants for ${parentSku}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        });
      }
    }

    // Orphan cleanup. Any category/tag this run created that didn't
    // end up linked to a product is dead weight (the rows referencing
    // it failed and rolled back). Delete the unreferenced ones — leaves
    // categories/tags that another product happens to use intact.
    if (createdCategoryIds.size > 0) {
      const referenced = await db.productCategory.findMany({
        where: { categoryId: { in: [...createdCategoryIds] } },
        select: { categoryId: true },
      });
      const referencedIds = new Set(referenced.map(r => r.categoryId));
      const orphanIds = [...createdCategoryIds].filter(id => !referencedIds.has(id));
      if (orphanIds.length > 0) {
        await writer.category.deleteMany({
          where: { id: { in: orphanIds }, storeId },
        });
      }
    }

    if (createdTagIds.size > 0) {
      const referenced = await db.productTag.findMany({
        where: { tagId: { in: [...createdTagIds] } },
        select: { tagId: true },
      });
      const referencedIds = new Set(referenced.map(r => r.tagId));
      const orphanIds = [...createdTagIds].filter(id => !referencedIds.has(id));
      if (orphanIds.length > 0) {
        await writer.tag.deleteMany({
          where: { id: { in: orphanIds }, storeId },
        });
      }
    }

    // Imported rows changed product text: ask the search indexer to look at this store once
    // (Task 11). Each batch above already committed; inside a request this waits for its COMMIT.
    if (result.created + result.updated > 0) await requestStoreReindex(storeId, 'bulk-import');

    // BARCODE-1: rows imported without a barcode get one (inventory.barcode stores only).
    // (a DO store allocates in one DO section, Ruling BARCODE-DO-1)
    if (result.created + result.updated > 0) await fillMissingAfterImport(storeId);

    return result;
  }

  /**
   * Bulk delete products
   */
  static async bulkDelete(
    storeId: string,
    productIds: string[],
    permanent: boolean = false
  ): Promise<{ deleted: number; failed: number; errors: string[] }> {
    if (productIds.length === 0) {
      return { deleted: 0, failed: 0, errors: [] };
    }

    if (permanent) {
      // Hard delete: remove rows that belong to this store in one query.
      // `products.id` is now referenced by `bundle_items.product_id`
      // (ON DELETE RESTRICT, final-review I1) — if ANY id in this batch is
      // pinned by a bundle, Postgres raises P2003 and the single deleteMany
      // fails as a whole, taking down products that were never bundled with
      // it. Fall back to one delete per id ONLY on that specific failure, so
      // the common case (no bundle-pinned products) stays a single query.
      try {
        const result = await (
          await storeWriter(storeId)
        ).product.deleteMany({
          where: { id: { in: productIds }, storeId },
        });
        return { deleted: result.count, failed: productIds.length - result.count, errors: [] };
      } catch (err) {
        if (bundleFkViolationKind(err) !== 'product') {
          throw err;
        }
        let deleted = 0;
        const errors: string[] = [];
        for (const id of productIds) {
          try {
            const r = await (
              await storeWriter(storeId)
            ).product.deleteMany({ where: { id, storeId } });
            deleted += r.count;
          } catch (innerErr) {
            if (bundleFkViolationKind(innerErr) === 'product') {
              errors.push(
                `Product ${id} is used in a bundle and cannot be permanently deleted. Remove it from the bundle first.`
              );
            } else {
              throw innerErr;
            }
          }
        }
        return { deleted, failed: productIds.length - deleted, errors };
      }
    }

    // Soft delete: stamp deletedAt on all matching rows in one query
    const result = await (
      await storeWriter(storeId)
    ).product.updateMany({
      where: { id: { in: productIds }, storeId },
      data: { deletedAt: new Date() },
    });
    // Deleted products leave the search index (vectors pruned; review M5). A hard delete cascades.
    if (result.count > 0) await requestStoreReindex(storeId, 'bulk-delete');

    return { deleted: result.count, failed: productIds.length - result.count, errors: [] };
  }

  /**
   * Bulk update product status
   */
  static async bulkUpdateStatus(
    storeId: string,
    productIds: string[],
    status: ProductStatus
  ): Promise<{ updated: number; failed: number; errors: string[] }> {
    if (productIds.length === 0) {
      return { updated: 0, failed: 0, errors: [] };
    }

    // QA-PRICE-ZERO-1: activating a product that would be orderable for free is refused for THAT product (it stays as it
    // was); the rest of the batch goes through. Variant products are judged on their variants, gold on the repricer.
    const refused: string[] = [];
    let allowedIds = productIds;
    if (status === 'active') {
      const rows = await (
        await storeWriter(storeId)
      ).product.findMany({
        where: { id: { in: productIds }, storeId, deletedAt: null },
        select: {
          id: true,
          name: true,
          price: true,
          pricingMode: true,
          _count: { select: { variants: true } },
        },
      });
      const free = rows.filter(r =>
        isFreeActiveProduct({
          status: 'active',
          price: r.price,
          pricingMode: r.pricingMode,
          hasVariants: r._count.variants > 0,
        })
      );
      for (const r of free) refused.push(`${r.name}: ${PRICE_REQUIRED_MESSAGE.messageEn}`);
      const freeIds = new Set(free.map(r => r.id));
      allowedIds = productIds.filter(id => !freeIds.has(id));
      if (allowedIds.length === 0) {
        return { updated: 0, failed: productIds.length, errors: refused };
      }
    }

    // Update all matching rows for this store in one query
    const result = await (
      await storeWriter(storeId)
    ).product.updateMany({
      where: { id: { in: allowedIds }, storeId, deletedAt: null },
      data: { status },
    });
    // Only active products are indexed: publish adds vectors, unpublish removes them (review M5).
    if (result.count > 0) await requestStoreReindex(storeId, 'bulk-status');

    return {
      updated: result.count,
      failed: productIds.length - result.count,
      errors: refused,
    };
  }

  // Helper methods
  // CSV field escaping (formula-injection safe) uses the shared `csvField` from
  // @ebda/shared — single canonical implementation across every exporter.

  /**
   * Split raw CSV text into records, honoring quoted fields that may span
   * multiple lines. Splitting only happens on newlines encountered OUTSIDE a
   * quoted field. Doubled quotes ("") inside a field are preserved for
   * parseCSVLine to collapse. Handles both \n and \r\n line endings.
   */
  static splitCsvRecords(csvData: string): string[] {
    const records: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < csvData.length; i++) {
      const char = csvData[i];

      if (char === '"') {
        if (inQuotes && csvData[i + 1] === '"') {
          current += '""'; // escaped quote inside a field
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        current += char;
      } else if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && csvData[i + 1] === '\n') i++; // CRLF → one boundary
        records.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    if (current.length > 0) records.push(current);
    return records;
  }

  private static parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"' && !inQuotes) {
        inQuotes = true;
      } else if (char === '"' && inQuotes) {
        if (nextChar === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = false;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  }

  private static mapRowToObject(headers: string[], values: string[]): ProductImportRow {
    const obj: Record<string, string | undefined> = {};
    headers.forEach((header, index) => {
      obj[header.trim()] = values[index]?.trim() || undefined;
    });
    return obj as unknown as ProductImportRow;
  }

  /**
   * Delegates to the shared helper rather than keeping a private copy.
   *
   * This charset (ASCII + the Arabic block, with a non-empty fallback) was
   * always the correct one — it is why importing a product produced a good slug
   * while creating the same product in the admin produced '-1'. Keeping a
   * fifth private implementation is what let the two drift apart, so the copy
   * is gone and the shared helper is the single definition.
   */
  private static generateSlug(name: string): string {
    return slugifyWithFallback(name, 'product');
  }

  // Note: ensureUniqueSlug, updateProductCategories, updateProductTags,
  // updateProductImages, and ensureUniqueCategorySlug were removed in DB-002
  // refactor -- their logic is now handled inline in importProducts via
  // pre-loaded Maps and batched createMany calls.
}
