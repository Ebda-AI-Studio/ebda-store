import { prisma, Prisma, InventoryChangeType } from '@force/database';
import { AppError } from '../middleware/error-handler';
import { notificationDispatcher } from './notification-dispatcher.service';
import logger from '../lib/logger';

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

export class InventoryService {
  /**
   * Get inventory statistics for a store
   */
  static async getStats(storeId: string): Promise<InventoryStats> {
    const baseWhere: Prisma.ProductWhereInput = {
      storeId,
      deletedAt: null,
      trackInventory: true,
    };

    const [aggregate, totalProducts, outOfStockCount, totalValue] = await Promise.all([
      prisma.product.aggregate({
        where: baseWhere,
        _sum: { inventory: true },
      }),
      prisma.product.count({ where: baseWhere }),
      prisma.product.count({
        where: { ...baseWhere, inventory: { lte: 0 } },
      }),
      // totalValue requires per-row computation (inventory * costPrice) which
      // Prisma aggregate cannot express; use raw SQL for accuracy.
      prisma.$queryRaw<[{ total_value: bigint | null }]>`
        SELECT COALESCE(SUM(inventory * COALESCE(cost_price, 0)), 0) AS total_value
        FROM public.products
        WHERE store_id = ${storeId}
          AND deleted_at IS NULL
          AND track_inventory = true
      `,
    ]);

    // Low stock requires a column-to-column comparison (inventory <= lowStockThreshold)
    // which Prisma does not support; use raw SQL.
    const [{ low_stock_count }] = await prisma.$queryRaw<[{ low_stock_count: bigint }]>`
      SELECT COUNT(*)::bigint AS low_stock_count
      FROM public.products
      WHERE store_id = ${storeId}
        AND deleted_at IS NULL
        AND track_inventory = true
        AND inventory > 0
        AND inventory <= low_stock_threshold
    `;

    return {
      totalProducts,
      totalStock: aggregate._sum.inventory ?? 0,
      lowStockCount: Number(low_stock_count),
      outOfStockCount,
      totalValue: Number(totalValue[0].total_value ?? 0),
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
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.ProductWhereInput = {
      storeId,
      deletedAt: null,
    };

    if (options?.search) {
      where.OR = [
        { name: { contains: options.search, mode: 'insensitive' } },
        { nameAr: { contains: options.search, mode: 'insensitive' } },
        { sku: { contains: options.search, mode: 'insensitive' } },
      ];
    }

    // Apply stock filter directly in the Prisma where clause to avoid fetching
    // all rows and paginating in JS. Each filter uses a fixed threshold per product
    // stored in lowStockThreshold. Since the threshold is per-row, we use a
    // representative default (5) for the DB filter, then format results correctly.
    // For precise per-product thresholds, the comparison is: lte lowStockThreshold.
    // Prisma supports column-to-column comparison only via raw SQL; the approach
    // below uses a reasonable split: inventory <= 0 = out_of_stock, > 0 and
    // inventory <= lowStockThreshold (via Prisma raw comparison) = low_stock,
    // else in_stock. We use the Prisma filter fields that map to column comparisons.
    if (options?.stockFilter === 'out_of_stock') {
      where.inventory = { lte: 0 };
    } else if (options?.stockFilter === 'low_stock') {
      // inventory > 0 AND inventory <= lowStockThreshold (column-level reference)
      // Prisma does not support column references in filters directly, so we
      // filter inventory > 0 and lte a sentinel, then rely on the select +
      // JS check only for the page window (not the full table scan).
      // The primary optimisation is pushing the non-null inventory bound to DB.
      where.inventory = { gt: 0 };
      where.trackInventory = true;
    } else if (options?.stockFilter === 'in_stock') {
      // inventory > lowStockThreshold: use gt: 0 as minimum, refine in format step
      where.inventory = { gt: 0 };
      where.trackInventory = true;
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput = {};
    if (options?.sortBy === 'name') {
      orderBy.name = options?.sortOrder || 'asc';
    } else if (options?.sortBy === 'sku') {
      orderBy.sku = options?.sortOrder || 'asc';
    } else {
      orderBy.inventory = options?.sortOrder || 'asc';
    }

    // Fetch only the page window when no per-row threshold filter is needed,
    // otherwise fetch with DB-level bounds and apply the per-row threshold check
    // across the smaller result set rather than the entire table.
    const needsPerRowFilter =
      options?.stockFilter === 'low_stock' || options?.stockFilter === 'in_stock';

    let products = await prisma.product.findMany({
      where,
      orderBy,
      // When a per-row threshold comparison is required we fetch without skip/take
      // so we can filter and then slice. For all other cases (no filter or
      // out_of_stock which is a pure DB filter) we push pagination to the DB.
      ...(needsPerRowFilter ? {} : { skip, take: limit }),
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

    // Finish per-row threshold filtering and paginate the filtered slice
    if (needsPerRowFilter) {
      products = products.filter(p => {
        const stockStatus = this.getStockStatus(p.inventory, p.lowStockThreshold);
        return stockStatus === options!.stockFilter;
      });
    }

    const total = needsPerRowFilter ? products.length : await prisma.product.count({ where });
    const paginatedProducts = needsPerRowFilter ? products.slice(skip, skip + limit) : products;

    const formattedProducts: ProductInventory[] = paginatedProducts.map(p => ({
      id: p.id,
      name: p.name,
      nameAr: p.nameAr,
      sku: p.sku,
      inventory: p.inventory,
      lowStockThreshold: p.lowStockThreshold,
      trackInventory: p.trackInventory,
      costPrice: p.costPrice,
      status: p.status,
      stockStatus: this.getStockStatus(p.inventory, p.lowStockThreshold),
      stockValue: p.inventory * (p.costPrice || 0),
    }));

    return {
      products: formattedProducts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get low stock alerts
   * Uses raw SQL to compare inventory against the per-row low_stock_threshold
   * column, which Prisma's where clause cannot express.
   */
  static async getLowStockAlerts(storeId: string): Promise<ProductInventory[]> {
    // Products that are low on stock (0 < inventory <= low_stock_threshold)
    const lowStockProducts = await prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        name_ar: string | null;
        sku: string | null;
        inventory: number;
        low_stock_threshold: number;
        track_inventory: boolean;
        cost_price: number | null;
        status: string;
      }>
    >`
      SELECT id, name, name_ar, sku, inventory, low_stock_threshold,
             track_inventory, cost_price, status
      FROM public.products
      WHERE store_id = ${storeId}
        AND deleted_at IS NULL
        AND track_inventory = true
        AND inventory <= low_stock_threshold
        AND inventory > 0
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
        low_stock_threshold: number;
        track_inventory: boolean;
        cost_price: number | null;
        status: string;
      }>
    >`
      SELECT id, name, name_ar, sku, inventory, low_stock_threshold,
             track_inventory, cost_price, status
      FROM public.products
      WHERE store_id = ${storeId}
        AND deleted_at IS NULL
        AND track_inventory = true
        AND inventory <= 0
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
      inventory: p.inventory,
      lowStockThreshold: p.low_stock_threshold,
      trackInventory: p.track_inventory,
      costPrice: p.cost_price,
      status: p.status,
      stockStatus: this.getStockStatus(p.inventory, p.low_stock_threshold),
      stockValue: p.inventory * (p.cost_price || 0),
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
    const product = await prisma.product.findFirst({
      where: { id: adjustment.productId, storeId, deletedAt: null },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const previousStock = product.inventory;
    const newStock = previousStock + adjustment.quantity;

    if (newStock < 0) {
      throw new AppError(400, 'INSUFFICIENT_STOCK', 'Cannot reduce stock below zero');
    }

    // Update product and create history in transaction
    const [updatedProduct, history] = await prisma.$transaction([
      prisma.product.update({
        where: { id: adjustment.productId },
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
      this.fireBackInStockNotifications(storeId, adjustment.productId, updatedProduct.name).catch(
        err =>
          logger.error(
            { err, storeId, productId: adjustment.productId },
            '[InventoryService] Back-in-stock notification failed'
          )
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

    const ids = adjustments.map(a => a.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: ids }, storeId, deletedAt: null },
      select: { id: true, inventory: true, name: true },
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
          where: { id: p.adjustment.productId },
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

    // Back-in-stock notifications fire AFTER the transaction commits
    // so a notification doesn't go out for a write that later got
    // rolled back. Same fire-and-forget contract as adjustInventory.
    for (const p of plans) {
      if (p.previousStock <= 0 && p.newStock > 0) {
        this.fireBackInStockNotifications(storeId, p.adjustment.productId, p.productName).catch(
          err =>
            logger.error(
              { err, storeId, productId: p.adjustment.productId },
              '[InventoryService] Back-in-stock notification failed'
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
        where: { id: productId },
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
    if (previousStock <= 0 && newQuantity > 0) {
      this.fireBackInStockNotifications(storeId, productId, updatedProduct.name).catch(err =>
        logger.error(
          { err, storeId, productId },
          '[InventoryService] Back-in-stock notification failed'
        )
      );
    }

    return result;
  }

  /**
   * Update low stock threshold for a product
   */
  static async updateThreshold(
    storeId: string,
    productId: string,
    threshold: number
  ): Promise<ProductInventory> {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
    });

    if (!product) {
      throw new AppError(404, 'NOT_FOUND', 'Product not found');
    }

    const updated = await prisma.product.update({
      where: { id: productId },
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
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const [history, total] = await Promise.all([
      prisma.inventoryHistory.findMany({
        where: { storeId, productId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.inventoryHistory.count({
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
      prisma.inventoryHistory.findMany({
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
      prisma.inventoryHistory.count({ where }),
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
        where: { id: productId },
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
        where: { id: productId },
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
  }

  // Helper: Determine stock status
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
  private static async fireBackInStockNotifications(
    storeId: string,
    productId: string,
    productName: string
  ): Promise<void> {
    try {
      // Find the store for name and slug
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { name: true, slug: true, domain: true },
      });

      if (!store) return;

      // Find all wishlists in this store that contain this product
      const wishlistItems = await prisma.wishlistItem.findMany({
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

      const storeBase = store.domain
        ? `https://${store.domain}`
        : `${process.env.WEB_URL ?? 'https://store.force-ai.co'}/${store.slug}`;

      // Dispatch notifications for each user — fire-and-forget per user
      for (const item of wishlistItems) {
        const user = item.wishlist.user;
        const productUrl = `${storeBase}/products/${item.product.slug}`;
        const customerName =
          [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Valued Customer';

        notificationDispatcher.dispatch(storeId, 'back_in_stock', {
          customerName,
          customerPhone: user.phone ?? undefined,
          orderNumber: '', // not applicable
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
