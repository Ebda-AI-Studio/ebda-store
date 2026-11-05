/**
 * Barcode Scanning Service — inventory.barcode (Enterprise)
 *
 * Three workflows:
 *   1. lookup      — resolve a barcode string to product/variant
 *   2. receive     — scan-to-receive stock (wraps InventoryService.adjustInventory)
 *   3. pick        — scan-to-pick an order line item
 *   4. count       — cycle-count session lifecycle (open / submit lines / close / reconcile)
 *
 * Reconcile reuses createAdjustment + postAdjustment so GL journal posting
 * remains the single authority for stock mutations.
 */

import { prisma, runInTenantContext, Prisma } from '@ebda/database';
import { storeDb, storeStock } from '../lib/repo-factory';
import { InventoryService } from './inventory.service';
import { createAdjustment, postAdjustment } from './accounting/stock-adjustment.service';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import { AppError } from '../middleware/error-handler';
import { inngest } from '../lib/inngest/client';
import { insertAuditLog } from '../lib/definer';
import logger from '../lib/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BarcodeLookupResult {
  type: 'product' | 'variant';
  productId: string;
  variantId?: string;
  productName: string;
  productNameAr: string | null;
  variantTitle?: string | null;
  variantTitleAr?: string | null;
  barcode: string;
  sku: string | null;
  inventory: number;
  /** true when the barcode matches both a product-level AND a variant-level field */
  ambiguous: boolean;
}

export interface ReceiveResult {
  productId: string;
  variantId: string | undefined;
  previousInventory: number;
  newInventory: number;
  qtyReceived: number;
}

export interface PickResult {
  orderItemId: string;
  orderId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  /** The picked line's personalisation text, so the picker knows which name this unit is. */
  personalisation: string | null;
  qtyOrdered: number;
  pickedQtyBefore: number;
  pickedQtyAfter: number;
  fullyPicked: boolean;
  orderFullyPicked: boolean;
}

export interface CountLineInput {
  productId: string;
  variantId?: string;
  countedQty: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Barcode Lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a barcode string within a store to a product/variant.
 * Returns null when no match is found.
 * Returns a result with ambiguous=true when both a product-level and a
 * variant-level row match (edge case for merchant data quality issues).
 */
export async function lookupBarcode(
  storeId: string,
  barcode: string
): Promise<BarcodeLookupResult | null> {
  const [productMatch, variantMatch] = await Promise.all([
    // Product-level barcode
    (await storeDb(storeId)).product.findFirst({
      where: { storeId, barcode, deletedAt: null },
      select: {
        id: true,
        name: true,
        nameAr: true,
        barcode: true,
        sku: true,
        inventory: true,
      },
    }),
    // Variant-level barcode (join through product to enforce store scope)
    (await storeDb(storeId)).productVariant.findFirst({
      where: {
        barcode,
        product: { storeId, deletedAt: null },
      },
      select: {
        id: true,
        barcode: true,
        sku: true,
        inventory: true,
        title: true,
        titleAr: true,
        productId: true,
        product: {
          select: { name: true, nameAr: true },
        },
      },
    }),
  ]);

  if (!productMatch && !variantMatch) return null;

  const ambiguous = productMatch !== null && variantMatch !== null;

  // When ambiguous, prefer the variant result (more specific).
  if (variantMatch) {
    return {
      type: 'variant',
      productId: variantMatch.productId,
      variantId: variantMatch.id,
      productName: variantMatch.product.name,
      productNameAr: variantMatch.product.nameAr,
      variantTitle: variantMatch.title,
      variantTitleAr: variantMatch.titleAr,
      barcode: variantMatch.barcode!,
      sku: variantMatch.sku,
      inventory: variantMatch.inventory,
      ambiguous,
    };
  }

  return {
    type: 'product',
    productId: productMatch!.id,
    productName: productMatch!.name,
    productNameAr: productMatch!.nameAr,
    barcode: productMatch!.barcode!,
    sku: productMatch!.sku,
    inventory: productMatch!.inventory,
    ambiguous: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Scan-to-Receive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record receipt of stock by scanning a barcode.
 * Resolves the barcode then calls InventoryService.adjustInventory
 * (type='manual_add', reason='barcode_receive') so the InventoryHistory row
 * and any downstream GL work happen through the existing path.
 */
export async function receiveByBarcode(
  storeId: string,
  barcode: string,
  qtyReceived: number,
  userId: string,
  reference?: string
): Promise<ReceiveResult> {
  if (qtyReceived <= 0) {
    throw new AppError(422, 'INVALID_QTY', 'Quantity received must be a positive integer');
  }

  const lookup = await lookupBarcode(storeId, barcode);
  if (!lookup) {
    throw new AppError(404, 'BARCODE_NOT_FOUND', `Barcode not found: ${barcode}`);
  }

  // Variant barcodes must mutate the VARIANT inventory row, not the product
  // row. InventoryService.adjustInventory is product-only, so for a resolved
  // variant we update its inventory + write the InventoryHistory entry inline
  // (mirrors the product path's manual_add semantics). Product barcodes still
  // flow through the shared InventoryService path.
  if (lookup.type === 'variant') {
    const stock = await storeStock(storeId);
    if (stock) {
      // Durable Object path (Ruling CF-R7-1): the variant stock and its history row are ONE section.
      const r = await stock.receiveVariant({
        productId: lookup.productId,
        variantId: lookup.variantId as string, // type "variant" always carries it
        quantity: qtyReceived,
        reason: 'barcode_receive',
        reference: reference ?? `barcode:${barcode}`,
        userId,
      });
      await invalidateStoreProductCaches(storeId);
      return {
        productId: r.productId,
        variantId: r.variantId,
        previousInventory: r.previousInventory,
        newInventory: r.newInventory,
        qtyReceived: r.qtyReceived,
      };
    }
    const variant = await prisma.productVariant.findFirst({
      where: { id: lookup.variantId },
      select: { inventory: true },
    });
    const previousInventory = variant?.inventory ?? 0;
    const newInventory = previousInventory + qtyReceived;

    await prisma.$transaction([
      prisma.productVariant.update({
        where: { id: lookup.variantId },
        data: { inventory: newInventory },
      }),
      prisma.inventoryHistory.create({
        data: {
          productId: lookup.productId,
          storeId,
          type: 'manual_add',
          quantity: qtyReceived,
          previousStock: previousInventory,
          newStock: newInventory,
          reason: 'barcode_receive',
          reference: reference ?? `barcode:${barcode}`,
          createdBy: userId,
        },
      }),
    ]);

    // Variant path writes `productVariant.inventory` directly — it never
    // goes through InventoryService.adjustInventory (product-only), so it
    // needs its own cache bust the same way that service's now does.
    await invalidateStoreProductCaches(storeId);

    return {
      productId: lookup.productId,
      variantId: lookup.variantId,
      previousInventory,
      newInventory,
      qtyReceived,
    };
  }

  const previousInventory =
    (
      await (
        await storeDb(storeId)
      ).product.findFirst({
        where: { id: lookup.productId, storeId },
        select: { inventory: true },
      })
    )?.inventory ?? 0;

  await InventoryService.adjustInventory(
    storeId,
    {
      productId: lookup.productId,
      quantity: qtyReceived,
      type: 'manual_add',
      reason: 'barcode_receive',
      reference: reference ?? `barcode:${barcode}`,
    },
    userId
  );

  return {
    productId: lookup.productId,
    variantId: lookup.variantId,
    previousInventory,
    newInventory: previousInventory + qtyReceived,
    qtyReceived,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Scan-to-Pick
// ─────────────────────────────────────────────────────────────────────────────

/** Which order line a scan lands on: the first matching line still short of its quantity. */
export function resolvePickTarget<T extends { pickedQty: number; quantity: number }>(
  candidates: T[]
): { kind: 'pick'; item: T } | { kind: 'already_picked' } | { kind: 'not_in_order' } {
  if (candidates.length === 0) return { kind: 'not_in_order' };
  const open = candidates.find(c => c.pickedQty < c.quantity);
  return open ? { kind: 'pick', item: open } : { kind: 'already_picked' };
}

/**
 * Pick one unit of an order line item identified by barcode scan.
 * Increments pickedQty on the matching OrderItem, sets pickedAt when the
 * line is fully picked. Returns whether the entire order is now fully picked.
 *
 * Resolves barcode → product/variant, then matches against the order's items.
 */
export async function pickOrderItemByBarcode(
  storeId: string,
  orderId: string,
  barcode: string,
  qtyToPick: number = 1
): Promise<PickResult> {
  if (qtyToPick <= 0) {
    throw new AppError(422, 'INVALID_QTY', 'Quantity to pick must be a positive integer');
  }

  // Resolve barcode
  const lookup = await lookupBarcode(storeId, barcode);
  if (!lookup) {
    throw new AppError(404, 'BARCODE_NOT_FOUND', `Barcode not found: ${barcode}`);
  }

  // Find the matching order item. One product/variant can sit on SEVERAL lines
  // of one order — personalised lines ("Sara" / "Omar" on the same abaya), or a
  // loose line plus a bundle component — so take the first line still short of
  // its quantity. A bare findFirst capped every scan at the first line and the
  // order could never reach fully-picked.
  // The quantity check and the increment are ONE statement (conditional UPDATE under a row lock),
  // so two scanners on the same line can never push it past its quantity: the loser re-evaluates
  // `picked_qty < quantity` on the committed row, matches nothing, and re-resolves to the next
  // open line or to ALREADY_PICKED.
  let orderItem: {
    id: string;
    orderId: string;
    productId: string;
    variantId: string | null;
    productName: string;
    personalisation: string | null;
    quantity: number;
  } | null = null;
  let pickedQtyBefore = 0;
  let newPickedQty = 0;
  for (let attempt = 0; attempt < 5 && !orderItem; attempt += 1) {
    const candidates = await prisma.orderItem.findMany({
      where: {
        orderId,
        productId: lookup.productId,
        ...(lookup.variantId ? { variantId: lookup.variantId } : {}),
        order: { storeId },
      },
      select: {
        id: true,
        orderId: true,
        productId: true,
        variantId: true,
        productName: true,
        personalisation: true,
        quantity: true,
        pickedQty: true,
      },
      orderBy: { id: 'asc' },
    });
    const target = resolvePickTarget(candidates);

    // Mismatch warnings. A real catalogue item that is NOT on this order is the picker grabbing
    // the wrong thing; an item already at its ordered quantity is a surplus unit. Both are told
    // apart from "barcode unknown" and neither writes anything.
    if (target.kind === 'not_in_order') {
      throw new AppError(409, 'NOT_IN_ORDER', `${lookup.productName} is not in this order`, {
        productName: lookup.productName,
        productNameAr: lookup.productNameAr,
        barcode,
      });
    }
    if (target.kind === 'already_picked') {
      throw new AppError(409, 'ALREADY_PICKED', `${lookup.productName} is already fully picked`, {
        productName: lookup.productName,
        productNameAr: lookup.productNameAr,
        barcode,
      });
    }

    const rows = await prisma.$queryRaw<{ before: number; after: number }[]>`
      WITH cur AS (
        SELECT id, picked_qty FROM public.order_items
        WHERE id = ${target.item.id} AND picked_qty < quantity
        FOR UPDATE
      )
      UPDATE public.order_items oi
      SET picked_qty = LEAST(oi.picked_qty + ${qtyToPick}::int, oi.quantity),
          picked_at = CASE WHEN oi.picked_qty + ${qtyToPick}::int >= oi.quantity THEN now() ELSE NULL END
      FROM cur
      WHERE oi.id = cur.id
      RETURNING cur.picked_qty AS before, oi.picked_qty AS after
    `;
    if (rows.length === 1) {
      orderItem = target.item;
      pickedQtyBefore = Number(rows[0].before);
      newPickedQty = Number(rows[0].after);
    }
  }
  if (!orderItem) {
    throw new AppError(409, 'ALREADY_PICKED', 'This item was just picked by another scanner', {
      productName: lookup.productName,
      productNameAr: lookup.productNameAr,
      barcode,
    });
  }
  const fullyPicked = newPickedQty >= orderItem.quantity;

  // Check if all items in the order are fully picked.
  // Prisma does not support column-to-column comparisons in a filter,
  // so we use a raw SQL query.
  const remainingRows = await prisma.$queryRaw<[{ remaining: bigint }]>`
    SELECT COUNT(*)::bigint AS remaining
    FROM public.order_items
    WHERE order_id = ${orderId}
      AND picked_qty < quantity
  `;
  const orderFullyPicked = Number(remainingRows[0].remaining) === 0;

  logger.info(
    {
      storeId,
      orderId,
      orderItemId: orderItem.id,
      barcode,
      qtyToPick,
      newPickedQty,
      fullyPicked,
      orderFullyPicked,
    },
    'barcode-scan: pick'
  );

  return {
    orderItemId: orderItem.id,
    orderId: orderItem.orderId,
    productId: orderItem.productId,
    variantId: orderItem.variantId,
    productName: orderItem.productName,
    personalisation: orderItem.personalisation,
    qtyOrdered: orderItem.quantity,
    pickedQtyBefore,
    pickedQtyAfter: newPickedQty,
    fullyPicked,
    orderFullyPicked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cycle-count Sessions
// ─────────────────────────────────────────────────────────────────────────────

/** Open a new count session. Only one open session per store is enforced
 * by convention (admin UI warns; API allows multiples for power users). */
export async function openCountSession(
  storeId: string,
  createdBy: string,
  note?: string
): Promise<{ id: string; storeId: string; status: string; note: string | null; createdAt: Date }> {
  const stock = await storeStock(storeId);
  if (stock) return stock.openCountSession({ createdBy, note: note ?? null });
  const session = await prisma.countSession.create({
    data: { storeId, createdBy, note: note ?? null, status: 'open' },
    select: { id: true, storeId: true, status: true, note: true, createdAt: true },
  });
  return session;
}

/** Submit (or update) a count line via upsert — scanning the same SKU again
 * updates the counted quantity instead of creating a duplicate. */
export async function submitCountLine(
  storeId: string,
  sessionId: string,
  line: CountLineInput
): Promise<{
  id: string;
  sessionId: string;
  productId: string;
  variantId: string | null;
  countedQty: number;
  systemQty: number;
  variance: number;
}> {
  const stock = await storeStock(storeId);
  if (stock)
    return stock.submitCountLine({
      sessionId,
      productId: line.productId,
      variantId: line.variantId ?? null,
      countedQty: line.countedQty,
    });
  // Verify session belongs to this store and is open
  const session = await prisma.countSession.findFirst({
    where: { id: sessionId, storeId, status: 'open' },
    select: { id: true },
  });
  if (!session) {
    throw new AppError(404, 'SESSION_NOT_FOUND', 'Count session not found or not open');
  }

  // Snapshot current system quantity
  let systemQty = 0;
  if (line.variantId) {
    const v = await prisma.productVariant.findFirst({
      // BE:S-7: the product must be THIS store's, else a foreign variant's stock is read
      where: { id: line.variantId, productId: line.productId, product: { storeId } },
      select: { inventory: true },
    });
    systemQty = v?.inventory ?? 0;
  } else {
    const p = await prisma.product.findFirst({
      where: { id: line.productId, storeId, deletedAt: null },
      select: { inventory: true },
    });
    systemQty = p?.inventory ?? 0;
  }

  const variance = line.countedQty - systemQty;

  // Upsert: update if same product/variant already scanned in this session
  const existing = await prisma.countLine.findFirst({
    where: {
      sessionId,
      productId: line.productId,
      variantId: line.variantId ?? null,
    },
    select: { id: true },
  });

  if (existing) {
    const updated = await prisma.countLine.update({
      where: { id: existing.id },
      data: { countedQty: line.countedQty, systemQty, variance, scannedAt: new Date() },
      select: {
        id: true,
        sessionId: true,
        productId: true,
        variantId: true,
        countedQty: true,
        systemQty: true,
        variance: true,
      },
    });
    return updated;
  }

  const created = await prisma.countLine.create({
    data: {
      sessionId,
      productId: line.productId,
      variantId: line.variantId ?? null,
      countedQty: line.countedQty,
      systemQty,
      variance,
    },
    select: {
      id: true,
      sessionId: true,
      productId: true,
      variantId: true,
      countedQty: true,
      systemQty: true,
      variance: true,
    },
  });
  return created;
}

/** Close a session (no more lines can be added). */
export async function closeCountSession(
  storeId: string,
  sessionId: string
): Promise<{ id: string; status: string; closedAt: Date | null }> {
  const stock = await storeStock(storeId);
  if (stock) return stock.closeCountSession({ sessionId });
  const session = await prisma.countSession.findFirst({
    where: { id: sessionId, storeId },
    select: { status: true },
  });
  if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
  if (session.status !== 'open') {
    throw new AppError(409, 'SESSION_NOT_OPEN', 'Session is not open');
  }
  const updated = await prisma.countSession.update({
    where: { id: sessionId, storeId },
    data: { status: 'closed', closedAt: new Date() },
    select: { id: true, status: true, closedAt: true },
  });
  return updated;
}

/**
 * Reconcile variances: create a cycle_count StockAdjustment for every line
 * with a non-zero variance, then post it immediately so inventory + GL update.
 * Lines with zero variance are included in the snapshot but don't move stock.
 *
 * Returns the created StockAdjustment id (or null when all variances are zero).
 */
export async function reconcileCountSession(
  storeId: string,
  sessionId: string,
  reconciledBy: string
): Promise<{ adjustmentId: string | null; linesReconciled: number; zeroVarianceLines: number }> {
  const stock = await storeStock(storeId);
  if (stock) {
    // Durable Object path (Ruling CF-R7-1): the adjustment, its posting and the session mark are ONE section.
    const r = await stock.reconcileCountSession({ sessionId, reconciledBy });
    await invalidateStoreProductCaches(storeId);
    if (r.adjustmentId) {
      try {
        await inngest.send({
          name: 'stock/adjustment-posted',
          data: { storeId, adjustmentId: r.adjustmentId },
        });
      } catch (err) {
        logger.error(
          { err, adjustmentId: r.adjustmentId, storeId },
          'reconcileCountSession: failed to fire inngest event'
        );
      }
    }
    logger.info(
      {
        storeId,
        sessionId,
        adjustmentId: r.adjustmentId,
        linesReconciled: r.linesReconciled,
        zeroVarianceLines: r.zeroVarianceLines,
      },
      'barcode-scan: reconcile (do)'
    );
    return r;
  }
  const session = await prisma.countSession.findFirst({
    where: { id: sessionId, storeId, status: 'closed' },
    include: {
      lines: {
        select: {
          productId: true,
          variantId: true,
          countedQty: true,
          variance: true,
        },
      },
    },
  });
  if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found or not closed');

  // Single claim: two concurrent reconciles (double tap, two devices) must post ONE adjustment.
  // The loser's updateMany matches no closed row and stops here.
  const claim = await prisma.countSession.updateMany({
    where: { id: sessionId, storeId, status: 'closed' },
    data: { status: 'reconciled', reconciledAt: new Date() },
  });
  if (claim.count === 0) {
    throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found or not closed');
  }

  const nonZeroLines = session.lines.filter(l => l.variance !== 0);
  const zeroVarianceLines = session.lines.length - nonZeroLines.length;

  let adjustmentId: string | null = null;

  try {
    if (nonZeroLines.length > 0) {
      // The adjustment is a DELTA (counted - system at scan time), applied as an atomic increment.
      // Stock moves ONLY through the
      // adjustment service: GL journal + InventoryHistory + cache invalidation live there.
      const adjustment = await runInTenantContext(storeId, () =>
        createAdjustment({
          storeId,
          type: 'cycle_count',
          reason: `Cycle count reconcile — session ${sessionId}`,
          createdBy: reconciledBy,
          items: nonZeroLines.map(l => ({
            productId: l.productId,
            variantId: l.variantId ?? undefined,
            newQty: l.countedQty,
            // counted - system qty at the moment of the scan: a sale made since is preserved.
            countDelta: l.variance,
          })),
        })
      );
      adjustmentId = adjustment.id;
      await runInTenantContext(storeId, () =>
        postAdjustment(storeId, adjustment.id, reconciledBy, { relative: true })
      );
    }

    await prisma.countSession.update({
      where: { id: sessionId, storeId },
      data: { adjustmentId: adjustmentId ?? undefined },
    });
  } catch (err) {
    // Compensating rollback: nothing was posted, so hand the session back to the merchant.
    await prisma.countSession.updateMany({
      where: { id: sessionId, storeId, status: 'reconciled' },
      data: { status: 'closed', reconciledAt: null },
    });
    throw err;
  }

  // Audit row: who reconciled which count, and what it moved.
  await insertAuditLog({
    action: 'inventory.count.reconciled',
    userId: reconciledBy,
    storeId,
    resourceType: 'count_session',
    resourceId: sessionId,
    details: { adjustmentId, linesReconciled: nonZeroLines.length, zeroVarianceLines },
  });

  logger.info(
    { storeId, sessionId, adjustmentId, nonZeroLines: nonZeroLines.length, zeroVarianceLines },
    'barcode-scan: reconcile'
  );

  return { adjustmentId, linesReconciled: nonZeroLines.length, zeroVarianceLines };
}

/** List count sessions for a store — newest first, capped at 50. */
export async function listCountSessions(
  storeId: string,
  opts: { status?: 'open' | 'closed' | 'reconciled'; limit?: number } = {}
): Promise<
  {
    id: string;
    status: string;
    note: string | null;
    createdAt: Date;
    closedAt: Date | null;
    reconciledAt: Date | null;
    adjustmentId: string | null;
    lineCount: number;
  }[]
> {
  const sessions = await (
    await storeDb(storeId)
  ).countSession.findMany({
    where: { storeId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 50,
    select: {
      id: true,
      status: true,
      note: true,
      createdAt: true,
      closedAt: true,
      reconciledAt: true,
      adjustmentId: true,
      _count: { select: { lines: true } },
    },
  });
  return sessions.map(s => ({ ...s, lineCount: s._count.lines }));
}

/** Get full detail of a single session including all count lines. */
export async function getCountSession(
  storeId: string,
  sessionId: string
): Promise<{
  id: string;
  status: string;
  note: string | null;
  createdAt: Date;
  closedAt: Date | null;
  reconciledAt: Date | null;
  adjustmentId: string | null;
  lines: {
    id: string;
    productId: string;
    variantId: string | null;
    productName: string;
    productNameAr: string | null;
    variantTitle: string | null;
    countedQty: number;
    systemQty: number;
    variance: number;
    scannedAt: Date;
  }[];
} | null> {
  const session = await (
    await storeDb(storeId)
  ).countSession.findFirst({
    where: { id: sessionId, storeId },
    select: {
      id: true,
      status: true,
      note: true,
      createdAt: true,
      closedAt: true,
      reconciledAt: true,
      adjustmentId: true,
      lines: {
        select: {
          id: true,
          productId: true,
          variantId: true,
          countedQty: true,
          systemQty: true,
          variance: true,
          scannedAt: true,
          product: { select: { name: true, nameAr: true } },
          variant: { select: { title: true, titleAr: true } },
        },
        orderBy: { scannedAt: 'desc' },
      },
    },
  });
  if (!session) return null;

  return {
    id: session.id,
    status: session.status,
    note: session.note,
    createdAt: session.createdAt,
    closedAt: session.closedAt,
    reconciledAt: session.reconciledAt,
    adjustmentId: session.adjustmentId,
    lines: session.lines.map(l => ({
      id: l.id,
      productId: l.productId,
      variantId: l.variantId,
      productName: l.product.name,
      productNameAr: l.product.nameAr,
      variantTitle: l.variant?.title ?? null,
      countedQty: l.countedQty,
      systemQty: l.systemQty,
      variance: l.variance,
      scannedAt: l.scannedAt,
    })),
  };
}

/** Get order items with pick progress for a given order. */
export async function getOrderPickProgress(
  storeId: string,
  orderId: string
): Promise<{
  orderId: string;
  orderNumber: string;
  status: string;
  fullyPicked: boolean;
  items: {
    id: string;
    productId: string;
    variantId: string | null;
    productName: string;
    variantName: string | null;
    variantNameAr: string | null;
    /** The customer's personalisation text; the picker needs it per line. */
    personalisation: string | null;
    quantity: number;
    pickedQty: number;
    pickedAt: Date | null;
  }[];
}> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, storeId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      items: {
        select: {
          id: true,
          productId: true,
          variantId: true,
          productName: true,
          variantName: true,
          variantNameAr: true,
          personalisation: true,
          quantity: true,
          pickedQty: true,
          pickedAt: true,
        },
      },
    },
  });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

  const fullyPicked = order.items.every(i => i.pickedQty >= i.quantity);

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    fullyPicked,
    items: order.items,
  };
}
