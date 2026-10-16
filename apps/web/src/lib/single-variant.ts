/**
 * Owner report 2026-09-30 (demo-store): a product with exactly ONE variant
 * (e.g. "Size: 380 Gram") showed a one-option picker and a disabled
 * "Select Options" / "اختر الخيارات" button until the shopper tapped the only
 * option. When there is nothing to choose, the PDP now starts with that option
 * already picked, so Add to Cart is enabled at once.
 *
 * Owner constraint (same day): nothing else may look different. The picker
 * keeps its markup; the pre-selected state is exactly the state a tap on the
 * only pill produces, so a variant is auto-selected ONLY when that pill is
 * tappable — i.e. by the same availability rule `VariantSelector` uses for
 * `disabled`: `canBuyNow` (in stock, untracked, or accepting backorders — X-02).
 * A sold-out single variant with no backorder stays unselected, as today.
 */
import { canBuyNow, type BuyableVariant } from './can-buy-now';

interface SelectableVariant extends BuyableVariant {
  options: Record<string, string>;
}

/** The variant to pre-select, or null when the shopper has a real choice. */
export function autoSelectVariant<V extends SelectableVariant>(
  variants: readonly V[] | null | undefined,
  optionNames: readonly string[]
): V | null {
  if (!variants || variants.length !== 1 || optionNames.length === 0) return null;
  const only = variants[0];
  if (!canBuyNow(null, only)) return null;
  // Every axis the picker renders must have a value on this variant, or the
  // picker could not show it as selected.
  if (!optionNames.every(name => only.options?.[name] !== undefined)) return null;
  return only;
}

/** The picker's initial `selected` map (option name → value) for that variant. */
export function autoSelection<V extends SelectableVariant>(
  variants: readonly V[] | null | undefined,
  optionNames: readonly string[]
): Record<string, string> {
  const only = autoSelectVariant(variants, optionNames);
  if (!only) return {};
  return Object.fromEntries(optionNames.map(name => [name, only.options[name]]));
}

/**
 * A product with variants but NO option groups (W1a fix round, minor 1): there
 * is no picker to choose from, so the PDP treats it like a single-variant
 * product. Pick the first buyable variant (`canBuyNow`), else
 * the first one, which then reads sold out (the button disables on its stock),
 * never a dead tap that nudges a picker that is not on the page.
 */
export function variantWithoutPicker<V extends SelectableVariant>(
  variants: readonly V[] | null | undefined,
  optionNames: readonly string[]
): V | null {
  if (!variants || variants.length === 0 || optionNames.length > 0) return null;
  return variants.find(v => canBuyNow(null, v)) ?? variants[0];
}
