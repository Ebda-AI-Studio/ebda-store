import { assertStoreOwnsInTenantScope } from './assert-store-owns';
import { AppError } from '../../middleware/error-handler';
import { prisma, Prisma, withMoneyTx } from '@ebda/database';
import type { StockAdjustment, StockAdjustmentItem, StockAdjustmentType } from '@prisma/client';
import { nextSequence } from '../sequence.service';
import { inngest } from '../../lib/inngest/client';
import { WarehouseService } from '../warehouse.service';
import { invalidateStoreProductCaches } from '../../lib/public-cache';
import logger from '../../lib/logger';
import { storeDb, storeStock } from '../../lib/repo-factory';

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
  /** CSV-import idempotency key (#226); unique per store. */
  importKey?: string;
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
  const stock = await storeStock(input.storeId);
  if (stock) {
    // Durable Object path (Ruling CF-R7-1): ownership, the snapshot, the number and the rows are ONE section.
    const r = await stock.createStockAdjustment({
      type: input.type,
      reason: input.reason,
      reasonAr: input.reasonAr,
      evidenceUrl: input.evidenceUrl,
      createdBy: input.createdBy,
      importKey: input.importKey,
      items: input.items,
    });
    return getAdjustmentOrThrow(input.storeId, r.id);
  }
  // Every product/variant id here comes from the request body. requireStoreAccess
  // only proved the caller owns the store in the URL, so without this a
  // store_admin could name a competitor's ids (harvestable from the public
  // storefront) and have postAdjustment write their inventory. Prod runs
  // BYPASSRLS, so there is no database backstop.
  //
  // #1241 / issue 2057: the guard must run under the store's RLS GUC —
  // on the ambient request transaction when there is one, in its own
  // tenant-scoped transaction when there is not (Inngest callers). See
  // assertStoreOwnsInTenantScope.
  await assertStoreOwnsInTenantScope(input.storeId, {
    productIds: input.items.map(i => i.productId),
    variantIds: input.items.map(i => i.variantId),
  });

  const adjustmentNumber = await nextSequence(input.storeId, 'adjustment');

  // Snapshot current state for every item line. Two batched reads, not one
  // query per line (#225): a 5,000-row CSV used to fan out into 5,000
  // concurrent findFirst calls and exhaust the connection pool. The
  // `product: { storeId }` / `storeId` scoping is load-bearing — it is the
  // same tenant guard the per-line queries carried.
  const variantIds = input.items.flatMap(i => (i.variantId ? [i.variantId] : []));
  const productOnlyIds = input.items.flatMap(i => (i.variantId ? [] : [i.productId]));
  const [variantRows, productRows] = await Promise.all([
    variantIds.length > 0
      ? prisma.productVariant.findMany({
          where: { id: { in: variantIds }, product: { storeId: input.storeId } },
          select: { id: true, productId: true, inventory: true, costPrice: true },
        })
      : Promise.resolve([]),
    productOnlyIds.length > 0
      ? prisma.product.findMany({
          where: { id: { in: productOnlyIds }, storeId: input.storeId },
          select: { id: true, inventory: true, costPrice: true },
        })
      : Promise.resolve([]),
  ]);
  const variantById = new Map(variantRows.map(v => [v.id, v]));
  const productById = new Map(productRows.map(p => [p.id, p]));

  const snapshots = input.items.map(item => {
    if (item.variantId) {
      const variant = variantById.get(item.variantId);
      // The variant must also belong to the named product (the old per-line
      // query filtered on both ids).
      const match = variant && variant.productId === item.productId ? variant : undefined;
      const previousQty = match?.inventory ?? 0;
      const unitCost = match?.costPrice ?? 0;
      const deltaQty = item.newQty - previousQty;
      return { ...item, previousQty, unitCost, deltaQty };
    }
    const product = productById.get(item.productId);
    const previousQty = product?.inventory ?? 0;
    const unitCost = product?.costPrice ?? 0;
    const deltaQty = item.newQty - previousQty;
    return { ...item, previousQty, unitCost, deltaQty };
  });

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
      importKey: input.importKey ?? null,
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
  const stock = await storeStock(storeId);
  if (stock) {
    // Durable Object path (Ruling CF-R7-1): the claim, the stock, the history and the warehouse shadow are ONE section.
    await stock.postStockAdjustment({ id, postedBy: postedBy ?? null });
    await invalidateStoreProductCaches(storeId);
    try {
      await inngest.send({ name: 'stock/adjustment-posted', data: { storeId, adjustmentId: id } });
    } catch (err) {
      logger.error(
        { err, adjustmentId: id, storeId },
        'postAdjustment: failed to fire inngest event'
      );
    }
    return getAdjustmentOrThrow(storeId, id);
  }
  const adjustment = await prisma.stockAdjustment.findFirst({
    where: { id, storeId },
    include: { items: true },
  });

  if (!adjustment) throw new AppError(404, 'NOT_FOUND', 'Stock adjustment not found');
  if (adjustment.status !== 'draft') {
    throw new AppError(409, 'ALREADY_POSTED', 'This stock adjustment has already been posted');
  }

  const inventoryType = INVENTORY_TYPE_MAP[adjustment.type];

  await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
    // Claim the draft FIRST (#226). The status check above is a plain read,
    // so two concurrent posts of the same draft (a double-click on "post", or
    // a CSV-import replay racing the original) both passed it and both wrote
    // the inventory, the history rows and the GL event. The conditional
    // update takes the row lock; the loser re-checks `status = 'draft'`
    // against the winner's committed row, matches 0 and stops here.
    const claim = await tx.stockAdjustment.updateMany({
      where: { id, storeId, status: 'draft' },
      data: { status: 'posted', postedAt: new Date(), postedBy: postedBy ?? null },
    });
    if (claim.count !== 1) {
      throw new AppError(409, 'ALREADY_POSTED', 'This stock adjustment has already been posted');
    }

    for (const item of adjustment.items) {
      // Belt-and-braces on top of the createAdjustment guard: updateMany lets
      // us carry a relation filter that update() (unique-where only) cannot,
      // so a foreign id matches zero rows instead of writing another tenant.
      if (item.variantId) {
        const res = await tx.productVariant.updateMany({
          where: { id: item.variantId, product: { storeId } },
          data: { inventory: item.newQty },
        });
        if (res.count !== 1) {
          throw new AppError(404, 'NOT_FOUND', 'One or more referenced records were not found');
        }
      } else {
        const res = await tx.product.updateMany({
          where: { id: item.productId, storeId },
          data: { inventory: item.newQty },
        });
        if (res.count !== 1) {
          throw new AppError(404, 'NOT_FOUND', 'One or more referenced records were not found');
        }
      }
    }

    // One INSERT for the whole ledger instead of one per line (#225).
    await tx.inventoryHistory.createMany({
      data: adjustment.items.map(item => ({
        productId: item.productId,
        storeId,
        type: inventoryType,
        quantity: item.deltaQty,
        previousStock: item.previousQty,
        newStock: item.newQty,
        reason: adjustment.reason ?? adjustment.type,
        reference: adjustment.adjustmentNumber,
        createdBy: postedBy,
      })),
    });
  });

  // Stock changed for every item this adjustment touched — POST-COMMIT, same
  // as the WarehouseStock reconcile below. This is the write path the
  // public bundle-list cache staleness traced back to: `postAdjustment`
  // (also reached via cycle-count reconcile) never busted the product/
  // bundle caches, so a bundle's `isPurchasable`/price could sit stale for
  // up to the cache TTL after a manual or reconciled stock correction.
  await invalidateStoreProductCaches(storeId);

  // Re-sync the WarehouseStock shadow for every SKU this adjustment touched
  // — POST-COMMIT, after the money tx above has already committed. Reconcile
  // is best-effort + internally retriable (see WarehouseService docstring),
  // so a reconcile failure must NEVER roll back or fail this already-posted
  // accounting adjustment: each SKU is isolated in its own try/catch that
  // logs (structured, per-SKU) and swallows, exactly like the Inngest event
  // fire below it. One adjustment can touch many line items/SKUs, so every
  // item's own (productId, variantId) — never admin-supplied — is reconciled
  // independently; one bad SKU doesn't block its siblings.
  // Most stores have no warehouses, and reconcile's own fast path is a
  // warehouse COUNT per call — 5,000 of them for a full CSV import (#225).
  // Ask once; skip the loop when there is nothing to reconcile.
  const hasWarehouses = (await prisma.warehouse.count({ where: { storeId } })) > 0;
  for (const item of hasWarehouses ? adjustment.items : []) {
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

  return getAdjustmentOrThrow(storeId, id);
}

async function getAdjustmentOrThrow(storeId: string, id: string): Promise<AdjustmentWithItems> {
  return (await storeDb(storeId)).stockAdjustment.findFirstOrThrow({
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
 * The adjustment an earlier CSV import with this idempotency key created, or
 * null. Used by the csv-import route to replay a retried request (#226).
 */
export async function findAdjustmentByImportKey(
  storeId: string,
  importKey: string
): Promise<{
  id: string;
  adjustmentNumber: string;
  status: StockAdjustment['status'];
  _count: { items: number };
} | null> {
  return (await storeDb(storeId)).stockAdjustment.findFirst({
    where: { storeId, importKey },
    select: { id: true, adjustmentNumber: true, status: true, _count: { select: { items: true } } },
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
  return (await storeDb(storeId)).stockAdjustment.findMany({
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
  return (await storeDb(storeId)).stockAdjustment.findFirst({
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
