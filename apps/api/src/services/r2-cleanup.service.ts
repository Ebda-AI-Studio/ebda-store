import { withRlsBypass } from '@force/database';
import { config } from '../config';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { StorageService } from './storage.service';
import logger from '../lib/logger';

/**
 * Helper that deletes R2 objects when their last DB reference goes away.
 *
 * Why this exists: before this service, replacing a product image (admin
 * UI edits the gallery and saves) deleted the `product_images` row but
 * NEVER deleted the underlying R2 object. Every edit leaked storage,
 * and the leaked objects then made periodic orphan-audit cleanups
 * dangerous (it became hard to tell "real orphan" from "in-flight
 * upload"). One Palora's worth of data already vanished that way — the
 * audit deleted objects that the audit thought were orphans but the
 * still-pointing DB rows had stale URLs.
 *
 * Safety model:
 *  - Only delete a key after confirming NO other live row points at the
 *    same URL (productImage, productVariant.imageUrl, category.image,
 *    store logo/hero/og/favicon, storePage.coverImage). This is a
 *    targeted version of `scripts/r2-orphan-audit.ts`'s cross-table
 *    sweep, scoped to a single URL so it's cheap.
 *  - Skip URLs that aren't ours (third-party CDN images stay alone).
 *  - Best-effort: errors are logged and swallowed; no caller wants
 *    their product save to fail because R2 had a hiccup.
 *  - Run AFTER the DB transaction commits. Calling inside the
 *    transaction would let a transient R2 failure roll back legitimate
 *    DB edits.
 *
 * Call from anywhere a row that owns an R2 image is being replaced or
 * deleted (product update, variant update, category update, etc.).
 */

/** Convert a DB-stored URL to its R2 object key, or null if foreign. */
export function urlToR2Key(url: string | null | undefined): string | null {
  if (!url) return null;
  if (config.storagePublicUrl && url.startsWith(config.storagePublicUrl + '/')) {
    return url.slice(config.storagePublicUrl.length + 1);
  }
  if (config.storageEndpoint && config.storageBucket) {
    const endpointPrefix = `${config.storageEndpoint}/${config.storageBucket}/`;
    if (url.startsWith(endpointPrefix)) {
      return url.slice(endpointPrefix.length);
    }
  }
  return null;
}

/**
 * True when at least one live row anywhere in the schema still
 * references this URL. Checks every table that the orphan-audit script
 * tracks — keep in sync when a new image-bearing column is added.
 *
 * Tables covered: productImage.url, productVariant.imageUrl,
 * category.image, storePage.coverImage, blogPost.coverImage,
 * store.(logo|logoAr|heroImage|ogImage|favicon), user.avatar.
 */
async function isStillReferenced(url: string): Promise<boolean> {
  // Run all the existence checks; any single match is enough to abort the
  // delete. Using `findFirst` + `select: { id }` keeps each query as a
  // one-row index probe.
  //
  // Under `withRlsBypass`, because "is this URL referenced ANYWHERE" is a
  // cross-store question (cloned demo stores share image URLs). Callers run
  // this inside a store's tenant transaction (deferred work) or with no
  // context at all; under `force_app` the first hid every other store's rows
  // and the second hid EVERY `blog_posts` row (strict policy), so a still-used
  // image read as orphaned and was deleted from R2.
  const [
    pi,
    pv,
    cat,
    page,
    blog,
    storeLogo,
    storeLogoAr,
    storeHero,
    storeOg,
    storeFavicon,
    userAvatar,
  ] = await withRlsBypass(tx =>
    Promise.all([
      tx.productImage.findFirst({ where: { url }, select: { id: true } }),
      tx.productVariant.findFirst({ where: { imageUrl: url }, select: { id: true } }),
      tx.category.findFirst({ where: { image: url }, select: { id: true } }),
      tx.storePage.findFirst({ where: { coverImage: url }, select: { id: true } }),
      tx.blogPost.findFirst({ where: { coverImage: url }, select: { id: true } }),
      tx.store.findFirst({ where: { logo: url }, select: { id: true } }),
      tx.store.findFirst({ where: { logoAr: url }, select: { id: true } }),
      tx.store.findFirst({ where: { heroImage: url }, select: { id: true } }),
      tx.store.findFirst({ where: { ogImage: url }, select: { id: true } }),
      tx.store.findFirst({ where: { favicon: url }, select: { id: true } }),
      tx.user.findFirst({ where: { avatar: url }, select: { id: true } }),
    ])
  );
  return Boolean(
    pi ||
    pv ||
    cat ||
    page ||
    blog ||
    storeLogo ||
    storeLogoAr ||
    storeHero ||
    storeOg ||
    storeFavicon ||
    userAvatar
  );
}

/**
 * Delete the R2 object backing `url` if it's safe to do so.
 *
 * "Safe" = the URL is in our bucket, AND no DB row still points at it.
 * Errors are logged and swallowed — never propagated to the caller.
 *
 * This is intended to be called AFTER the DB write that removed the
 * row: by the time we run, the new `images` array is already saved,
 * so an existence check sees the post-write state and won't flag
 * "still referenced" against the row we just deleted.
 */
export async function deleteR2ObjectIfOrphan(url: string | null | undefined): Promise<void> {
  // Every caller fires this AFTER its own write, without awaiting, so under a
  // store-scoped request it used to run on the request's tenant transaction
  // AFTER that transaction committed: `isStillReferenced` below issues ELEVEN
  // Prisma queries, all of which died with P2028 and were swallowed by the
  // `catch` at the bottom of this function as "[r2-cleanup] failed to delete
  // orphan R2 object". The object then leaked — the exact failure this
  // service was written to prevent. Deferring runs the same work in a fresh
  // tenant transaction once the request's has committed; outside a request
  // (Inngest, crons, scripts) it still executes inline, unchanged.
  await deferAfterTenantCommit('r2-cleanup.deleteOrphan', () => deleteR2ObjectIfOrphanNow(url));
}

async function deleteR2ObjectIfOrphanNow(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const key = urlToR2Key(url);
  if (!key) {
    // External URL (storefront pasted in a Picsum / CDN URL, etc.) —
    // not ours to touch.
    return;
  }
  if (!StorageService.isAvailable()) {
    return;
  }
  try {
    const stillUsed = await isStillReferenced(url);
    if (stillUsed) {
      logger.info({ key, url }, '[r2-cleanup] skipping delete — URL still referenced elsewhere');
      return;
    }
    await StorageService.delete(key);
    logger.info({ key }, '[r2-cleanup] deleted orphan R2 object');
  } catch (err) {
    // Best-effort. Don't surface to the caller — the merchant just
    // saved a product, they shouldn't see "save failed" because R2
    // 503'd a delete request.
    logger.warn({ err, key, url }, '[r2-cleanup] failed to delete orphan R2 object');
  }
}

/**
 * Diff `oldUrls` against `newUrls` and asynchronously clean up any URL
 * that disappeared. Runs concurrently with reasonable bounds.
 *
 * Returns immediately — never awaits the cleanup itself, so callers
 * can fire-and-forget without blocking the request response. The
 * function still awaits internally so the Node process keeps the work
 * alive until it finishes (no detached promises that can be GC'd).
 */
export function cleanupRemovedImages(
  oldUrls: Array<string | null | undefined>,
  newUrls: Array<string | null | undefined>
): Promise<void> {
  const newSet = new Set(newUrls.filter((u): u is string => Boolean(u)));
  const removed = oldUrls.filter(
    (u): u is string => typeof u === 'string' && u.length > 0 && !newSet.has(u)
  );
  if (removed.length === 0) return Promise.resolve();
  return Promise.all(removed.map(url => deleteR2ObjectIfOrphan(url))).then(() => undefined);
}

/**
 * Recursively walk a JSON value (object / array / string) and collect
 * every string that looks like an http(s) URL. Used by JSON-blob columns
 * (Store.layoutSettings, announcementBar, etc.) where image URLs may be
 * nested arbitrarily — mirrors the walker in scripts/r2-orphan-audit.ts
 * so the runtime cleanup and the periodic audit see the same surface.
 */
export function collectUrlsFromJson(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (v.startsWith('http://') || v.startsWith('https://')) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === 'object') {
      for (const inner of Object.values(v as Record<string, unknown>)) visit(inner);
    }
  };
  visit(value);
  return out;
}

/**
 * Diff two JSON blobs by the URLs they contain and clean up any URL
 * that disappeared. Use this for JSON columns like
 * `Store.layoutSettings` (hero slides, banner blocks, etc.) where the
 * admin replaces the whole blob on save — without this diff, every
 * banner-image swap leaks the previous R2 object.
 */
export function cleanupRemovedJsonUrls(oldJson: unknown, newJson: unknown): Promise<void> {
  return cleanupRemovedImages(collectUrlsFromJson(oldJson), collectUrlsFromJson(newJson));
}
