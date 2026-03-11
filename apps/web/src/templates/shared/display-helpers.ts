/**
 * Shared display helpers used across all template components.
 *
 * These centralise the RTL-aware text selection and discount calculation
 * logic that was previously duplicated in every template.
 */

import type { StoreBranding } from '../types';

/**
 * Return the appropriate text based on RTL mode.
 * If RTL is active and an Arabic variant exists, use it; otherwise fall back
 * to the default text.
 */
export function getDisplayText<T extends string | undefined>(
  text: T,
  textAr: string | undefined,
  isRtl: boolean
): T {
  return (isRtl && textAr ? textAr : text) as T;
}

/**
 * Derive display-ready branding values (name, logo, description) from a
 * `StoreBranding` object, respecting the current text direction.
 */
export function getDisplayBranding(
  branding: StoreBranding,
  isRtl: boolean
): { name: string; logo: string | undefined; description: string | undefined } {
  return {
    name: getDisplayText(branding.name, branding.nameAr, isRtl),
    logo: getDisplayText(branding.logo, branding.logoAr, isRtl),
    description: getDisplayText(branding.description, branding.descriptionAr, isRtl),
  };
}

/**
 * Calculate the discount percentage between a compare-at price and the
 * current price.  Returns 0 when no valid discount exists.
 */
export function calculateDiscount(price: number, compareAtPrice: number | undefined): number {
  if (!compareAtPrice || compareAtPrice <= price) return 0;
  return Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
}
