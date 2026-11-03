/**
 * next/image loader for the Cloudflare build (audit 2026-11-03 #2, Ruling PREMIUM-2).
 *
 * `next/image` is `unoptimized` on Workers (sharp cannot run there), so every `<img>` served the raw
 * upload. The API now writes three WebP widths NEXT TO every raster upload at upload time
 * (`<name>.w480.webp`, `.w960.webp`, `.w1600.webp`, via the Cloudflare Images binding). This loader
 * only RENAMES: it maps (src, requested width) to the smallest variant that is wide enough. There is
 * no transformation at request time, so the storefront path costs nothing per view and the variants
 * are plain immutable R2 objects behind the CDN.
 *
 * OFF by default: `NEXT_PUBLIC_IMAGE_VARIANTS=1` at build selects this file (next.config.js), and it
 * must only be set once the backfill has covered the existing images. Anything not on our media
 * origin (external URL, data:, SVG/GIF, a local /public file) passes through unchanged.
 */
import { VARIANT_WIDTHS, canHaveVariants, variantUrl } from '@ebda/shared';

const MEDIA_ORIGINS = new Set(['https://media.ebda.app']);

/** Smallest variant width >= the requested one (capped at the widest). */
export function snapWidth(width: number): number {
  return VARIANT_WIDTHS.find(w => w >= width) ?? VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
}

export function variantFor(src: string, width: number): string {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return src;
  }
  if (!MEDIA_ORIGINS.has(u.origin) || !canHaveVariants(u.pathname)) return src;
  return variantUrl(src, snapWidth(width));
}

export default function ebdaImageLoader({ src, width }: { src: string; width: number }): string {
  return variantFor(src, width);
}

/**
 * `srcset` for the plain `<img>` / `<picture>` paths that are not `next/image` (section images,
 * the Dahab hero poster, the PDP lightbox, footer logos). Undefined when variants are off or the URL
 * is not a media raster, so the element falls back to its plain `src`.
 */
export function imageSrcSet(src: string | undefined, maxWidth: number = 1600): string | undefined {
  if (process.env.NEXT_PUBLIC_IMAGE_VARIANTS !== '1' || !src) return undefined;
  const cap = snapWidth(maxWidth);
  const parts = VARIANT_WIDTHS.filter(w => w <= cap).map(w => [variantFor(src, w), w] as const);
  if (parts.every(([u]) => u === src)) return undefined;
  return parts.map(([u, w]) => `${u} ${w}w`).join(', ');
}
