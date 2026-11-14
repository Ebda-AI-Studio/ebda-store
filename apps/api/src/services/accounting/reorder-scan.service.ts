/**
 * Reorder Scan Service — Accounting Smart Layer (Batch 3, Task 3)
 *
 * Scans active trackInventory products for a store and generates AI-powered
 * bilingual reorder suggestions when projected stock falls below the minimum
 * threshold. Designed to be called by the Inngest daily cron (06:00 Cairo) or
 * on-demand by a super_admin "Re-scan now" action.
 *
 * Algorithm (per spec Part 3.1):
 *   1. Mark stale open suggestions as expired (>30 days old).
 *   2. Compute velocity7d / velocity28d from paid OrderItems.
 *   3. Load ReorderRule for the product (or derive defaults from product fields).
 *   4. Compute projectedStock = onHand + onOrder - backlog - demandDuringLead.
 *   5. Stage candidate when projectedStock < minQty.
 *   6. Batch-call Gemini for bilingual reasoning (max 20 candidates per call).
 *   7. Refresh the item's existing OPEN suggestion (scannedAt included), else
 *      create one. Keying on the per-run scannedAt inserted a new open row on
 *      every daily run: 4156 open suggestions for 143 items in prod (audit
 *      2026-09-30, finding 6).
 *
 * The unit of a suggestion is the row that HOLDS the stock (owner decision
 * 2026-10-01, docs/architecture/inventory-model.md): one suggestion per
 * ACTIVE variant of a variant product, one per product for a product with no
 * variants. The dedupe key is (store, product, variant). A product-level
 * suggestion for a variant product drafted a PO line with no variant, and
 * receiving it wrote the parent `products.inventory` column — which must stay
 * 0 for a variant product. Step 1 expires any such legacy open row (and any
 * open row for a variant that has since been disabled) on the next run.
 *
 * RLS note (2026-06-01): the entire scan body runs inside withStore so
 * Inngest jobs (no tenant GUC in context) can read reorder_suggestions,
 * purchase_order_items, backorder_lines and products without being filtered
 * to an empty result set by the direct-compare RLS policies.
 */

import { prisma, withStore } from '@ebda/database';
import { storeDb, storeMoney } from '../../lib/repo-factory';
import logger from '../../lib/logger';
import { callGemini } from './gemini-ai.service';
import { effectiveInventory } from '../../lib/effective-inventory';
import { withSavepointOn } from '../../lib/savepoint';

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
  /** Unique per suggestion unit: the variant id, else the product id. */
  key: string;
  productId: string;
  /** Null for a product with no variants; the variant for a variant product. */
  variantId: string | null;
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
  key: string;
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
 * When `tx` is provided (inside a withStore callback) the query runs
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
async function getSupplierLeadTime(
  storeId: string,
  supplierId: string,
  tx: any
): Promise<number | null> {
  const row = await tx.supplier.findUnique({
    where: { id: supplierId, storeId },
    select: { leadTimeDays: true },
  });
  return row?.leadTimeDays ?? null;
}

// ---------------------------------------------------------------------------
// Helper: sum OrderItem quantity for a product (or ONE of its variants) over
// the last N days. DEMAND, not revenue (Ruling INV-AUDIT-4): every order that
// is not cancelled / refunded counts whatever its payment status (a COD order
// stays `unpaid` until delivery settles it, MONEYB-7), net of units taken back
// by COMPLETED returns. Revenue definitions are a separate decision.
// ---------------------------------------------------------------------------

const DEMAND_EXCLUDED_ORDER_STATUSES = ['cancelled', 'refunded'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// pq-allow(unused-export): test seam, imported by tests/unit/reorder-scan-demand.test.ts
export async function sumOrderQty(
  productId: string,
  variantId: string | null,
  storeId: string,
  days: number,
  tx: any,
  onDo: boolean
): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // A store on its Durable Object (Ruling CF-JOBS-4): the read client has no raw SQL, so the same sum is an aggregate. The
  // caller says so (`onDo`): the DO client THROWS on any `$`-member, so probing `tx.$queryRaw` was itself the crash (2026-11-09 P1).
  if (onDo) {
    const orderWhere = {
      storeId,
      status: { notIn: DEMAND_EXCLUDED_ORDER_STATUSES },
      createdAt: { gte: since },
    };
    const [sold, back] = await Promise.all([
      tx.orderItem.aggregate({
        where: { productId, ...(variantId ? { variantId } : {}), order: orderWhere },
        _sum: { quantity: true },
      }),
      tx.returnItem.aggregate({
        where: {
          productId,
          orderItem: { ...(variantId ? { variantId } : {}), order: orderWhere },
          return: { status: 'completed', type: { in: ['return', 'refund'] } },
        },
        _sum: { quantity: true },
      }),
    ]);
    return Math.max(0, Number(sold._sum.quantity ?? 0) - Number(back._sum.quantity ?? 0));
  }

  // A variant unit's velocity is that variant's own sales — summing the whole
  // product would give every variant the product's total demand.
  const sold = variantId
    ? await tx.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(oi.quantity), 0) AS total
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.product_id = ${productId}
      AND oi.variant_id = ${variantId}
      AND o.store_id = ${storeId}
      AND o.status NOT IN ('cancelled', 'refunded')
      AND o.created_at >= ${since}
  `
    : await tx.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(oi.quantity), 0) AS total
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.product_id = ${productId}
      AND o.store_id = ${storeId}
      AND o.status NOT IN ('cancelled', 'refunded')
      AND o.created_at >= ${since}
  `;
  const back = variantId
    ? await tx.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(ri.quantity), 0) AS total
    FROM public.return_items ri
    JOIN public.returns r ON r.id = ri.return_id
    JOIN public.order_items oi ON oi.id = ri.order_item_id
    JOIN public.orders o ON o.id = oi.order_id
    WHERE ri.product_id = ${productId}
      AND oi.variant_id = ${variantId}
      AND r.status = 'completed' AND r.type IN ('return', 'refund')
      AND o.store_id = ${storeId}
      AND o.status NOT IN ('cancelled', 'refunded')
      AND o.created_at >= ${since}
  `
    : await tx.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(ri.quantity), 0) AS total
    FROM public.return_items ri
    JOIN public.returns r ON r.id = ri.return_id
    JOIN public.order_items oi ON oi.id = ri.order_item_id
    JOIN public.orders o ON o.id = oi.order_id
    WHERE ri.product_id = ${productId}
      AND r.status = 'completed' AND r.type IN ('return', 'refund')
      AND o.store_id = ${storeId}
      AND o.status NOT IN ('cancelled', 'refunded')
      AND o.created_at >= ${since}
  `;

  return Math.max(0, Number(sold[0]?.total ?? 0) - Number(back[0]?.total ?? 0));
}

// ---------------------------------------------------------------------------
// Helper: build Gemini prompt for a chunk of candidates
// ---------------------------------------------------------------------------

function buildGeminiPrompt(candidates: ReorderCandidate[]): string {
  const products = candidates.map(c => ({
    key: c.key,
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

  return `You are an inventory ops assistant for an Egypt retailer. For each product below,
in <=2 sentences each, explain WHY this reorder suggestion makes sense given the velocity
+ on-hand + lead time + open backlog. Output bilingual (English + Arabic).
Return STRICT JSON:
{ "items": [{ "key": "<the product's key, copied exactly>", "reasoningEn": "...", "reasoningAr": "..." }] }

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
  // A store on its Durable Object (Ruling CF-JOBS-4) reads through its read client and writes the suggestions through the
  // `reorderExpire` / `reorderUpsert` ops; a Postgres store keeps its short `withStore` transactions exactly.
  const money = await storeMoney(storeId);
  const doDb = money ? await storeDb(storeId) : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = <T>(fn: (tx: any) => Promise<T>): Promise<T> =>
    doDb ? fn(doDb) : withStore(storeId, fn);

  // --- Phase 1: expire stale suggestions + load the product list -------------
  // The bypass GUC is SET LOCAL (transaction-scoped) so all RLS-protected reads
  // (reorder_suggestions, purchase_order_items, backorder_lines, products) must
  // happen inside a withStore tx. This first tx stays tiny (one UPDATE + one
  // findMany); the per-product metric fan-out is computed below in BOUNDED
  // chunks (each its own short tx), and the slow Gemini reasoning (phase 2) runs
  // OUTSIDE any open transaction. Keeping every tx short is what prevents the
  // 30s interactive-tx timeout ("Transaction not found", P1 2026-06-27) and the
  // connection-pool starvation the prior single-tx-around-everything design hit
  // (~112s on stores with many candidates + the 2.5s per-chunk throttle).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { expiredCount, products } = await scoped(async (tx: any) => {
    // -------------------------------------------------------------------------
    // Step 1: Mark stale open suggestions as expired
    // -------------------------------------------------------------------------
    const expireThreshold = new Date(Date.now() - EXPIRE_AFTER_DAYS * 24 * 60 * 60 * 1000);

    let expired: number;
    if (money) {
      const r = await money.reorderExpire({ thresholdMs: expireThreshold.getTime() });
      expired = r.expired;
      if (r.variantlessOpenPoLines > 0) {
        logger.warn(
          { storeId, variantlessOpenPoLines: r.variantlessOpenPoLines },
          'reorder-scan: open PO lines with no variant on variant products — their quantity is on order for no variant (issue 2345)'
        );
      }
    } else {
      const expiredResult = await tx.$executeRaw`
        UPDATE public.reorder_suggestions
        SET status = 'expired'
        WHERE store_id = ${storeId}
          AND status = 'open'
          AND scanned_at < ${expireThreshold}
      `;

      // Step 1b: expire open suggestions whose unit no longer exists in the
      // per-variant model — a product-level row (variant_id NULL) for a product
      // that HAS variants (the pre-2026-10-01 shape: drafting a PO from it wrote
      // the parent column), and a row for a variant that is now disabled (a
      // disabled variant is not stock — inventory-model.md). The scan below then
      // creates the correct per-variant rows. Runs before the per-unit upsert so
      // the dedupe lookup can never pick a legacy row back up.
      const unitGoneResult = await tx.$executeRaw`
        UPDATE public.reorder_suggestions rs
        SET status = 'expired'
        WHERE rs.store_id = ${storeId}
          AND rs.status = 'open'
          AND (
            (rs.variant_id IS NULL AND EXISTS (
              SELECT 1 FROM public.product_variants pv WHERE pv.product_id = rs.product_id
            ))
            OR (rs.variant_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.product_variants pv
              WHERE pv.id = rs.variant_id AND pv.is_active = false
            ))
          )
      `;
      expired = Number(expiredResult) + Number(unitGoneResult);

      // Issue 2345: open old-shape PO lines (no variant, on a variant product)
      // match NO scan unit, so their open quantity counts as on order for no
      // variant and the scan can over-suggest. How to count them is an owner
      // decision; until then the transition is made observable, never silent.
      // (The one-off lister script was removed in NZ-17 slice 2; the count below is the live signal.)
      const [variantless] = await tx.$queryRaw<Array<{ n: bigint | null }>>`
        SELECT COUNT(*)::bigint AS n
        FROM public.purchase_order_items i
        JOIN public.purchase_orders p ON p.id = i.po_id
        WHERE p.store_id = ${storeId}
          AND p.status IN ('sent', 'partial')
          AND i.variant_id IS NULL
          AND i.qty > i.qty_received
          AND EXISTS (SELECT 1 FROM public.product_variants pv WHERE pv.product_id = i.product_id)
      `;
      const variantlessOpen = Number(variantless?.n ?? 0);
      if (variantlessOpen > 0) {
        logger.warn(
          { storeId, variantlessOpenPoLines: variantlessOpen },
          'reorder-scan: open PO lines with no variant on variant products — their quantity is on order for no variant (issue 2345)'
        );
      }
    }

    // -------------------------------------------------------------------------
    // Step 2: List active trackInventory products
    // -------------------------------------------------------------------------
    const products = await tx.product.findMany({
      // repo-tx: tx is the DO read client on a DO store (scoped)
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
        // A variant product's stock lives on its variants and its parent
        // column is held at 0 (docs/architecture/inventory-model.md), so each
        // ACTIVE variant is scanned as its own unit. `isActive` is selected
        // (not pre-filtered) so a product whose variants are ALL disabled is
        // still recognised as a variant product and scans as nothing, rather
        // than falling back to its parent column.
        variants: {
          select: {
            id: true,
            title: true,
            titleAr: true,
            sku: true,
            inventory: true,
            isActive: true,
          },
        },
        lowStockThreshold: true,
        // Every active rule: the product-level one (variantId null) and any
        // per-variant ones. A variant uses its own rule, else the product's.
        reorderRules: {
          where: { isActive: true },
          select: {
            variantId: true,
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

  // Flatten to scan UNITS: one per active variant of a variant product, one
  // per product with no variants.
  type ScanProduct = (typeof products)[number];
  type ScanRule = ScanProduct['reorderRules'][number];
  interface ScanUnit {
    product: ScanProduct;
    variantId: string | null;
    name: string;
    nameAr: string | null;
    sku: string | null;
    onHand: number;
    rule: ScanRule | null;
  }
  const units: ScanUnit[] = [];
  for (const product of products) {
    const productRule = product.reorderRules.find((r: ScanRule) => r.variantId === null) ?? null;
    const variants = product.variants ?? [];
    if (variants.length === 0) {
      units.push({
        product,
        variantId: null,
        name: product.name,
        nameAr: product.nameAr,
        sku: product.sku,
        onHand: effectiveInventory(product),
        rule: productRule,
      });
      continue;
    }
    for (const v of variants) {
      if (v.isActive === false) continue; // a disabled variant is not stock
      units.push({
        product,
        variantId: v.id,
        name: `${product.name} — ${v.title}`,
        nameAr: product.nameAr ? `${product.nameAr} — ${v.titleAr ?? v.title}` : null,
        sku: v.sku ?? product.sku,
        // Variant rows are floored at 0 (inventory-model.md).
        onHand: Math.max(v.inventory ?? 0, 0),
        rule: product.reorderRules.find((r: ScanRule) => r.variantId === v.id) ?? productRule,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Steps 3–4: Compute metrics + collect candidates in BOUNDED chunks, each in
  // its OWN short RLS-bypass tx. The per-unit fan-out (sumOrderQty ×2,
  // pickLastSupplierForProduct, 2 aggregates) over a large catalog otherwise
  // blew the 30s interactive-tx timeout → "Transaction not found" (P1
  // 2026-06-27, ebda-api-stock-reorder-scan-cron, stores with many products).
  // Chunking bounds each tx's duration regardless of catalog size — it is by
  // UNIT, not product, so a product with many variants cannot widen one tx.
  // -------------------------------------------------------------------------
  const candidates: ReorderCandidate[] = [];
  const SCAN_CHUNK_SIZE = 25;

  // Product-level lookups run ONCE per product per scan (issue 2344). The loop
  // iterates units — one per active variant — but the last-PO supplier and
  // that supplier's lead time belong to the product, so a 20-variant product
  // used to scan its whole PO-item history 20 times for one answer. Memoised
  // across chunks: the answer does not depend on which chunk's tx asked.
  const lastSupplierByProduct = new Map<string, string | null>();
  const leadTimeBySupplier = new Map<string, number | null>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastSupplierFor = async (productId: string, tx: any): Promise<string | null> => {
    if (!lastSupplierByProduct.has(productId)) {
      lastSupplierByProduct.set(productId, await pickLastSupplierForProduct(productId, tx));
    }
    return lastSupplierByProduct.get(productId) ?? null;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leadTimeFor = async (supplierId: string, tx: any): Promise<number | null> => {
    if (!leadTimeBySupplier.has(supplierId)) {
      leadTimeBySupplier.set(supplierId, await getSupplierLeadTime(storeId, supplierId, tx));
    }
    return leadTimeBySupplier.get(supplierId) ?? null;
  };
  for (let chunkStart = 0; chunkStart < units.length; chunkStart += SCAN_CHUNK_SIZE) {
    const unitSlice = units.slice(chunkStart, chunkStart + SCAN_CHUNK_SIZE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chunkCandidates = await scoped(async (tx: any) => {
      const collected: ReorderCandidate[] = [];

      for (const unit of unitSlice) {
        const { product, variantId, rule, onHand } = unit;
        const qty7d = await sumOrderQty(product.id, variantId, storeId, 7, tx, !!money);
        const qty28d = await sumOrderQty(product.id, variantId, storeId, 28, tx, !!money);

        const velocity7d = qty7d / 7;
        const velocity28d = qty28d / 28;
        const velocity = Math.max(velocity7d, velocity28d);

        const minQty = rule?.minQty ?? product.lowStockThreshold;
        const safetyStockDays = rule?.safetyStockDays ?? 7;
        const defaultReorderQty = Math.max(Math.round(velocity * 14), minQty * 2);
        const reorderQty = rule?.reorderQty ?? defaultReorderQty;

        // Lead-time resolution order (per spec):
        //   1. ReorderRule.leadTimeDays  — explicit rule (variant's, else product's)
        //   2. supplier.leadTimeDays     — last-PO supplier when no rule is configured
        //   3. 7                         — system-wide default
        //
        // Also resolve supplierId here so we can reuse the last-PO lookup for both
        // lead-time fallback and the suggestion row (avoiding a duplicate DB call).
        let leadTimeDays: number;
        let resolvedSupplierId: string | null;

        if (rule !== null) {
          // A rule always takes priority over the supplier's lead time.
          leadTimeDays = rule.leadTimeDays;
          // Supplier for the suggestion: prefer rule's explicit preferred supplier.
          resolvedSupplierId = rule.preferredSupplierId ?? (await lastSupplierFor(product.id, tx));
        } else {
          // No rule: resolve the supplier first (last PO), then use its leadTimeDays.
          resolvedSupplierId = await lastSupplierFor(product.id, tx);
          const supplierLt = resolvedSupplierId ? await leadTimeFor(resolvedSupplierId, tx) : null;
          leadTimeDays = supplierLt ?? 7;
        }

        // Sum qty - qtyReceived for active PO items (status IN ('sent','partial'))
        // on THIS unit: the variant's own lines, or the product's variant-less ones.
        const onOrderAgg = await tx.purchaseOrderItem.aggregate({
          where: {
            productId: product.id,
            variantId,
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
            variantId,
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
          key: variantId ?? product.id,
          productId: product.id,
          variantId,
          name: unit.name,
          nameAr: unit.nameAr,
          sku: unit.sku,
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
        if (!item?.key) continue;
        reasoningMap.set(item.key, {
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
        if (!reasoningMap.has(c.key)) {
          reasoningMap.set(c.key, {
            reasoningEn: 'AI reasoning unavailable — manual review suggested',
            reasoningAr: null,
          });
        }
      }
    }
  }

  // --- Phase 3: Upsert ReorderSuggestion rows in a SHORT RLS-bypass tx --------
  // DB writes only — no network, so this stays well under the 30s timeout.
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
    rowsUpserted += await scoped(async (tx: any) => {
      let upserted = 0;

      if (money) {
        const r = await money.reorderUpsert({
          scannedAtMs: scanStartedAt.getTime(),
          items: slice.map(candidate => {
            const reasoning = reasoningMap.get(candidate.key) ?? {
              reasoningEn: 'AI reasoning unavailable — manual review suggested',
              reasoningAr: null,
            };
            return {
              productId: candidate.productId,
              variantId: candidate.variantId,
              suggestedQty: candidate.suggestedQty,
              velocity7d: candidate.velocity7d,
              velocity28d: candidate.velocity28d,
              onHand: candidate.onHand,
              onOrder: candidate.onOrder,
              openBacklog: candidate.openBacklog,
              urgencyDays: candidate.urgencyDays,
              supplierId: candidate.supplierId,
              reasoningEn: reasoning.reasoningEn,
              reasoningAr: reasoning.reasoningAr,
            };
          }),
        });
        return r.upserted;
      }

      for (const candidate of slice) {
        const reasoning = reasoningMap.get(candidate.key) ?? {
          reasoningEn: 'AI reasoning unavailable — manual review suggested',
          reasoningAr: null,
        };

        try {
          // One OPEN suggestion per unit — (store, product, variant): refresh
          // it (newest first, in case pre-fix duplicates still exist) or
          // create one. Own SAVEPOINT per candidate so a failed write cannot
          // abort the rest of the batch.
          await withSavepointOn(tx, async () => {
            const existing = await tx.reorderSuggestion.findFirst({
              where: {
                storeId,
                productId: candidate.productId,
                variantId: candidate.variantId,
                status: 'open',
              },
              orderBy: { scannedAt: 'desc' },
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
              await tx.reorderSuggestion.update({
                where: { id: existing.id, storeId },
                data: { ...payload, scannedAt: scanStartedAt },
              });
            } else {
              await tx.reorderSuggestion.create({
                data: {
                  storeId,
                  productId: candidate.productId,
                  variantId: candidate.variantId,
                  scannedAt: scanStartedAt,
                  ...payload,
                },
              });
            }
          });
          upserted += 1;
        } catch (err) {
          logger.error(
            { err, storeId, productId: candidate.productId, variantId: candidate.variantId },
            'reorder-scan: failed to upsert suggestion'
          );
        }
      }

      return upserted;
    });
  }

  logger.info(
    { storeId, scanned: candidates.length, suggested: rowsUpserted, expiredCount },
    'reorder-scan completed'
  );

  return { scanned: candidates.length, suggested: rowsUpserted, expiredCount };
}
