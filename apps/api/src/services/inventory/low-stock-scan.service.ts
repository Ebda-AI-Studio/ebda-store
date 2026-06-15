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

import { prisma, withRlsBypass } from '@force/database';
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
 * Returns true when the sentinel already exists (product was already alerted
 * and has NOT restocked above the threshold yet).
 *
 * Falls back to `false` (send the alert) when Redis is unavailable — better
 * to over-alert than to silently miss a low-stock condition.
 */
export async function isSentinelSet(storeId: string, productId: string): Promise<boolean> {
  try {
    // redis.exists() wraps under `cache:` prefix — use the raw client to
    // avoid the `cache:` namespace collision with the general cache layer.
    const client = redis.getClient();
    if (!client) return false;
    const key = sentinelKey(storeId, productId);
    return (await client.exists(key)) === 1;
  } catch (err) {
    logger.warn({ err, storeId, productId }, 'low-stock-scan: sentinel read failed, proceeding');
    return false;
  }
}

/**
 * Sets the dedup sentinel for (storeId, productId) with a 30-day backstop TTL.
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
 * Clears the dedup sentinel for (storeId, productId) — called when a product
 * is back ABOVE its threshold so the next drop triggers a fresh alert.
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
  // Run inside withRlsBypass so Inngest jobs (no tenant GUC) can read the
  // products table without being filtered to 0 rows by FORCE RLS policies.
  // -------------------------------------------------------------------------
  return withRlsBypass(async tx => {
    // -----------------------------------------------------------------------
    // Step 1: Load the store owner email (the notification recipient)
    // -----------------------------------------------------------------------
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

    if (!store) {
      logger.warn({ storeId }, 'low-stock-scan: store not found, aborting');
      return { alertedProducts: [], clearedCount: 0, skippedCount: 0, recipientEmail: null };
    }

    const recipientEmail = store.owner?.email ?? null;

    // -----------------------------------------------------------------------
    // Step 2: Load active, trackInventory products with inventory > 0
    //         We load all of them so we can also clear sentinels for restocks.
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Step 3: Classify each product and manage sentinels
    // -----------------------------------------------------------------------
    const alertedProducts: LowStockAlertItem[] = [];
    let clearedCount = 0;
    let skippedCount = 0;

    for (const product of products) {
      const threshold = product.lowStockThreshold ?? 5;
      const isLow = product.inventory > 0 && product.inventory <= threshold;

      if (!isLow) {
        // Product is either back above threshold OR out-of-stock (inventory === 0).
        // Clear the sentinel so the next drop re-alerts, but only if a sentinel
        // actually exists — avoid a Redis write on every healthy product scan.
        const wasAlerted = await isSentinelSet(storeId, product.id);
        if (wasAlerted) {
          await clearSentinel(storeId, product.id);
          clearedCount++;
          logger.debug(
            { storeId, productId: product.id, inventory: product.inventory, threshold },
            'low-stock-scan: cleared sentinel — product restocked or exhausted'
          );
        }
        continue;
      }

      // Product is in low-stock range (0 < inventory <= threshold).
      const alreadyAlerted = await isSentinelSet(storeId, product.id);
      if (alreadyAlerted) {
        skippedCount++;
        logger.debug(
          { storeId, productId: product.id, inventory: product.inventory },
          'low-stock-scan: sentinel already set, skipping'
        );
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

    // -----------------------------------------------------------------------
    // Step 4: Set sentinels for all newly-alerted products AFTER building the
    //         digest so a failure mid-loop doesn't produce partial sentinels
    //         for products that weren't included in the digest.
    // -----------------------------------------------------------------------
    for (const item of alertedProducts) {
      await setSentinel(storeId, item.productId);
    }

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
  });
}
