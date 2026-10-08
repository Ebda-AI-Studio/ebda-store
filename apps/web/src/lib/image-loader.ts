/**
 * `next/image` loader for the storefront (docs/RULINGS.md PERF-STORE-3).
 *
 * Cloudflare Workers cannot run Next's sharp optimiser and Image
 * Transformations are not enabled on the ebda.app zone, so the upload pipeline
 * pre-generates a width ladder next to every raster original
 * (`@force/shared` media/image-variants.ts). This loader maps a requested
 * width onto the smallest rung that covers it. Anything that is not one of our
 * own media URLs (foreign CDN, SVG, GIF, relative `/icon.png`, a width above
 * the top rung) is returned untouched, so a `next/image` pointing at it behaves
 * exactly as it did when images were `unoptimized`.
 *
 * `images.deviceSizes` / `imageSizes` in next.config.js are the ladder, so the
 * `srcset` widths Next emits ARE the rungs.
 */
import { imageVariantUrl } from '@force/shared';

export default function ebdaImageLoader({ src, width }: { src: string; width: number }): string {
  return imageVariantUrl(src, width);
}
