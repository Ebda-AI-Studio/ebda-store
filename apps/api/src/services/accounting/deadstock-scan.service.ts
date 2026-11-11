/**
 * Dead-Stock Scan Service — Accounting Smart Layer (Batch 3, Task 4)
 *
 * Scans active trackInventory products for a store and generates AI-powered
 * bilingual clearance copy for dead-stock products. Designed to be called by
 * the Inngest weekly cron (Sunday 06:00 Cairo) or on-demand by a super_admin.
 *
 * Algorithm (per spec Part 3.2):
 *   1. Expire old open flags (>30 days, status='expired').
 *   2. List active products with trackInventory=true and stock on hand.
 *   3. For each product: compute daysSinceSale + stockValueFils (null when the
 *      product has no cost price — value UNKNOWN, not zero).
 *   4. Flag if daysSinceSale >= 90 AND (stockValueFils >= 500000 OR value unknown).
 *      A product that has never sold is aged from its createdAt instead, so a
 *      newly listed product is not "90 days dead" on day one.
 *      A product without a cost price used to be skipped entirely, which made
 *      the scan blind on every store that never entered costs (2026-09-30
 *      audit: demo-store 0/210, demo-boutique 0/22) while the page said "No dead stock".
 *   5. Batch-call Gemini for bilingual clearance copy (max 20/call).
 *   6. Refresh the product's existing OPEN flag, or create one. Keyed on the
 *      open flag, not on scannedAt: keying on the per-run timestamp inserted a
 *      new open flag every weekly run (5 open cards for 1 product in prod).
 *
 * RLS note (2026-06-01): the entire scan body runs inside withStore so
 * Inngest jobs (no tenant GUC in context) can read deadstock_flags, products,
 * and order_items without being filtered to an empty result set by the
 * direct-compare RLS policies.
 */

import { prisma, withStore, Prisma } from '@ebda/database';
import { activeVariants, effectiveInventory } from '../../lib/effective-inventory';
import logger from '../../lib/logger';
import { callGemini } from './gemini-ai.service';
import { AppError } from '../../middleware/error-handler';
import { withSavepointOn } from '../../lib/savepoint';
import { storeDb, storeRepo, storeWriter } from '../../lib/repo-factory';
import { isP2002 } from '../../lib/prisma-errors';
import { withStoreRw } from '../../lib/jobs/store-db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeadstockScanResult {
  scanned: number;
  flagged: number;
  expiredCount: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DeadstockCandidate {
  productId: string;
  name: string;
  nameAr: string | null;
  daysSinceSale: number;
  stockOnHand: number;
  /** null = the product has no cost price, so its value is unknown. */
  stockValueFils: number | null;
  costPrice: number | null;
}

interface GeminiClearanceItem {
  productId: string;
  discountPercent: number;
  copyEn: string;
  copyAr: string;
}

interface GeminiClearanceResponse {
  items: GeminiClearanceItem[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_CHUNK_SIZE = 20;
const GEMINI_THROTTLE_MS = 2500;
const EXPIRE_AFTER_DAYS = 30;
const DEADSTOCK_DAYS_THRESHOLD = 90;
// 5,000 EGP in piastres (1 EGP = 100 piastres). Egypt-scale default; product to confirm.
const DEADSTOCK_VALUE_FILS_THRESHOLD = 500_000;

// ---------------------------------------------------------------------------
// Helper: days since last paid sale for a product
// ---------------------------------------------------------------------------

/**
 * Returns a map of productId -> last paid-sale date for the given product ids in
 * one store, computed in a SINGLE grouped query. Products with no paid sale are
 * absent from the map (callers treat absence as "never sold" = 9999 days).
 *
 * This replaces the old per-product query that ran inside the scan transaction:
 * N sequential `$queryRaw` calls serialized in one interactive tx blew the 30s
 * timeout on large catalogues (the same defect that hit low-stock-scan). One
 * grouped query is a single round-trip regardless of catalogue size.
 *
 * Accepts `tx` so it participates in the caller's bypass transaction (required
 * for Inngest jobs where no tenant GUC is set).
 */
async function lastSaleByProduct(
  productIds: string[],
  storeId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (productIds.length === 0) return map;

  const rows = await tx.$queryRaw<{ product_id: string; last_sale: Date | null }[]>`
    SELECT oi.product_id, MAX(o.created_at) AS last_sale
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.store_id = ${storeId}
      AND o.payment_status = 'paid'
      AND oi.product_id IN (${Prisma.join(productIds)})
    GROUP BY oi.product_id
  `;

  for (const row of rows) {
    if (row.last_sale) map.set(row.product_id, new Date(row.last_sale));
  }
  return map;
}

/** The same map from the DO op `lastPaidSales` (at most 90 ids per call: the DO binds 100 parameters). */
async function lastSaleByProductDo(
  productIds: string[],
  money: { lastPaidSales(a: { productIds: string[] }): Promise<{ sales: Record<string, number> }> }
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  for (let i = 0; i < productIds.length; i += 90) {
    const { sales } = await money.lastPaidSales({ productIds: productIds.slice(i, i + 90) });
    for (const [id, ms] of Object.entries(sales)) map.set(id, new Date(ms));
  }
  return map;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSince(lastSaleAt: Date | undefined): number {
  if (!lastSaleAt) return 9999;
  return Math.floor((Date.now() - lastSaleAt.getTime()) / MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Helper: variant-aware stock value (piastres), or null when unknown
// ---------------------------------------------------------------------------

const knownCost = (c: number | null | undefined): number | null =>
  typeof c === 'number' && c > 0 ? c : null;

/**
 * Stock value of a dead-stock candidate — the JS twin of `STOCK_VALUE_SQL`
 * (lib/effective-inventory-sql.ts), which the finance dashboard, analytics
 * snapshot and inventory page value stock with: a variant product is valued
 * per ACTIVE variant at that variant's own cost, falling back to the parent's.
 * Valuing the variant sum at the parent's cost alone mis-valued every variant
 * product whose cost lives on its variants (ruling AP-10).
 *
 * Differs from the SQL twin in ONE place, on purpose (ruling AN-2): a stocked
 * unit with no cost anywhere makes the value `null` (unknown), not a 0 that
 * would silently fail the value threshold.
 */
export function deadStockValueFils(product: {
  inventory: number;
  costPrice: number | null;
  variants?: Array<{ inventory: number; isActive?: boolean; costPrice?: number | null }> | null;
}): number | null {
  const parentCost = knownCost(product.costPrice);
  const variants = product.variants ?? [];
  if (variants.length === 0) {
    return parentCost === null ? null : Math.round(product.inventory * parentCost);
  }
  let total = 0;
  for (const v of activeVariants(variants)) {
    const qty = v.inventory ?? 0;
    const cost = knownCost(v.costPrice) ?? parentCost;
    if (cost === null) {
      // Only a unit actually on hand makes the value unknown.
      if (qty > 0) return null;
      continue;
    }
    total += qty * cost;
  }
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// Helper: build Gemini prompt for a chunk of candidates
// ---------------------------------------------------------------------------

function buildGeminiPrompt(candidates: DeadstockCandidate[]): string {
  const products = candidates.map(c => ({
    productId: c.productId,
    name: c.name,
    nameAr: c.nameAr,
    daysSinceSale: c.daysSinceSale,
    stockOnHand: c.stockOnHand,
    stockValueFils: c.stockValueFils,
    costPrice: c.costPrice,
  }));

  return `You are a retail clearance copywriter for an Egypt e-commerce store. For each
dead-stock product below, suggest a clearance discount percentage (10-50) and
write a short bilingual campaign copy (<=80 chars each, English + Arabic).

Return STRICT JSON:
{ "items": [{ "productId": "...", "discountPercent": 25, "copyEn": "...", "copyAr": "..." }] }

Products: ${JSON.stringify(products)}`;
}

// ---------------------------------------------------------------------------
// Main export: runDeadstockScan
// ---------------------------------------------------------------------------

export async function runDeadstockScan(storeId: string): Promise<DeadstockScanResult> {
  const scanStartedAt = new Date();

  // --- Phase 1: DB reads/writes inside a SHORT RLS-bypass transaction ---------
  // Only DB work here (expire stale flags, list products, collect candidates).
  // The slow Gemini clearance-copy reasoning (phase 2) runs OUTSIDE any open
  // transaction so it can never blow the 30s interactive-tx timeout — same fix
  // as reorder-scan.service.ts (the prior single-tx-around-everything design
  // timed out at ~112s on stores with many candidates + the 2.5s throttle).
  // A store on its Durable Object (Ruling CF-JOBS-4B): the expiry is a model write, the last-sale read is the DO op
  // `lastPaidSales`; the catalogue read goes through the DO read client. Postgres keeps the transaction and its raw SQL.
  const repo = await storeRepo(storeId);
  const doMoney = repo.backend === 'do' ? (repo.money ?? null) : null;
  if (repo.backend === 'do' && !doMoney)
    throw new Error(`deadstock-scan: no money client for DO store ${storeId}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phase1 = async (tx: any) => {
    // -------------------------------------------------------------------------
    // Step 1: Expire old open flags (>30 days)
    // -------------------------------------------------------------------------
    const expireThreshold = new Date(Date.now() - EXPIRE_AFTER_DAYS * 24 * 60 * 60 * 1000);

    const expired = doMoney
      ? (
          await repo.writer.deadStockFlag.updateMany({
            where: { storeId, status: 'open', scannedAt: { lt: expireThreshold } },
            data: { status: 'expired' },
          })
        ).count
      : Number(
          await tx.$executeRaw`
      UPDATE public.deadstock_flags
      SET status = 'expired'
      WHERE store_id = ${storeId}
        AND status = 'open'
        AND scanned_at < ${expireThreshold}
    `
        );

    // -------------------------------------------------------------------------
    // Step 2: List active products with trackInventory=true and stock on hand.
    // No costPrice filter: a product without a cost is valued as unknown below.
    // -------------------------------------------------------------------------
    const products = await tx.product.findMany({
      // repo-tx: tx is repo.db on a DO store (phase1)
      where: {
        storeId,
        trackInventory: true,
        deletedAt: null,
        status: 'active',
        // Variant-aware "has stock". Filtering on `inventory: { gt: 0 }` here
        // excluded every variant product BEFORE the variant-aware valuation
        // below could see it — the filter has to agree with the computation.
        OR: [
          { variants: { none: {} }, inventory: { gt: 0 } },
          { variants: { some: { isActive: true, inventory: { gt: 0 } } } },
        ],
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        inventory: true,
        costPrice: true,
        // A never-sold product is aged from its listing date (issue 2271).
        createdAt: true,
        // For a variant product the on-hand quantity is the variant sum;
        // `inventory` is unused for one. See lib/effective-inventory.ts.
        // `costPrice` per variant: a variant is valued at its own cost
        // (deadStockValueFils — the STOCK_VALUE_SQL rule).
        variants: { select: { inventory: true, isActive: true, costPrice: true } },
      },
    });

    // -------------------------------------------------------------------------
    // Steps 3–4: Compute metrics and collect candidates.
    // Last-sale dates come from ONE grouped query (not N per-product queries),
    // so this stays a constant number of round-trips inside the short tx.
    // -------------------------------------------------------------------------
    const productIds = products.map((p: { id: string }) => p.id);
    const lastSales = doMoney
      ? await lastSaleByProductDo(productIds, doMoney)
      : await lastSaleByProduct(productIds, storeId, tx);

    const collected: DeadstockCandidate[] = [];

    for (const product of products) {
      const lastSale = lastSales.get(product.id);
      const days = daysSince(lastSale);
      // Issue 2271: "never sold" is only dead stock once the product has been
      // LISTED for the threshold. Without this, a product added three days ago
      // with stock read as 9999 days unsold and was flagged on every store
      // with no cost prices (the value threshold cannot gate an unknown value).
      // The 9999 sentinel stays for display — a flagged never-sold product is
      // then at least 90 days old, so "Never sold" is true of it.
      if (!lastSale && daysSince(product.createdAt) < DEADSTOCK_DAYS_THRESHOLD) continue;
      // Variant-aware on-hand — valuing against `product.inventory` reported
      // 0 (or a negative) stock-on-hand for the entire variant catalogue, so
      // no variant product could ever clear the dead-stock value threshold.
      const onHand = effectiveInventory(product);
      const hasCost = typeof product.costPrice === 'number' && product.costPrice > 0;
      const stockValueFils = deadStockValueFils(product);

      if (days < DEADSTOCK_DAYS_THRESHOLD) continue;
      // The value threshold can only be applied when the value is known.
      if (stockValueFils !== null && stockValueFils < DEADSTOCK_VALUE_FILS_THRESHOLD) continue;

      collected.push({
        productId: product.id,
        name: product.name,
        nameAr: product.nameAr,
        daysSinceSale: days,
        stockOnHand: onHand,
        stockValueFils,
        costPrice: hasCost ? product.costPrice : null,
      });
    }

    return { expiredCount: expired, candidates: collected, scanned: products.length };
  };
  const { expiredCount, candidates, scanned } = doMoney
    ? await phase1(repo.db)
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await withStore(storeId, (tx: any) => phase1(tx));

  if (candidates.length === 0) {
    logger.info({ storeId, scanned, flagged: 0, expiredCount }, 'deadstock-scan: no candidates');
    return { scanned, flagged: 0, expiredCount };
  }

  // --- Phase 2: Gemini clearance copy OUTSIDE any transaction -----------------
  // Pure network + in-memory; the 2.5s per-chunk throttle no longer holds a tx.
  const copyMap = new Map<
    string,
    { discountPercent: number; copyEn: string; copyAr: string | null }
  >();

  const chunks: DeadstockCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += GEMINI_CHUNK_SIZE) {
    chunks.push(candidates.slice(i, i + GEMINI_CHUNK_SIZE));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    if (ci > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, GEMINI_THROTTLE_MS));
    }
    const chunk = chunks[ci];
    try {
      const response = await callGemini<GeminiClearanceResponse>({
        prompt: buildGeminiPrompt(chunk),
        feature: 'deadstock-scan',
        storeId,
      });
      for (const item of response.items ?? []) {
        copyMap.set(item.productId, {
          discountPercent: Math.max(10, Math.min(50, Math.round(item.discountPercent ?? 20))),
          copyEn: item.copyEn?.slice(0, 80) || 'Clearance — limited time offer!',
          copyAr: item.copyAr?.slice(0, 80) || null,
        });
      }
    } catch (err) {
      logger.warn(
        { err, storeId, chunkIndex: ci },
        'deadstock-scan: Gemini call failed for chunk — proceeding with fallback copy'
      );
      for (const c of chunk) {
        if (!copyMap.has(c.productId)) {
          copyMap.set(c.productId, {
            discountPercent: 20,
            copyEn: 'Clearance — limited time offer!',
            copyAr: null,
          });
        }
      }
    }
  }

  // --- Phase 3: upsert DeadStockFlag rows in a SHORT RLS-bypass tx ------------
  // DB writes only — no network, so this stays well under the 30s timeout.
  //
  // One OPEN flag per product: find the product's open flag (newest first, in
  // case duplicates from before this fix still exist) and refresh it —
  // including scannedAt — else create one. Each candidate runs in its own
  // SAVEPOINT so one failed write rolls back only itself instead of aborting
  // the whole transaction (every later statement would otherwise fail 25P02).
  //
  // Chunked (issue 2259): one withStore per PHASE3_CHUNK_SIZE candidates,
  // the way phase 1 chunks its scan. The candidate set is uncapped (every
  // uncosted store's whole stale catalogue can qualify) and each candidate
  // costs ~5 round-trips with its savepoint, so a single transaction could
  // cross the 30s interactive-tx ceiling. A chunk that fails commits nothing
  // of its own; earlier chunks stay committed, and the next weekly run
  // refreshes the same one-open-row-per-product set.
  const PHASE3_CHUNK_SIZE = 25;
  let rowsUpserted = 0;
  for (let chunkStart = 0; chunkStart < candidates.length; chunkStart += PHASE3_CHUNK_SIZE) {
    const slice = candidates.slice(chunkStart, chunkStart + PHASE3_CHUNK_SIZE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rowsUpserted += await withStoreRw(storeId, async (tx: any) => {
      let upserted = 0;

      for (const candidate of slice) {
        const copy = copyMap.get(candidate.productId) ?? {
          discountPercent: 20,
          copyEn: 'Clearance — limited time offer!',
          copyAr: null,
        };

        try {
          // Postgres: one savepoint per candidate. On the DO each write is its own atomic call, so a failed one rolls back alone.
          const savepoint = doMoney
            ? (_tx: unknown, fn: () => Promise<void>) => fn()
            : withSavepointOn;
          await savepoint(tx, async () => {
            const existing = await tx.deadStockFlag.findFirst({
              // repo-tx: tx is the store writer on a DO store (withStoreRw)
              where: {
                storeId,
                productId: candidate.productId,
                variantId: null,
                status: 'open',
              },
              orderBy: { scannedAt: 'desc' },
              select: { id: true },
            });

            const payload = {
              daysSinceSale: candidate.daysSinceSale,
              stockOnHand: candidate.stockOnHand,
              stockValueFils: candidate.stockValueFils,
              suggestedDiscountBps: Math.round(copy.discountPercent * 100),
              clearanceCopyEn: copy.copyEn,
              clearanceCopyAr: copy.copyAr ?? undefined,
              status: 'open' as const,
            };

            if (existing) {
              await tx.deadStockFlag.update({
                where: { id: existing.id, storeId },
                data: { ...payload, scannedAt: scanStartedAt },
              });
            } else {
              await tx.deadStockFlag.create({
                data: {
                  storeId,
                  productId: candidate.productId,
                  variantId: null,
                  scannedAt: scanStartedAt,
                  ...payload,
                },
              });
            }
          });
          upserted += 1;
        } catch (err) {
          logger.error(
            { err, storeId, productId: candidate.productId },
            'deadstock-scan: failed to upsert flag'
          );
        }
      }

      return upserted;
    });
  }

  logger.info(
    { storeId, scanned, flagged: rowsUpserted, expiredCount },
    'deadstock-scan completed'
  );

  return { scanned, flagged: rowsUpserted, expiredCount };
}

// ---------------------------------------------------------------------------
// Exported factory: createClearanceCouponFromFlag (Task 7 inline, per plan)
// ---------------------------------------------------------------------------

/**
 * Creates a Coupon for the flagged product and marks the DeadStockFlag as
 * accepted_clearance. Called by the POST /stock/deadstock-flags/:id/clearance
 * route (Task 8).
 *
 * This function is called from an HTTP route handler (tenant context already
 * set by middleware); both writes go through the store writer (its DO or Postgres).
 */
export async function createClearanceCouponFromFlag(
  flagId: string,
  storeId: string
): Promise<{ couponCode: string }> {
  const flag = await (
    await storeDb(storeId)
  ).deadStockFlag.findFirst({
    where: { id: flagId, storeId },
    include: { product: { select: { sku: true, id: true } } },
  });

  if (!flag) throw new AppError(404, 'FLAG_NOT_FOUND', `DeadStockFlag ${flagId} not found`);
  if (flag.status !== 'open')
    throw new AppError(
      409,
      'FLAG_ALREADY_PROCESSED',
      `DeadStockFlag ${flagId} is not open (status: ${flag.status})`
    );

  const skuSlug = flag.product.sku
    ? flag.product.sku
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 8)
    : flag.productId.slice(0, 6).toUpperCase();

  const code = `CLEAR-${skuSlug}`;
  const discountValue = Math.round(flag.suggestedDiscountBps / 100);

  const couponData = {
    storeId: flag.storeId,
    code,
    name: `Clearance ${discountValue}% off`,
    nameAr: `تخفيض ${discountValue}٪`,
    type: 'percentage' as const,
    value: discountValue,
    // isActive defaults to true in the schema; merchant can narrow scope afterwards
  };
  const flagData = { status: 'accepted_clearance' as const, couponCode: code };
  if ((await storeRepo(storeId)).backend === 'do') {
    // A store on its Durable Object (the Worker has no Postgres): ONE DO batch, so the coupon and the flag move together, and
    // a second click (or a code another coupon already holds) meets the (store, code) unique key and writes nothing.
    const w = await storeWriter(storeId);
    try {
      await w.$transaction([
        w.coupon.create({ data: couponData }),
        w.deadStockFlag.update({ where: { id: flagId, storeId }, data: flagData }),
      ]);
    } catch (err) {
      if (isP2002(err))
        throw new AppError(
          409,
          'COUPON_CODE_TAKEN',
          `A coupon with the code ${code} already exists. Rename it, then try again.`
        );
      throw err;
    }
  } else {
    await prisma.coupon.create({ data: couponData });
    await prisma.deadStockFlag.update({ where: { id: flagId, storeId }, data: flagData });
  }

  return { couponCode: code };
}
