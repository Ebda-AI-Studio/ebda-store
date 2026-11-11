/**
 * S3-X8: per-store R2 usage, summed from the bucket listing under `stores/<id>/`.
 *
 * Staleness class: BOUNDED-stale. A short in-memory TTL (60 s) is enough because the cap is a
 * plan ceiling, not money or permissions; the residual is one burst of uploads inside the window
 * overshooting by at most that window's uploads. The upload gate adds the incoming bytes itself.
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

export async function cachedStoreBytes(
  storeId: string,
  list: ListPage,
  now: number = Date.now()
): Promise<number> {
  const hit = cache.get(storeId);
  if (hit && now - hit.at < USAGE_TTL_MS) return hit.bytes;
  const bytes = await sumStoreBytes(list);
  cache.set(storeId, { at: now, bytes });
  return bytes;
}

export function resetStorageUsageCache(): void {
  cache.clear();
}

export const BYTES_PER_MB = 1024 * 1024;
