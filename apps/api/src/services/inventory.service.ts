import { prisma, Prisma, InventoryChangeType, withStore } from '@ebda/database';
import { cfWaitUntil } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import { notificationDispatcher } from './notification-dispatcher.service';
import { WarehouseService } from './warehouse.service';
import { ON_HAND_SQL, STOCK_VALUE_SQL } from '../lib/effective-inventory-sql';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import logger from '../lib/logger';
import { storefrontOrigin } from '@ebda/shared';
import { storeDb, storeRepo, storeStock, storeWriter } from '../lib/repo-factory';
import { notifyCatalogChanged } from '../lib/wa/catalog-state';

interface InventoryAdjustment {
  productId: string;
  quantity: number;
  type: InventoryChangeType;
  reason?: string;
  reference?: string;
}

interface InventoryStats {
  totalProducts: number;
  totalStock: number;
  lowStockCount: number;
  outOfStockCount: number;
  totalValue: number; // Based on cost price
}

interface ProductInventory {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  inventory: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  costPrice: number | null;
  status: string;
  stockStatus: 'in_stock' | 'low_stock' | 'out_of_stock';
  stockValue: number;
}

interface DoStockRow {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  onHand: number;
  stockValue: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  costPrice: number | null;
  status: string;
}

async function isDoStore(storeId: string): Promise<boolean> {
  return (await storeRepo(storeId)).backend === 'do';
}

/**
 * The variant-aware on-hand and stock value of a Durable Object store's live products: the JS twin of ON_HAND_SQL /
 * STOCK_VALUE_SQL (effective-inventory-sql.ts). A product with ANY variant row is a variant product: only ACTIVE variants
 * count, a variant is valued at its own cost, falling back to the parent's, then 0. Without variants: inventory * cost.
 * `all: false` keeps only the products that track inventory (the stats / alert populations); `all: true` keeps every live
 * product (the listing).
 */
async function doStockRows(storeId: string, opts: { all?: boolean } = {}): Promise<DoStockRow[]> {
  const db = await storeDb(storeId);
  const products = await db.product.findMany({
    where: opts.all
      ? { storeId, deletedAt: null }
      : { storeId, deletedAt: null, trackInventory: true },
    select: {
      id: true,
      name: true,
      nameAr: true,
      sku: true,
      inventory: true,
      lowStockThreshold: true,
      trackInventory: true,
      costPrice: true,
      status: true,
      variants: { select: { inventory: true, costPrice: true, isActive: true } },
    },
  });
  return products.map(p => {
    const vs = p.variants ?? [];
    const active = vs.filter(v => v.isActive !== false);
    const hasVariants = vs.length > 0;
    return {
      id: p.id,
      name: p.name,
      nameAr: p.nameAr,
      sku: p.sku,
      onHand: hasVariants ? active.reduce((n, v) => n + (v.inventory ?? 0), 0) : p.inventory,
      stockValue: hasVariants
        ? active.reduce((n, v) => n + (v.inventory ?? 0) * (v.costPrice ?? p.costPrice ?? 0), 0)
        : p.inventory * (p.costPrice ?? 0),
      lowStockThreshold: p.lowStockThreshold,
      trackInventory: p.trackInventory,
      costPrice: p.costPrice,
      status: String(p.status),
    };
  });
}

export class InventoryService {
  /**
   * Get inventory statistics for a store
   */
  static async getStats(storeId: string): Promise<InventoryStats> {
    if (await isDoStore(storeId)) {
      const rows = await doStockRows(storeId);
      return {
        totalProducts: rows.length,
        totalStock: rows.reduce((n, r) => n + r.onHand, 0),
        lowStockCount: rows.filter(r => r.onHand > 0 && r.onHand <= r.lowStockThreshold).length,
        outOfStockCount: rows.filter(r => r.onHand <= 0).length,
        totalValue: rows.reduce((n, r) => n + r.stockValue, 0),
      };
    }
    // ONE variant-aware pass. This was four separate queries reading
    // `products.inventory` directly, so every variant product contributed its
    // unused parent column (0, or a drifted negative) instead of its real
    // variant stock — understating totalStock/totalValue and counting the
    // whole variant catalogue as out-of-stock. See lib/effective-inventory.ts.
    const [row] = await prisma.$queryRaw<
      [
        {
          total_products: bigint;
          total_stock: bigint | null;
          low_stock_count: bigint;
          out_of_stock_count: bigint;
          total_value: bigint | null;
        },
      ]
    >`
      WITH on_hand AS (
        -- value: a variant at its own cost, falling back to the parent's
        -- (STOCK_VALUE_SQL) — the parent cost alone valued variants wrongly.
        SELECT ${ON_HAND_SQL} AS qty, ${STOCK_VALUE_SQL} AS value, p.low_stock_threshold
        FROM public.products p
        WHERE p.store_id = ${storeId}
          AND p.deleted_at IS NULL
          AND p.track_inventory = true
      )
      SELECT
        COUNT(*)::bigint                                                         AS total_products,
        COALESCE(SUM(qty), 0)::bigint                                            AS total_stock,
        COUNT(*) FILTER (WHERE qty > 0 AND qty <= low_stock_threshold)::bigint   AS low_stock_count,
        COUNT(*) FILTER (WHERE qty <= 0)::bigint                                 AS out_of_stock_count,
        COALESCE(SUM(value), 0)::bigint                                          AS total_value
      FROM on_hand
    `;

    return {
      totalProducts: Number(row.total_products),
      totalStock: Number(row.total_stock ?? 0),
      lowStockCount: Number(row.low_stock_count),
      outOfStockCount: Number(row.out_of_stock_count),
      totalValue: Number(row.total_value ?? 0),
    };
  }

  /**
   * List products with inventory info
   */
  static async listProducts(
    storeId: string,
    options?: {
      page?: number;
      limit?: number;
      search?: string;
      stockFilter?: 'all' | 'in_stock' | 'low_stock' | 'out_of_stock';
      sortBy?: 'name' | 'inventory' | 'sku';
      sortOrder?: 'asc' | 'desc';
    }
  ): Promise<{
    products: ProductInventory[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const page = Math.max(1, options?.page || 1);
    const limit = Math.min(500, Math.max(1, options?.limit || 20));
    const skip = (page - 1) * limit;

    if (await isDoStore(storeId)) {
      // Durable Object store: the same filter/sort/page as the SQL below, over the store's own rows (no raw SQL on the DO).
      const needle = options?.search?.trim().toLowerCase();
      let rows = await doStockRows(storeId, { all: true });
      if (needle)
        rows = rows.filter(
          r =>
            r.name.toLowerCase().includes(needle) ||
            (r.nameAr ?? '').toLowerCase().includes(needle) ||
            (r.sku ?? '').toLowerCase().includes(needle)
        );
      const f = options?.stockFilter;
      if (f === 'out_of_stock') rows = rows.filter(r => r.onHand <= 0);
      else if (f === 'low_stock')
        rows = rows.filter(
          r => r.trackInventory && r.onHand > 0 && r.onHand <= r.lowStockThreshold
        );
      else if (f === 'in_stock')
        rows = rows.filter(r => r.trackInventory && r.onHand > r.lowStockThreshold);
      const dir = options?.sortOrder === 'desc' ? -1 : 1;
      const key = (r: DoStockRow): string | number =>
        options?.sortBy === 'name' ? r.name : options?.sortBy === 'sku' ? (r.sku ?? '') : r.onHand;
      rows.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        const c = typeof x === 'number' ? x - (y as number) : x.localeCompare(y as string);
        return c * dir || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      const total = rows.length;
      return {
        products: rows.slice(skip, skip + limit).map(r => this.toInventoryRow(r)),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }

    // Raw SQL because every part of this — the stock filter, the sort and the
    // displayed quantity — needs the VARIANT-AWARE on-hand, and two of them
    // also need a column-to-column comparison against `low_stock_threshold`
    // that Prisma's where clause cannot express. The previous Prisma version
    // filtered and sorted on `products.inventory`, which is not stock for a
    // variant product: variant products sorted as if empty, `in_stock` never
    // matched them and `out_of_stock` matched all of them. It also fetched
    // the whole table and paginated in JS for two of the four filters.
    const search = options?.search?.trim();
    const searchSql = search
      ? Prisma.sql`AND (p.name ILIKE ${`%${search}%`} OR p.name_ar ILIKE ${`%${search}%`} OR p.sku ILIKE ${`%${search}%`})`
      : Prisma.empty;

    let stockSql = Prisma.empty;
    if (options?.stockFilter === 'out_of_stock') {
      stockSql = Prisma.sql`AND ${ON_HAND_SQL} <= 0`;
    } else if (options?.stockFilter === 'low_stock') {
      stockSql = Prisma.sql`AND p.track_inventory = true AND ${ON_HAND_SQL} > 0 AND ${ON_HAND_SQL} <= p.low_stock_threshold`;
    } else if (options?.stockFilter === 'in_stock') {
      stockSql = Prisma.sql`AND p.track_inventory = true AND ${ON_HAND_SQL} > p.low_stock_threshold`;
    }

    // Whitelisted — these reach Prisma.raw, so they must never be caller text.
    const sortColumn =
      options?.sortBy === 'name' ? 'p.name' : options?.sortBy === 'sku' ? 'p.sku' : 'on_hand';
    const sortDir = options?.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const where = Prisma.sql`
      WHERE p.store_id = ${storeId} AND p.deleted_at IS NULL ${searchSql} ${stockSql}
    `;

    const [rows, [{ count }]] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          id: string;
          name: string;
          name_ar: string | null;
          sku: string | null;
          on_hand: bigint | number;
          stock_value: bigint | number;
          low_stock_threshold: number;
          track_inventory: boolean;
          cost_price: number | null;
          status: string;
        }>
      >`
        SELECT p.id, p.name, p.name_ar, p.sku, ${ON_HAND_SQL} AS on_hand,
               ${STOCK_VALUE_SQL} AS stock_value,
               p.low_stock_threshold, p.track_inventory, p.cost_price, p.status
        FROM public.products p
        ${where}
        ORDER BY ${Prisma.raw(sortColumn)} ${Prisma.raw(sortDir)}, p.id ASC
        LIMIT ${limit} OFFSET ${skip}
      `,
      prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count FROM public.products p ${where}
      `,
    ]);

    const total = Number(count);
    const products: ProductInventory[] = rows.map(r => {
      const inventory = Number(r.on_hand);
      return {
        id: r.id,
        name: r.name,
        nameAr: r.name_ar,
        sku: r.sku,
        inventory,
        lowStockThreshold: r.low_stock_threshold,
        trackInventory: r.track_inventory,
        costPrice: r.cost_price,
        status: r.status,
        stockStatus: this.getStockStatus(inventory, r.low_stock_threshold),
        stockValue: Number(r.stock_value),
      };
    });

    return {
      products,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get low stock alerts
   * Uses raw SQL to compare inventory against the per-row low_stock_threshold
   * column, which Prisma's where clause cannot express. On-hand is
   * variant-aware (ON_HAND_SQL) — reading `products.inventory` here listed
   * every variant product as out-of-stock and none as low-stock.
   */
  static async getLowStockAlerts(storeId: string): Promise<ProductInventory[]> {
    if (await isDoStore(storeId)) {
      const rows = (await doStockRows(storeId)).sort((a, b) => a.onHand - b.onHand);
      const out = rows.filter(r => r.onHand <= 0).slice(0, 100);
      const low = rows.filter(r => r.onHand > 0 && r.onHand <= r.lowStockThreshold).slice(0, 100);
      return [...out, ...low].map(r => this.toInventoryRow(r));
    }
    // Products that are low on stock (0 < inventory <= low_stock_threshold)
    const lowStockProducts = await prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        name_ar: string | null;
        sku: string | null;
        inventory: number;
        stock_value: bigint | number;
        low_stock_threshold: number;
        track_inventory: boolean;
        cost_price: number | null;
        status: string;
      }>
    >`
      SELECT p.id, p.name, p.name_ar, p.sku, ${ON_HAND_SQL} AS inventory,
             ${STOCK_VALUE_SQL} AS stock_value,
             p.low_stock_threshold, p.track_inventory, p.cost_price, p.status
      FROM public.products p
      WHERE p.store_id = ${storeId}
        AND p.deleted_at IS NULL
        AND p.track_inventory = true
        AND ${ON_HAND_SQL} <= p.low_stock_threshold
        AND ${ON_HAND_SQL} > 0
      ORDER BY inventory ASC
      LIMIT 100
    `;

    // Products that are completely out of stock (inventory <= 0)
    const outOfStockProducts = await prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        name_ar: string | null;
        sku: string | null;
        inventory: number;
        stock_value: bigint | number;
        low_stock_threshold: number;
        track_inventory: boolean;
        cost_price: number | null;
        status: string;
      }>
    >`
      SELECT p.id, p.name, p.name_ar, p.sku, ${ON_HAND_SQL} AS inventory,
             ${STOCK_VALUE_SQL} AS stock_value,
             p.low_stock_threshold, p.track_inventory, p.cost_price, p.status
      FROM public.products p
      WHERE p.store_id = ${storeId}
        AND p.deleted_at IS NULL
        AND p.track_inventory = true
        AND ${ON_HAND_SQL} <= 0
      ORDER BY inventory ASC
      LIMIT 100
    `;

    // Combine: out-of-stock first (more urgent), then low stock
    const allProducts = [...outOfStockProducts, ...lowStockProducts];

    return allProducts.map(p => ({
      id: p.id,
      name: p.name,
      nameAr: p.name_ar,
      sku: p.sku,
      inventory: Number(p.inventory),
      lowStockThreshold: p.low_stock_threshold,
      trackInventory: p.track_inventory,
      costPrice: p.cost_price,
      status: p.status,
      stockStatus: this.getStockStatus(p.inventory, p.low_stock_threshold),
      stockValue: Number(p.stock_value),
    }));
  }

  /**
   * Adjust inventory for a single product
   */
  static async adjustInventory(
    storeId: string,
    adjustment: InventoryAdjustment,
    userId?: string
  ): Promise<{ product: ProductInventory; history: object }> {
    const stock = await storeStock(storeId);
    if (stock) {
      // Durable Object path (Ruling CF-STOCK-1): the check, the write, the history row and the warehouse shadow re-sync are
      // ONE section in the DO; no read-then-write window.
      const r = await stock.adjustProduct({ ...adjustment, userId });
      const db = await storeDb(storeId);
      const [updatedProduct, history] = await Promise.all([
        db.product.findUniqueOrThrow({
          where: { id: adjustment.productId },
          select: {
            id: true,
            name: true,
            nameAr: true,
            sku: true,
            inventory: true,
            lowStockThreshold: true,
            trackInventory: true,
            costPrice: true,
            status: true,
          },
        }),
        db.inventoryHistory.findUniqueOrThrow({ where: { id: r.historyId } }),
      ]);
      await notifyCatalogChanged({ storeId, productIds: [adjustment.productId] });
      await invalidateStoreProductCaches(storeId);
      return this.afterAdjust(
        storeId,
        adjustment.productId,
        updatedProduct,
        history,
        r.previousStock,
        r.newStock,
        false
      );
    }

    const product = await prisma.product.findFirst({
      where: { id: adjustment.productId, storeId, deletedAt: null },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // A variant product's stock lives on its variants; `products.inventory`
    // is unused for it (see lib/effective-inventory.ts). Writing it here
    // would corrupt the column without moving any real stock, so refuse
    // rather than silently no-op. The variant endpoints
    // (PUT/POST .../variants/:id, .../variants/bulk-inventory) and the
    // StockAdjustment flow — which the admin inventory grid already links to
    // for these products — both handle variant products correctly.
    const variantCount = await prisma.productVariant.count({
      where: { productId: adjustment.productId },
    });
    if (variantCount > 0) {
      throw new AppError(
        400,
        'VARIANT_PRODUCT',
        'This product tracks stock on its variants. Adjust the variant inventory instead.'
      );
    }

    const previousStock = product.inventory;
    const newStock = previousStock + adjustment.quantity;

    if (newStock < 0) {
      throw new AppError(400, 'INSUFFICIENT_STOCK', 'Cannot reduce stock below zero');
    }

    // Update product and create history in transaction
    const [updatedProduct, history] = await prisma.$transaction([
      prisma.product.update({
        where: { id: adjustment.productId, storeId },
        data: { inventory: newStock },
        select: {
          id: true,
          name: true,
          nameAr: true,
          sku: true,
          inventory: true,
          lowStockThreshold: true,
          trackInventory: true,
          costPrice: true,
          status: true,
        },
      }),
      prisma.inventoryHistory.create({
        data: {
          productId: adjustment.productId,
          storeId,
          type: adjustment.type,
          quantity: adjustment.quantity,
          previousStock,
          newStock,
          reason: adjustment.reason,
          reference: adjustment.reference,
          createdBy: userId,
        },
      }),
    ]);

    await invalidateStoreProductCaches(storeId);
    return this.afterAdjust(
      storeId,
      adjustment.productId,
      updatedProduct,
      history,
      previousStock,
      newStock,
      true
    );
  }

  /** Shared tail of adjustInventory: cache bust, response shape, back-in-stock, and (Postgres only) the warehouse shadow re-sync. */
  private static async afterAdjust(
    storeId: string,
    productId: string,
    updatedProduct: {
      id: string;
      name: string;
      nameAr: string | null;
      sku: string | null;
      inventory: number;
      lowStockThreshold: number;
      trackInventory: boolean;
      costPrice: number | null;
      status: string;
    },
    history: object,
    previousStock: number,
    newStock: number,
    reconcileShadow: boolean
  ): Promise<{ product: ProductInventory; history: object }> {
    // Stock changed — every product/bundle cache keyed on availability
    // must clear (see the class-wide fix on this defect: a bundle's
    // isPurchasable/componentSum depend on component product stock, and
    // this write path bypassed the cache entirely before).

    const result = {
      product: {
        id: updatedProduct.id,
        name: updatedProduct.name,
        nameAr: updatedProduct.nameAr,
        sku: updatedProduct.sku,
        inventory: updatedProduct.inventory,
        lowStockThreshold: updatedProduct.lowStockThreshold,
        trackInventory: updatedProduct.trackInventory,
        costPrice: updatedProduct.costPrice,
        status: updatedProduct.status,
        stockStatus: this.getStockStatus(
          updatedProduct.inventory,
          updatedProduct.lowStockThreshold
        ),
        stockValue: updatedProduct.inventory * (updatedProduct.costPrice || 0),
      },
      history,
    };

    // Fire back-in-stock notifications if stock went from 0 to >0
    if (previousStock <= 0 && newStock > 0) {
      cfWaitUntil(
        this.fireBackInStockNotifications(storeId, productId, updatedProduct.name).catch(err =>
          logger.error(
            { err, storeId, productId: productId },
            '[InventoryService] Back-in-stock notification failed'
          )
        )
      );
    }

    // Re-sync the WarehouseStock shadow to the aggregate we just committed.
    // This service is product-level only (no variantId concept), so the
    // SKU is always (productId, variantId=null) — the SKU THIS call
    // actually touched, never admin-supplied. Best-effort: the aggregate
    // write above already committed, so a reconcile failure must not fail
    // this already-successful admin request — log and swallow. The
    // no-op fast path makes this ~free for single-/no-warehouse stores.
    try {
      if (reconcileShadow)
        await WarehouseService.reconcileWarehouseStockToAggregate(storeId, productId, null);
    } catch (err) {
      logger.error(
        { err, storeId, productId: productId, variantId: null },
        '[InventoryService] adjustInventory: warehouse stock reconcile failed (best-effort)'
      );
    }

    return result;
  }

  /**
   * Bulk adjust inventory for multiple products.
   *
   * Previously implemented as a per-adjustment loop calling
   * `adjustInventory`, which issued 3 queries per row (findFirst +
   * transactional update + history insert). On a 100-row CSV import
   * that's 300 round-trips against Neon's pooled connection — slow
   * enough to noticeably stall the admin response. This rewrite:
   *
   *   1. Single findMany to load every candidate product
   *   2. Validate each adjustment in memory (out-of-store / not-found
   *      / negative-stock) without hitting the DB
   *   3. One transaction with all product updates + a `createMany`
   *      for history rows
   *   4. Fire back-in-stock notifications post-commit for every
   *      product that crossed 0 → >0
   *
   * Per-row error handling is preserved: a single bad row marks just
   * that row as failed; valid rows still apply atomically inside the
   * transaction.
   */
  static async bulkAdjustInventory(
    storeId: string,
    adjustments: InventoryAdjustment[],
    userId?: string
  ): Promise<{ successful: number; failed: number; errors: string[] }> {
    let failed = 0;
    const errors: string[] = [];

    if (adjustments.length === 0) {
      return { successful: 0, failed: 0, errors: [] };
    }

    const stock = await storeStock(storeId);
    if (stock) {
      // Durable Object path (Ruling CF-STOCK-1): planned and applied in ONE section; a bad row fails alone.
      const r = await stock.bulkAdjustProducts({ adjustments, userId });
      if (r.applied.length > 0) {
        await notifyCatalogChanged({ storeId, productIds: r.applied.map(p => p.productId) });
        await invalidateStoreProductCaches(storeId);
      }
      for (const p of r.applied) {
        if (p.previousStock <= 0 && p.newStock > 0) {
          cfWaitUntil(
            this.fireBackInStockNotifications(storeId, p.productId, p.name).catch(err =>
              logger.error(
                { err, storeId, productId: p.productId },
                '[InventoryService] Back-in-stock notification failed'
              )
            )
          );
        }
      }
      return { successful: r.successful, failed: r.failed, errors: r.errors };
    }

    const ids = adjustments.map(a => a.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: ids }, storeId, deletedAt: null },
      // `variants` (capped at 1 row — only its presence matters) so a variant
      // product can be rejected instead of having its unused parent column
      // written. See lib/effective-inventory.ts.
      select: {
        id: true,
        inventory: true,
        name: true,
        variants: { select: { id: true }, take: 1 },
      },
    });
    const productById = new Map(products.map(p => [p.id, p]));

    type Plan = {
      adjustment: InventoryAdjustment;
      previousStock: number;
      newStock: number;
      productName: string;
    };
    const plans: Plan[] = [];

    for (const adjustment of adjustments) {
      const product = productById.get(adjustment.productId);
      if (!product) {
        failed++;
        errors.push(`Product ${adjustment.productId}: NOT_FOUND`);
        continue;
      }
      if (product.variants.length > 0) {
        failed++;
        errors.push(
          `${product.name}: tracks stock on its variants — adjust the variant inventory instead`
        );
        continue;
      }
      const previousStock = product.inventory;
      const newStock = previousStock + adjustment.quantity;
      if (newStock < 0) {
        failed++;
        errors.push(`Product ${adjustment.productId}: INSUFFICIENT_STOCK`);
        continue;
      }
      plans.push({ adjustment, previousStock, newStock, productName: product.name });
    }

    if (plans.length === 0) {
      return { successful: 0, failed, errors };
    }

    await prisma.$transaction([
      ...plans.map(p =>
        prisma.product.update({
          where: { id: p.adjustment.productId, storeId },
          data: { inventory: p.newStock },
        })
      ),
      prisma.inventoryHistory.createMany({
        data: plans.map(p => ({
          productId: p.adjustment.productId,
          storeId,
          type: p.adjustment.type,
          quantity: p.adjustment.quantity,
          previousStock: p.previousStock,
          newStock: p.newStock,
          reason: p.adjustment.reason,
          reference: p.adjustment.reference,
          createdBy: userId,
        })),
      }),
    ]);

    // Stock changed for every product in `plans` — one invalidation for the
    // whole store covers them all (see the same note in adjustInventory).
    await invalidateStoreProductCaches(storeId);

    // Back-in-stock notifications fire AFTER the transaction commits
    // so a notification doesn't go out for a write that later got
    // rolled back. Same fire-and-forget contract as adjustInventory.
    for (const p of plans) {
      if (p.previousStock <= 0 && p.newStock > 0) {
        cfWaitUntil(
          this.fireBackInStockNotifications(storeId, p.adjustment.productId, p.productName).catch(
            err =>
              logger.error(
                { err, storeId, productId: p.adjustment.productId },
                '[InventoryService] Back-in-stock notification failed'
              )
          )
        );
      }
    }

    return { successful: plans.length, failed, errors };
  }

  /**
   * Set inventory to specific value (for inventory counts)
   */
  static async setInventory(
    storeId: string,
    productId: string,
    newQuantity: number,
    reason?: string,
    userId?: string
  ): Promise<{ product: ProductInventory; history: object }> {
    const stock = await storeStock(storeId);
    if (stock) {
      const r = await stock.setProduct({ productId, quantity: newQuantity, reason, userId });
      const db = await storeDb(storeId);
      const [updatedProduct, history] = await Promise.all([
        db.product.findUniqueOrThrow({
          where: { id: productId },
          select: {
            id: true,
            name: true,
            nameAr: true,
            sku: true,
            inventory: true,
            lowStockThreshold: true,
            trackInventory: true,
            costPrice: true,
            status: true,
          },
        }),
        db.inventoryHistory.findUniqueOrThrow({ where: { id: r.historyId } }),
      ]);
      await notifyCatalogChanged({ storeId, productIds: [productId] });
      await invalidateStoreProductCaches(storeId);
      return this.afterAdjust(
        storeId,
        productId,
        updatedProduct,
        history,
        r.previousStock,
        r.newStock,
        false
      );
    }

    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const previousStock = product.inventory;
    const quantityChange = newQuantity - previousStock;

    // Update product and create history in transaction
    const [updatedProduct, history] = await prisma.$transaction([
      prisma.product.update({
        where: { id: productId, storeId },
        data: { inventory: newQuantity },
        select: {
          id: true,
          name: true,
          nameAr: true,
          sku: true,
          inventory: true,
          lowStockThreshold: true,
          trackInventory: true,
          costPrice: true,
          status: true,
        },
      }),
      prisma.inventoryHistory.create({
        data: {
          productId,
          storeId,
          type: 'adjustment',
          quantity: quantityChange,
          previousStock,
          newStock: newQuantity,
          reason: reason || 'Inventory count adjustment',
          createdBy: userId,
        },
      }),
    ]);

    await invalidateStoreProductCaches(storeId);
    return this.afterAdjust(
      storeId,
      productId,
      updatedProduct,
      history,
      previousStock,
      newQuantity,
      true
    );
  }

  /**
   * Update low stock threshold for a product
   */
  static async updateThreshold(
    storeId: string,
    productId: string,
    threshold: number
  ): Promise<ProductInventory> {
    const product = await (
      await storeDb(storeId)
    ).product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    // The threshold is a plain product column: the write follows the store's backend like the read above (CF-R6B-1).
    const updated = await (
      await storeWriter(storeId)
    ).product.update({
      where: { id: productId, storeId },
      data: { lowStockThreshold: threshold },
      select: {
        id: true,
        name: true,
        nameAr: true,
        sku: true,
        inventory: true,
        lowStockThreshold: true,
        trackInventory: true,
        costPrice: true,
        status: true,
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      nameAr: updated.nameAr,
      sku: updated.sku,
      inventory: updated.inventory,
      lowStockThreshold: updated.lowStockThreshold,
      trackInventory: updated.trackInventory,
      costPrice: updated.costPrice,
      status: updated.status,
      stockStatus: this.getStockStatus(updated.inventory, updated.lowStockThreshold),
      stockValue: updated.inventory * (updated.costPrice || 0),
    };
  }

  /**
   * Get inventory history for a product
   */
  static async getProductHistory(
    storeId: string,
    productId: string,
    options?: { page?: number; limit?: number }
  ) {
    const db = await storeDb(storeId);
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const [history, total] = await Promise.all([
      db.inventoryHistory.findMany({
        where: { storeId, productId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.inventoryHistory.count({
        where: { storeId, productId },
      }),
    ]);

    return {
      history,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get store-wide inventory history
   */
  static async getStoreHistory(
    storeId: string,
    options?: {
      page?: number;
      limit?: number;
      type?: InventoryChangeType;
      startDate?: Date;
      endDate?: Date;
    }
  ) {
    const db = await storeDb(storeId);
    const page = options?.page || 1;
    const limit = options?.limit || 50;
    const skip = (page - 1) * limit;

    const where: Prisma.InventoryHistoryWhereInput = { storeId };

    if (options?.type) {
      where.type = options.type;
    }

    if (options?.startDate || options?.endDate) {
      where.createdAt = {};
      if (options?.startDate) {
        where.createdAt.gte = options.startDate;
      }
      if (options?.endDate) {
        where.createdAt.lte = options.endDate;
      }
    }

    const [history, total] = await Promise.all([
      db.inventoryHistory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              nameAr: true,
              sku: true,
            },
          },
        },
      }),
      db.inventoryHistory.count({ where }),
    ]);

    return {
      history,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Reduce inventory on sale (called when order is placed)
   */
  static async reduceOnSale(
    storeId: string,
    productId: string,
    quantity: number,
    orderId: string
  ): Promise<void> {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
    });

    if (!product || !product.trackInventory) {
      return; // Skip if not tracking inventory
    }

    const previousStock = product.inventory;
    const newStock = Math.max(0, previousStock - quantity);

    await prisma.$transaction([
      prisma.product.update({
        where: { id: productId, storeId },
        data: { inventory: newStock },
      }),
      prisma.inventoryHistory.create({
        data: {
          productId,
          storeId,
          type: 'sale',
          quantity: -quantity,
          previousStock,
          newStock,
          reason: 'Sold via order',
          reference: orderId,
        },
      }),
    ]);

    // Same class-wide cache bust as adjustInventory/setInventory. This method
    // has no caller today; whoever revives it must not inherit stale stock.
    await invalidateStoreProductCaches(storeId);
  }

  /**
   * Return inventory on return/cancel (called when order is returned)
   */
  static async returnToStock(
    storeId: string,
    productId: string,
    quantity: number,
    returnId: string
  ): Promise<void> {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
    });

    if (!product || !product.trackInventory) {
      return; // Skip if not tracking inventory
    }

    const previousStock = product.inventory;
    const newStock = previousStock + quantity;

    await prisma.$transaction([
      prisma.product.update({
        where: { id: productId, storeId },
        data: { inventory: newStock },
      }),
      prisma.inventoryHistory.create({
        data: {
          productId,
          storeId,
          type: 'return_stock',
          quantity,
          previousStock,
          newStock,
          reason: 'Returned to stock',
          reference: returnId,
        },
      }),
    ]);

    // Same class-wide cache bust as adjustInventory/setInventory. This method
    // has no caller today; whoever revives it must not inherit stale stock.
    await invalidateStoreProductCaches(storeId);
  }

  // Helper: Determine stock status
  private static toInventoryRow(r: DoStockRow): ProductInventory {
    return {
      id: r.id,
      name: r.name,
      nameAr: r.nameAr,
      sku: r.sku,
      inventory: r.onHand,
      lowStockThreshold: r.lowStockThreshold,
      trackInventory: r.trackInventory,
      costPrice: r.costPrice,
      status: r.status,
      stockStatus: this.getStockStatus(r.onHand, r.lowStockThreshold),
      stockValue: r.stockValue,
    };
  }

  private static getStockStatus(
    inventory: number,
    threshold: number
  ): 'in_stock' | 'low_stock' | 'out_of_stock' {
    if (inventory <= 0) return 'out_of_stock';
    if (inventory <= threshold) return 'low_stock';
    return 'in_stock';
  }

  /**
   * Fire back-in-stock notifications to all users who have this product
   * in a public or private wishlist for this store.
   * Fire-and-forget — never throws.
   */
  /**
   * The wishers of a product on a store's Durable Object (no Postgres, no `users` table in the Worker): the wishlist rows
   * and the product slug from the DO, the shopper's name and phone from the store's `customers` row linked to the
   * wishlist's user (`customers.user_id`). A wisher with no customer row still gets the notification, unnamed and with no
   * phone (the dispatcher then skips SMS), the shape the Postgres read produced for a user with no name.
   */
  private static async backInStockWishersOnDo(storeId: string, productId: string) {
    const db = await storeDb(storeId);
    const items = await db.wishlistItem.findMany({
      where: { productId, wishlist: { storeId } },
      select: { wishlist: { select: { userId: true } }, product: { select: { slug: true } } },
    });
    const userIds = [...new Set(items.map(i => i.wishlist.userId))];
    const customers = userIds.length
      ? await db.customer.findMany({
          where: { storeId, userId: { in: userIds } },
          select: { userId: true, firstName: true, lastName: true, phone: true },
        })
      : [];
    const byUser = new Map(customers.map(c => [c.userId, c]));
    return items.map(i => {
      const c = byUser.get(i.wishlist.userId);
      return {
        product: i.product,
        wishlist: {
          user: {
            id: i.wishlist.userId,
            firstName: c?.firstName ?? null,
            lastName: c?.lastName ?? null,
            phone: c?.phone ?? null,
          },
        },
      };
    });
  }

  private static async fireBackInStockNotifications(
    storeId: string,
    productId: string,
    productName: string
  ): Promise<void> {
    try {
      // Find the store for name and slug
      const store = await withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: { name: true, slug: true, domain: true },
        })
      );

      if (!store) return;

      // Find all wishlists in this store that contain this product
      const wishlistItems =
        (await storeRepo(storeId)).backend === 'do'
          ? await InventoryService.backInStockWishersOnDo(storeId, productId)
          : await prisma.wishlistItem.findMany({
              where: {
                productId,
                wishlist: { storeId },
              },
              include: {
                wishlist: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        phone: true,
                      },
                    },
                  },
                },
                product: {
                  select: { slug: true },
                },
              },
            });

      if (wishlistItems.length === 0) return;

      logger.info(
        { storeId, productId, userCount: wishlistItems.length },
        '[InventoryService] Firing back-in-stock notifications'
      );

      const storeBase = storefrontOrigin(store);

      // Dispatch notifications for each user — fire-and-forget per user
      for (const item of wishlistItems) {
        const user = item.wishlist.user;
        const productUrl = `${storeBase}/products/${item.product.slug}`;
        const customerName =
          [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Valued Customer';

        notificationDispatcher.dispatch(storeId, 'back_in_stock', {
          customerName,
          customerPhone: user.phone ?? undefined,
          customerId: user.id,
          orderNumber: '', // not applicable
          // One SMS per shopper per product per restock day. Without it every
          // back-in-stock SMS of the store shared ONE idempotency key.
          dedupeKey: `${productId}_${user.id}_${new Date().toISOString().slice(0, 10)}`,
          storeId,
          storeName: store.name,
          productName,
          productUrl,
        });
      }
    } catch (err) {
      logger.error(
        { err, storeId, productId },
        '[InventoryService] fireBackInStockNotifications error'
      );
    }
  }
}
