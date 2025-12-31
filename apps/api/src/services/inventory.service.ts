import { prisma, Prisma, InventoryChangeType } from '@force/database';
import { AppError } from '../middleware/error-handler';

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
    const products = await prisma.product.findMany({
      where: {
        storeId,
        deletedAt: null,
        trackInventory: true,
      },
      select: {
        inventory: true,
        lowStockThreshold: true,
        costPrice: true,
      },
    });

    const totalProducts = products.length;
    const totalStock = products.reduce((sum, p) => sum + p.inventory, 0);
    const lowStockCount = products.filter(p => p.inventory > 0 && p.inventory <= p.lowStockThreshold).length;
    const outOfStockCount = products.filter(p => p.inventory <= 0).length;
    const totalValue = products.reduce((sum, p) => sum + (p.inventory * (p.costPrice || 0)), 0);

    return {
      totalProducts,
      totalStock,
      lowStockCount,
      outOfStockCount,
      totalValue,
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
  ): Promise<{ products: ProductInventory[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
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

    // Stock filter handled after query due to threshold comparison
    const orderBy: Prisma.ProductOrderByWithRelationInput = {};
    if (options?.sortBy === 'name') {
      orderBy.name = options?.sortOrder || 'asc';
    } else if (options?.sortBy === 'sku') {
      orderBy.sku = options?.sortOrder || 'asc';
    } else {
      orderBy.inventory = options?.sortOrder || 'asc';
    }

    let products = await prisma.product.findMany({
      where,
      orderBy,
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

    // Apply stock filter
    if (options?.stockFilter && options.stockFilter !== 'all') {
      products = products.filter(p => {
        const status = this.getStockStatus(p.inventory, p.lowStockThreshold);
        return status === options.stockFilter;
      });
    }

    const total = products.length;
    const paginatedProducts = products.slice(skip, skip + limit);

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
   */
  static async getLowStockAlerts(storeId: string): Promise<ProductInventory[]> {
    const products = await prisma.product.findMany({
      where: {
        storeId,
        deletedAt: null,
        trackInventory: true,
      },
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
      orderBy: { inventory: 'asc' },
    });

    return products
      .filter(p => p.inventory <= p.lowStockThreshold)
      .map(p => ({
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

    return {
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
        stockStatus: this.getStockStatus(updatedProduct.inventory, updatedProduct.lowStockThreshold),
        stockValue: updatedProduct.inventory * (updatedProduct.costPrice || 0),
      },
      history,
    };
  }

  /**
   * Bulk adjust inventory for multiple products
   */
  static async bulkAdjustInventory(
    storeId: string,
    adjustments: InventoryAdjustment[],
    userId?: string
  ): Promise<{ successful: number; failed: number; errors: string[] }> {
    let successful = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const adjustment of adjustments) {
      try {
        await this.adjustInventory(storeId, adjustment, userId);
        successful++;
      } catch (error) {
        failed++;
        errors.push(`Product ${adjustment.productId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return { successful, failed, errors };
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

    return {
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
        stockStatus: this.getStockStatus(updatedProduct.inventory, updatedProduct.lowStockThreshold),
        stockValue: updatedProduct.inventory * (updatedProduct.costPrice || 0),
      },
      history,
    };
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
}
