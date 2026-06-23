/**
 * View Ingest Service
 *
 * Records storefront product page views as per-day aggregates in
 * `product_daily_views`. One row per (storeId, productId, date) — a counter,
 * not an event log. Designed for high-traffic, unauthenticated, fire-and-forget
 * use from the PDP beacon.
 *
 * Rate-limiting strategy (two layers):
 *  1. `viewIngestLimiter` on the route (Redis-backed, shared per-IP, 60/min).
 *  2. `sessionViewDebounce` in-memory BoundedMap — one increment per
 *     (sessionId, productId) per 10-minute window so a tab reload, aggressive
 *     prefetch, or bot that rotates IPs can't inflate counts.
 *
 * Scaling: uses a raw `$executeRaw` upsert (INSERT … ON CONFLICT DO UPDATE)
 * so one SQL round-trip handles the counter increment without a separate read.
 * The `withRlsBypass` wrapper is required because this runs outside a tenant
 * context (public endpoint, no JWT) and the table has RLS enabled.
 */

import { prisma, withRlsBypass } from '@force/database';
import { BoundedMap } from '../lib/bounded-map';
import logger from '../lib/logger';

// ---------------------------------------------------------------------------
// Kuwait timezone helper (mirrors analytics-rollup.service.ts)
// ---------------------------------------------------------------------------
const KW_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Returns the current day's date at UTC midnight aligned to Kuwait calendar day
 * (KW midnight = UTC 21:00 previous day). This is the same logic the rollup
 * uses for FunnelSnapshot periodDate, so the JOIN is exact.
 */
function kwDayStart(d: Date = new Date()): Date {
  const kwMs = d.getTime() + KW_OFFSET_MS;
  const dayMs = Math.floor(kwMs / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
  return new Date(dayMs - KW_OFFSET_MS);
}

// ---------------------------------------------------------------------------
// In-memory session debounce
// ---------------------------------------------------------------------------
// Keyed by `${sessionId}:${productId}`, value = expiry timestamp (ms).
// BoundedMap caps at 50_000 entries (~50k concurrent session+product pairs).
// Entries expire after 10 minutes so a genuine re-visit later in the day
// is still counted once per 10 min window (not deduplicated for the whole day).
const SESSION_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_DEBOUNCE_ENTRIES = 50_000;
const sessionViewDebounce = new BoundedMap<string, number>(MAX_DEBOUNCE_ENTRIES);

// Periodic cleanup: remove expired debounce entries every 5 minutes to prevent
// false positives once the BoundedMap starts evicting the oldest entry.
const _cleanupInterval = setInterval(
  () => {
    const now = Date.now();
    for (const [key, expiresAt] of sessionViewDebounce) {
      if (expiresAt <= now) sessionViewDebounce.delete(key);
    }
  },
  5 * 60 * 1000
);

// Allow Jest teardown to clear this interval (see CI/CD standard in CLAUDE.md).
export function clearViewDebounceInterval(): void {
  clearInterval(_cleanupInterval);
}

// ---------------------------------------------------------------------------
// Core ingest function
// ---------------------------------------------------------------------------

/**
 * Increments the daily view counter for a product. Silently no-ops on any
 * error (fail-open: a tracking failure must never surface to the storefront).
 *
 * @param storeId   - UUID of the store (already validated by the route).
 * @param productId - UUID of the product (already verified to belong to store).
 * @param sessionId - Optional browser session id for debouncing.
 * @returns true if the counter was incremented, false if debounced/no-op.
 */
export async function recordProductView(
  storeId: string,
  productId: string,
  sessionId?: string
): Promise<boolean> {
  // Session-level debounce: one count per (session, product) per 10 min window.
  if (sessionId) {
    const key = `${sessionId}:${productId}`;
    const expiresAt = sessionViewDebounce.get(key);
    const now = Date.now();
    if (expiresAt && expiresAt > now) {
      // Already counted within the debounce window.
      return false;
    }
    sessionViewDebounce.set(key, now + SESSION_DEBOUNCE_MS);
  }

  const date = kwDayStart();

  try {
    // Single-round-trip upsert: increment count or create a new row for today.
    // We bypass RLS because this runs outside a tenant JWT context.
    await withRlsBypass(
      tx =>
        tx.$executeRaw`
        INSERT INTO product_daily_views (id, store_id, product_id, date, count)
        VALUES (gen_random_uuid(), ${storeId}, ${productId}, ${date}, 1)
        ON CONFLICT (store_id, product_id, date)
        DO UPDATE SET count = product_daily_views.count + 1
      `
    );
    return true;
  } catch (err) {
    // Fail-open: never propagate a tracking failure to the caller.
    logger.warn(
      { err: err instanceof Error ? err.message : 'unknown', storeId, productId },
      '[VIEW-INGEST] failed to record product view — tracking skipped'
    );
    return false;
  }
}
