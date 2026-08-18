import type { ProductCardDefaults, StoreLayoutSettings } from '@force/shared';
import type { CtaShape, CtaSize } from './card-size';

/**
 * Resolve the merchant-configurable product-card defaults once.
 *
 * The same sixteen-line `defaults?.x` block existed in SIX card components —
 * bold, classic, elegant, minimal, modern and the canonical PecannbeeProductCard
 * — identical apart from two comments and one place that wrote
 * `layout?.productCardDefaults?.productNameCase` instead of
 * `defaults?.productNameCase` (the same expression, since `defaults` IS
 * `layout?.productCardDefaults`).
 *
 * Six copies of the merchant's card settings means adding one setting requires
 * six edits, and the template that gets missed silently ignores what the
 * merchant configured — a difference they see on their storefront and we do not.
 */
export interface ResolvedProductCardDefaults {
  ctaShape?: CtaShape;
  ctaSize?: CtaSize;
  ctaColor?: ProductCardDefaults['ctaColor'];
  ctaTextColor?: ProductCardDefaults['ctaTextColor'];
  ctaLabelTextEn?: ProductCardDefaults['ctaLabelTextEn'];
  ctaLabelTextAr?: ProductCardDefaults['ctaLabelTextAr'];
  oosDimColor?: ProductCardDefaults['oosDimColor'];
  oosLabel?: ProductCardDefaults['oosLabel'];
  oosLabelTextEn?: ProductCardDefaults['oosLabelTextEn'];
  oosLabelTextAr?: ProductCardDefaults['oosLabelTextAr'];
  oosLabelShape?: CtaShape;
  // Derived from the source type, never hand-widened: writing this as `string`
  // silently dropped the 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end'
  // union and broke every card that passes it on.
  oosLabelPlacement?: ProductCardDefaults['oosLabelPlacement'];
  oosLabelColor?: ProductCardDefaults['oosLabelColor'];
  oosLabelTextColor?: ProductCardDefaults['oosLabelTextColor'];
  /** Merchant-controlled name casing; unset = normal, no forced caps. */
  nameCase?: ProductCardDefaults['productNameCase'];
  /** `ctaMode: 'viewOnly'` forces the View link even for in-stock simple products. */
  viewOnly: boolean;
}

export function resolveProductCardDefaults(
  layout?: StoreLayoutSettings | null
): ResolvedProductCardDefaults {
  const defaults = layout?.productCardDefaults;
  return {
    ctaShape: defaults?.ctaShape as CtaShape | undefined,
    ctaSize: defaults?.ctaSize as CtaSize | undefined,
    ctaColor: defaults?.ctaColor,
    ctaTextColor: defaults?.ctaTextColor,
    ctaLabelTextEn: defaults?.ctaLabelTextEn,
    ctaLabelTextAr: defaults?.ctaLabelTextAr,
    oosDimColor: defaults?.oosDimColor,
    oosLabel: defaults?.oosLabel,
    oosLabelTextEn: defaults?.oosLabelTextEn,
    oosLabelTextAr: defaults?.oosLabelTextAr,
    oosLabelShape: defaults?.oosLabelShape as CtaShape | undefined,
    oosLabelPlacement: defaults?.oosLabelPlacement,
    oosLabelColor: defaults?.oosLabelColor,
    oosLabelTextColor: defaults?.oosLabelTextColor,
    nameCase: defaults?.productNameCase,
    viewOnly: defaults?.ctaMode === 'viewOnly',
  };
}
