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
 *      - Claim each new hit with a short `pending` SET NX (so two overlapping
 *        scans cannot both alert it); the caller promotes the claim to the
 *        30-day sentinel only after the digest sends, so a future run is a
 *        no-op until the merchant restocks above the threshold.
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

import { withStore, type AppPrismaClient } from '@ebda/database';
import { storeRepo } from '../../lib/repo-factory';
import { redis } from '../redis.service';
import { effectiveInventory } from '../../lib/effective-inventory';
import logger from '../../lib/logger';
import type { LowStockAlertItem } from '../email-templates/low-stock-alert';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Sentinel key prefix. Full key: `low-stock-alerted:{storeId}:{productId}`
// ioredis transparently applies REDIS_KEY_PREFIX (e.g. `ebda-staging:`) so
// we don't need to embed the env prefix here.
export const SENTINEL_KEY_PREFIX = 'low-stock-alerted';

// Backstop TTL (30 days). If the sentinel is never cleared by a restock event
// the scan will clear it and re-alert after 30 days for persistent low stock.
// This also prevents orphaned keys from accumulating forever.
export const SENTINEL_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Short-lived CLAIM written by the scan itself (value `pending`, SET NX) so
// two overlapping scans for one store — the 6-hourly cron and an admin
// "Scan now", or a double-clicked "Scan now" — cannot both put the same
// product in a digest: only the scan whose SET NX wins includes it. The caller
// promotes the claim to the 30-day sentinel after the send succeeds
// (commitLowStockAlertSentinels overwrites it). If the send fails for good the
// claim just expires, so the product re-alerts on a later scan — the #187
// fail-open direction is kept, delayed by at most this window. It must outlast
// Inngest's retry window for the send step.
export const PENDING_CLAIM_TTL_SECONDS = 60 * 60; // 1 hour

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
  // Step 1: DB reads ONLY inside withStore.
  //
  // withStore opens an *interactive* Postgres transaction scoped to the store
  // (so an Inngest cron reads its own tenant under FORCE RLS). It is critical that NOTHING
  // slow runs inside it: the per-product Redis sentinel round-trips used to
  // live in here, and on a large catalogue N sequential Redis calls serialized
  // inside the transaction blew the 30s interactive-tx timeout
  // ("Transaction already closed ... 39532 ms passed"). Keep this block to the
  // two reads and get out fast — all sentinel I/O happens AFTER, off the tx.
  // -------------------------------------------------------------------------
  // The `Store` row (name, settings, owner) is a platform row; the catalogue is the store's own rows, on Postgres (same
  // transaction as before) or on its Durable Object (Ruling CF-JOBS-4B).
  const loadStore = (tx: Pick<AppPrismaClient, 'store'>) =>
    tx.store.findUnique({
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
  // Load active, trackInventory products. We load all of them (not just the
  // low ones) so we can also clear sentinels for products now back above
  // threshold or exhausted.
  const loadProducts = (db: Pick<AppPrismaClient, 'product'>) =>
    db.product.findMany({
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
        // For a variant product the on-hand quantity is the variant sum;
        // `inventory` is unused for one. See lib/effective-inventory.ts.
        variants: { select: { inventory: true, isActive: true } },
      },
    });
  const repo = await storeRepo(storeId);
  const data =
    repo.backend === 'do'
      ? await (async () => {
          const store = await withStore(storeId, tx => loadStore(tx));
          return store ? { store, products: await loadProducts(repo.db as never) } : null;
        })()
      : await withStore(storeId, async tx => {
          const store = await loadStore(tx);
          if (!store) return null;
          return { store, products: await loadProducts(tx) };
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

  const candidates: LowStockAlertItem[] = [];
  const toClear: string[] = [];
  let clearedCount = 0;
  let skippedCount = 0;

  for (const product of products) {
    const threshold = product.lowStockThreshold ?? 5;
    // Variant-aware on-hand. Reading `product.inventory` here meant a variant
    // product — whose parent column is 0 by design, and had drifted negative —
    // could never satisfy `> 0`, so NO variant product had ever produced a
    // low-stock alert. A silent gap, not a visible failure.
    const onHand = effectiveInventory(product);
    const isLow = onHand > 0 && onHand <= threshold;
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

    // New low-stock hit — a digest candidate, pending the claim below.
    candidates.push({
      productId: product.id,
      name: product.name,
      nameAr: product.nameAr,
      inventory: onHand,
      lowStockThreshold: threshold,
    });
  }

  // Clear sentinels for restocked/exhausted products now — that correction
  // is right regardless of whether a notification ever goes out. Newly-
  // alerted products deliberately do NOT get the 30-day sentinel here (only
  // the short `pending` claim below): the caller (the Inngest
  // function) commits those via commitLowStockAlertSentinels() only AFTER
  // the digest email actually sends. Setting them here, before the send,
  // meant a permanently-failed send step (retries exhausted — a bad owner
  // email, a Resend outage) left the sentinel set with no email ever having
  // gone out: the product silently never alerted again until it happened to
  // cross the threshold a second time.
  await writeSentinels(storeId, [], toClear);

  // Claim the new hits atomically; drop any another in-flight scan already
  // claimed (see PENDING_CLAIM_TTL_SECONDS).
  const claimed = await claimPending(
    storeId,
    candidates.map(p => p.productId)
  );
  const alertedProducts = candidates.filter(p => claimed.has(p.productId));
  skippedCount += candidates.length - alertedProducts.length;

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
 * SET NX a short `pending` claim per product in ONE pipeline and return the
 * ids this scan won. With no Redis (or on error) every id counts as won —
 * over-alert rather than silently miss, same fallback as readSentinels.
 */
async function claimPending(storeId: string, productIds: string[]): Promise<Set<string>> {
  const all = new Set(productIds);
  if (productIds.length === 0) return all;
  try {
    const client = redis.getClient();
    if (!client) return all;
    const pipeline = client.pipeline();
    for (const id of productIds) {
      pipeline.set(sentinelKey(storeId, id), 'pending', 'EX', PENDING_CLAIM_TTL_SECONDS, 'NX');
    }
    const replies = await pipeline.exec();
    if (!replies) return all;
    const won = new Set<string>();
    productIds.forEach((id, i) => {
      const [err, val] = replies[i] ?? [];
      // An errored reply is treated as won (over-alert); a null reply means
      // the key already existed — another scan holds this product.
      if (err || val === 'OK') won.add(id);
    });
    return won;
  } catch (err) {
    logger.warn({ err, storeId }, 'low-stock-scan: pending claim failed, proceeding');
    return all;
  }
}

/**
 * Mark the given products as alerted — called by the Inngest function ONLY
 * after its digest email for them has actually sent successfully. This is
 * the counterpart to `runLowStockScan` deliberately NOT setting these
 * sentinels itself; see the comment at its `writeSentinels` call.
 */
export async function commitLowStockAlertSentinels(
  storeId: string,
  productIds: string[]
): Promise<void> {
  await writeSentinels(storeId, productIds, []);
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
