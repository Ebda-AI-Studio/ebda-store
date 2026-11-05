/**
 * Resized image variants: the key scheme shared by the API (writes them at upload) and the
 * storefront (derives the `srcset`). See apps/api/src/lib/images/variants.ts (Ruling PREMIUM-2).
 */
export const VARIANT_WIDTHS = [480, 960, 1600] as const;

const RASTER = /\.(jpe?g|png|webp)$/i;
const VARIANT = /\.w(480|960|1600)\.webp$/i;

/** SVG and GIF (animation) are never resized; neither is a variant itself. */
export function canHaveVariants(key: string): boolean {
  return RASTER.test(key) && !VARIANT.test(key);
}

export function isVariantKey(key: string): boolean {
  return VARIANT.test(key);
}

/** `stores/x/a.png` + 960 -> `stores/x/a.w960.webp`. */
export function variantKey(originalKey: string, width: number): string {
  return originalKey.replace(RASTER, '') + `.w${width}.webp`;
}

/** The original key a variant belongs to is not recoverable (extension lost); callers keep the pair. */
export function variantUrl(originalUrl: string, width: number): string {
  try {
    const u = new URL(originalUrl);
    u.pathname = variantKey(u.pathname, width);
    return u.toString();
  } catch {
    return originalUrl;
  }
}
