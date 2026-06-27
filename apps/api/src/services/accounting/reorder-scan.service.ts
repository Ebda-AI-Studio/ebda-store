/**
 * Reorder Scan Service — Accounting Smart Layer (Batch 3, Task 3)
 *
 * Scans active trackInventory products for a store and generates AI-powered
 * bilingual reorder suggestions when projected stock falls below the minimum
 * threshold. Designed to be called by the Inngest daily cron (06:00 KW) or
 * on-demand by a super_admin "Re-scan now" action.
 *
 * Algorithm (per spec Part 3.1):
 *   1. Mark stale open suggestions as expired (>30 days old).
 *   2. Compute velocity7d / velocity28d from paid OrderItems.
 *   3. Load ReorderRule for the product (or derive defaults from product fields).
 *   4. Compute projectedStock = onHand + onOrder - backlog - demandDuringLead.
 *   5. Stage candidate when projectedStock < minQty.
 *   6. Batch-call Gemini for bilingual reasoning (max 20 candidates per call).
 *   7. Upsert ReorderSuggestion rows keyed on (storeId, productId, variantId, scannedAt).
 *
 * RLS note (2026-06-01): the entire scan body runs inside withRlsBypass so
 * Inngest jobs (no tenant GUC in context) can read reorder_suggestions,
 * purchase_order_items, backorder_lines and products without being filtered
 * to an empty result set by the direct-compare RLS policies.
 */

import { prisma, withRlsBypass } from '@force/database';
import logger from '../../lib/logger';
import { callGemini } from './gemini-ai.service';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReorderScanResult {
  scanned: number;
  suggested: number;
  expiredCount: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReorderCandidate {
  productId: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  velocity7d: number;
  velocity28d: number;
  onHand: number;
  onOrder: number;
  openBacklog: number;
  urgencyDays: number;
  suggestedQty: number;
  supplierId: string | null;
  leadTimeDays: number;
  safetyStockDays: number;
  minQty: number;
}

interface GeminiReasoningItem {
  productId: string;
  reasoningEn: string;
  reasoningAr: string;
}

interface GeminiReasoningResponse {
  items: GeminiReasoningItem[];
}

// ---------------------------------------------------------------------------
// Helper: last supplier for a product (used here + exported for Task 7)
// ---------------------------------------------------------------------------

/**
 * Returns the supplierId from the most-recent PurchaseOrder line for this
 * product, or null if none exists. Used as a fallback when no ReorderRule
 * carries a preferredSupplierId.
 *
 * When `tx` is provided (inside a withRlsBypass callback) the query runs
 * within the bypass transaction so RLS doesn't filter results. Falls back
 * to the module-level `prisma` proxy for HTTP-context callers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pickLastSupplierForProduct(
  productId: string,
  tx?: any
): Promise<string | null> {
  const client = tx ?? prisma;
  const lastItem = await client.purchaseOrderItem.findFirst({
    where: { productId },
    orderBy: { createdAt: 'desc' },
    include: { po: { select: { supplierId: true } } },
  });
  return lastItem?.po.supplierId ?? null;
}

// ---------------------------------------------------------------------------
// Helper: fetch leadTimeDays from a supplier row (returns null if not found)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSupplierLeadTime(supplierId: string, tx: any): Promise<number | null> {
  const row = await tx.supplier.findUnique({
    where: { id: supplierId },
    select: { leadTimeDays: true },
  });
  return row?.leadTimeDays ?? null;
}

// ---------------------------------------------------------------------------
// Helper: sum OrderItem quantity for a product over the last N days (paid orders)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sumOrderQty(
  productId: string,
  storeId: string,
  days: number,
  tx: any
): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await tx.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(oi.quantity), 0) AS total
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.product_id = ${productId}
      AND o.store_id = ${storeId}
      AND o.payment_status = 'paid'
      AND o.created_at >= ${since}
  `;

  return Number(result[0]?.total ?? 0);
}

// ---------------------------------------------------------------------------
// Helper: build Gemini prompt for a chunk of candidates
// ---------------------------------------------------------------------------

function buildGeminiPrompt(candidates: ReorderCandidate[]): string {
  const products = candidates.map(c => ({
    productId: c.productId,
    name: c.name,
    nameAr: c.nameAr,
    sku: c.sku,
    velocity7d: c.velocity7d.toFixed(3),
    velocity28d: c.velocity28d.toFixed(3),
    onHand: c.onHand,
    onOrder: c.onOrder,
    openBacklog: c.openBacklog,
    urgencyDays: c.urgencyDays,
    suggestedQty: c.suggestedQty,
    leadTimeDays: c.leadTimeDays,
    safetyStockDays: c.safetyStockDays,
    minQty: c.minQty,
  }));

  return `You are an inventory ops assistant for a Kuwait retailer. For each product below,
in <=2 sentences each, explain WHY this reorder suggestion makes sense given the velocity
+ on-hand + lead time + open backlog. Output bilingual (English + Arabic).
Return STRICT JSON:
{ "items": [{ "productId": "...", "reasoningEn": "...", "reasoningAr": "..." }] }

Products: ${JSON.stringify(products)}`;
}

// ---------------------------------------------------------------------------
// Main export: runReorderScan
// ---------------------------------------------------------------------------

const GEMINI_CHUNK_SIZE = 20;
const GEMINI_THROTTLE_MS = 2500;
const EXPIRE_AFTER_DAYS = 30;

export async function runReorderScan(storeId: string): Promise<ReorderScanResult> {
  const scanStartedAt = new Date();

  // --- Phase 1: expire stale suggestions + load the product list -------------
  // The bypass GUC is SET LOCAL (transaction-scoped) so all RLS-protected reads
  // (reorder_suggestions, purchase_order_items, backorder_lines, products) must
  // happen inside a withRlsBypass tx. This first tx stays tiny (one UPDATE + one
  // findMany); the per-product metric fan-out is computed below in BOUNDED
  // chunks (each its own short tx), and the slow Gemini reasoning (phase 2) runs
  // OUTSIDE any open transaction. Keeping every tx short is what prevents the
  // 30s interactive-tx timeout ("Transaction not found", P1 2026-06-27) and the
  // connection-pool starvation the prior single-tx-around-everything design hit
  // (~112s on stores with many candidates + the 2.5s per-chunk throttle).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { expiredCount, products } = await withRlsBypass(async (tx: any) => {
    // -------------------------------------------------------------------------
    // Step 1: Mark stale open suggestions as expired
    // -------------------------------------------------------------------------
    const expireThreshold = new Date(Date.now() - EXPIRE_AFTER_DAYS * 24 * 60 * 60 * 1000);

    const expiredResult = await tx.$executeRaw`
      UPDATE public.reorder_suggestions
      SET status = 'expired'
      WHERE store_id = ${storeId}
        AND status = 'open'
        AND scanned_at < ${expireThreshold}
    `;
    const expired = Number(expiredResult);

    // -------------------------------------------------------------------------
    // Step 2: List active trackInventory products
    // -------------------------------------------------------------------------
    const products = await tx.product.findMany({
      where: {
        storeId,
        trackInventory: true,
        deletedAt: null,
        status: 'active',
      },
      select: {
        id: true,
        name: true,
        nameAr: true,
        sku: true,
        inventory: true,
        lowStockThreshold: true,
        reorderRules: {
          where: { variantId: null, isActive: true },
          take: 1,
          select: {
            minQty: true,
            reorderQty: true,
            leadTimeDays: true,
            safetyStockDays: true,
            preferredSupplierId: true,
          },
        },
      },
    });

    return { expiredCount: expired, products };
  });

  // -------------------------------------------------------------------------
  // Steps 3–4: Compute metrics + collect candidates in BOUNDED chunks, each in
  // its OWN short RLS-bypass tx. The per-product fan-out (sumOrderQty ×2,
  // pickLastSupplierForProduct, 2 aggregates) over a large catalog otherwise
  // blew the 30s interactive-tx timeout → "Transaction not found" (P1
  // 2026-06-27, force-api-stock-reorder-scan-cron, stores with many products).
  // Chunking bounds each tx's duration regardless of catalog size.
  // -------------------------------------------------------------------------
  const candidates: ReorderCandidate[] = [];
  const SCAN_CHUNK_SIZE = 25;
  for (let chunkStart = 0; chunkStart < products.length; chunkStart += SCAN_CHUNK_SIZE) {
    const productSlice = products.slice(chunkStart, chunkStart + SCAN_CHUNK_SIZE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunkCandidates = await withRlsBypass(async (tx: any) => {
      const collected: ReorderCandidate[] = [];

      for (const product of productSlice) {
        const qty7d = await sumOrderQty(product.id, storeId, 7, tx);
        const qty28d = await sumOrderQty(product.id, storeId, 28, tx);

        const velocity7d = qty7d / 7;
        const velocity28d = qty28d / 28;
        const velocity = Math.max(velocity7d, velocity28d);

        const rule = product.reorderRules[0] ?? null;

        const minQty = rule?.minQty ?? product.lowStockThreshold;
        const safetyStockDays = rule?.safetyStockDays ?? 7;
        const defaultReorderQty = Math.max(Math.round(velocity * 14), minQty * 2);
        const reorderQty = rule?.reorderQty ?? defaultReorderQty;

        // Lead-time resolution order (per spec):
        //   1. ReorderRule.leadTimeDays  — explicit per-product rule (wins when a rule exists)
        //   2. supplier.leadTimeDays     — last-PO supplier when no rule is configured
        //   3. 7                         — system-wide default
        //
        // Also resolve supplierId here so we can reuse the last-PO lookup for both
        // lead-time fallback and the suggestion row (avoiding a duplicate DB call).
        let leadTimeDays: number;
        let resolvedSupplierId: string | null;

        if (rule !== null) {
          // A per-product rule always takes priority over the supplier's lead time.
          leadTimeDays = rule.leadTimeDays;
          // Supplier for the suggestion: prefer rule's explicit preferred supplier.
          resolvedSupplierId =
            rule.preferredSupplierId ?? (await pickLastSupplierForProduct(product.id, tx));
        } else {
          // No rule: resolve the supplier first (last PO), then use its leadTimeDays.
          resolvedSupplierId = await pickLastSupplierForProduct(product.id, tx);
          const supplierLt = resolvedSupplierId
            ? await getSupplierLeadTime(resolvedSupplierId, tx)
            : null;
          leadTimeDays = supplierLt ?? 7;
        }

        const onHand = product.inventory;

        // Sum qty - qtyReceived for active PO items (status IN ('sent','partial'))
        const onOrderAgg = await tx.purchaseOrderItem.aggregate({
          where: {
            productId: product.id,
            po: {
              storeId,
              status: { in: ['sent', 'partial'] },
            },
          },
          _sum: { qty: true, qtyReceived: true },
        });
        const onOrder = Math.max(
          0,
          (onOrderAgg._sum.qty ?? 0) - (onOrderAgg._sum.qtyReceived ?? 0)
        );

        // Open backlog: qty - qtyFulfilled for unfulfilled, non-cancelled backorder lines
        const backlogAgg = await tx.backorderLine.aggregate({
          where: {
            productId: product.id,
            storeId,
            fulfilledAt: null,
            cancelledAt: null,
          },
          _sum: { qty: true, qtyFulfilled: true },
        });
        const openBacklog = Math.max(
          0,
          (backlogAgg._sum.qty ?? 0) - (backlogAgg._sum.qtyFulfilled ?? 0)
        );

        const demandDuringLead = velocity * (leadTimeDays + safetyStockDays);
        const projectedStock = onHand + onOrder - openBacklog - demandDuringLead;

        if (projectedStock >= minQty) continue; // healthy — skip

        const safeVelocity = Math.max(velocity, 0.01);
        const urgencyDays = Math.round(onHand / safeVelocity);
        const suggestedQty = Math.max(reorderQty, openBacklog + reorderQty - onHand - onOrder);

        // Use the already-resolved supplierId (avoids a second pickLastSupplierForProduct call).
        const supplierId = resolvedSupplierId;

        collected.push({
          productId: product.id,
          name: product.name,
          nameAr: product.nameAr,
          sku: product.sku,
          velocity7d,
          velocity28d,
          onHand,
          onOrder,
          openBacklog,
          urgencyDays,
          suggestedQty: Math.round(suggestedQty),
          supplierId,
          leadTimeDays,
          safetyStockDays,
          minQty,
        });
      }

      return collected;
    });
    candidates.push(...chunkCandidates);
  }

  if (candidates.length === 0) {
    logger.info({ storeId, scanned: 0, suggested: 0, expiredCount }, 'reorder-scan: no candidates');
    return { scanned: 0, suggested: 0, expiredCount };
  }

  // --- Phase 2: Gemini reasoning OUTSIDE any transaction ----------------------
  // Pure network + in-memory. The 2.5s per-chunk throttle sleeps live here, so
  // they no longer hold a DB transaction open.
  const reasoningMap = new Map<string, { reasoningEn: string; reasoningAr: string | null }>();

  const chunks: ReorderCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += GEMINI_CHUNK_SIZE) {
    chunks.push(candidates.slice(i, i + GEMINI_CHUNK_SIZE));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    if (ci > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, GEMINI_THROTTLE_MS));
    }
    const chunk = chunks[ci];
    try {
      const response = await callGemini<GeminiReasoningResponse>({
        prompt: buildGeminiPrompt(chunk),
        feature: 'reorder-scan',
        storeId,
      });
      for (const item of response.items ?? []) {
        reasoningMap.set(item.productId, {
          reasoningEn: item.reasoningEn ?? 'AI reasoning unavailable — manual review suggested',
          reasoningAr: item.reasoningAr ?? null,
        });
      }
    } catch (err) {
      logger.warn(
        { err, storeId, chunkIndex: ci },
        'reorder-scan: Gemini call failed for chunk — proceeding without AI reasoning'
      );
      // Set fallback reasoning for all products in this chunk
      for (const c of chunk) {
        if (!reasoningMap.has(c.productId)) {
          reasoningMap.set(c.productId, {
            reasoningEn: 'AI reasoning unavailable — manual review suggested',
            reasoningAr: null,
          });
        }
      }
    }
  }

  // --- Phase 3: Upsert ReorderSuggestion rows in a SHORT RLS-bypass tx --------
  // DB writes only — no network, so this stays well under the 30s timeout.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowsUpserted = await withRlsBypass(async (tx: any) => {
    let upserted = 0;

    for (const candidate of candidates) {
      const reasoning = reasoningMap.get(candidate.productId) ?? {
        reasoningEn: 'AI reasoning unavailable — manual review suggested',
        reasoningAr: null,
      };

      try {
        // Prisma's compound-unique where clause doesn't support null members
        // (the generated type requires variantId: string). Use findFirst +
        // create/update to handle the null-variantId case correctly.
        const existing = await tx.reorderSuggestion.findFirst({
          where: {
            storeId,
            productId: candidate.productId,
            variantId: null,
            scannedAt: scanStartedAt,
          },
          select: { id: true },
        });

        const payload = {
          suggestedQty: candidate.suggestedQty,
          velocity7d: candidate.velocity7d,
          velocity28d: candidate.velocity28d,
          onHand: candidate.onHand,
          onOrder: candidate.onOrder,
          openBacklog: candidate.openBacklog,
          urgencyDays: candidate.urgencyDays,
          supplierId: candidate.supplierId,
          reasoningEn: reasoning.reasoningEn,
          reasoningAr: reasoning.reasoningAr ?? undefined,
          status: 'open' as const,
        };

        if (existing) {
          await tx.reorderSuggestion.update({ where: { id: existing.id }, data: payload });
        } else {
          await tx.reorderSuggestion.create({
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
          'reorder-scan: failed to upsert suggestion'
        );
      }
    }

    return upserted;
  });

  logger.info(
    { storeId, scanned: candidates.length, suggested: rowsUpserted, expiredCount },
    'reorder-scan completed'
  );

  return { scanned: candidates.length, suggested: rowsUpserted, expiredCount };
}
