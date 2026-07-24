import { prisma, Prisma, withMoneyTx } from '@force/database';
import type { StockAdjustment, StockAdjustmentItem, StockAdjustmentType } from '@prisma/client';
import { nextSequence } from '../sequence.service';
import { inngest } from '../../lib/inngest/client';
import { WarehouseService } from '../warehouse.service';
import logger from '../../lib/logger';

// InventoryChangeType mapping for StockAdjustmentType values
const INVENTORY_TYPE_MAP: Record<
  StockAdjustmentType,
  'adjustment' | 'damage' | 'manual_add' | 'manual_remove'
> = {
  cycle_count: 'adjustment',
  damage: 'damage',
  theft: 'damage',
  loss: 'damage',
  write_off: 'damage',
  found: 'manual_add',
  return_to_supplier: 'manual_remove',
};

export interface CreateAdjustmentInput {
  storeId: string;
  type: StockAdjustmentType;
  reason?: string;
  reasonAr?: string;
  evidenceUrl?: string;
  createdBy?: string;
  items: Array<{
    productId: string;
    variantId?: string;
    newQty: number;
  }>;
}

export type AdjustmentWithItems = StockAdjustment & {
  items: (StockAdjustmentItem & {
    product: { name: string; nameAr: string | null };
    variant: { sku: string | null } | null;
  })[];
};

/**
 * Create a draft StockAdjustment. Snapshots previousQty + unitCost from the
 * current product/variant state and computes deltaQty + totalValueImpact.
 * The adjustment sits in status='draft' until postAdjustment is called.
 */
export async function createAdjustment(input: CreateAdjustmentInput): Promise<AdjustmentWithItems> {
  const adjustmentNumber = await nextSequence(input.storeId, 'adjustment');

  // Snapshot current state for every item line
  const snapshots = await Promise.all(
    input.items.map(async item => {
      if (item.variantId) {
        const variant = await prisma.productVariant.findFirst({
          where: { id: item.variantId, productId: item.productId },
          select: { inventory: true, costPrice: true },
        });
        const previousQty = variant?.inventory ?? 0;
        const unitCost = variant?.costPrice ?? 0;
        const deltaQty = item.newQty - previousQty;
        return { ...item, previousQty, unitCost, deltaQty };
      } else {
        const product = await prisma.product.findFirst({
          where: { id: item.productId, storeId: input.storeId },
          select: { inventory: true, costPrice: true },
        });
        const previousQty = product?.inventory ?? 0;
        const unitCost = product?.costPrice ?? 0;
        const deltaQty = item.newQty - previousQty;
        return { ...item, previousQty, unitCost, deltaQty };
      }
    })
  );

  const totalValueImpact = snapshots.reduce((sum, s) => sum + s.deltaQty * s.unitCost, 0);

  return prisma.stockAdjustment.create({
    data: {
      storeId: input.storeId,
      adjustmentNumber,
      type: input.type,
      status: 'draft',
      reason: input.reason,
      reasonAr: input.reasonAr,
      evidenceUrl: input.evidenceUrl,
      totalValueImpact,
      createdBy: input.createdBy,
      items: {
        create: snapshots.map(s => ({
          productId: s.productId,
          variantId: s.variantId ?? null,
          previousQty: s.previousQty,
          newQty: s.newQty,
          deltaQty: s.deltaQty,
          unitCost: s.unitCost,
        })),
      },
    },
    include: {
      items: {
        include: {
          product: { select: { name: true, nameAr: true } },
          variant: { select: { sku: true } },
        },
      },
    },
  });
}

/**
 * Post a draft adjustment: applies inventory mutations atomically
 * (Product.inventory / ProductVariant.inventory + InventoryHistory rows),
 * marks the adjustment as posted, then fires the Inngest event so the
 * GL journal posts asynchronously.
 */
export async function postAdjustment(
  storeId: string,
  id: string,
  postedBy?: string
): Promise<AdjustmentWithItems> {
  const adjustment = await prisma.stockAdjustment.findFirst({
    where: { id, storeId },
    include: { items: true },
  });

  if (!adjustment) throw new Error(`StockAdjustment ${id} not found in store ${storeId}`);
  if (adjustment.status !== 'draft')
    throw new Error(`StockAdjustment ${id} is already posted (status=${adjustment.status})`);

  const inventoryType = INVENTORY_TYPE_MAP[adjustment.type];

  await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
    for (const item of adjustment.items) {
      if (item.variantId) {
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { inventory: item.newQty },
        });
      } else {
        await tx.product.update({
          where: { id: item.productId },
          data: { inventory: item.newQty },
        });
      }

      await tx.inventoryHistory.create({
        data: {
          productId: item.productId,
          storeId,
          type: inventoryType,
          quantity: item.deltaQty,
          previousStock: item.previousQty,
          newStock: item.newQty,
          reason: adjustment.reason ?? adjustment.type,
          reference: adjustment.adjustmentNumber,
          createdBy: postedBy,
        },
      });
    }

    await tx.stockAdjustment.update({
      where: { id },
      data: {
        status: 'posted',
        postedAt: new Date(),
        postedBy: postedBy ?? null,
      },
    });
  });

  // Re-sync the WarehouseStock shadow for every SKU this adjustment touched
  // — POST-COMMIT, after the money tx above has already committed. Reconcile
  // is best-effort + internally retriable (see WarehouseService docstring),
  // so a reconcile failure must NEVER roll back or fail this already-posted
  // accounting adjustment: each SKU is isolated in its own try/catch that
  // logs (structured, per-SKU) and swallows, exactly like the Inngest event
  // fire below it. One adjustment can touch many line items/SKUs, so every
  // item's own (productId, variantId) — never admin-supplied — is reconciled
  // independently; one bad SKU doesn't block its siblings.
  for (const item of adjustment.items) {
    try {
      await WarehouseService.reconcileWarehouseStockToAggregate(
        storeId,
        item.productId,
        item.variantId
      );
    } catch (err) {
      logger.error(
        { err, storeId, adjustmentId: id, productId: item.productId, variantId: item.variantId },
        'postAdjustment: warehouse stock reconcile failed (best-effort)'
      );
    }
  }

  // Fire the Inngest event so the GL journal posts asynchronously
  try {
    await inngest.send({
      name: 'stock/adjustment-posted',
      data: { storeId, adjustmentId: id },
    });
  } catch (err) {
    logger.error(
      { err, adjustmentId: id, storeId },
      'postAdjustment: failed to fire inngest event'
    );
  }

  return prisma.stockAdjustment.findFirstOrThrow({
    where: { id, storeId },
    include: {
      items: {
        include: {
          product: { select: { name: true, nameAr: true } },
          variant: { select: { sku: true } },
        },
      },
    },
  });
}

/**
 * List last 100 adjustments for a store with items + product names.
 * Accepts optional from/to Date values to filter by createdAt.
 */
export async function listAdjustments(
  storeId: string,
  opts: { from?: Date; to?: Date } = {}
): Promise<AdjustmentWithItems[]> {
  const where: any = { storeId };
  if (opts.from || opts.to) {
    where.createdAt = {};
    if (opts.from) where.createdAt.gte = opts.from;
    if (opts.to) where.createdAt.lte = opts.to;
  }
  return prisma.stockAdjustment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      items: {
        include: {
          product: { select: { name: true, nameAr: true } },
          variant: { select: { sku: true } },
        },
      },
    },
  });
}

/**
 * Full detail for a single adjustment.
 */
export async function getAdjustment(
  storeId: string,
  id: string
): Promise<AdjustmentWithItems | null> {
  return prisma.stockAdjustment.findFirst({
    where: { id, storeId },
    include: {
      items: {
        include: {
          product: { select: { name: true, nameAr: true } },
          variant: { select: { sku: true } },
        },
      },
    },
  });
}
