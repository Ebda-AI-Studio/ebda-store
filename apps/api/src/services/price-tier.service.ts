/**
 * Merchant price tiers (B2B Task 4). Ownership (product/variant/group in THIS store) is enforced twice: here (clean 404s)
 * and by the composite FKs (23503). Validation is the pure `validateTierWrite` (@ebda/shared): TIER_ABOVE_BASE,
 * TIER_NOT_MONOTONE, TIER_VARIANT_ABOVE_PRODUCT (B2B-12), TIER_DUPLICATE, TIER_LIMIT, below-cost warning.
 * Every write invalidates the cached public payload after commit (lib/b2b-invalidate).
 */
import { storeDb, storeWriter } from '../lib/repo-factory';
import { validateTierWrite, isStaleTier, type TierInput } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { withSavepoint } from '../lib/savepoint';
import { invalidateB2bPricing, assertWholesaleEntitled } from '../lib/b2b-invalidate';

export interface TierWriteInput {
  variantId?: string | null;
  groupId?: string | null;
  minQty: number;
  priceMinor: number;
}

const tierSelect = {
  id: true,
  productId: true,
  variantId: true,
  groupId: true,
  minQty: true,
  priceMinor: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function loadProduct(storeId: string, productId: string) {
  const product = await (
    await storeWriter(storeId)
  ).product.findFirst({
    where: { id: productId, storeId, deletedAt: null },
    select: { id: true, price: true, costPrice: true, moq: true, pricingMode: true },
  });
  if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  return product;
}

/**
 * Ruling B5-19a: a fixed-amount wholesale tier cannot sit under a gold-rate product. The base price
 * moves with the rate, the tier amount does not, so within a day the "discount" tier would be
 * ABOVE the base (or lose the merchant money). A group PERCENT still works on a gold base.
 */
function assertNotGold(product: { pricingMode: string }) {
  if (product.pricingMode === 'gold_rate')
    throw new AppError(
      409,
      'GOLD_NO_PRICE_TIERS',
      'A gold-rate product cannot have fixed-price wholesale tiers: its price moves with the gold rate.',
      {
        messageAr:
          'المنتج المسعّر بالدهب مينفعش يتحط له شرائح أسعار ثابتة لأن سعره بيتغيّر مع سعر الجرام.',
      }
    );
}

const toInput = (t: {
  id: string;
  variantId: string | null;
  groupId: string | null;
  minQty: number;
  priceMinor: number;
}): TierInput => ({
  id: t.id,
  variantId: t.variantId,
  groupId: t.groupId,
  minQty: t.minQty,
  priceMinor: t.priceMinor,
});

async function validate(
  storeId: string,
  productId: string,
  tier: TierInput,
  product: { price: number; costPrice: number | null; moq?: number | null }
) {
  let variantPrice: number | null = null;
  let variantCost: number | null = null;
  if (tier.variantId) {
    const variant = await (
      await storeWriter(storeId)
    ).productVariant.findFirst({
      where: { id: tier.variantId, productId, product: { storeId } },
      select: { price: true, costPrice: true },
    });
    if (!variant) throw new AppError(404, 'NOT_FOUND', 'Variant not found for this product');
    variantPrice = variant.price;
    variantCost = variant.costPrice;
  }
  if (tier.groupId) {
    const group = await (
      await storeDb(storeId)
    ).customerGroup.findFirst({
      where: { id: tier.groupId, storeId },
      select: { id: true },
    });
    if (!group) throw new AppError(404, 'NOT_FOUND', 'Customer group not found');
  }
  const existing = await (
    await storeWriter(storeId)
  ).productPriceTier.findMany({
    where: { storeId, productId },
    select: tierSelect,
  });
  const result = validateTierWrite({
    tier,
    existing: existing.map(toInput),
    productPriceMinor: product.price,
    variantPriceMinor: variantPrice,
    costPriceMinor: tier.variantId ? (variantCost ?? product.costPrice) : product.costPrice,
    moq: product.moq,
  });
  const first = result.errors[0];
  if (first) {
    throw new AppError(first.code === 'TIER_DUPLICATE' ? 409 : 422, first.code, first.message, {
      errors: result.errors,
    });
  }
  return result.warnings;
}

export const PriceTierService = {
  /** Tiers of a product, each flagged `stale` when the merchant has since lowered the base under it. */
  async list(storeId: string, productId: string) {
    const product = await loadProduct(storeId, productId);
    const [tiers, variants] = await Promise.all([
      (await storeWriter(storeId)).productPriceTier.findMany({
        where: { storeId, productId },
        select: tierSelect,
        orderBy: [{ variantId: 'asc' }, { groupId: 'asc' }, { minQty: 'asc' }],
      }),
      (await storeWriter(storeId)).productVariant.findMany({
        where: { productId },
        select: { id: true, price: true },
      }),
    ]);
    const vPrice = new Map(variants.map(v => [v.id, v.price]));
    return tiers.map(t => ({
      ...t,
      stale: isStaleTier(toInput(t), product.price, t.variantId ? vPrice.get(t.variantId) : null),
    }));
  },

  async create(storeId: string, productId: string, input: TierWriteInput) {
    await assertWholesaleEntitled(storeId);
    const product = await loadProduct(storeId, productId);
    assertNotGold(product);
    const tier: TierInput = {
      variantId: input.variantId ?? null,
      groupId: input.groupId ?? null,
      minQty: input.minQty,
      priceMinor: input.priceMinor,
    };
    const warnings = await validate(storeId, productId, tier, product);
    const w = await storeWriter(storeId);
    try {
      const created = await withSavepoint(() =>
        w.productPriceTier.create({
          data: { storeId, productId, ...tier },
          select: tierSelect,
        })
      );
      invalidateB2bPricing(storeId);
      return { tier: created, warnings };
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        throw new AppError(
          409,
          'TIER_DUPLICATE',
          'A tier for this quantity already exists in this scope.'
        );
      }
      throw err;
    }
  },

  /** Update minQty / priceMinor. The scope (variant, group) is immutable: delete and re-create to move a tier. */
  async update(
    storeId: string,
    productId: string,
    tierId: string,
    input: { minQty?: number; priceMinor?: number }
  ) {
    await assertWholesaleEntitled(storeId);
    const product = await loadProduct(storeId, productId);
    assertNotGold(product);
    const current = await (
      await storeWriter(storeId)
    ).productPriceTier.findFirst({
      where: { id: tierId, storeId, productId },
      select: tierSelect,
    });
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Price tier not found');
    const tier: TierInput = {
      id: current.id,
      variantId: current.variantId,
      groupId: current.groupId,
      minQty: input.minQty ?? current.minQty,
      priceMinor: input.priceMinor ?? current.priceMinor,
    };
    const warnings = await validate(storeId, productId, tier, product);
    const w = await storeWriter(storeId);
    try {
      const updated = await withSavepoint(() =>
        w.productPriceTier.update({
          where: { id: tierId, storeId },
          data: { minQty: tier.minQty, priceMinor: tier.priceMinor },
          select: tierSelect,
        })
      );
      invalidateB2bPricing(storeId);
      return { tier: updated, warnings };
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        throw new AppError(
          409,
          'TIER_DUPLICATE',
          'A tier for this quantity already exists in this scope.'
        );
      }
      throw err;
    }
  },

  /** Deleting is allowed on a downgraded store (benefits switch off; the merchant can still clean up). */
  async remove(storeId: string, productId: string, tierId: string) {
    const current = await (
      await storeWriter(storeId)
    ).productPriceTier.findFirst({
      where: { id: tierId, storeId, productId },
      select: { id: true },
    });
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Price tier not found');
    await (await storeWriter(storeId)).productPriceTier.delete({ where: { id: tierId, storeId } });
    invalidateB2bPricing(storeId);
  },
};
