/**
 * Dead-Stock Scan Service — Accounting Smart Layer (Batch 3, Task 4)
 *
 * Scans active trackInventory products for a store and generates AI-powered
 * bilingual clearance copy for dead-stock products. Designed to be called by
 * the Inngest weekly cron (Sunday 06:00 KW) or on-demand by a super_admin.
 *
 * Algorithm (per spec Part 3.2):
 *   1. Expire old open flags (>30 days, status='expired').
 *   2. List active products with trackInventory=true, inventory>0, costPrice>0.
 *   3. For each product: compute daysSinceSale + stockValueFils.
 *   4. Flag if daysSinceSale >= 90 AND stockValueFils >= 50000.
 *   5. Batch-call Gemini for bilingual clearance copy (max 20/call).
 *   6. findFirst+create/update DeadStockFlag rows (Prisma null-variant quirk).
 *
 * RLS note (2026-06-01): the entire scan body runs inside withRlsBypass so
 * Inngest jobs (no tenant GUC in context) can read deadstock_flags, products,
 * and order_items without being filtered to an empty result set by the
 * direct-compare RLS policies.
 */

import { prisma, withRlsBypass, Prisma } from '@force/database';
import { effectiveInventory } from '../../lib/effective-inventory';
import logger from '../../lib/logger';
import { callGemini } from './gemini-ai.service';
import { AppError } from '../../middleware/error-handler';

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
  stockValueFils: number;
  costPrice: number;
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
const DEADSTOCK_VALUE_FILS_THRESHOLD = 50_000; // 500 KWD in fils (1 KWD = 1000 fils)

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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSince(lastSaleAt: Date | undefined): number {
  if (!lastSaleAt) return 9999;
  return Math.floor((Date.now() - lastSaleAt.getTime()) / MS_PER_DAY);
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

  return `You are a retail clearance copywriter for a Kuwait e-commerce store. For each
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { expiredCount, candidates, scanned } = await withRlsBypass(async (tx: any) => {
    // -------------------------------------------------------------------------
    // Step 1: Expire old open flags (>30 days)
    // -------------------------------------------------------------------------
    const expireThreshold = new Date(Date.now() - EXPIRE_AFTER_DAYS * 24 * 60 * 60 * 1000);

    const expiredResult = await tx.$executeRaw`
      UPDATE public.deadstock_flags
      SET status = 'expired'
      WHERE store_id = ${storeId}
        AND status = 'open'
        AND scanned_at < ${expireThreshold}
    `;
    const expired = Number(expiredResult);

    // -------------------------------------------------------------------------
    // Step 2: List active products with trackInventory=true, inventory>0, costPrice>0
    // -------------------------------------------------------------------------
    const products = await tx.product.findMany({
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
        costPrice: { gt: 0 },
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        inventory: true,
        costPrice: true,
        // For a variant product the on-hand quantity is the variant sum;
        // `inventory` is unused for one. See lib/effective-inventory.ts.
        variants: { select: { inventory: true, isActive: true } },
      },
    });

    // -------------------------------------------------------------------------
    // Steps 3–4: Compute metrics and collect candidates.
    // Last-sale dates come from ONE grouped query (not N per-product queries),
    // so this stays a constant number of round-trips inside the short tx.
    // -------------------------------------------------------------------------
    const lastSales = await lastSaleByProduct(
      products.map((p: { id: string }) => p.id),
      storeId,
      tx
    );

    const collected: DeadstockCandidate[] = [];

    for (const product of products) {
      const days = daysSince(lastSales.get(product.id));
      // Variant-aware on-hand — valuing against `product.inventory` reported
      // 0 (or a negative) stock-on-hand for the entire variant catalogue, so
      // no variant product could ever clear the dead-stock value threshold.
      const onHand = effectiveInventory(product);
      const stockValueFils = Math.round(onHand * (product.costPrice ?? 0));

      if (days < DEADSTOCK_DAYS_THRESHOLD) continue;
      if (stockValueFils < DEADSTOCK_VALUE_FILS_THRESHOLD) continue;

      collected.push({
        productId: product.id,
        name: product.name,
        nameAr: product.nameAr,
        daysSinceSale: days,
        stockOnHand: onHand,
        stockValueFils,
        costPrice: product.costPrice ?? 0,
      });
    }

    return { expiredCount: expired, candidates: collected, scanned: products.length };
  });

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
  // Prisma's compound-unique where clause doesn't support null members in the
  // generated type (variantId: string is required). Use findFirst+create/update
  // to handle null variantId correctly — same pattern as reorder-scan.service.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowsUpserted = await withRlsBypass(async (tx: any) => {
    let upserted = 0;

    for (const candidate of candidates) {
      const copy = copyMap.get(candidate.productId) ?? {
        discountPercent: 20,
        copyEn: 'Clearance — limited time offer!',
        copyAr: null,
      };

      try {
        const existing = await tx.deadStockFlag.findFirst({
          where: {
            storeId,
            productId: candidate.productId,
            variantId: null,
            scannedAt: scanStartedAt,
          },
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
          await tx.deadStockFlag.update({ where: { id: existing.id }, data: payload });
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
 * set by middleware) — plain prisma calls are fine here; no bypass needed.
 */
export async function createClearanceCouponFromFlag(
  flagId: string,
  storeId: string
): Promise<{ couponCode: string }> {
  const flag = await prisma.deadStockFlag.findFirst({
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

  await prisma.coupon.create({
    data: {
      storeId: flag.storeId,
      code,
      name: `Clearance ${discountValue}% off`,
      nameAr: `تخفيض ${discountValue}٪`,
      type: 'percentage',
      value: discountValue,
      // isActive defaults to true in the schema; merchant can narrow scope afterwards
    },
  });

  await prisma.deadStockFlag.update({
    where: { id: flagId },
    data: { status: 'accepted_clearance', couponCode: code },
  });

  return { couponCode: code };
}
