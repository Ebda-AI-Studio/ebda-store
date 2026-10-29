import { prisma, Prisma, withMoneyTx } from '@ebda/database';
import { GoldRateService } from './gold-rate/gold-rate.service';
import { assertBarcodeAvailable, ensureBarcode, parseBarcodeOrThrow } from './barcode.service';
import { AppError } from '../middleware/error-handler';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import logger from '../lib/logger';
import { deleteR2ObjectIfOrphan } from './r2-cleanup.service';
import { throwIfBundleFkViolation } from '../lib/bundle-fk-errors';
import { withSavepoint } from '../lib/savepoint';
import { storeWriter } from '../lib/repo-factory';

interface CreateOptionInput {
  name: string;
  nameAr?: string;
  values: Array<{
    value: string;
    valueAr?: string;
    swatchHex?: string | null;
    swatchImageUrl?: string | null;
  }>;
}

interface CreateVariantInput {
  sku?: string;
  barcode?: string;
  price?: number;
  compareAtPrice?: number;
  costPrice?: number;
  inventory?: number;
  weight?: number;
  // Optional + nullable: the admin form posts `null` to clear an existing
  // image (the create call doesn't really hit that branch since variants
  // are created from the generate-all flow, but Zod is parsed as
  // `nullable().optional()` so the type must accept null too).
  imageUrl?: string | null;
  optionValueIds: string[];
}

interface UpdateVariantInput {
  sku?: string | null;
  barcode?: string | null;
  price?: number | null;
  compareAtPrice?: number | null;
  costPrice?: number | null;
  inventory?: number;
  weight?: number | null;
  imageUrl?: string | null;
  isActive?: boolean;
}

export class VariantService {
  /**
   * Get product with options and variants
   */
  static async getProductVariants(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: {
        options: {
          orderBy: { position: 'asc' },
          include: {
            values: {
              orderBy: { position: 'asc' },
            },
          },
        },
        variants: {
          orderBy: { position: 'asc' },
          include: {
            options: {
              include: {
                value: {
                  include: {
                    option: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    return {
      product: {
        id: product.id,
        name: product.name,
        nameAr: product.nameAr,
        // Parent SKU surfaced so the admin variant editor can auto-fill
        // a per-variant SKU as `<parentSku>-<variant identifier>` when
        // the merchant doesn't set one explicitly. Cuts down the number
        // of fields the merchant has to type per variant from 7 → 6.
        sku: product.sku,
        price: product.price,
        hasVariants: product.hasVariants,
        inventory: product.inventory,
      },
      options: product.options,
      variants: product.variants.map(v => ({
        ...v,
        optionValues: v.options.map(o => ({
          optionId: o.value.option.id,
          optionName: o.value.option.name,
          optionNameAr: o.value.option.nameAr,
          valueId: o.value.id,
          value: o.value.value,
          valueAr: o.value.valueAr,
        })),
      })),
    };
  }

  /**
   * Add option to a product
   */
  static async addOption(storeId: string, productId: string, input: CreateOptionInput) {
    const w = await storeWriter(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-WRITES-1)
    // Verify product exists
    const product = await w.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: { options: true },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Check max options (typically 3)
    if (product.options.length >= 3) {
      throw new AppError(400, 'MAX_OPTIONS_REACHED', 'Products can have a maximum of 3 options');
    }

    // Check for duplicate option name
    const existingOption = await w.productOption.findFirst({
      where: { productId, name: input.name },
    });

    if (existingOption) {
      throw new AppError(400, 'DUPLICATE_OPTION', `Option "${input.name}" already exists`);
    }

    // Create option with values
    const option = await w.productOption.create({
      data: {
        productId,
        name: input.name,
        nameAr: input.nameAr,
        position: product.options.length,
        values: {
          create: input.values.map((v, index) => ({
            value: v.value,
            valueAr: v.valueAr,
            swatchHex: v.swatchHex,
            swatchImageUrl: v.swatchImageUrl,
            position: index,
          })),
        },
      },
      include: {
        values: { orderBy: { position: 'asc' } },
      },
    });

    // Mark product as having variants if it's the first option
    if (!product.hasVariants) {
      await w.product.update({
        where: { id: productId, storeId },
        data: { hasVariants: true },
      });
    }

    // Public PDP/list payloads are cached and now carry option values.
    await invalidateStoreProductCaches(storeId);

    return option;
  }

  /**
   * Update option
   */
  static async updateOption(
    storeId: string,
    productId: string,
    optionId: string,
    input: { name?: string; nameAr?: string | null }
  ) {
    const w = await storeWriter(storeId);
    const option = await w.productOption.findFirst({
      where: {
        id: optionId,
        product: { id: productId, storeId, deletedAt: null },
      },
    });

    if (!option) {
      throw new AppError(404, 'NOT_FOUND', 'Option not found');
    }

    return w.productOption.update({
      where: { id: optionId },
      data: {
        name: input.name,
        nameAr: input.nameAr,
      },
      include: {
        values: { orderBy: { position: 'asc' } },
      },
    });
  }

  /**
   * Delete option (and all associated variants)
   */
  static async deleteOption(storeId: string, productId: string, optionId: string) {
    const option = await prisma.productOption.findFirst({
      where: {
        id: optionId,
        product: { id: productId, storeId, deletedAt: null },
      },
      include: { product: { include: { options: true } } },
    });

    if (!option) {
      throw new AppError(404, 'NOT_FOUND', 'Option not found');
    }

    // Capture imageUrls BEFORE the transaction deletes the rows so we
    // can clean up R2 after the commit. Variants are hard-deleted (no
    // soft-delete), so the image is genuinely orphaned once deleteMany
    // runs. We collect outside the tx so the select is a plain read
    // and doesn't enlarge the transaction window.
    const variantsToDelete = await prisma.productVariant.findMany({
      where: { productId },
      select: { imageUrl: true },
    });

    try {
      await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
        // Delete all variants since they depend on options
        await tx.productVariant.deleteMany({ where: { productId } });

        // Delete option (cascade will delete values and variant option junctions)
        await tx.productOption.delete({ where: { id: optionId } });

        // If no more options, mark product as not having variants
        if (option.product.options.length <= 1) {
          await tx.product.update({
            where: { id: productId, storeId },
            data: { hasVariants: false },
          });
        }
      });
    } catch (err) {
      // Deleting an option takes ALL its variants with it in one deleteMany
      // — if any one of them is pinned by a bundle_items row, the whole
      // transaction rolls back (RESTRICT). This is inherently all-or-nothing
      // (an option's variants form one set), so the actionable error names
      // the option deletion as blocked rather than attempting a partial
      // per-variant retry.
      throwIfBundleFkViolation(err);
      throw err;
    }

    // Cached public payloads list this option's values (ids + swatches).
    await invalidateStoreProductCaches(storeId);

    // Fire-and-forget R2 cleanup after the commit — same pattern as
    // updateVariant / deleteVariant above.
    for (const v of variantsToDelete) {
      if (v.imageUrl) {
        void deleteR2ObjectIfOrphan(v.imageUrl).catch(err =>
          logger.warn({ err, productId, optionId }, '[variant.deleteOption] r2 cleanup failed')
        );
      }
    }
  }

  /**
   * Add value to an option
   */
  static async addOptionValue(
    storeId: string,
    productId: string,
    optionId: string,
    input: {
      value: string;
      valueAr?: string;
      swatchHex?: string | null;
      swatchImageUrl?: string | null;
    }
  ) {
    const option = await prisma.productOption.findFirst({
      where: {
        id: optionId,
        product: { id: productId, storeId, deletedAt: null },
      },
      include: { values: true },
    });

    if (!option) {
      throw new AppError(404, 'NOT_FOUND', 'Option not found');
    }

    // Check for duplicate value
    const existingValue = option.values.find(v => v.value === input.value);
    if (existingValue) {
      throw new AppError(400, 'DUPLICATE_VALUE', `Value "${input.value}" already exists`);
    }

    const created = await prisma.productOptionValue.create({
      data: {
        optionId,
        value: input.value,
        valueAr: input.valueAr,
        swatchHex: input.swatchHex,
        swatchImageUrl: input.swatchImageUrl,
        position: option.values.length,
      },
    });
    await invalidateStoreProductCaches(storeId);
    return created;
  }

  /**
   * Update option value
   */
  static async updateOptionValue(
    storeId: string,
    productId: string,
    valueId: string,
    input: {
      value?: string;
      valueAr?: string | null;
      swatchHex?: string | null;
      swatchImageUrl?: string | null;
    }
  ) {
    const optionValue = await prisma.productOptionValue.findFirst({
      where: {
        id: valueId,
        option: {
          product: { id: productId, storeId, deletedAt: null },
        },
      },
    });

    if (!optionValue) {
      throw new AppError(404, 'NOT_FOUND', 'Option value not found');
    }

    const updated = await prisma.productOptionValue.update({
      where: { id: valueId },
      data: {
        value: input.value,
        valueAr: input.valueAr,
        swatchHex: input.swatchHex,
        swatchImageUrl: input.swatchImageUrl,
      },
    });
    await invalidateStoreProductCaches(storeId);
    return updated;
  }

  /**
   * Delete option value
   */
  static async deleteOptionValue(storeId: string, productId: string, valueId: string) {
    const optionValue = await prisma.productOptionValue.findFirst({
      where: {
        id: valueId,
        option: {
          product: { id: productId, storeId, deletedAt: null },
        },
      },
      include: { option: { include: { values: true } } },
    });

    if (!optionValue) {
      throw new AppError(404, 'NOT_FOUND', 'Option value not found');
    }

    // Prevent deleting last value
    if (optionValue.option.values.length <= 1) {
      throw new AppError(
        400,
        'LAST_VALUE',
        'Cannot delete the last value. Delete the option instead.'
      );
    }

    // Delete any variants using this value.  Select imageUrl so we can
    // clean up R2 objects after the deletes commit.
    const variantsWithValue = await prisma.productVariant.findMany({
      where: {
        options: { some: { valueId } },
      },
      select: { id: true, imageUrl: true },
    });

    if (variantsWithValue.length > 0) {
      try {
        await prisma.productVariant.deleteMany({
          where: { id: { in: variantsWithValue.map(v => v.id) } },
        });
      } catch (err) {
        // Same all-or-nothing shape as deleteOption: every variant carrying
        // this option value is deleted together, so a single bundle-pinned
        // variant blocks the whole value deletion.
        throwIfBundleFkViolation(err);
        throw err;
      }
    }

    await prisma.productOptionValue.delete({ where: { id: valueId } });
    await invalidateStoreProductCaches(storeId);

    // Fire-and-forget R2 cleanup for any variant images that were just
    // hard-deleted — same pattern as deleteVariant / deleteOption.
    for (const v of variantsWithValue) {
      if (v.imageUrl) {
        void deleteR2ObjectIfOrphan(v.imageUrl).catch(err =>
          logger.warn({ err, valueId }, '[variant.deleteOptionValue] r2 cleanup failed')
        );
      }
    }
  }

  /**
   * Create a new variant
   */
  static async createVariant(storeId: string, productId: string, input: CreateVariantInput) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: { options: { include: { values: true } } },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Validate option values
    const allValueIds = product.options.flatMap(o => o.values.map(v => v.id));
    for (const valueId of input.optionValueIds) {
      if (!allValueIds.includes(valueId)) {
        throw new AppError(400, 'INVALID_OPTION_VALUE', `Invalid option value ID: ${valueId}`);
      }
    }

    // Check if each option has exactly one value
    for (const option of product.options) {
      const matchingValues = input.optionValueIds.filter(id =>
        option.values.some(v => v.id === id)
      );
      if (matchingValues.length !== 1) {
        throw new AppError(400, 'INVALID_VARIANT', `Each option must have exactly one value`);
      }
    }

    // Check for duplicate variant
    const existingVariants = await prisma.productVariant.findMany({
      where: { productId },
      include: { options: true },
    });

    for (const existing of existingVariants) {
      const existingValueIds = existing.options.map(o => o.valueId).sort();
      const newValueIds = [...input.optionValueIds].sort();
      if (JSON.stringify(existingValueIds) === JSON.stringify(newValueIds)) {
        throw new AppError(400, 'DUPLICATE_VARIANT', 'This variant combination already exists');
      }
    }

    // Generate title from option values
    const optionValues = await prisma.productOptionValue.findMany({
      where: { id: { in: input.optionValueIds } },
      include: { option: true },
      orderBy: { option: { position: 'asc' } },
    });

    const title = optionValues.map(v => v.value).join(' / ');
    const titleAr = optionValues.every(v => v.valueAr)
      ? optionValues.map(v => v.valueAr).join(' / ')
      : null;

    // Ruling B5-13: a variant of a gold-rate product is priced by the repricer, never by the caller.
    const isGold = product.pricingMode === 'gold_rate';
    if (isGold && (input.price != null || input.compareAtPrice != null)) {
      throw new AppError(
        409,
        'GOLD_PRICE_MANAGED',
        "The price of a gold-rate product is calculated from the day's gold rate"
      );
    }

    // BARCODE-1: a typed/scanned barcode must be valid and unused anywhere in the store.
    const typedBarcode = input.barcode?.trim() ? parseBarcodeOrThrow(input.barcode) : undefined;
    if (typedBarcode) await assertBarcodeAvailable(storeId, typedBarcode);

    // Create variant
    const createVariantRow = (db: Pick<typeof prisma, 'productVariant'>) =>
      db.productVariant.create({
        data: {
          productId,
          title,
          titleAr,
          sku: input.sku,
          barcode: typedBarcode,
          price: input.price,
          compareAtPrice: input.compareAtPrice,
          costPrice: input.costPrice,
          inventory: input.inventory || 0,
          weight: input.weight,
          imageUrl: input.imageUrl,
          position: existingVariants.length,
          options: {
            create: input.optionValueIds.map(valueId => ({ valueId })),
          },
        },
        include: {
          options: {
            include: {
              value: {
                include: { option: true },
              },
            },
          },
        },
      });
    const variant = isGold
      ? await GoldRateService.asRepricer(storeId, productId, tx =>
          createVariantRow(tx as unknown as Pick<typeof prisma, 'productVariant'>)
        )
      : await createVariantRow(prisma);

    // BARCODE-1: no barcode typed -> the store's next in-store EAN-13 (when inventory.barcode is on).
    const autoBarcode = typedBarcode
      ? null
      : await ensureBarcode(storeId, { variantId: variant.id });

    const result = {
      ...variant,
      barcode: autoBarcode ?? variant.barcode,
      optionValues: variant.options.map(o => ({
        optionId: o.value.option.id,
        optionName: o.value.option.name,
        optionNameAr: o.value.option.nameAr,
        valueId: o.value.id,
        value: o.value.value,
        valueAr: o.value.valueAr,
      })),
    };

    // Variant stock/price is serialised into the storefront product list,
    // detail and suggest caches (lib/public-cache.ts, which states that ANY
    // write changing price or stock MUST bust them). Without this the
    // merchant restocks a variant and the storefront keeps serving "Sold
    // Out" until the TTL lapses.
    await invalidateStoreProductCaches(storeId);

    return result;
  }

  /**
   * Update a variant
   */
  static async updateVariant(
    storeId: string,
    productId: string,
    variantId: string,
    input: UpdateVariantInput
  ) {
    const variant = await prisma.productVariant.findFirst({
      where: {
        id: variantId,
        product: { id: productId, storeId, deletedAt: null },
      },
    });

    if (!variant) {
      throw new AppError(404, 'NOT_FOUND', 'Variant not found');
    }

    // BARCODE-1: validate a changed barcode; '' clears it.
    let barcodeUpdate: { barcode?: string | null } = {};
    if (input.barcode !== undefined) {
      const raw = input.barcode?.trim();
      if (!raw) barcodeUpdate = { barcode: null };
      else {
        const value = parseBarcodeOrThrow(raw);
        await assertBarcodeAvailable(storeId, value, { variantId });
        barcodeUpdate = { barcode: value };
      }
    }

    const updated = await prisma.productVariant.update({
      where: { id: variantId },
      data: { ...input, ...barcodeUpdate },
      include: {
        options: {
          include: {
            value: {
              include: { option: true },
            },
          },
        },
      },
    });

    // Disabling (or re-enabling) a variant that HOLDS stock moves those units
    // out of (or back into) every stock and stock-value figure (a disabled
    // variant is not stock — inventory-model.md, Ruling M5-6), without any
    // quantity changing. Record it in the stock history so the drop is
    // traceable (issue 2146): quantity 0, previous = new = the variant's
    // units, so no reader that sums movements is affected.
    if (
      input.isActive !== undefined &&
      input.isActive !== variant.isActive &&
      variant.inventory !== 0
    ) {
      await prisma.inventoryHistory.create({
        data: {
          productId,
          storeId,
          type: 'adjustment',
          quantity: 0,
          previousStock: variant.inventory,
          newStock: variant.inventory,
          reason: input.isActive
            ? `Variant re-enabled — ${variant.inventory} unit(s) count as stock again`
            : `Variant disabled — ${variant.inventory} unit(s) no longer count as stock`,
          reference: `variant:${variantId}`,
        },
      });
    }

    // If the variant's image URL changed, queue the old object for R2
    // cleanup. Skip when input.imageUrl is undefined (caller didn't
    // touch the field) — only the explicit-set or explicit-null cases
    // should trigger a delete.
    if (input.imageUrl !== undefined && variant.imageUrl && variant.imageUrl !== input.imageUrl) {
      void deleteR2ObjectIfOrphan(variant.imageUrl).catch(err =>
        logger.warn({ err, variantId }, '[variant.update] r2 cleanup failed')
      );
    }

    // Variant stock/price is serialised into the storefront product list,
    // detail and suggest caches (lib/public-cache.ts, which states that ANY
    // write changing price or stock MUST bust them). Without this the
    // merchant restocks a variant and the storefront keeps serving "Sold
    // Out" until the TTL lapses.
    await invalidateStoreProductCaches(storeId);

    return updated;
  }

  /**
   * Delete a variant
   */
  static async deleteVariant(storeId: string, productId: string, variantId: string) {
    const variant = await prisma.productVariant.findFirst({
      where: {
        id: variantId,
        product: { id: productId, storeId, deletedAt: null },
      },
    });

    if (!variant) {
      throw new AppError(404, 'NOT_FOUND', 'Variant not found');
    }

    try {
      await prisma.productVariant.delete({ where: { id: variantId } });
    } catch (err) {
      throwIfBundleFkViolation(err);
      throw err;
    }

    // Variant rows are hard-deleted (no soft-delete on this table), so
    // the image is genuinely orphaned the moment the row goes. Safe to
    // clean up immediately.
    if (variant.imageUrl) {
      void deleteR2ObjectIfOrphan(variant.imageUrl).catch(err =>
        logger.warn({ err, variantId }, '[variant.delete] r2 cleanup failed')
      );
    }

    // Variant stock/price is serialised into the storefront product list,
    // detail and suggest caches (lib/public-cache.ts, which states that ANY
    // write changing price or stock MUST bust them). Without this the
    // merchant restocks a variant and the storefront keeps serving "Sold
    // Out" until the TTL lapses.
    await invalidateStoreProductCaches(storeId);
  }

  /**
   * Generate all possible variants from current options
   */
  static async generateVariants(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: {
        options: {
          orderBy: { position: 'asc' },
          include: {
            values: { orderBy: { position: 'asc' } },
          },
        },
        variants: { include: { options: true } },
      },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    if (product.options.length === 0) {
      throw new AppError(400, 'NO_OPTIONS', 'Product has no options defined');
    }

    // Generate all combinations
    const combinations = this.generateCombinations(product.options.map(o => o.values));

    // Filter out existing variants
    const existingCombinations = new Set(
      product.variants.map(v =>
        v.options
          .map(o => o.valueId)
          .sort()
          .join(',')
      )
    );

    const newCombinations = combinations.filter(
      combo =>
        !existingCombinations.has(
          combo
            .map(v => v.id)
            .sort()
            .join(',')
        )
    );

    // Create new variants
    const created: string[] = [];
    for (const combo of newCombinations) {
      const title = combo.map(v => v.value).join(' / ');
      const titleAr = combo.every(v => v.valueAr) ? combo.map(v => v.valueAr).join(' / ') : null;

      const createRow = (db: Pick<typeof prisma, 'productVariant'>) =>
        db.productVariant.create({
          data: {
            productId,
            title,
            titleAr,
            inventory: 0,
            position: product.variants.length + created.length,
            options: {
              create: combo.map(value => ({ valueId: value.id })),
            },
          },
        });
      // Ruling B5-13: a generated variant of a gold-rate product is born priced by the repricer.
      const variant =
        product.pricingMode === 'gold_rate'
          ? await GoldRateService.asRepricer(storeId, productId, tx =>
              createRow(tx as unknown as Pick<typeof prisma, 'productVariant'>)
            )
          : await createRow(prisma);

      created.push(variant.id);
      await ensureBarcode(storeId, { variantId: variant.id });
    }

    // Variant stock/price is serialised into the storefront product list,
    // detail and suggest caches (lib/public-cache.ts, which states that ANY
    // write changing price or stock MUST bust them). Without this the
    // merchant restocks a variant and the storefront keeps serving "Sold
    // Out" until the TTL lapses.
    await invalidateStoreProductCaches(storeId);

    return {
      created: created.length,
      existing: product.variants.length,
      total: product.variants.length + created.length,
    };
  }

  /**
   * Bulk update variant inventory
   */
  static async bulkUpdateInventory(
    storeId: string,
    productId: string,
    updates: Array<{ variantId: string; inventory: number }>
  ) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // One at a time, each in its own savepoint (issue 2215's class). The
    // route runs in the request's single tenant transaction: a failing item
    // used to abort it while the catch reported "success: false" for that
    // item and success for the rest — and the COMMIT then silently rolled
    // every item back. Savepoints on one connection cannot interleave, so the
    // items are not run concurrently.
    const results: Array<{ variantId: string; success: boolean }> = [];
    for (const update of updates) {
      try {
        const updated = await withSavepoint(async () => {
          const variant = await prisma.productVariant.findFirst({
            where: { id: update.variantId, productId },
          });
          if (!variant) return false;
          await prisma.productVariant.update({
            where: { id: update.variantId },
            data: { inventory: update.inventory },
          });
          return true;
        });
        results.push({ variantId: update.variantId, success: updated });
      } catch {
        results.push({ variantId: update.variantId, success: false });
      }
    }

    // Variant stock is serialised into the storefront product list, detail
    // and suggest caches (lib/public-cache.ts, which states that ANY write
    // changing price or stock MUST bust them). This is the bulk restock path
    // — the one a merchant reaches for first — so a stale cache here reads
    // exactly like the restock never happened.
    await invalidateStoreProductCaches(storeId);

    return {
      updated: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    };
  }

  /**
   * Reorder options
   */
  static async reorderOptions(storeId: string, productId: string, optionIds: string[]) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: { options: true },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Validate all option IDs belong to this product
    const validOptionIds = new Set(product.options.map(o => o.id));
    for (const optionId of optionIds) {
      if (!validOptionIds.has(optionId)) {
        throw new AppError(
          400,
          'INVALID_OPTION',
          `Option ${optionId} does not belong to this product`
        );
      }
    }

    await Promise.all(
      optionIds.map((optionId, index) =>
        prisma.productOption.update({
          where: { id: optionId },
          data: { position: index },
        })
      )
    );
  }

  /**
   * Reorder variants
   */
  static async reorderVariants(storeId: string, productId: string, variantIds: string[]) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      include: { variants: true },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // Validate all variant IDs belong to this product
    const validVariantIds = new Set(product.variants.map(v => v.id));
    for (const variantId of variantIds) {
      if (!validVariantIds.has(variantId)) {
        throw new AppError(
          400,
          'INVALID_VARIANT',
          `Variant ${variantId} does not belong to this product`
        );
      }
    }

    await Promise.all(
      variantIds.map((variantId, index) =>
        prisma.productVariant.update({
          where: { id: variantId },
          data: { position: index },
        })
      )
    );

    // Deliberately NOT busting the product caches (unlike every other mutator
    // in this service): this writes `position` only, and no cached storefront
    // payload orders on variant position — the PDP renders variants in the
    // order the detail query returns them, which this does not feed. If a
    // cached surface ever starts honouring variant order, add the bust here.
  }

  // Helper to generate all combinations
  private static generateCombinations<T>(arrays: T[][]): T[][] {
    if (arrays.length === 0) return [[]];
    if (arrays.length === 1) return arrays[0].map(item => [item]);

    const result: T[][] = [];
    const restCombinations = this.generateCombinations(arrays.slice(1));

    for (const item of arrays[0]) {
      for (const rest of restCombinations) {
        result.push([item, ...rest]);
      }
    }

    return result;
  }
}
