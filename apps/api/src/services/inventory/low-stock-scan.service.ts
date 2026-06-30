/**
 * Low-Stock Scan Service
 *
 * Called by the Inngest `stock-low-stock-alert` cron (every 6 h) or on-demand.
 *
 * Algorithm:
 *   1. Load all active, trackInventory products where inventory > 0
 *      AND inventory <= lowStockThreshold (in-stock-but-low).
 *   2. Dedup via Redis sentinels (key: `low-stock-alerted:{storeId}:{productId}`):
 *      - Skip a product if its sentinel already exists (already alerted since last restock).
 *      - Set the sentinel after building the digest so a future run is a no-op
 *        until the merchant restocks above the threshold.
 *   3. In the SAME scan, clear sentinels for products now back ABOVE threshold
 *      so the next drop re-alerts.
 *   4. Return the digest (bilingual list) for the Inngest function to email.
 *
 * RLS note: the entire scan runs inside withRlsBypass because Inngest cron
 * jobs have no tenant GUC in context — mirrors the reorder-scan and dead-stock
 * scan pattern exactly.
 *
 * Recipient: the store owner's email address (User.email where User.id = Store.ownerId).
 * This is consistent with the owner being the admin managing the store.
 */

import { withRlsBypass } from '@force/database';
import { redis } from '../redis.service';
import logger from '../../lib/logger';
import type { LowStockAlertItem } from '../email-templates/low-stock-alert';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Sentinel key prefix. Full key: `low-stock-alerted:{storeId}:{productId}`
// ioredis transparently applies REDIS_KEY_PREFIX (e.g. `fwb-staging:`) so
// we don't need to embed the env prefix here.
export const SENTINEL_KEY_PREFIX = 'low-stock-alerted';

// Backstop TTL (30 days). If the sentinel is never cleared by a restock event
// the scan will clear it and re-alert after 30 days for persistent low stock.
// This also prevents orphaned keys from accumulating forever.
export const SENTINEL_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LowStockScanResult {
  /** Products included in the digest (sentinel was NOT set before this run). */
  alertedProducts: LowStockAlertItem[];
  /** Products restocked above threshold (sentinels cleared). */
  clearedCount: number;
  /** Products already alerted and still low (sentinels existed, skipped). */
  skippedCount: number;
  /** Store owner email — the send target resolved during the scan. */
  recipientEmail: string | null;
}

// ---------------------------------------------------------------------------
// Sentinel helpers
// ---------------------------------------------------------------------------

function sentinelKey(storeId: string, productId: string): string {
  return `${SENTINEL_KEY_PREFIX}:${storeId}:${productId}`;
}

/**
 * Single-key sentinel read. The scan itself uses the batched `readSentinels`
 * below, but this stays exported as a verification API for tests and any
 * future per-product caller. Falls back to `false` (over-alert) when Redis is
 * unavailable — better than silently missing a low-stock condition.
 */
export async function isSentinelSet(storeId: string, productId: string): Promise<boolean> {
  try {
    const client = redis.getClient();
    if (!client) return false;
    return (await client.exists(sentinelKey(storeId, productId))) === 1;
  } catch (err) {
    logger.warn({ err, storeId, productId }, 'low-stock-scan: sentinel read failed, proceeding');
    return false;
  }
}

/**
 * Single-key sentinel write — sets the dedup sentinel for (storeId, productId)
 * with the 30-day backstop TTL. The scan uses the batched `writeSentinels`; this
 * stays exported for tests and restock-event callers.
 */
export async function setSentinel(storeId: string, productId: string): Promise<void> {
  try {
    const client = redis.getClient();
    if (!client) return;
    await client.setex(sentinelKey(storeId, productId), SENTINEL_TTL_SECONDS, '1');
  } catch (err) {
    logger.warn({ err, storeId, productId }, 'low-stock-scan: sentinel write failed');
  }
}

/**
 * Single-key sentinel clear — clears the dedup sentinel for (storeId, productId)
 * so the next drop re-alerts. The scan uses the batched `writeSentinels`; this
 * stays exported for tests and restock-event callers.
 */
export async function clearSentinel(storeId: string, productId: string): Promise<void> {
  try {
    const client = redis.getClient();
    if (!client) return;
    await client.del(sentinelKey(storeId, productId));
  } catch (err) {
    logger.warn({ err, storeId, productId }, 'low-stock-scan: sentinel clear failed');
  }
}

// ---------------------------------------------------------------------------
// Main export: runLowStockScan
// ---------------------------------------------------------------------------

export async function runLowStockScan(storeId: string): Promise<LowStockScanResult> {
  // -------------------------------------------------------------------------
  // Step 1: DB reads ONLY inside withRlsBypass.
  //
  // withRlsBypass opens an *interactive* Postgres transaction (no tenant GUC,
  // so an Inngest cron can read past FORCE RLS). It is critical that NOTHING
  // slow runs inside it: the per-product Redis sentinel round-trips used to
  // live in here, and on a large catalogue N sequential Redis calls serialized
  // inside the transaction blew the 30s interactive-tx timeout
  // ("Transaction already closed ... 39532 ms passed"). Keep this block to the
  // two reads and get out fast — all sentinel I/O happens AFTER, off the tx.
  // -------------------------------------------------------------------------
  const data = await withRlsBypass(async tx => {
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        settings: true,
        owner: {
          select: { email: true },
        },
      },
    });

    if (!store) return null;

    // Load active, trackInventory products. We load all of them (not just the
    // low ones) so we can also clear sentinels for products now back above
    // threshold or exhausted.
    const products = await tx.product.findMany({
      where: {
        storeId,
        trackInventory: true,
        deletedAt: null,
        status: 'active',
        // Only products that have a defined threshold can be evaluated.
        // lowStockThreshold defaults to 5 in the schema — always set.
        lowStockThreshold: { gt: 0 },
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        inventory: true,
        lowStockThreshold: true,
      },
    });

    return { store, products };
  });

  if (!data) {
    logger.warn({ storeId }, 'low-stock-scan: store not found, aborting');
    return { alertedProducts: [], clearedCount: 0, skippedCount: 0, recipientEmail: null };
  }

  const { store, products } = data;
  const recipientEmail = store.owner?.email ?? null;

  // -------------------------------------------------------------------------
  // Step 2: Classify + manage sentinels OUTSIDE the transaction.
  //
  // Batch the Redis reads/writes with pipelines so the whole scan is ~3 round-
  // trips regardless of catalogue size (was 3N sequential round-trips). When
  // Redis is unavailable we treat every sentinel as unset (over-alert rather
  // than silently miss a low-stock condition) — same fallback as before.
  // -------------------------------------------------------------------------
  const sentinelExists = await readSentinels(
    storeId,
    products.map(p => p.id)
  );

  const alertedProducts: LowStockAlertItem[] = [];
  const toClear: string[] = [];
  let clearedCount = 0;
  let skippedCount = 0;

  for (const product of products) {
    const threshold = product.lowStockThreshold ?? 5;
    const isLow = product.inventory > 0 && product.inventory <= threshold;
    const alerted = sentinelExists.get(product.id) === true;

    if (!isLow) {
      // Back above threshold OR out-of-stock (inventory === 0). Clear the
      // sentinel so the next drop re-alerts, but only if one actually exists.
      if (alerted) {
        toClear.push(product.id);
        clearedCount++;
      }
      continue;
    }

    // Product is in low-stock range (0 < inventory <= threshold).
    if (alerted) {
      skippedCount++;
      continue;
    }

    // New low-stock hit — include in digest.
    alertedProducts.push({
      productId: product.id,
      name: product.name,
      nameAr: product.nameAr,
      inventory: product.inventory,
      lowStockThreshold: threshold,
    });
  }

  // Set sentinels for newly-alerted products AFTER building the digest, and
  // clear restocked ones — both batched into a single pipeline.
  await writeSentinels(
    storeId,
    alertedProducts.map(p => p.productId),
    toClear
  );

  logger.info(
    {
      storeId,
      alerted: alertedProducts.length,
      cleared: clearedCount,
      skipped: skippedCount,
      hasRecipient: !!recipientEmail,
    },
    'low-stock-scan completed'
  );

  return { alertedProducts, clearedCount, skippedCount, recipientEmail };
}

/**
 * Batch-reads sentinel existence for a list of product ids in ONE Redis
 * pipeline. Returns a map of productId -> exists. On any Redis error (or no
 * client) returns an empty map, which callers read as "not set" (over-alert).
 */
async function readSentinels(storeId: string, productIds: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (productIds.length === 0) return result;
  try {
    const client = redis.getClient();
    if (!client) return result;
    const pipeline = client.pipeline();
    for (const id of productIds) pipeline.exists(sentinelKey(storeId, id));
    const replies = await pipeline.exec();
    if (!replies) return result;
    productIds.forEach((id, i) => {
      const [err, val] = replies[i] ?? [];
      if (!err) result.set(id, val === 1);
    });
  } catch (err) {
    logger.warn({ err, storeId }, 'low-stock-scan: batch sentinel read failed, proceeding');
  }
  return result;
}

/**
 * Batch-writes sentinel state in ONE Redis pipeline: SETEX for newly-alerted
 * products (30-day backstop TTL) and DEL for restocked/exhausted ones.
 */
async function writeSentinels(storeId: string, toSet: string[], toClear: string[]): Promise<void> {
  if (toSet.length === 0 && toClear.length === 0) return;
  try {
    const client = redis.getClient();
    if (!client) return;
    const pipeline = client.pipeline();
    for (const id of toSet) pipeline.setex(sentinelKey(storeId, id), SENTINEL_TTL_SECONDS, '1');
    for (const id of toClear) pipeline.del(sentinelKey(storeId, id));
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, storeId }, 'low-stock-scan: batch sentinel write failed');
  }
}
