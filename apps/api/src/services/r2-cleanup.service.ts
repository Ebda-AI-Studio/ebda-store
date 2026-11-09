import { platformD1ReferencedKeys } from '../lib/r2-platform-d1-references';
import { storeHasNoDataHere } from '../lib/store-pg-gone';
import { currentStoreId, storeDirectory, withStore } from '@ebda/database';
import { config } from '../config';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { StorageService } from './storage.service';
import { collectUrlsFromJson, isR2UrlReferenced } from '../lib/r2-references';
import { collectDoStoreReferencedKeys } from '../lib/r2-do-references';
import logger from '../lib/logger';

/**
 * Helper that deletes R2 objects when their last DB reference goes away.
 *
 * Why this exists: before this service, replacing a product image (admin
 * UI edits the gallery and saves) deleted the `product_images` row but
 * NEVER deleted the underlying R2 object. Every edit leaked storage,
 * and the leaked objects then made periodic orphan-audit cleanups
 * dangerous (it became hard to tell "real orphan" from "in-flight
 * upload"). One Demo Boutique's worth of data already vanished that way — the
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
 * True when `key` is an object of store `storeId`: it sits under that store's own namespace
 * (`stores/<storeId>/...`, how every upload is keyed, `StorageService.composeKey`). An exact
 * prefix, so `stores/abc/` never matches `stores/abcd/`, and no `..` segment.
 */
export function r2KeyBelongsToStore(
  key: string,
  storeId: string,
  opts: { legacyFlat?: boolean } = {}
): boolean {
  if (!storeId || key.split('/').includes('..')) return false;
  if (key.startsWith(`stores/${storeId}/`)) return true;
  // The oldest uploads were keyed `<storeId>/...` (no `stores/` namespace); only the explicit file
  // delete route still honours them.
  return opts.legacyFlat === true && key.startsWith(`${storeId}/`);
}

/** The store the current code is scoped to, or null (a user-scoped request, a cron). */
function ambientStoreId(): string | null {
  try {
    return currentStoreId();
  } catch {
    return null;
  }
}

/**
 * Whether the CURRENT scope may delete `key`. The URL that led here is usually merchant-controlled
 * (a font, a hero slide, a category image the merchant saved), and "no row anywhere still references
 * it" is not "it is mine": a merchant who pastes another store's object URL into a field and then
 * removes it would otherwise delete that store's object whenever the owner has not saved it yet
 * (an upload not yet attached, an object only in a pending draft). So:
 *  - inside a store scope, only that store's own namespace may be deleted;
 *  - outside one (a user-scoped request, a cron), a store-namespaced key is never deleted, because
 *    no store has been proven to own it; only the legacy flat keys (platform uploads) remain.
 */
export function mayDeleteKey(key: string, ownerStoreId?: string | null): boolean {
  const ambient = ambientStoreId();
  // A caller that knows whose object this is (an erased user's avatar belongs to the user's own
  // store) says so; the scope it runs in must not contradict it.
  if (ownerStoreId) {
    if (ambient && ambient !== ownerStoreId) return false;
    return r2KeyBelongsToStore(key, ownerStoreId);
  }
  if (ambient) return r2KeyBelongsToStore(key, ambient);
  return !key.startsWith('stores/');
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
 * Read store by store (see the body), because "is this URL referenced ANYWHERE"
 * is a cross-store question (cloned demo stores share image URLs) and every
 * registered column is store-scoped under strict RLS. Callers run this inside a
 * store's tenant transaction (deferred work) or with no context at all; a
 * contextless read of a strict table sees NOTHING, so a still-used image would
 * read as orphaned and be deleted from R2. KNOWN GAP: `users.avatar` of an
 * admin-namespace account (store_id NULL) is visible in no store scope; an admin
 * avatar is never shared between accounts, so the per-URL check cannot be fooled
 * by it, but the bulk orphan sweep (owner-role only) does read it.
 */
async function isStillReferenced(url: string, key: string): Promise<boolean> {
  // Store by store: each registered column (including the store's own brand columns:
  // `stores` is under RLS too, R-EBDA-005) is store-scoped, so "referenced ANYWHERE" is
  // the OR over every store's own view. Soft-deleted stores count (the safe direction).
  // Stops at the first store that still references it.
  const stores = await storeDirectory(undefined, { includeDeleted: true });
  for (const { id } of stores) {
    // A Postgres-flagged store on a Worker with no Postgres (the soft-deleted qa-merchant-test) has no rows to read here; its
    // withStore would throw POSTGRES_REMOVED, the caller would KEEP every object, and no image would ever be deleted again.
    if (await storeHasNoDataHere(id)) continue;
    const referenced = await withStore(id, async tx => {
      // issue 2249: the substring half of the check is a full scan of the
      // JSON/HTML columns. Bound how long it may hold its connection; a timeout
      // (57014) throws, and the caller's catch then KEEPS the object — the safe
      // direction (a leaked file, never a deleted live one).
      // set_config(…, true) is SET LOCAL with a bound parameter.
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(ORPHAN_CHECK_STATEMENT_TIMEOUT_MS)}, true)`;
      return isR2UrlReferenced(tx, url, key);
    });
    if (referenced) return true;
    // A store on its Durable Object (Ruling CF-R2-REF-1): its Postgres rows are sealed and stale, so its DO is asked too. A DO that
    // cannot be read THROWS, and the caller's catch KEEPS the object (a leaked file, never a deleted live one).
    const doKeys = await collectDoStoreReferencedKeys(id, urlToR2Key, key);
    if (doKeys?.has(key)) return true;
  }
  // Platform tables that moved to D1 (N-10d): their Postgres rows are stale, so D1 is asked too (a throw keeps the object).
  return (await platformD1ReferencedKeys(urlToR2Key, key)).has(key);
}

/** Per-statement ceiling for the orphan check (ms). See isStillReferenced. */
export const ORPHAN_CHECK_STATEMENT_TIMEOUT_MS = 5000;

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
export async function deleteR2ObjectIfOrphan(
  url: string | null | undefined,
  opts: { ownerStoreId?: string | null } = {}
): Promise<void> {
  // Every caller fires this AFTER its own write, without awaiting, so under a
  // store-scoped request it used to run on the request's tenant transaction
  // AFTER that transaction committed: `isStillReferenced` then issued ELEVEN
  // Prisma queries (one statement now), all of which died with P2028 and were swallowed by the
  // `catch` at the bottom of this function as "[r2-cleanup] failed to delete
  // orphan R2 object". The object then leaked — the exact failure this
  // service was written to prevent. Deferring runs the same work in a fresh
  // tenant transaction once the request's has committed; outside a request
  // (Inngest, crons, scripts) it still executes inline, unchanged.
  // `connections: 2` — the orphan check opens a `withRlsBypass` transaction
  // while the task's own tenant transaction is still held (issue 2250), so the
  // global deferred-work cap must count it twice.
  await deferAfterTenantCommit(
    'r2-cleanup.deleteOrphan',
    () => deleteR2ObjectIfOrphanNow(url, opts.ownerStoreId),
    {
      connections: 2,
    }
  );
}

async function deleteR2ObjectIfOrphanNow(
  url: string | null | undefined,
  ownerStoreId?: string | null
): Promise<void> {
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
  if (!mayDeleteKey(key, ownerStoreId)) {
    // Defence in depth, independent of whatever validated the URL on the way in.
    logger.warn({ key }, '[r2-cleanup] refused to delete an object outside the current store');
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
  // `connections: 2`: each check nests a `withRlsBypass` transaction inside
  // the task's own tenant transaction (issue 2250) — sequential, so never
  // more than two at once.
  return deferAfterTenantCommit(
    'r2-cleanup.deleteRemoved',
    async () => {
      for (const url of removed) {
        await deleteR2ObjectIfOrphanNow(url);
      }
    },
    { connections: 2 }
  ).then(() => undefined);
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
