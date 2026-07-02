import type { StoreTheme } from '@force/shared';
import { resolveColor } from '@force/shared';

/**
 * Discount/sale badge corner + color — merchant-configurable via Page
 * Builder → "Product cards (everywhere)" → "Discount / sale badge",
 * sibling to ctaShape/oosLabel*. See `ProductCardDefaults.discountBadge`
 * in packages/shared/src/types/store-layout.ts.
 */
export type DiscountBadgePosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * Map the merchant's chosen discount-badge corner to Tailwind PHYSICAL
 * position classes (`left-*` / `right-*` / `top-*` / `bottom-*`) — NOT
 * logical `start-*` / `end-*`.
 *
 * This is deliberately different from `oosPlacementClass` in card-size.ts,
 * which uses logical start/end so the out-of-stock ribbon mirrors with
 * reading direction. The discount badge must NOT mirror: "bottom-left"
 * means the physical bottom-left corner on BOTH LTR and RTL storefronts.
 * (Fixed 2026-07: the prior hardcoded `bottom-3 end-3` placement silently
 * rendered at the physical bottom-RIGHT on RTL stores — logical `end`
 * flips with direction, physical `left` must not.)
 *
 * `isRtl` is accepted for signature symmetry with the rest of the
 * placement helpers in this file but is intentionally NOT used to flip
 * the corner — that's the entire point of this helper existing.
 */
export function getDiscountBadgePosition(
  position: DiscountBadgePosition | undefined,
  isRtl?: boolean
): string {
  void isRtl;
  switch (position) {
    case 'top-left':
      return 'top-3 left-3';
    case 'top-right':
      return 'top-3 right-3';
    case 'bottom-right':
      return 'bottom-3 right-3';
    case 'bottom-left':
    default:
      return 'bottom-3 left-3';
  }
}

/**
 * Resolve the merchant's discount-badge color (token:* or hex) via
 * `resolveColor`. Falls back to the platform's destructive/red CSS
 * variable when unset or no theme is available — Rule 15: token color
 * resolution must fall back to `hsl(var(--<key>))`, never silently drop
 * the merchant's intent or render unstyled.
 */
export function getDiscountBadgeColor(color: string | undefined, theme?: StoreTheme): string {
  const resolved = color && theme ? resolveColor(color, theme) : undefined;
  return resolved ?? 'hsl(var(--destructive))';
}
