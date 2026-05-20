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
 */

import { prisma } from '@force/database';
import logger from '../../lib/logger';
import { callGemini } from './gemini-ai.service';

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
 * Returns the number of days since the last paid OrderItem for this product in
 * this store. Returns 9999 if the product has never been sold.
 */
async function daysSinceLastSale(productId: string, storeId: string): Promise<number> {
  const lastItem = await prisma.$queryRaw<{ last_sale: Date | null }[]>`
    SELECT MAX(o.created_at) AS last_sale
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.product_id = ${productId}
      AND o.store_id = ${storeId}
      AND o.payment_status = 'paid'
  `;

  const lastSaleAt = lastItem[0]?.last_sale;
  if (!lastSaleAt) return 9999;

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((Date.now() - new Date(lastSaleAt).getTime()) / msPerDay);
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

  // -------------------------------------------------------------------------
  // Step 1: Expire old open flags (>30 days)
  // -------------------------------------------------------------------------
  const expireThreshold = new Date(Date.now() - EXPIRE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  const expiredResult = await prisma.$executeRaw`
    UPDATE public.deadstock_flags
    SET status = 'expired'
    WHERE store_id = ${storeId}
      AND status = 'open'
      AND scanned_at < ${expireThreshold}
  `;
  const expiredCount = Number(expiredResult);

  // -------------------------------------------------------------------------
  // Step 2: List active products with trackInventory=true, inventory>0, costPrice>0
  // -------------------------------------------------------------------------
  const products = await prisma.product.findMany({
    where: {
      storeId,
      trackInventory: true,
      deletedAt: null,
      status: 'active',
      inventory: { gt: 0 },
      costPrice: { gt: 0 },
    },
    select: {
      id: true,
      name: true,
      nameAr: true,
      inventory: true,
      costPrice: true,
    },
  });

  // -------------------------------------------------------------------------
  // Steps 3–4: Compute metrics and collect candidates
  // -------------------------------------------------------------------------
  const candidates: DeadstockCandidate[] = [];

  for (const product of products) {
    const days = await daysSinceLastSale(product.id, storeId);
    const stockValueFils = Math.round((product.inventory ?? 0) * (product.costPrice ?? 0));

    if (days < DEADSTOCK_DAYS_THRESHOLD) continue;
    if (stockValueFils < DEADSTOCK_VALUE_FILS_THRESHOLD) continue;

    candidates.push({
      productId: product.id,
      name: product.name,
      nameAr: product.nameAr,
      daysSinceSale: days,
      stockOnHand: product.inventory ?? 0,
      stockValueFils,
      costPrice: product.costPrice ?? 0,
    });
  }

  const scanned = products.length;

  if (candidates.length === 0) {
    logger.info({ storeId, scanned, flagged: 0, expiredCount }, 'deadstock-scan: no candidates');
    return { scanned, flagged: 0, expiredCount };
  }

  // -------------------------------------------------------------------------
  // Step 5: Batch-call Gemini for bilingual clearance copy (max 20/call)
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Step 6: findFirst+create/update DeadStockFlag rows
  //
  // Prisma's compound-unique where clause doesn't support null members in the
  // generated type (variantId: string is required). Use findFirst+create/update
  // to handle null variantId correctly — same pattern as reorder-scan.service.ts.
  // -------------------------------------------------------------------------
  let rowsUpserted = 0;

  for (const candidate of candidates) {
    const copy = copyMap.get(candidate.productId) ?? {
      discountPercent: 20,
      copyEn: 'Clearance — limited time offer!',
      copyAr: null,
    };

    try {
      const existing = await prisma.deadStockFlag.findFirst({
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
        await prisma.deadStockFlag.update({ where: { id: existing.id }, data: payload });
      } else {
        await prisma.deadStockFlag.create({
          data: {
            storeId,
            productId: candidate.productId,
            variantId: null,
            scannedAt: scanStartedAt,
            ...payload,
          },
        });
      }
      rowsUpserted += 1;
    } catch (err) {
      logger.error(
        { err, storeId, productId: candidate.productId },
        'deadstock-scan: failed to upsert flag'
      );
    }
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
 */
export async function createClearanceCouponFromFlag(
  flagId: string
): Promise<{ couponCode: string }> {
  const flag = await prisma.deadStockFlag.findUnique({
    where: { id: flagId },
    include: { product: { select: { sku: true, id: true } } },
  });

  if (!flag) throw new Error(`DeadStockFlag ${flagId} not found`);
  if (flag.status !== 'open')
    throw new Error(`DeadStockFlag ${flagId} is not open (status: ${flag.status})`);

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
