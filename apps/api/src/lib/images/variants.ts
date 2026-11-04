/**
 * Resized image variants, made ONCE at upload (storefront audit 2026-11-03 #2, Ruling PREMIUM-2).
 *
 * The storefront used to serve the raw upload to every screen. Now every raster upload also gets
 * three WebP widths written next to it in R2 by the Cloudflare Images binding (`env.IMAGES`, the same
 * binding as the PWA icons, Ruling D1016-ICONS-1):
 *
 *   stores/<id>/products/abc-name.png           the original (kept, still the `src`)
 *   stores/<id>/products/abc-name.w480.webp     phones / thumbs
 *   stores/<id>/products/abc-name.w960.webp     tablets, 2x phones, PDP
 *   stores/<id>/products/abc-name.w1600.webp    desktop heroes
 *
 * The name is a pure function of the original key, so the storefront derives the `srcset` with no
 * database column and no per-request transformation (`packages/shared/src/images/variants.ts`).
 * Siblings share the original's prefix, so a store purge (`deleteByPrefix`) removes them with it;
 * `StorageService.delete` removes them with the original. Never fails an upload: a binding that is
 * missing or throws yields no variants and the storefront keeps the original.
 */
import { imagesBinding, type ImagesBindingLike } from './icon-resizer';
import { VARIANT_WIDTHS, variantKey, canHaveVariants } from '@ebda/shared';

const QUALITY = 78;

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new Response(new Uint8Array(bytes)).body as ReadableStream<Uint8Array>;
}

export interface RenderedVariant {
  key: string;
  width: number;
  body: Buffer;
}

/** Render the three widths of `source` (never upscaled: `fit: scale-down`). Throws on a binding error. */
export async function renderVariants(
  images: ImagesBindingLike,
  originalKey: string,
  source: Buffer
): Promise<RenderedVariant[]> {
  const out: RenderedVariant[] = [];
  for (const width of VARIANT_WIDTHS) {
    const result = await images
      .input(streamOf(source))
      .transform({ width, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: QUALITY } as { format: string });
    const body = Buffer.from(await result.response().arrayBuffer());
    if (body.length === 0) throw new Error(`Images answered an empty body for ${width}px`);
    out.push({ key: variantKey(originalKey, width), width, body });
  }
  return out;
}

/** Cost counter: unique transformations this deploy produced (3 per image), logged per call by callers. */
export const TRANSFORMATIONS_PER_IMAGE = VARIANT_WIDTHS.length;

export function variantsAvailable(): boolean {
  return imagesBinding() !== null;
}

export { canHaveVariants };
