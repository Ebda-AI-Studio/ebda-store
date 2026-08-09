import sharp from 'sharp';
import logger from '../lib/logger';

/**
 * Target dimensions per aspect ratio. Picked to match the storefront's
 * sizing-contract defaults (see store-layout.ts + 2026-05-16-mobile-ui-
 * ship.md) and provide enough resolution for Retina displays.
 *
 * Keep these large enough that resizing DOWN happens (sharp upscales
 * poorly). 1200×800 hero @ 3:2 covers a 600×400 CSS-px hero at 2x DPR.
 */
const ASPECT_TARGETS: Record<string, { w: number; h: number }> = {
  '3:2': { w: 1200, h: 800 }, // legacy hero desktop
  '1:1': { w: 1000, h: 1000 }, // category + product
  // 3:4 was hero mobile portrait — DEPRECATED 2026-05-18 (Ahmad: mobile
  // hero must be landscape). Kept for product/category portrait crops.
  '3:4': { w: 600, h: 800 },
  '16:9': { w: 1280, h: 720 }, // alternative hero
  '4:3': { w: 1200, h: 900 }, // alternative hero
  '2:3': { w: 800, h: 1200 }, // alternative category
  '2.45:1': { w: 1470, h: 600 }, // wide-cinema hero (legacy)
  // Canonical hero desktop per packages/shared/src/types/image-standards.ts.
  '1920:700': { w: 1920, h: 700 }, // hero desktop (all themes inherit or override)
  // Hero mobile 16:9 standard (Ahmad 2026-06-03): supersedes 1080×394.
  // '1080:394' kept for legacy uploaded assets that may still reference it;
  // new uploads target '1200:675'. The '16:9' key above (1280×720) is
  // a close proxy — '1200:675' is the precise key for the new standard.
  '1200:675': { w: 1200, h: 675 }, // hero mobile 16:9 (trial)
  '1200:900': { w: 1200, h: 900 }, // hero mobile 4:3 (canonical from 2026-06-03)
  '1080:394': { w: 1080, h: 394 }, // hero mobile legacy (superseded — kept for old assets)
};

/**
 * If the requested aspect maps to a known target, returns a sharp-
 * resized buffer cropped to fill the target dimensions (cover fit,
 * centered). Otherwise returns the original buffer untouched.
 *
 * Format preservation: sharp auto-detects input format and re-encodes
 * to the same. Reasonable compression defaults:
 *   - jpeg: quality 85 (default sharp quality, no perceptible loss)
 *   - png: kept as png (lossless)
 *   - webp: quality 85
 *
 * Fire-and-forget design: if sharp throws (corrupt input, unsupported
 * format, OOM), we log the error and return the ORIGINAL buffer. Better
 * to upload a non-resized image than fail the entire upload.
 *
 * EXIF metadata is stripped (sharp default) — protects against camera
 * GPS data leaking through merchant uploads.
 */
/**
 * Hard ceiling applied to EVERY image upload, aspect or not.
 *
 * 2000px on the longest side is generous for storefront product zoom while
 * keeping a photo around 200-800 KB. Nothing a merchant can do from the admin
 * should put a multi-megabyte image in front of a mobile customer.
 */
const MAX_LONGEST_SIDE = 2000;

/**
 * Unconditional size ceiling — runs even when no `?aspect=` is supplied.
 *
 * WHY THIS EXISTS
 * ---------------
 * `resizeToAspect` is opt-in: it returns the original buffer untouched when
 * `?aspect=` is absent, and no admin upload surface currently sends that param
 * for product images. So a 26-megapixel camera original uploaded straight from
 * a phone was stored, and served, at full size.
 *
 * That is not hypothetical. On 2026-05-01 the palora catalog went up as 19
 * images averaging 8 MB — including a 4160x6240 PNG at 28 MB — and those pages
 * shipped exactly that to every mobile customer until 2026-08-09. 178 MB of
 * originals reduced to 7 MB (96%) with no visible quality change, which is the
 * measure of how much was being wasted.
 *
 * Deliberately separate from the aspect crop: aspect is a DESIGN choice about
 * shape, this is a SAFETY floor about bytes. An upload surface can forget the
 * former; it must not be able to opt out of the latter.
 *
 * Fail-soft like its sibling: if sharp throws, return the original rather than
 * failing the upload — a large image beats a broken one.
 */
export async function enforceMaxDimensions(buffer: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) return buffer;
    if (metadata.width <= MAX_LONGEST_SIDE && metadata.height <= MAX_LONGEST_SIDE) {
      return buffer;
    }

    // `fit: inside` constrains the LONGEST side. Constraining width alone
    // leaves a portrait shot at 2000x3000 (6 MP) — still far more than a
    // storefront needs.
    const pipeline = sharp(buffer)
      // Bake in EXIF orientation before stripping metadata, or a phone photo
      // silently rotates once the orientation tag is gone.
      .rotate()
      .resize({
        width: MAX_LONGEST_SIDE,
        height: MAX_LONGEST_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      });

    const format = metadata.format ?? 'jpeg';
    let out: Buffer;
    if (format === 'png') {
      out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    } else if (format === 'webp') {
      out = await pipeline.webp({ quality: 85 }).toBuffer();
    } else {
      out = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }

    // Never make a file bigger. Re-encoding an already-optimised image can
    // do that, and the whole point here is bytes.
    if (out.length >= buffer.length) return buffer;

    logger.info(
      {
        from: `${metadata.width}x${metadata.height}`,
        bytesBefore: buffer.length,
        bytesAfter: out.length,
      },
      'image-resize: applied max-dimension ceiling'
    );
    return out;
  } catch (err) {
    logger.warn({ err }, 'image-resize: max-dimension ceiling failed, keeping original');
    return buffer;
  }
}

export async function resizeToAspect(buffer: Buffer, aspect: string | undefined): Promise<Buffer> {
  if (!aspect) return buffer;
  const target = ASPECT_TARGETS[aspect];
  if (!target) {
    logger.debug({ aspect }, 'image-resize: unknown aspect, skipping');
    return buffer;
  }

  try {
    const metadata = await sharp(buffer).metadata();
    const inputFormat = metadata.format ?? 'jpeg';

    // Only resize if the image is LARGER than target in at least one
    // dimension. Avoids upscaling small uploads (which would soften
    // them without adding detail).
    if (
      metadata.width &&
      metadata.height &&
      metadata.width <= target.w &&
      metadata.height <= target.h
    ) {
      logger.debug(
        { inputWxH: `${metadata.width}x${metadata.height}`, target: `${target.w}x${target.h}` },
        'image-resize: input already <= target, skipping resize'
      );
      return buffer;
    }

    const pipeline = sharp(buffer).resize(target.w, target.h, {
      fit: 'cover',
      position: 'center',
    });

    // Re-encode preserving format with sane quality defaults
    let out: Buffer;
    if (inputFormat === 'png') {
      out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    } else if (inputFormat === 'webp') {
      out = await pipeline.webp({ quality: 85 }).toBuffer();
    } else if (inputFormat === 'gif') {
      // sharp gif animation support requires libvips compiled with gif —
      // not guaranteed in all envs. resize to first-frame jpeg to keep
      // behavior consistent.
      out = await pipeline.jpeg({ quality: 85 }).toBuffer();
    } else {
      // jpeg + everything else → jpeg
      out = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }

    logger.info(
      {
        aspect,
        before: `${metadata.width}x${metadata.height}`,
        after: `${target.w}x${target.h}`,
        inputBytes: buffer.length,
        outputBytes: out.length,
      },
      'image-resize: resized image to target aspect'
    );

    return out;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : 'unknown', aspect },
      'image-resize: failed, returning original buffer'
    );
    return buffer;
  }
}
