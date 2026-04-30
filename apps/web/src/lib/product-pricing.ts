/**
 * Variant-aware pricing helpers for storefront + admin product cards.
 *
 * The Product row carries its own `price` + `compareAtPrice` even when
 * the product has variants — but those parent-level values are usually
 * stale defaults from before the merchant configured variants (see the
 * Wady Aljuz olive-oil consolidation: parent retained a pre-fold
 * compareAtPrice of 20 KWD that no variant inherited, producing a
 * fake "20% OFF" badge on the storefront card).
 *
 * Rules these helpers enforce, applied uniformly across every card
 * surface (product detail, list view, grid templates, admin lists):
 *
 *   - When a product has variants, the displayed price defaults to
 *     the CHEAPEST variant's price. No range, no "from X", no
 *     parent fallback — the headline is always a single concrete
 *     number the customer will actually pay if they pick the
 *     smallest option.
 *   - When a product has variants, the parent's `compareAtPrice` is
 *     IGNORED. Discount badges only fire if the variant the customer
 *     ultimately picks has a real compareAtPrice on it.
 *   - When a product has NO variants, behaviour is unchanged: parent
 *     price + parent compareAtPrice + parent discount badge.
 */

interface VariantLike {
  price?: number | null;
  compareAtPrice?: number | null;
}

interface ProductLike {
  price: number;
  compareAtPrice?: number | null;
  variants?: VariantLike[];
}

/** How the price should be rendered on screen. */
export type PriceMode =
  /** Single concrete price — the only display when the product has no
   *  variants OR a variant is currently selected. */
  | 'single'
  /** "From <min>" headline. Used on listing cards (grid + list +
   *  template variants) when the product has variants and the
   *  customer hasn't engaged with the detail page yet. */
  | 'fromMin'
  /** "min – max" range. Used on the detail page when the product has
   *  variants but no specific variant is selected — the customer is
   *  on the page and can see the full spread before picking a size. */
  | 'range';

export interface ProductPricing {
  /** Number to render as the headline price. Always a single concrete
   *  amount: cheapest variant when the product has variants, otherwise
   *  the parent's own price. For `range` mode, this is the min. */
  displayPrice: number;
  /** Optional struck-through "was" price. `null` when no real
   *  discount applies (variant parents NEVER show parent.compareAtPrice). */
  displayCompare: number | null;
  /** Cheapest variant price, or `null` when the product has no variants. */
  minVariantPrice: number | null;
  /** Most-expensive variant price, or `null` when no variants. */
  maxVariantPrice: number | null;
  /** True when at least one variant has a real compareAtPrice >
   *  variant.price. Lets list cards show a "Sale" badge for
   *  variant-product cards before the customer picks a size. */
  hasVariantDiscount: boolean;
}

/**
 * Surface the call-site is rendering on. Affects how multi-variant
 * pricing is displayed when no variant is selected:
 *   - `card`   → "From <min>"   (listing cards: grid, list, templates)
 *   - `detail` → "<min> – <max>" range (product detail page)
 *
 * When `selectedVariant` is supplied or the product has no variants,
 * surface is irrelevant — both paths render a single price.
 */
export type PricingSurface = 'card' | 'detail';

/**
 * Compute the price the storefront should show for a product.
 *
 * Pass `selectedVariant` on the product detail page to lock the price
 * to that variant's values. Listing cards omit it and get the
 * variant-aware default behaviour. `surface` controls whether the
 * "no-selection but hasVariants" case renders as a `fromMin` (cards)
 * or `range` (detail page) — see PriceMode.
 */
export function getProductPricing(
  product: ProductLike,
  selectedVariant?: VariantLike | null,
  surface: PricingSurface = 'card'
): ProductPricing & { mode: PriceMode } {
  const variants = product.variants ?? [];
  const variantPrices = variants
    .map(v => v.price)
    .filter((p): p is number => typeof p === 'number');
  const minVariantPrice = variantPrices.length > 0 ? Math.min(...variantPrices) : null;
  const maxVariantPrice = variantPrices.length > 0 ? Math.max(...variantPrices) : null;
  const hasVariants = variants.length > 0;
  const hasVariantDiscount = variants.some(
    v =>
      typeof v.compareAtPrice === 'number' &&
      typeof v.price === 'number' &&
      v.compareAtPrice > v.price
  );

  if (selectedVariant) {
    return {
      mode: 'single',
      displayPrice: selectedVariant.price ?? product.price,
      displayCompare:
        typeof selectedVariant.compareAtPrice === 'number' &&
        typeof selectedVariant.price === 'number' &&
        selectedVariant.compareAtPrice > selectedVariant.price
          ? selectedVariant.compareAtPrice
          : null,
      minVariantPrice,
      maxVariantPrice,
      hasVariantDiscount,
    };
  }

  if (hasVariants && minVariantPrice !== null && maxVariantPrice !== null) {
    // All variants share a price → no "from" / range needed; render as a
    // plain single price. Otherwise pick the surface-appropriate mode.
    const sameAcross = minVariantPrice === maxVariantPrice;
    const mode: PriceMode = sameAcross ? 'single' : surface === 'detail' ? 'range' : 'fromMin';
    return {
      mode,
      displayPrice: minVariantPrice,
      // Never show parent.compareAtPrice when variants exist — almost
      // always stale data from a pre-fold standalone listing. The
      // selected-variant branch above re-introduces it once a variant
      // is actually picked.
      displayCompare: null,
      minVariantPrice,
      maxVariantPrice,
      hasVariantDiscount,
    };
  }

  return {
    mode: 'single',
    displayPrice: product.price,
    displayCompare:
      product.compareAtPrice && product.compareAtPrice > product.price
        ? product.compareAtPrice
        : null,
    minVariantPrice,
    maxVariantPrice,
    hasVariantDiscount,
  };
}
