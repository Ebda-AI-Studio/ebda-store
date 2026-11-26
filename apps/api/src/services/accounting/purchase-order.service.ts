import { assertStoreOwnsInTenantScope } from './assert-store-owns';
import { prisma, withMoneyTx, hasTenantContext, runInTenantContext } from '@ebda/database';
import type { Prisma, PurchaseOrder, PurchaseOrderItem } from '@prisma/client';
import { nextSequence } from '../sequence.service';
import { getSystemAccountIdByCode } from './account.service';
import { inngest } from '../../lib/inngest/client';
import { postPoReceiveJournal } from './posting/po-receive-posting';
import logger from '../../lib/logger';
import { AppError } from '../../middleware/error-handler';
import { effectiveInventory } from '../../lib/effective-inventory';
import { invalidateStoreProductCaches } from '../../lib/public-cache';
import { healBackorderStockDebt } from './backorder-stock-heal';
import { storeDb, storeStock } from '../../lib/repo-factory';

export interface CreatePoInput {
  storeId: string;
  supplierId: string;
  expectedDate?: Date;
  notes?: string;
  notesAr?: string;
  createdBy?: string;
  /** createPoFromSuggestion on a DO store: the suggestion is marked accepted in the same section. */
  suggestionId?: string;
  items: { productId: string; variantId?: string; qty: number; unitCost: number; notes?: string }[];
}

export async function createPurchaseOrder(
  input: CreatePoInput
): Promise<PurchaseOrder & { items: PurchaseOrderItem[] }> {
  const stock = await storeStock(input.storeId);
  if (stock) {
    // Durable Object path (Ruling CF-R7-1): ownership, variant rules, the number and the rows are ONE section.
    const r = await stock.createPurchaseOrder({
      supplierId: input.supplierId,
      expectedDate: input.expectedDate ?? null,
      notes: input.notes,
      notesAr: input.notesAr,
      createdBy: input.createdBy,
      suggestionId: input.suggestionId ?? null,
      items: input.items,
    });
    return (await storeDb(input.storeId)).purchaseOrder.findFirstOrThrow({
      where: { id: r.id, storeId: input.storeId },
      include: { items: true },
    });
  }
  // product/variant/supplier ids all arrive in the request body and were
  // written onto the PO unchecked. requireStoreAccess only proves the caller
  // owns the store in the URL — so a store_admin could plant a competitor's
  // ids here and have receivePurchaseOrder write that tenant's inventory,
  // weighted-average cost, backorders and order items, and read back the
  // foreign supplier row via getPurchaseOrder's `include: { supplier: true }`.
  //
  // #1241 / issue 2057: the guard must run under the store's RLS GUC —
  // on the ambient request transaction when there is one, in its own
  // tenant-scoped transaction when there is not (Inngest callers). See
  // assertStoreOwnsInTenantScope.
  await assertStoreOwnsInTenantScope(input.storeId, {
    productIds: input.items.map(i => i.productId),
    variantIds: input.items.map(i => i.variantId),
    supplierIds: [input.supplierId],
  });
  // Issue 2145: a disabled variant is not stock (inventory-model.md), so a PO
  // drafted against one would receive units that every stock and valuation
  // surface then reads as 0. Refuse at draft time; receive refuses too.
  await assertVariantsActive(
    input.storeId,
    input.items.map(i => i.variantId)
  );
  // Owner decision 2026-10-01: a PO line must name the row that holds the
  // stock — see assertPoLinesTargetStockRow.
  await assertPoLinesTargetStockRow(input.storeId, input.items);

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

/**
 * 409 VARIANT_INACTIVE unless every named variant is active. Receiving into a
 * disabled variant would book cost and AP for units that no stock or value
 * surface counts (issue 2145); the merchant re-enables the variant first.
 */
async function assertVariantsActive(
  storeId: string,
  variantIds: (string | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(variantIds.filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  const inactive = await prisma.productVariant.count({
    where: { id: { in: ids }, isActive: false, product: { storeId } },
  });
  if (inactive > 0) {
    throw new AppError(
      409,
      'VARIANT_INACTIVE',
      'A variant on this purchase order is disabled. Re-enable it before ordering or receiving stock for it.'
    );
  }
}

/**
 * A PO line must name the row that HOLDS the stock (owner decision
 * 2026-10-01, docs/architecture/inventory-model.md):
 *   - a line for a product WITH variants must carry a `variantId` — a
 *     variant-less line on such a product would, on receive, write the parent
 *     `products.inventory` column, which must stay 0 for a variant product;
 *   - a `variantId` must belong to the line's own `productId` (store ownership
 *     alone, checked by `assertStoreOwns`, would accept a sibling product's
 *     variant and receive stock into the wrong product).
 * Fails loud (400) rather than writing a column that moves no sellable stock.
 */
async function assertPoLinesTargetStockRow(
  storeId: string,
  items: { productId: string; variantId?: string | null }[]
): Promise<void> {
  const productIds = [...new Set(items.map(i => i.productId))];
  // Same RLS posture as assertStoreOwnsInTenantScope: the ambient request
  // transaction when there is one, else a tenant-scoped one (Inngest), so a
  // GUC-less read cannot return zero variants and wave a bad line through.
  const load = () =>
    prisma.productVariant.findMany({
      where: { productId: { in: productIds }, product: { storeId } },
      select: { id: true, productId: true },
    });
  const variants = hasTenantContext() ? await load() : await runInTenantContext(storeId, load);
  const variantProducts = new Set(variants.map(v => v.productId));
  const variantOwner = new Map(variants.map(v => [v.id, v.productId]));
  for (const item of items) {
    if (item.variantId) {
      if (variantOwner.get(item.variantId) !== item.productId) {
        throw new AppError(
          400,
          'VARIANT_PRODUCT_MISMATCH',
          'A purchase order line names a variant that does not belong to its product.'
        );
      }
    } else if (variantProducts.has(item.productId)) {
      throw new AppError(
        400,
        'VARIANT_REQUIRED',
        'This product has variants — choose the variant for each purchase order line.'
      );
    }
  }
}

export interface ReceiveInput {
  storeId: string;
  poId: string;
  receivedBy?: string;
  receipts: { poItemId: string; qtyReceived: number }[];
}

/**
 * ACCT-AUDIT-5: the `stock/po-received` trigger could not be enqueued. Post the receive journal inline instead (idempotent per
 * receive pass, so a later retry or the nightly sweep posts nothing twice); a failure here is logged and left to the sweep.
 */
async function postReceiveInline(
  storeId: string,
  poId: string,
  clearedBackorders: Array<Record<string, unknown>>,
  enqueueErr: unknown
): Promise<void> {
  logger.error({ err: enqueueErr, poId }, 'Failed to enqueue stock/po-received');
  try {
    await postPoReceiveJournal({ storeId, poId, clearedBackorders: clearedBackorders as never });
  } catch (err) {
    logger.error({ err, poId }, 'stock/po-received: inline journal post failed');
  }
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

  const stock = await storeStock(input.storeId);
  if (stock) {
    // Durable Object path (Ruling CF-R7-1): the backorder FIFO, the on-hand and weighted-average cost, the history rows and the
    // PO status are ONE section; the DO is single threaded, so the Postgres row locks are not needed.
    const r = await stock.receivePurchaseOrder({
      poId: input.poId,
      receivedBy: input.receivedBy ?? null,
      receipts: input.receipts,
    });
    await invalidateStoreProductCaches(input.storeId);
    inngest
      .send({
        name: 'stock/po-received',
        data: { storeId: input.storeId, poId: input.poId, clearedBackorders: r.clearedBackorders },
      })
      .catch((err: unknown) =>
        postReceiveInline(input.storeId, input.poId, r.clearedBackorders, err)
      );
    const po = await (
      await storeDb(input.storeId)
    ).purchaseOrder.findFirstOrThrow({
      where: { id: input.poId, storeId: input.storeId },
    });
    return { po, clearedBackorders: r.clearedBackorders };
  }

  const po = await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
    // Serialise receives of ONE purchase order (M-022): the PO row lock first, the PO read AFTER it, so a double
    // click / two staff see each other's receipt (the qty guard and `qtyReceived` are judged on the locked state).
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${input.poId} AND store_id = ${input.storeId} FOR UPDATE`;
    const po = await tx.purchaseOrder.findUnique({
      where: { id: input.poId, storeId: input.storeId },
      include: { items: true },
    });
    if (!po || po.storeId !== input.storeId)
      throw new AppError(404, 'PO_NOT_FOUND', 'Purchase order not found.');
    if (po.status === 'received' || po.status === 'cancelled')
      throw new AppError(
        409,
        'PO_NOT_RECEIVABLE',
        `This purchase order can no longer be received (status: ${po.status}).`
      );

    // Lock the PRODUCTS being received (sorted, so two receives cannot deadlock) before anything about them is read:
    // a receive of a DIFFERENT PO for the same product would otherwise read the same open backorder lines and the same
    // on-hand / cost, and both would write absolute values (backorder `qtyFulfilled`, the weighted-average cost).
    const lockIds = [
      ...new Set(
        input.receipts
          .filter(r => r.qtyReceived > 0)
          .map(r => po.items.find(i => i.id === r.poItemId)?.productId)
          .filter((x): x is string => !!x)
      ),
    ].sort();
    if (lockIds.length > 0) {
      await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${lockIds}::text[]) AND store_id = ${input.storeId} ORDER BY id FOR UPDATE`;
    }

    for (const receipt of input.receipts) {
      if (receipt.qtyReceived <= 0) continue;
      const item = po.items.find(i => i.id === receipt.poItemId);
      if (!item)
        throw new AppError(400, 'PO_ITEM_NOT_FOUND', 'A receipt line does not match this PO.');
      const remainingAfter = item.qtyReceived + receipt.qtyReceived;
      if (remainingAfter > item.qty)
        throw new AppError(
          400,
          'RECEIVE_EXCEEDS_QTY',
          `Cannot receive ${receipt.qtyReceived}; that would exceed the ordered quantity (${item.qty}).`
        );

      // Old-shape guard: a variant-less line on a product that has variants
      // (drafted before 2026-10-01, or by a client that skipped the create
      // check) would write the parent column below. Refuse it — the merchant
      // cancels the PO and redrafts it per variant.
      if (!item.variantId) {
        const variantCount = await tx.productVariant.count({
          where: { productId: item.productId },
        });
        if (variantCount > 0)
          throw new AppError(
            400,
            'VARIANT_REQUIRED',
            'This line has no variant but its product has variants. Cancel this purchase order and draft it again per variant.'
          );
      }

      let remainingToProcess = receipt.qtyReceived;

      // Step 1a: FIFO-clear backorders (oldest open first)
      const openBackorders = await tx.backorderLine.findMany({
        where: {
          storeId: input.storeId,
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
          where: { id: bo.id, storeId: input.storeId },
          data: {
            qtyFulfilled: newQtyFulfilled,
            ...(isFullyFulfilled ? { fulfilledAt: new Date(), fulfilledByPoItemId: item.id } : {}),
          },
        });

        // Heal the backorder stock debt these units leave behind (#2299,
        // ruling AP-5d, same heal-to-0 rule as a line cancel, AP-5c): the
        // received units go to the customer, not the shelf, so without this a
        // NON-variant product backordered at checkout kept its negative
        // on-hand forever after the PO fulfilled it. Variant lines heal
        // nothing (checkout floors them at 0).
        await healBackorderStockDebt(tx, {
          storeId: input.storeId,
          productId: item.productId,
          variantId: item.variantId ?? null,
          quantity: fulfilQty,
          reference: `po-backorder:${bo.id}`,
          reason: `PO receive ${po.poNumber} — backorder fulfilled, stock debt healed to 0`,
          userId: input.receivedBy ?? null,
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
              storeId: input.storeId,
              orderItemId: bo.orderItemId,
              fulfilledAt: null,
              cancelledAt: null,
              id: { not: bo.id },
            },
          });
          if (remainingOpen === 0) {
            // OrderItem has no storeId of its own — scope through its order.
            await tx.orderItem.updateMany({
              where: { id: bo.orderItemId, order: { storeId: input.storeId } },
              data: { costPriceDeferred: false },
            });
          }
        }

        remainingToProcess -= fulfilQty;
      }

      // Step 1b: Replenish on-hand with remainder + WAC recompute
      if (remainingToProcess > 0) {
        const product = await tx.product.findFirst({
          where: { id: item.productId, storeId: input.storeId },
          select: {
            inventory: true,
            costPrice: true,
            variants: { select: { inventory: true, isActive: true } },
          },
        });
        if (!product) throw new Error(`Product ${item.productId} not found`);

        // On-hand BEFORE this receive. For a variant product that is the
        // variant sum — `products.inventory` is not stock for one (see
        // lib/effective-inventory.ts), so using it here would weight the
        // average against a meaningless quantity.
        const onHandBefore = effectiveInventory(product);

        if (item.variantId) {
          // A variant line: stock AND cost land on the VARIANT. The merchant
          // prices cost per variant, and checkout snapshots
          // `variant.costPrice ?? product.costPrice` onto the order line — a
          // weighted average written only to the parent never reached a sold
          // variant that has its own cost, and averaged unrelated variants
          // together for one that does not.
          const variant = await tx.productVariant.findFirst({
            where: {
              id: item.variantId,
              productId: item.productId,
              product: { storeId: input.storeId },
            },
            select: { inventory: true, costPrice: true, isActive: true },
          });
          if (!variant) throw new Error(`Variant ${item.variantId} not found in store`);
          // Issue 2145: a disabled variant is not stock — receiving into it
          // would post AP/Inventory for units every surface reads as 0.
          if (!variant.isActive) {
            throw new AppError(
              409,
              'VARIANT_INACTIVE',
              'A variant on this purchase order is disabled. Re-enable it before receiving stock for it.'
            );
          }

          // WAC over THIS variant's own on-hand (floored at 0 — variant rows
          // never go negative, see docs/architecture/inventory-model.md).
          // First receive with no cost on the variant starts from the
          // parent's cost when it has one, else from this receipt's cost.
          const vOldStock = Math.max(variant.inventory, 0);
          const vOldCost = variant.costPrice ?? product.costPrice ?? item.unitCost;
          const vDenom = vOldStock + remainingToProcess;
          const vNewCost =
            vDenom > 0
              ? Math.round((vOldStock * vOldCost + remainingToProcess * item.unitCost) / vDenom)
              : item.unitCost;

          const vRes = await tx.productVariant.updateMany({
            where: { id: item.variantId, product: { storeId: input.storeId } },
            data: { inventory: { increment: remainingToProcess }, costPrice: vNewCost },
          });
          if (vRes.count !== 1) throw new Error(`Variant ${item.variantId} not found in store`);

          // The parent keeps no stock for a variant product; only stamp when
          // its cost basis last moved. Its own costPrice is left alone — it
          // is the fallback for variants that have none, not their average.
          const pRes = await tx.product.updateMany({
            where: { id: item.productId, storeId: input.storeId },
            data: { lastCostUpdateAt: new Date() },
          });
          if (pRes.count !== 1) throw new Error(`Product ${item.productId} not found in store`);
        } else {
          // WAC formula: treat negative on-hand as 0 (backorder demand was consumed
          // in the FIFO clearance phase above; only pre-existing positive stock counts).
          const oldStock = Math.max(onHandBefore, 0);
          const oldCost = product.costPrice ?? item.unitCost; // first-receive fallback
          const denom = oldStock + remainingToProcess;
          const newCost =
            denom > 0
              ? Math.round((oldStock * oldCost + remainingToProcess * item.unitCost) / denom)
              : item.unitCost;

          const pRes = await tx.product.updateMany({
            where: { id: item.productId, storeId: input.storeId },
            data: {
              // a relative write: an absolute `onHandBefore + n` (built from an earlier read) overwrote a customer
              // order that decremented the shelf in between, bringing the sold unit back as stock (M-022)
              inventory: { increment: remainingToProcess },
              costPrice: newCost,
              lastCostUpdateAt: new Date(),
            },
          });
          if (pRes.count !== 1) throw new Error(`Product ${item.productId} not found in store`);
        }
        const newStock = onHandBefore + remainingToProcess;

        // InventoryHistory row (existing Ebda pattern)
        await tx.inventoryHistory.create({
          data: {
            productId: item.productId,
            storeId: input.storeId,
            type: 'transfer_in',
            quantity: remainingToProcess,
            previousStock: onHandBefore,
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
      where: { id: input.poId, storeId: input.storeId },
      data: {
        status: newStatus,
        receivedAt: allComplete ? new Date() : po.receivedAt,
        receivedBy: input.receivedBy ?? po.receivedBy,
      },
    });
  });

  // Receiving stock changes product/variant availability — same
  // cache-invalidation gap as the other stock-write paths (see
  // stock-adjustment.service.ts postAdjustment).
  await invalidateStoreProductCaches(input.storeId);

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
    .catch((err: unknown) => postReceiveInline(input.storeId, input.poId, clearedBackorders, err));

  return { po, clearedBackorders };
}

export async function listPurchaseOrders(
  storeId: string,
  opts: { status?: string; page?: number; perPage?: number; q?: string } = {}
) {
  const page = opts.page ?? 1;
  const perPage = Math.min(opts.perPage ?? 50, 200);
  const where: Prisma.PurchaseOrderWhereInput = { storeId };
  if (opts.status) where.status = opts.status as any;
  if (opts.q) {
    where.OR = [
      { poNumber: { contains: opts.q, mode: 'insensitive' } },
      { supplier: { name: { contains: opts.q, mode: 'insensitive' } } },
    ];
  }
  const db = await storeDb(storeId);
  const [items, total] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      include: { supplier: { select: { name: true } }, items: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.purchaseOrder.count({ where }),
  ]);
  return { items, total, page, perPage };
}

export async function getPurchaseOrder(storeId: string, id: string) {
  return (await storeDb(storeId)).purchaseOrder.findFirst({
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
  const stock = await storeStock(storeId);
  if (stock) {
    await stock.cancelPurchaseOrder({ id });
    return (await storeDb(storeId)).purchaseOrder.findFirstOrThrow({ where: { id, storeId } });
  }
  const po = await prisma.purchaseOrder.findFirst({ where: { id, storeId } });
  if (!po) throw new AppError(404, 'PO_NOT_FOUND', 'Purchase order not found.');
  // ONE conditional update (it row-locks the PO, so a receive that is committing `received` is waited for and then
  // re-judged): a fully received PO - stock and accounts payable already posted - is never overwritten to cancelled.
  const done = await prisma.purchaseOrder.updateMany({
    where: { id, storeId, status: { not: 'received' } },
    data: { status: 'cancelled' },
  });
  if (done.count !== 1)
    throw new AppError(
      409,
      'PO_ALREADY_RECEIVED',
      'A fully-received purchase order cannot be cancelled.'
    );
  return prisma.purchaseOrder.findFirstOrThrow({ where: { id, storeId } });
}

/**
 * One-click "Draft PO from suggestion" factory used by the Reorder admin page
 * (Batch 3 Task 7). Reads the ReorderSuggestion, resolves the supplier (rule's
 * preferredSupplier > last PO supplier for this product > throw), creates a
 * draft PO for the suggestion's unit — its variant, for a variant product —
 * with the suggested qty at that row's current cost (variant.costPrice ??
 * product.costPrice), and marks the suggestion accepted with the resulting
 * poId for audit trace.
 */
export async function createPoFromSuggestion(
  suggestionId: string,
  storeId: string,
  createdBy?: string
): Promise<PurchaseOrder & { items: PurchaseOrderItem[] }> {
  const sdb = await storeDb(storeId);
  const sug = await sdb.reorderSuggestion.findFirst({
    where: { id: suggestionId, storeId },
    include: {
      product: {
        select: {
          costPrice: true,
          name: true,
          _count: { select: { variants: true } },
        },
      },
      variant: { select: { costPrice: true } },
    },
  });
  if (!sug) throw new AppError(404, 'SUGGESTION_NOT_FOUND', 'Reorder suggestion not found.');
  if (sug.status !== 'open')
    throw new AppError(
      409,
      'SUGGESTION_ALREADY_PROCESSED',
      `This reorder suggestion was already ${sug.status}.`
    );

  // A product-level suggestion for a variant product is the pre-2026-10-01
  // shape. The next reorder scan expires it and writes one per variant;
  // drafting from it would need a variant it does not carry.
  if (!sug.variantId && sug.product._count.variants > 0)
    throw new AppError(
      409,
      'SUGGESTION_OUTDATED',
      'This suggestion predates per-variant reordering. Run the reorder scan again to get one suggestion per variant.'
    );

  const supplierId = sug.supplierId ?? (await pickLastSupplierForProduct(sug.productId, storeId));
  if (!supplierId) {
    throw new AppError(
      400,
      'SUPPLIER_REQUIRED',
      'This product has no supplier yet. Add a supplier (Inventory → Suppliers) or set the product’s reorder rule preferred supplier, then draft the PO.'
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
        // A variant line drafts at the VARIANT's cost (the row receive
        // averages against), falling back to the parent — the parent's cost
        // is no longer updated by variant receipts (2145 comment).
        unitCost: sug.variant?.costPrice ?? sug.product.costPrice ?? 0,
      },
    ],
    createdBy,
    // a DO store accepts the suggestion inside the PO section; Postgres does it right after (below)
    suggestionId: (await storeStock(storeId)) ? suggestionId : undefined,
    notes: `Auto-drafted from reorder suggestion (urgency ${sug.urgencyDays}d, velocity ${sug.velocity7d.toFixed(2)}/d)`,
  });

  if (!(await storeStock(storeId))) {
    await prisma.reorderSuggestion.update({
      where: { id: suggestionId, storeId },
      data: { status: 'accepted', poId: po.id },
    });
  }

  return po;
}

/**
 * Used by createPoFromSuggestion fallback supplier resolution + by reorder-scan
 * candidate enrichment when no ReorderRule.preferredSupplierId is set.
 *
 * Returns the supplier from the most recent PurchaseOrder containing this
 * productId, or null if no PO has ever been placed for it.
 */
export async function pickLastSupplierForProduct(
  productId: string,
  storeId?: string
): Promise<string | null> {
  const db = storeId ? await storeDb(storeId) : prisma;
  const lastPoItem = await db.purchaseOrderItem.findFirst({
    where: { productId },
    select: { po: { select: { supplierId: true } } },
    orderBy: { po: { createdAt: 'desc' } },
  });
  return lastPoItem?.po.supplierId ?? null;
}
