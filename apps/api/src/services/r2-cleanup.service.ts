import { withRlsBypass } from '@force/database';
import { config } from '../config';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { StorageService } from './storage.service';
import { collectUrlsFromJson, isR2UrlReferenced } from '../lib/r2-references';
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
 *    same URL — every column in the shared `R2_REFERENCE_COLUMNS`
 *    registry (lib/r2-references.ts), JSON and HTML columns included.
 *    This is a targeted version of `scripts/r2-orphan-audit.ts`'s
 *    cross-table sweep, scoped to a single URL so it's cheap.
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
 * True when at least one live row anywhere in the schema still references
 * this URL. The column set is the shared registry in
 * `lib/r2-references.ts` — the SAME one the orphan-audit script and the
 * weekly sweep read — so a new image-bearing column is added in one place and
 * `tests/unit/r2-reference-registry.test.ts` fails until it is.
 *
 * One statement, not one query per column: it ORs an EXISTS per table.
 *
 * Under `withRlsBypass`, because "is this URL referenced ANYWHERE" is a
 * cross-store question (cloned demo stores share image URLs). Callers run
 * this inside a store's tenant transaction (deferred work) or with no
 * context at all; under `force_app` the first hid every other store's rows
 * and the second hid EVERY `blog_posts` row (strict policy), so a still-used
 * image read as orphaned and was deleted from R2.
 */
async function isStillReferenced(url: string, key: string): Promise<boolean> {
  return withRlsBypass(tx => isR2UrlReferenced(tx, url, key));
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
  // AFTER that transaction committed: `isStillReferenced` then issued ELEVEN
  // Prisma queries (one statement now), all of which died with P2028 and were swallowed by the
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
    const stillUsed = await isStillReferenced(url, key);
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
 * The URLs are checked sequentially — see the body (issue 2042).
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
  // ONE AT A TIME (issue 2042). Each check opens its own `withRlsBypass`
  // transaction, i.e. pins a pooled connection. Inside a request the calls
  // are deferred and drained sequentially anyway, but OUTSIDE one (Inngest
  // bulk import, crons, scripts) a `Promise.all` turned N removed images into
  // N concurrent pinned transactions against DB_CONNECTION_LIMIT (15), shared
  // with storefront traffic — the losers timed out on `maxWait`, the catch
  // swallowed it, and the R2 objects leaked. This is post-response cleanup;
  // latency does not matter, connection pressure does.
  //
  // Queued as ONE deferred task, synchronously: inside a request it must be
  // registered before the handler returns (a later `deferAfterTenantCommit`
  // from a still-running loop would arrive after the scope closed), and the
  // drain then runs the whole list in one fresh tenant transaction.
  return deferAfterTenantCommit('r2-cleanup.deleteRemoved', async () => {
    for (const url of removed) {
      await deleteR2ObjectIfOrphanNow(url);
    }
  }).then(() => undefined);
}

/**
 * JSON URL walker — lives in `lib/r2-references.ts` so the runtime cleanup,
 * the weekly sweep and the audit script all see the same surface.
 */
export { collectUrlsFromJson };

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
