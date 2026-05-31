import { prisma, withMoneyTx } from '@force/database';
import type { Prisma, PurchaseOrder, PurchaseOrderItem } from '@prisma/client';
import { nextSequence } from '../sequence.service';
import { getSystemAccountIdByCode } from './account.service';
import { inngest } from '../../lib/inngest/client';
import logger from '../../lib/logger';

export interface CreatePoInput {
  storeId: string;
  supplierId: string;
  expectedDate?: Date;
  notes?: string;
  notesAr?: string;
  createdBy?: string;
  items: { productId: string; variantId?: string; qty: number; unitCost: number; notes?: string }[];
}

export async function createPurchaseOrder(
  input: CreatePoInput
): Promise<PurchaseOrder & { items: PurchaseOrderItem[] }> {
  const subtotal = input.items.reduce((s, i) => s + i.qty * i.unitCost, 0);
  const apAccountId = await getSystemAccountIdByCode(input.storeId, '2000'); // AP
  const poNumber = await nextSequence(input.storeId, 'po');

  return prisma.purchaseOrder.create({
    data: {
      storeId: input.storeId,
      supplierId: input.supplierId,
      poNumber,
      status: 'draft',
      expectedDate: input.expectedDate,
      subtotal,
      total: subtotal,
      apAccountId,
      notes: input.notes,
      notesAr: input.notesAr,
      createdBy: input.createdBy,
      items: {
        create: input.items.map(i => ({
          productId: i.productId,
          variantId: i.variantId,
          qty: i.qty,
          unitCost: i.unitCost,
          total: i.qty * i.unitCost,
          notes: i.notes,
        })),
      },
    },
    include: { items: true },
  });
}

export interface ReceiveInput {
  storeId: string;
  poId: string;
  receivedBy?: string;
  receipts: { poItemId: string; qtyReceived: number }[];
}

/**
 * Receive purchase order. Implements spec Part 2.3:
 *   1. For each PO item line received:
 *      a. FIFO-clear oldest open BackorderLines for this productId+variantId
 *         consuming up to qtyReceived. Each cleared line fires a deferred-COGS
 *         posting at the PO unitCost; if estimate (OrderItem.costPrice) differs,
 *         post a COGS variance entry to 5010.
 *      b. Replenish on-hand with the remainder. Recompute Product.costPrice
 *         via WAC.
 *   2. Update PO item.qtyReceived; transition status (partial vs received).
 *   3. Fire `stock/po-received` Inngest event so the AP journal posts.
 */
export async function receivePurchaseOrder(input: ReceiveInput): Promise<{
  po: PurchaseOrder;
  clearedBackorders: Array<{
    backorderLineId: string;
    orderItemId: string;
    qty: number;
    actualUnitCost: number;
    estimateUnitCost: number;
    variance: number;
  }>;
}> {
  const clearedBackorders: Array<{
    backorderLineId: string;
    orderItemId: string;
    qty: number;
    actualUnitCost: number;
    estimateUnitCost: number;
    variance: number;
  }> = [];

  const po = await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: input.poId },
      include: { items: true },
    });
    if (!po || po.storeId !== input.storeId)
      throw new Error(`PO ${input.poId} not found in store ${input.storeId}`);
    if (po.status === 'received' || po.status === 'cancelled')
      throw new Error(`PO ${input.poId} cannot be received (status=${po.status})`);

    for (const receipt of input.receipts) {
      if (receipt.qtyReceived <= 0) continue;
      const item = po.items.find(i => i.id === receipt.poItemId);
      if (!item) throw new Error(`PO item ${receipt.poItemId} not in PO ${input.poId}`);
      const remainingAfter = item.qtyReceived + receipt.qtyReceived;
      if (remainingAfter > item.qty)
        throw new Error(`Cannot receive ${receipt.qtyReceived}; would exceed PO qty ${item.qty}`);

      let remainingToProcess = receipt.qtyReceived;

      // Step 1a: FIFO-clear backorders (oldest open first)
      const openBackorders = await tx.backorderLine.findMany({
        where: {
          productId: item.productId,
          variantId: item.variantId ?? null,
          fulfilledAt: null,
          cancelledAt: null,
        },
        orderBy: { createdAt: 'asc' },
        include: { orderItem: true },
      });

      for (const bo of openBackorders) {
        if (remainingToProcess <= 0) break;
        const stillNeeded = bo.qty - bo.qtyFulfilled;
        const fulfilQty = Math.min(stillNeeded, remainingToProcess);
        const newQtyFulfilled = bo.qtyFulfilled + fulfilQty;
        const isFullyFulfilled = newQtyFulfilled === bo.qty;

        await tx.backorderLine.update({
          where: { id: bo.id },
          data: {
            qtyFulfilled: newQtyFulfilled,
            ...(isFullyFulfilled ? { fulfilledAt: new Date(), fulfilledByPoItemId: item.id } : {}),
          },
        });

        // Track the cleared backorder for journal posting
        const estimateUnitCost = bo.orderItem.costPrice ?? 0;
        const variance = (item.unitCost - estimateUnitCost) * fulfilQty;
        clearedBackorders.push({
          backorderLineId: bo.id,
          orderItemId: bo.orderItemId,
          qty: fulfilQty,
          actualUnitCost: item.unitCost,
          estimateUnitCost,
          variance,
        });

        // If fully fulfilled, clear costPriceDeferred on OrderItem when all its lines done
        if (isFullyFulfilled) {
          const remainingOpen = await tx.backorderLine.count({
            where: {
              orderItemId: bo.orderItemId,
              fulfilledAt: null,
              cancelledAt: null,
              id: { not: bo.id },
            },
          });
          if (remainingOpen === 0) {
            await tx.orderItem.update({
              where: { id: bo.orderItemId },
              data: { costPriceDeferred: false },
            });
          }
        }

        remainingToProcess -= fulfilQty;
      }

      // Step 1b: Replenish on-hand with remainder + WAC recompute
      if (remainingToProcess > 0) {
        if (item.variantId) {
          // Variant inventory tracked separately; parent product.costPrice still holds the WAC.
          await tx.productVariant.update({
            where: { id: item.variantId },
            data: { inventory: { increment: remainingToProcess } },
          });
        }

        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { inventory: true, costPrice: true },
        });
        if (!product) throw new Error(`Product ${item.productId} not found`);

        // WAC formula: treat negative on-hand as 0 (backorder demand was consumed
        // in the FIFO clearance phase above; only pre-existing positive stock counts).
        const oldStock = Math.max(product.inventory, 0);
        const oldCost = product.costPrice ?? item.unitCost; // first-receive fallback
        const newStock = product.inventory + remainingToProcess;
        const denom = oldStock + remainingToProcess;
        const newCost =
          denom > 0
            ? Math.round((oldStock * oldCost + remainingToProcess * item.unitCost) / denom)
            : item.unitCost;

        await tx.product.update({
          where: { id: item.productId },
          data: {
            inventory: newStock,
            costPrice: newCost,
            lastCostUpdateAt: new Date(),
          },
        });

        // InventoryHistory row (existing FWB pattern)
        await tx.inventoryHistory.create({
          data: {
            productId: item.productId,
            storeId: input.storeId,
            type: 'transfer_in',
            quantity: remainingToProcess,
            previousStock: product.inventory,
            newStock,
            reason: `PO receive ${po.poNumber}`,
            reference: item.id,
          },
        });
      }

      // Step 2: Update PO item.qtyReceived
      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data: { qtyReceived: remainingAfter },
      });
    }

    // Recompute PO status
    const updatedItems = await tx.purchaseOrderItem.findMany({ where: { poId: input.poId } });
    const allComplete = updatedItems.every(i => i.qtyReceived === i.qty);
    const anyReceived = updatedItems.some(i => i.qtyReceived > 0);
    const newStatus = allComplete ? 'received' : anyReceived ? 'partial' : po.status;

    return tx.purchaseOrder.update({
      where: { id: input.poId },
      data: {
        status: newStatus,
        receivedAt: allComplete ? new Date() : po.receivedAt,
        receivedBy: input.receivedBy ?? po.receivedBy,
      },
    });
  });

  // Step 3: Fire async event outside the transaction (.catch pattern from Batch 1 order-posting.ts)
  inngest
    .send({
      name: 'stock/po-received',
      data: {
        storeId: input.storeId,
        poId: input.poId,
        clearedBackorders,
      },
    })
    .catch((err: unknown) =>
      logger.error({ err, poId: input.poId }, 'Failed to enqueue stock/po-received')
    );

  return { po, clearedBackorders };
}

export async function listPurchaseOrders(
  storeId: string,
  opts: { status?: string; page?: number; perPage?: number } = {}
) {
  const page = opts.page ?? 1;
  const perPage = Math.min(opts.perPage ?? 50, 200);
  const where: Prisma.PurchaseOrderWhereInput = { storeId };
  if (opts.status) where.status = opts.status as any;
  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: { supplier: { select: { name: true } }, items: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return { items, total, page, perPage };
}

export async function getPurchaseOrder(storeId: string, id: string) {
  return prisma.purchaseOrder.findFirst({
    where: { id, storeId },
    include: {
      supplier: true,
      items: {
        include: {
          product: { select: { name: true, sku: true } },
          variant: { select: { id: true, title: true, titleAr: true } },
        },
      },
    },
  });
}

export async function cancelPurchaseOrder(storeId: string, id: string) {
  const po = await prisma.purchaseOrder.findFirst({ where: { id, storeId } });
  if (!po) throw new Error(`PO ${id} not found in store ${storeId}`);
  if (po.status === 'received') throw new Error('Cannot cancel a fully-received PO');
  return prisma.purchaseOrder.update({ where: { id }, data: { status: 'cancelled' } });
}

/**
 * One-click "Draft PO from suggestion" factory used by the Reorder admin page
 * (Batch 3 Task 7). Reads the ReorderSuggestion, resolves the supplier (rule's
 * preferredSupplier > last PO supplier for this product > throw), creates a
 * draft PO with the suggested qty at the product's current costPrice, and
 * marks the suggestion accepted with the resulting poId for audit trace.
 */
export async function createPoFromSuggestion(
  suggestionId: string,
  createdBy?: string
): Promise<PurchaseOrder & { items: PurchaseOrderItem[] }> {
  const sug = await prisma.reorderSuggestion.findUnique({
    where: { id: suggestionId },
    include: { product: { select: { costPrice: true, name: true } } },
  });
  if (!sug) throw new Error(`ReorderSuggestion ${suggestionId} not found`);
  if (sug.status !== 'open')
    throw new Error(`ReorderSuggestion ${suggestionId} already ${sug.status}`);

  const supplierId = sug.supplierId ?? (await pickLastSupplierForProduct(sug.productId));
  if (!supplierId) {
    throw new Error(
      `No supplier on suggestion + no prior PO supplier for product ${sug.productId}. ` +
        `Set ReorderRule.preferredSupplierId or place a manual PO first.`
    );
  }

  const po = await createPurchaseOrder({
    storeId: sug.storeId,
    supplierId,
    items: [
      {
        productId: sug.productId,
        variantId: sug.variantId ?? undefined,
        qty: sug.suggestedQty,
        unitCost: sug.product.costPrice ?? 0,
      },
    ],
    createdBy,
    notes: `Auto-drafted from reorder suggestion (urgency ${sug.urgencyDays}d, velocity ${sug.velocity7d.toFixed(2)}/d)`,
  });

  await prisma.reorderSuggestion.update({
    where: { id: suggestionId },
    data: { status: 'accepted', poId: po.id },
  });

  return po;
}

/**
 * Used by createPoFromSuggestion fallback supplier resolution + by reorder-scan
 * candidate enrichment when no ReorderRule.preferredSupplierId is set.
 *
 * Returns the supplier from the most recent PurchaseOrder containing this
 * productId, or null if no PO has ever been placed for it.
 */
export async function pickLastSupplierForProduct(productId: string): Promise<string | null> {
  const lastPoItem = await prisma.purchaseOrderItem.findFirst({
    where: { productId },
    select: { po: { select: { supplierId: true } } },
    orderBy: { po: { createdAt: 'desc' } },
  });
  return lastPoItem?.po.supplierId ?? null;
}
