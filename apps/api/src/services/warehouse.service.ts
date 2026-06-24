/**
 * Warehouse Service — Multi-Warehouse Inventory (Enterprise)
 *
 * Manages Warehouse CRUD and per-warehouse WarehouseStock writes.
 *
 * Aggregate sync rule: every WarehouseStock quantity change MUST call
 * syncAggregateInventory() in the same transaction to keep Product.inventory /
 * ProductVariant.inventory accurate for the storefront (badge, backorder logic).
 *
 * RLS: all methods run inside a tenant context or explicit bypass. The service
 * does NOT open its own transactions — callers (routes) are already wrapped by
 * tenantContext middleware.
 */

import { prisma, Prisma, withRlsBypass } from '@force/database';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { haversineKm } from '../lib/haversine';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WarehouseCreateInput {
  name: string;
  nameAr?: string;
  code: string;
  isDefault?: boolean;
  priority?: number;
  lat?: number;
  lng?: number;
  address?: string;
}

export interface WarehouseUpdateInput {
  name?: string;
  nameAr?: string | null;
  code?: string;
  isDefault?: boolean;
  priority?: number;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  isActive?: boolean;
}

export interface WarehouseRow {
  id: string;
  storeId: string;
  name: string;
  nameAr: string | null;
  code: string;
  isDefault: boolean;
  priority: number;
  lat: number | null;
  lng: number | null;
  address: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** total SKUs (base products + variants) across this warehouse */
  totalSkus: number;
  /** total units on hand across this warehouse */
  totalUnits: number;
}

export interface WarehouseStockRow {
  id: string;
  warehouseId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  updatedAt: Date;
  productName: string;
  productSku: string | null;
  variantTitle: string | null;
  variantSku: string | null;
}

export interface StockSetInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface StockAdjustInput {
  productId: string;
  variantId?: string | null;
  delta: number;
  reason?: string;
}

export interface RouteOrderItem {
  productId: string;
  variantId?: string | null;
  qty: number;
}

export interface RouteOrderInput {
  items: RouteOrderItem[];
  lat?: number;
  lng?: number;
  rule?: 'priority' | 'proximity';
}

export interface RoutedLine {
  productId: string;
  variantId: string | null;
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  rule: 'priority' | 'proximity';
  availableQty: number;
  insufficientStock: boolean;
}

// ─── Select fields ─────────────────────────────────────────────────────────────

const WAREHOUSE_SELECT = {
  id: true,
  storeId: true,
  name: true,
  nameAr: true,
  code: true,
  isDefault: true,
  priority: true,
  lat: true,
  lng: true,
  address: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WarehouseSelect;

// ─── Service ──────────────────────────────────────────────────────────────────

export class WarehouseService {
  /**
   * List all warehouses for a store, with total SKU / unit counts.
   */
  static async listWarehouses(storeId: string): Promise<WarehouseRow[]> {
    const warehouses = await prisma.warehouse.findMany({
      where: { storeId, isActive: true },
      select: {
        ...WAREHOUSE_SELECT,
        warehouseStock: {
          select: { quantity: true },
        },
      },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
    });

    return warehouses.map(w => ({
      id: w.id,
      storeId: w.storeId,
      name: w.name,
      nameAr: w.nameAr,
      code: w.code,
      isDefault: w.isDefault,
      priority: w.priority,
      lat: w.lat,
      lng: w.lng,
      address: w.address,
      isActive: w.isActive,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      totalSkus: w.warehouseStock.length,
      totalUnits: w.warehouseStock.reduce((sum, s) => sum + s.quantity, 0),
    }));
  }

  /**
   * Get a single warehouse (with stock totals).
   */
  static async getWarehouse(storeId: string, warehouseId: string): Promise<WarehouseRow> {
    const w = await prisma.warehouse.findFirst({
      where: { id: warehouseId, storeId },
      select: {
        ...WAREHOUSE_SELECT,
        warehouseStock: { select: { quantity: true } },
      },
    });
    if (!w) throw new AppError(404, 'WAREHOUSE_NOT_FOUND', 'Warehouse not found');
    return {
      ...w,
      totalSkus: w.warehouseStock.length,
      totalUnits: w.warehouseStock.reduce((sum, s) => sum + s.quantity, 0),
    };
  }

  /**
   * Create a warehouse.
   * If isDefault=true, clears isDefault on all other warehouses first.
   */
  static async createWarehouse(
    storeId: string,
    input: WarehouseCreateInput
  ): Promise<WarehouseRow> {
    // Check code uniqueness within store
    const existing = await prisma.warehouse.findFirst({
      where: { storeId, code: input.code.toUpperCase() },
    });
    if (existing) {
      throw new AppError(
        409,
        'WAREHOUSE_CODE_EXISTS',
        `A warehouse with code "${input.code}" already exists`
      );
    }

    // If setting as default, clear existing default first
    if (input.isDefault) {
      await prisma.warehouse.updateMany({
        where: { storeId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const warehouse = await prisma.warehouse.create({
      data: {
        storeId,
        name: input.name,
        nameAr: input.nameAr ?? null,
        code: input.code.toUpperCase(),
        isDefault: input.isDefault ?? false,
        priority: input.priority ?? 0,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        address: input.address ?? null,
        isActive: true,
      },
      select: {
        ...WAREHOUSE_SELECT,
        warehouseStock: { select: { quantity: true } },
      },
    });

    logger.info(
      { storeId, warehouseId: warehouse.id, code: warehouse.code },
      '[Warehouse] created'
    );

    return {
      ...warehouse,
      totalSkus: 0,
      totalUnits: 0,
    };
  }

  /**
   * Update a warehouse.
   * If isDefault is being set to true, clears existing default first.
   */
  static async updateWarehouse(
    storeId: string,
    warehouseId: string,
    input: WarehouseUpdateInput
  ): Promise<WarehouseRow> {
    const existing = await prisma.warehouse.findFirst({
      where: { id: warehouseId, storeId },
    });
    if (!existing) throw new AppError(404, 'WAREHOUSE_NOT_FOUND', 'Warehouse not found');

    // Code uniqueness check if code is changing
    if (input.code && input.code.toUpperCase() !== existing.code) {
      const clash = await prisma.warehouse.findFirst({
        where: { storeId, code: input.code.toUpperCase(), id: { not: warehouseId } },
      });
      if (clash) {
        throw new AppError(
          409,
          'WAREHOUSE_CODE_EXISTS',
          `A warehouse with code "${input.code}" already exists`
        );
      }
    }

    // Setting this as default → clear others
    if (input.isDefault === true) {
      await prisma.warehouse.updateMany({
        where: { storeId, isDefault: true, id: { not: warehouseId } },
        data: { isDefault: false },
      });
    }

    // Block disabling the only active warehouse
    if (input.isActive === false && existing.isDefault) {
      const activeCount = await prisma.warehouse.count({
        where: { storeId, isActive: true, id: { not: warehouseId } },
      });
      if (activeCount === 0) {
        throw new AppError(
          400,
          'WAREHOUSE_LAST_ACTIVE',
          'Cannot disable the only active warehouse. Create another first.'
        );
      }
    }

    const updated = await prisma.warehouse.update({
      where: { id: warehouseId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.nameAr !== undefined && { nameAr: input.nameAr }),
        ...(input.code !== undefined && { code: input.code.toUpperCase() }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.lat !== undefined && { lat: input.lat }),
        ...(input.lng !== undefined && { lng: input.lng }),
        ...(input.address !== undefined && { address: input.address }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
      select: {
        ...WAREHOUSE_SELECT,
        warehouseStock: { select: { quantity: true } },
      },
    });

    return {
      ...updated,
      totalSkus: updated.warehouseStock.length,
      totalUnits: updated.warehouseStock.reduce((sum, s) => sum + s.quantity, 0),
    };
  }

  /**
   * Deactivate a warehouse (soft delete — sets isActive=false).
   * Blocks if it's the last active warehouse for the store.
   */
  static async deactivateWarehouse(storeId: string, warehouseId: string): Promise<void> {
    const existing = await prisma.warehouse.findFirst({
      where: { id: warehouseId, storeId },
    });
    if (!existing) throw new AppError(404, 'WAREHOUSE_NOT_FOUND', 'Warehouse not found');

    const activeCount = await prisma.warehouse.count({
      where: { storeId, isActive: true, id: { not: warehouseId } },
    });
    if (activeCount === 0) {
      throw new AppError(
        400,
        'WAREHOUSE_LAST_ACTIVE',
        'Cannot deactivate the only active warehouse. Create another first.'
      );
    }

    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: { isActive: false, isDefault: false },
    });

    logger.info({ storeId, warehouseId }, '[Warehouse] deactivated');
  }

  // ─── Stock operations ───────────────────────────────────────────────

  /**
   * List all warehouse_stock rows for a product (and optionally a specific variant),
   * joined with warehouse name/code for display.
   */
  static async getProductStock(
    storeId: string,
    productId: string,
    variantId?: string | null
  ): Promise<
    {
      warehouseId: string;
      warehouseName: string;
      warehouseCode: string;
      isDefault: boolean;
      quantity: number;
    }[]
  > {
    const rows = await prisma.warehouseStock.findMany({
      where: {
        storeId,
        productId,
        ...(variantId !== undefined ? { variantId: variantId ?? null } : {}),
      },
      select: {
        warehouseId: true,
        quantity: true,
        warehouse: {
          select: { name: true, code: true, isDefault: true, isActive: true },
        },
      },
      orderBy: { warehouse: { priority: 'desc' } },
    });

    return rows.map(r => ({
      warehouseId: r.warehouseId,
      warehouseName: r.warehouse.name,
      warehouseCode: r.warehouse.code,
      isDefault: r.warehouse.isDefault,
      quantity: r.quantity,
    }));
  }

  /**
   * List all warehouse_stock rows for a warehouse (paginated).
   */
  static async listWarehouseStock(
    storeId: string,
    warehouseId: string,
    options?: { page?: number; limit?: number; search?: string }
  ): Promise<{ rows: WarehouseStockRow[]; total: number }> {
    // Verify warehouse belongs to store
    const warehouse = await prisma.warehouse.findFirst({
      where: { id: warehouseId, storeId },
    });
    if (!warehouse) throw new AppError(404, 'WAREHOUSE_NOT_FOUND', 'Warehouse not found');

    const page = options?.page ?? 1;
    const limit = Math.min(options?.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const where: Prisma.WarehouseStockWhereInput = {
      warehouseId,
      storeId,
    };

    if (options?.search) {
      where.OR = [
        { product: { name: { contains: options.search, mode: 'insensitive' } } },
        { product: { sku: { contains: options.search, mode: 'insensitive' } } },
        { variant: { sku: { contains: options.search, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.warehouseStock.findMany({
        where,
        select: {
          id: true,
          warehouseId: true,
          productId: true,
          variantId: true,
          quantity: true,
          updatedAt: true,
          product: { select: { name: true, sku: true } },
          variant: { select: { title: true, sku: true } },
        },
        orderBy: [{ product: { name: 'asc' } }, { variantId: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.warehouseStock.count({ where }),
    ]);

    return {
      rows: rows.map(r => ({
        id: r.id,
        warehouseId: r.warehouseId,
        productId: r.productId,
        variantId: r.variantId,
        quantity: r.quantity,
        updatedAt: r.updatedAt,
        productName: r.product.name,
        productSku: r.product.sku,
        variantTitle: r.variant?.title ?? null,
        variantSku: r.variant?.sku ?? null,
      })),
      total,
    };
  }

  /**
   * Set (upsert) stock quantity for a product/variant in a specific warehouse.
   * Updates the aggregate Product.inventory / ProductVariant.inventory afterward.
   */
  static async setStock(storeId: string, warehouseId: string, input: StockSetInput): Promise<void> {
    if (input.quantity < 0) {
      throw new AppError(400, 'INVALID_QUANTITY', 'Quantity cannot be negative');
    }

    // Verify warehouse belongs to store
    const warehouse = await prisma.warehouse.findFirst({
      where: { id: warehouseId, storeId },
    });
    if (!warehouse) throw new AppError(404, 'WAREHOUSE_NOT_FOUND', 'Warehouse not found');

    // Verify product belongs to store
    const product = await prisma.product.findFirst({
      where: { id: input.productId, storeId, deletedAt: null },
    });
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');

    // Upsert warehouse_stock — use findFirst+update/create because Prisma's
    // composite-unique WHERE requires a non-nullable variantId (SQL NULL != NULL),
    // but variantId is intentionally null for base-product stock rows.
    const existingStock = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId: input.productId, variantId: input.variantId ?? null },
      select: { id: true },
    });
    if (existingStock) {
      await prisma.warehouseStock.update({
        where: { id: existingStock.id },
        data: { quantity: input.quantity },
      });
    } else {
      await prisma.warehouseStock.create({
        data: {
          warehouseId,
          productId: input.productId,
          variantId: input.variantId ?? null,
          quantity: input.quantity,
          storeId,
        },
      });
    }

    // Sync aggregate
    await WarehouseService.syncAggregateInventory(input.productId, input.variantId ?? null);
  }

  /**
   * Adjust stock by a delta (positive = add, negative = remove).
   * Floors at 0 — never goes negative.
   */
  static async adjustStock(
    storeId: string,
    warehouseId: string,
    input: StockAdjustInput
  ): Promise<{ newQuantity: number }> {
    // Verify warehouse belongs to store
    const warehouse = await prisma.warehouse.findFirst({
      where: { id: warehouseId, storeId },
    });
    if (!warehouse) throw new AppError(404, 'WAREHOUSE_NOT_FOUND', 'Warehouse not found');

    // Verify product belongs to store
    const product = await prisma.product.findFirst({
      where: { id: input.productId, storeId, deletedAt: null },
    });
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');

    // Get current stock (or 0 if no row yet)
    const current = await prisma.warehouseStock.findFirst({
      where: {
        warehouseId,
        productId: input.productId,
        variantId: input.variantId ?? null,
      },
      select: { quantity: true },
    });

    const currentQty = current?.quantity ?? 0;
    const newQty = Math.max(0, currentQty + input.delta);

    // Same findFirst+update/create pattern — composite-unique WHERE can't match null variantId.
    const existingStockAdj = await prisma.warehouseStock.findFirst({
      where: { warehouseId, productId: input.productId, variantId: input.variantId ?? null },
      select: { id: true },
    });
    if (existingStockAdj) {
      await prisma.warehouseStock.update({
        where: { id: existingStockAdj.id },
        data: { quantity: newQty },
      });
    } else {
      await prisma.warehouseStock.create({
        data: {
          warehouseId,
          productId: input.productId,
          variantId: input.variantId ?? null,
          quantity: newQty,
          storeId,
        },
      });
    }

    // Sync aggregate
    await WarehouseService.syncAggregateInventory(input.productId, input.variantId ?? null);

    // Record in InventoryHistory for audit trail
    const changeType = input.delta >= 0 ? 'manual_add' : 'manual_remove';
    await prisma.inventoryHistory.create({
      data: {
        productId: input.productId,
        storeId,
        type: changeType,
        quantity: input.delta,
        previousStock: currentQty,
        newStock: newQty,
        reason: input.reason
          ? `[Warehouse: ${warehouse.code}] ${input.reason}`
          : `[Warehouse: ${warehouse.code}] delta adjustment`,
        reference: warehouseId,
      },
    });

    logger.info(
      { storeId, warehouseId, productId: input.productId, delta: input.delta, newQty },
      '[Warehouse] stock adjusted'
    );

    return { newQuantity: newQty };
  }

  /**
   * Re-aggregate Product.inventory / ProductVariant.inventory from the SUM of
   * all warehouse_stock rows. Called after every WarehouseStock mutation.
   *
   * Uses withRlsBypass because this is a cross-warehouse aggregate write —
   * not a single-tenant read, but the product IS the current tenant's.
   * We need the bypass because the tenantContext tx and withRlsBypass cannot
   * nest — the service is called from within a tenant tx, so we use a raw
   * aggregation query and a direct update.
   */
  static async syncAggregateInventory(productId: string, variantId: string | null): Promise<void> {
    if (variantId) {
      // Aggregate for this specific variant
      const agg = await prisma.warehouseStock.aggregate({
        where: { productId, variantId },
        _sum: { quantity: true },
      });
      const total = agg._sum.quantity ?? 0;
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { inventory: total },
      });

      // Also re-aggregate the parent product from all its variants
      const variantAgg = await prisma.productVariant.aggregate({
        where: { productId },
        _sum: { inventory: true },
      });
      await prisma.product.update({
        where: { id: productId },
        data: { inventory: variantAgg._sum.inventory ?? 0 },
      });
    } else {
      // Base-product stock (no variant)
      const agg = await prisma.warehouseStock.aggregate({
        where: { productId, variantId: null },
        _sum: { quantity: true },
      });
      const total = agg._sum.quantity ?? 0;
      await prisma.product.update({
        where: { id: productId },
        data: { inventory: total },
      });
    }
  }

  // ─── Order routing ─────────────────────────────────────────────────────────

  /**
   * Route order items to warehouses based on the selected rule.
   *
   * Rules:
   *  - 'priority' (default): highest-priority warehouse with sufficient stock.
   *    Tiebreak: alphabetical by code.
   *  - 'proximity': nearest warehouse (Haversine) with sufficient stock.
   *    Falls back to priority if no warehouses have lat/lng coordinates.
   *
   * If no warehouse has sufficient stock, returns the one with the most stock
   * + insufficientStock=true (partial fulfillment indicator).
   */
  static async routeOrder(storeId: string, input: RouteOrderInput): Promise<RoutedLine[]> {
    // Fetch all active warehouses for this store with their stock
    const warehouses = await prisma.warehouse.findMany({
      where: { storeId, isActive: true },
      select: {
        id: true,
        name: true,
        code: true,
        priority: true,
        lat: true,
        lng: true,
        isDefault: true,
        warehouseStock: {
          select: { productId: true, variantId: true, quantity: true },
        },
      },
      orderBy: [{ priority: 'desc' }, { code: 'asc' }],
    });

    if (warehouses.length === 0) {
      throw new AppError(400, 'NO_WAREHOUSES', 'No active warehouses configured for this store');
    }

    // Determine effective rule
    const hasCoordinates =
      input.lat !== undefined &&
      input.lng !== undefined &&
      warehouses.some(w => w.lat !== null && w.lng !== null);
    const effectiveRule = input.rule === 'proximity' && hasCoordinates ? 'proximity' : 'priority';

    return input.items.map(item => {
      const variantId = item.variantId ?? null;

      // Filter warehouses that have a stock row for this item
      const candidates = warehouses
        .map(w => {
          const stockRow = w.warehouseStock.find(
            s => s.productId === item.productId && s.variantId === variantId
          );
          return {
            id: w.id,
            name: w.name,
            code: w.code,
            priority: w.priority,
            lat: w.lat,
            lng: w.lng,
            qty: stockRow?.quantity ?? 0,
          };
        })
        .filter(c => c.qty > 0); // exclude out-of-stock

      // If no candidate has stock, return the warehouse with the most stock (even 0)
      if (candidates.length === 0) {
        // Fall back to warehouse with most stock (may be 0 — partial fulfillment)
        const fallback =
          warehouses
            .map(w => {
              const stockRow = w.warehouseStock.find(
                s => s.productId === item.productId && s.variantId === variantId
              );
              return { id: w.id, name: w.name, code: w.code, qty: stockRow?.quantity ?? 0 };
            })
            .sort((a, b) => b.qty - a.qty)[0] ?? warehouses[0];

        return {
          productId: item.productId,
          variantId,
          warehouseId: fallback.id,
          warehouseName: fallback.name,
          warehouseCode: fallback.code,
          rule: effectiveRule,
          availableQty: fallback.qty,
          insufficientStock: true,
        };
      }

      // Filter by sufficient stock
      const sufficient = candidates.filter(c => c.qty >= item.qty);
      const pool = sufficient.length > 0 ? sufficient : candidates;

      let chosen: (typeof candidates)[0];

      if (effectiveRule === 'proximity' && input.lat !== undefined && input.lng !== undefined) {
        // Haversine sort
        const withDist = pool
          .filter(c => c.lat !== null && c.lng !== null)
          .map(c => ({
            ...c,
            dist: haversineKm(input.lat!, input.lng!, c.lat!, c.lng!),
          }))
          .sort((a, b) => a.dist - b.dist);

        if (withDist.length > 0) {
          chosen = withDist[0];
        } else {
          // No coordinates on any candidate → fall back to priority
          chosen = pool[0]; // already sorted by priority desc, code asc
        }
      } else {
        // Priority rule: pool is already sorted by priority desc, code asc
        chosen = pool[0];
      }

      return {
        productId: item.productId,
        variantId,
        warehouseId: chosen.id,
        warehouseName: chosen.name,
        warehouseCode: chosen.code,
        rule: effectiveRule,
        availableQty: chosen.qty,
        insufficientStock: sufficient.length === 0,
      };
    });
  }
}

// ─── Haversine distance (km) ──────────────────────────────────────────────────

// haversineKm is available in lib/haversine; this re-export is intentionally removed
