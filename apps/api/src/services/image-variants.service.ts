import sharp from 'sharp';
import { IMAGE_VARIANT_WIDTHS } from '@force/shared';
import logger from '../lib/logger';
import { isWorkers } from '../lib/runtime';

/**
 * Pre-generate the storefront width ladder (docs/architecture/image-variants.md,
 * ruling PERF-STORE-3). Naming lives in @force/shared (`variantKey`).
 *
 * One webp per ladder rung. A source narrower than a rung is re-encoded at its
 * own width (`withoutEnlargement`) so EVERY rung always exists and the web
 * loader never needs the intrinsic width.
 *
 * Fail-soft like image-resize.service: never throws, returns [] on Workers
 * (sharp is a native addon), on animated input, or on any sharp failure. A
 * missing ladder only costs bandwidth; the web loader falls back to the original.
 */
export async function generateImageVariants(
  buffer: Buffer
): Promise<Array<{ width: number; buffer: Buffer }>> {
  if (isWorkers) return [];
  try {
    const metadata = await sharp(buffer).metadata();
    if ((metadata.pages ?? 1) > 1) return []; // animated: a still would change the image
    const out: Array<{ width: number; buffer: Buffer }> = [];
    for (const width of IMAGE_VARIANT_WIDTHS) {
      const data = await sharp(buffer)
        // Bake EXIF orientation in before metadata is dropped.
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 75, effort: 4 })
        .toBuffer();
      out.push({ width, buffer: data });
    }
    return out;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : 'unknown' },
      'image-variants: generation failed, skipping variants'
    );
    return [];
  }
}
