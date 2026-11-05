/**
 * Expired catalogue-import uploads sweep (Ruling CATIMP-6).
 *
 * `purgeExpiredJobs` only runs when a store opens its import list, so an inactive store's
 * originals would sit in the private bucket for ever. This walks `stores/<id>/catalogimport-*`
 * and deletes every object older than the 30-day retention plus a 1-day grace. R2 cannot
 * wildcard a prefix, so it lists the store prefixes (delimiter) and then lists each store's
 * `catalogimport-` prefix. No database read: object age is the clock, and a job row that outlives
 * its objects is already handled (a missing original fails that file, uncharged).
 *
 * Idempotent: a second run over the same bucket finds nothing older than the cutoff. A delete
 * that fails is counted and left for the next run. Logs counts only, never keys or store ids.
 */
export const CATALOGUE_UPLOAD_MAX_AGE_MS = 31 * 86_400_000;
/** Per-run cap so one run stays bounded; the next daily run continues. */
export const SWEEP_MAX_DELETES = 5_000;

const KEY_RE = /^stores\/[^/]+\/catalogimport-[^/]+\/.+$/;

export interface SweepBucket {
  /** `stores/<id>/` prefixes, one per store. */
  listStorePrefixes(): Promise<string[]>;
  listObjects(prefix: string): Promise<Array<{ key: string; lastModified?: Date }>>;
  deleteObjects(keys: string[]): Promise<{ deleted: number; failed: number }>;
}

export interface SweepResult {
  storesScanned: number;
  objectsSeen: number;
  expired: number;
  deleted: number;
  failed: number;
  capped: boolean;
}

export async function sweepExpiredCatalogueUploads(
  bucket: SweepBucket,
  now: Date = new Date()
): Promise<SweepResult> {
  const cutoff = now.getTime() - CATALOGUE_UPLOAD_MAX_AGE_MS;
  const result: SweepResult = {
    storesScanned: 0,
    objectsSeen: 0,
    expired: 0,
    deleted: 0,
    failed: 0,
    capped: false,
  };
  for (const storePrefix of await bucket.listStorePrefixes()) {
    if (result.expired >= SWEEP_MAX_DELETES) {
      result.capped = true;
      break;
    }
    result.storesScanned++;
    const objects = await bucket.listObjects(`${storePrefix}catalogimport-`);
    result.objectsSeen += objects.length;
    const stale = objects
      .filter(o => KEY_RE.test(o.key) && o.lastModified && o.lastModified.getTime() < cutoff)
      .map(o => o.key)
      .slice(0, SWEEP_MAX_DELETES - result.expired);
    if (stale.length === 0) continue;
    result.expired += stale.length;
    const r = await bucket.deleteObjects(stale);
    result.deleted += r.deleted;
    result.failed += r.failed;
  }
  return result;
}
