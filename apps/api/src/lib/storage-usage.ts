/**
 * S3-X8: per-store R2 usage, summed from the bucket listing under `stores/<id>/`.
 *
 * Staleness class: BOUNDED-stale. A short in-memory TTL (60 s) is enough because the cap is a
 * plan ceiling, not money or permissions. A burst inside the window no longer overshoots: the upload gate
 * RESERVES each upload's bytes in this cache synchronously (`reserveStoreBytes`) before it returns, so the next
 * request sees them. Residual: an upload that is reserved but then fails keeps its bytes counted until the TTL
 * re-lists the bucket (over-counts, never under-counts).
 */
export interface UsagePage {
  sizes: number[];
  nextCursor: string | null;
}
export type ListPage = (cursor: string | undefined) => Promise<UsagePage>;

/** 50 pages x 1000 keys. Past this the store is reported as AT LEAST that much (never under-counted to zero). */
export const USAGE_MAX_PAGES = 50;
export const USAGE_TTL_MS = 60_000;

export async function sumStoreBytes(list: ListPage, maxPages = USAGE_MAX_PAGES): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await list(cursor);
    for (const s of page.sizes) total += s;
    if (!page.nextCursor) return total;
    cursor = page.nextCursor;
  }
  return total;
}

const cache = new Map<string, { at: number; bytes: number }>();

/** One in-flight listing per store: a cold burst shares it, so no listing overwrites another request's reservation. */
const inflight = new Map<string, Promise<number>>();

export async function cachedStoreBytes(
  storeId: string,
  list: ListPage,
  now: number = Date.now()
): Promise<number> {
  const hit = cache.get(storeId);
  if (hit && now - hit.at < USAGE_TTL_MS) return hit.bytes;
  let p = inflight.get(storeId);
  if (!p) {
    p = sumStoreBytes(list)
      .then(bytes => {
        cache.set(storeId, { at: now, bytes });
        return bytes;
      })
      .finally(() => inflight.delete(storeId));
    inflight.set(storeId, p);
  }
  return p;
}

/**
 * Atomic check-and-reserve against the cached usage: if `used + bytes` (rounded up to whole MB, as the gate always
 * did) fits in `limitMb`, add `bytes` to the cache and return `{ ok: true }`; otherwise return `{ ok: false, usedBytes }`
 * and change nothing. Fully synchronous, so concurrent requests on one isolate cannot interleave between the check
 * and the add. `null` = no live cache entry (caller falls back to its plain check).
 */
export function reserveStoreBytes(
  storeId: string,
  bytes: number,
  limitMb: number,
  now: number = Date.now()
): { ok: boolean; usedBytes: number } | null {
  const hit = cache.get(storeId);
  if (!hit || now - hit.at >= USAGE_TTL_MS) return null;
  if (Math.ceil((hit.bytes + bytes) / BYTES_PER_MB) > limitMb)
    return { ok: false, usedBytes: hit.bytes };
  hit.bytes += bytes;
  return { ok: true, usedBytes: hit.bytes };
}

/** Undo a reservation (floors at 0). */
export function releaseStoreBytes(storeId: string, bytes: number): void {
  const hit = cache.get(storeId);
  if (hit) hit.bytes = Math.max(0, hit.bytes - bytes);
}

/** A held reservation; `release()` is idempotent and a no-op when nothing was reserved. */
export interface StorageReservation {
  release(): void;
}
export const NO_RESERVATION: StorageReservation = { release() {} };

/**
 * Give the bytes back when the request ends in an error (any status >= 400, thrown or answered), so a failed
 * upload does not count against the ceiling until the TTL. `room` may be undefined (mocked gate).
 */
export function releaseOnFailure(
  res: { statusCode: number; once(ev: 'finish' | 'close', fn: () => void): unknown },
  room: StorageReservation | void
): void {
  if (!room) return;
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    if (res.statusCode >= 400) room.release();
  };
  res.once('finish', settle);
  res.once('close', settle);
}

export function resetStorageUsageCache(): void {
  cache.clear();
  inflight.clear();
}

export const BYTES_PER_MB = 1024 * 1024;
