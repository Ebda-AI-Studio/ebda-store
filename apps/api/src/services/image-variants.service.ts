import logger from '../lib/logger';
import { imagesBinding, type ImagesBindingLike } from '../lib/images/icon-resizer';
import { renderVariants, TRANSFORMATIONS_PER_IMAGE } from '../lib/images/variants';
import { canHaveVariants } from '@ebda/shared';
import { StorageService } from './storage.service';

const DEADLINE_MS = 15_000;

/** Make + store the three WebP widths for one stored original. Returns how many were written. Never throws. */
export async function generateImageVariants(
  originalKey: string,
  source: Buffer,
  images: ImagesBindingLike | null = imagesBinding()
): Promise<number> {
  if (!images || !canHaveVariants(originalKey)) return 0;
  try {
    const rendered = await Promise.race([
      renderVariants(images, originalKey, source),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('image variants deadline')), DEADLINE_MS)
      ),
    ]);
    await Promise.all(rendered.map(v => StorageService.putVariant(v.key, v.body)));
    logger.info(
      { key: originalKey, transformations: TRANSFORMATIONS_PER_IMAGE },
      'image variants written'
    );
    return rendered.length;
  } catch (err) {
    logger.warn({ err, key: originalKey, code: 'IMAGE_VARIANTS_FAILED' }, 'image variants skipped');
    return 0;
  }
}

/**
 * Backfill one page of existing images: list originals under `prefix`, skip those that already have
 * their 960 variant, fetch the original over the public URL and generate the rest. Resumable with
 * the returned cursor. `dryRun` counts only (no transformation is billed).
 */
export async function backfillImageVariants(opts: {
  storeId: string;
  cursor?: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<{
  scanned: number;
  generated: number;
  skipped: number;
  failed: number;
  nextCursor: string | null;
}> {
  const page = await StorageService.listByPrefix(`stores/${opts.storeId}/`, {
    cursor: opts.cursor,
    limit: opts.limit ?? 25,
  });
  const keys = new Set(page.items.map(i => i.key));
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of page.items) {
    if (!canHaveVariants(item.key)) {
      skipped++;
      continue;
    }
    const sibling = item.key.replace(/\.(jpe?g|png|webp)$/i, '') + '.w960.webp';
    if (keys.has(sibling)) {
      skipped++;
      continue;
    }
    if (opts.dryRun) {
      generated++;
      continue;
    }
    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const n = await generateImageVariants(item.key, Buffer.from(await res.arrayBuffer()));
      if (n > 0) generated++;
      else failed++;
    } catch (err) {
      failed++;
      logger.warn({ err, key: item.key }, 'image variants backfill: item failed');
    }
  }
  return {
    scanned: page.items.length,
    generated,
    skipped,
    failed,
    nextCursor: page.nextCursor,
  };
}
