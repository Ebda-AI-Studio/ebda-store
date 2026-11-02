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

import { notifyCatalogChanged } from '../lib/wa/catalog-state';
import { randomUUID } from 'node:crypto';
import { prisma, Prisma, withMoneyTx } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { haversineKm } from '../lib/haversine';
import { retryOnWriteConflict } from '../lib/db-retry';
import { planDeficit } from '../lib/warehouse-deficit';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import { storeStock } from '../lib/repo-factory';
import { searchProductIdSet, searchVariantIdsBySku } from './product-search.service';

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

/**
 * Retry policy for every warehouse_stock writer (#937).
 *
 * `setStock`/`adjustStock` lock warehouse_stock first and the aggregate row
 * second; `reconcileWarehouseStockToAggregate` takes them in the opposite
 * order, so a concurrent pair can deadlock (Postgres 40P01). Postgres picks
 * the victim arbitrarily, so BOTH sides need the retry — before this only
 * reconcile had it, and a merchant's stock edit that lost surfaced as a 500.
 *
 * Safe to retry: the whole `withMoneyTx` rolls back on the error, so a re-run
 * applies the set (absolute) or the delta exactly once. The transaction is
 * its own (`$transaction` is not proxied onto the request's tenant tx — see
 * `hasTenantContext` in @ebda/database), so the retry never runs inside an
 * aborted outer transaction. Raw-query failures carry the SQLSTATE at
 * `err.meta.code`, which is why the codes are passed explicitly (see the
 * reconcile docstring below).
 */
const WAREHOUSE_WRITE_RETRY = {
  retries: 3,
  label: 'warehouse-stock-write',
  extraRetryCodes: ['40P01', '40001'],
};

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
      where: { id: warehouseId, storeId },
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
      where: { id: warehouseId, storeId },
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
  ): Promise<{ rows: WarehouseStockRow[]; total: number; truncated: boolean }> {
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

    // `truncated`: more than PRODUCT_SEARCH_ID_CAP products (or variants) matched, so the
    // rows cover only the closest 1,000; the stock page says "add a word".
    let truncated = false;
    if (options?.search) {
      // Arabic-normalised: product names/terms/descriptions + product SKU, and variant SKU
      // with the same folding ("mug-77" finds "MUG-٧٧") (product-search.service).
      const [products, variants] = await Promise.all([
        searchProductIdSet(storeId, options.search, { scope: 'admin', includeDeleted: true }),
        searchVariantIdsBySku(storeId, options.search),
      ]);
      truncated = products.truncated || variants.truncated;
      where.OR = [{ productId: { in: products.ids } }, { variantId: { in: variants.ids } }];
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
      truncated,
    };
  }

  /**
   * Set (upsert) stock quantity for a product/variant in a specific warehouse.
   * Updates the aggregate Product.inventory / ProductVariant.inventory afterward.
   *
   * Atomic: the WarehouseStock upsert + the aggregate resync run inside ONE
   * transaction (`withMoneyTx`) as a single logical unit — see the race-fix
   * docstring on `syncAggregateInventory` below.
   */
  static async setStock(storeId: string, warehouseId: string, input: StockSetInput): Promise<void> {
    if (input.quantity < 0) {
      throw new AppError(400, 'INVALID_QUANTITY', 'Quantity cannot be negative');
    }

    const stock = await storeStock(storeId);
    if (stock) {
      // Durable Object path (Ruling CF-STOCK-1): the checks, the upsert and the aggregate sum are ONE section.
      await stock.setWarehouseStock({
        warehouseId,
        productId: input.productId,
        variantId: input.variantId ?? null,
        quantity: input.quantity,
      });
      await notifyCatalogChanged({ storeId, productIds: [input.productId] });
      await invalidateStoreProductCaches(storeId);
      return;
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

    const variantId = input.variantId ?? null;
    await WarehouseService.assertNotVariantProductLevel(input.productId, variantId);

    await retryOnWriteConflict(
      () =>
        withMoneyTx(prisma, async tx => {
          await WarehouseService.upsertWarehouseStock(tx, {
            warehouseId,
            productId: input.productId,
            variantId,
            storeId,
            setExpr: Prisma.sql`${input.quantity}`,
            initialQty: input.quantity,
          });

          await WarehouseService.syncAggregateInventory(storeId, input.productId, variantId, tx);
        }),
      WAREHOUSE_WRITE_RETRY
    );

    // The aggregate moved: bust the storefront product caches (variant writes included).
    await invalidateStoreProductCaches(storeId);
  }

  /**
   * Adjust stock by a delta (positive = add, negative = remove).
   * Floors at 0 — never goes negative.
   *
   * Atomic: the WarehouseStock upsert + the aggregate resync run inside ONE
   * transaction (`withMoneyTx`) as a single logical unit — see the race-fix
   * docstring on `syncAggregateInventory` below.
   */
  static async adjustStock(
    storeId: string,
    warehouseId: string,
    input: StockAdjustInput
  ): Promise<{ newQuantity: number }> {
    const stock = await storeStock(storeId);
    if (stock) {
      // Durable Object path (Ruling CF-STOCK-1): checks, upsert, aggregate sum and the audit row are ONE section.
      const r = await stock.adjustWarehouseStock({
        warehouseId,
        productId: input.productId,
        variantId: input.variantId ?? null,
        delta: input.delta,
        reason: input.reason,
      });
      await notifyCatalogChanged({ storeId, productIds: [input.productId] });
      await invalidateStoreProductCaches(storeId);
      return { newQuantity: r.newQuantity };
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

    const variantId = input.variantId ?? null;
    await WarehouseService.assertNotVariantProductLevel(input.productId, variantId);

    const newQty = await retryOnWriteConflict(
      () =>
        withMoneyTx(prisma, async tx => {
          // Best-effort snapshot for the InventoryHistory audit row only. The
          // actual new quantity below is computed atomically INSIDE Postgres from
          // the row's value at UPDATE time (`warehouse_stock.quantity` in the SET
          // clause of upsertWarehouseStock refers to the pre-update row, read
          // under the row's own write lock) — never from this read. A very tight
          // concurrent race could make this logged "previousStock" one write
          // stale; it never affects the persisted quantity itself (that's the
          // actual bug this task fixes).
          const before = await tx.warehouseStock.findFirst({
            where: { storeId, warehouseId, productId: input.productId, variantId },
            select: { quantity: true },
          });
          const previousQty = before?.quantity ?? 0;

          const newQty = await WarehouseService.upsertWarehouseStock(tx, {
            warehouseId,
            productId: input.productId,
            variantId,
            storeId,
            setExpr: Prisma.sql`GREATEST(0, "warehouse_stock"."quantity" + ${input.delta})`,
            initialQty: Math.max(0, input.delta),
          });

          await WarehouseService.syncAggregateInventory(storeId, input.productId, variantId, tx);

          // Record in InventoryHistory for audit trail
          const changeType = input.delta >= 0 ? 'manual_add' : 'manual_remove';
          await tx.inventoryHistory.create({
            data: {
              productId: input.productId,
              storeId,
              type: changeType,
              quantity: input.delta,
              previousStock: previousQty,
              newStock: newQty,
              reason: input.reason
                ? `[Warehouse: ${warehouse.code}] ${input.reason}`
                : `[Warehouse: ${warehouse.code}] delta adjustment`,
              reference: warehouseId,
            },
          });

          return newQty;
        }),
      WAREHOUSE_WRITE_RETRY
    );

    await invalidateStoreProductCaches(storeId);

    logger.info(
      { storeId, warehouseId, productId: input.productId, delta: input.delta, newQty },
      '[Warehouse] stock adjusted'
    );

    return { newQuantity: newQty };
  }

  /**
   * A product-level warehouse write (no variantId) aimed at a product that has
   * variants would write `products.inventory`, which must stay 0 for it. Fail
   * loud, as InventoryService.adjustInventory does.
   */
  private static async assertNotVariantProductLevel(
    productId: string,
    variantId: string | null
  ): Promise<void> {
    if (variantId) return;
    const variantCount = await prisma.productVariant.count({ where: { productId } });
    if (variantCount > 0) {
      throw new AppError(
        400,
        'VARIANT_PRODUCT',
        'This product tracks stock on its variants. Set the warehouse stock per variant instead.'
      );
    }
  }

  /**
   * Atomic upsert of a single warehouse_stock row — the core race fix.
   *
   * `@@unique([warehouseId, productId, variantId])` does NOT enforce
   * uniqueness when variantId IS NULL (Postgres treats NULL <> NULL for both
   * unique-index matching and ON CONFLICT inference), so base-product rows
   * (variantId null) rely on a separate PARTIAL unique index instead:
   * `warehouse_stock_warehouse_id_product_id_base_key` ON
   * (warehouse_id, product_id) WHERE variant_id IS NULL — added in migration
   * 20260615000000_multi_warehouse specifically for this. ON CONFLICT must
   * target whichever index actually covers the row being written, so the two
   * branches below use different conflict targets.
   *
   * The single `INSERT … ON CONFLICT … DO UPDATE … RETURNING` statement is
   * what makes this race-free: Postgres resolves the conflict and applies
   * `setExpr` (which reads the pre-update row via the unqualified
   * `"warehouse_stock"."quantity"` reference) under the row's own write lock,
   * so concurrent writers to the SAME row serialize correctly with no
   * lost updates — verified empirically under 20-way concurrency (see
   * task-1-report.md).
   */
  private static async upsertWarehouseStock(
    tx: Prisma.TransactionClient,
    args: {
      warehouseId: string;
      productId: string;
      variantId: string | null;
      storeId: string;
      setExpr: Prisma.Sql;
      initialQty: number;
    }
  ): Promise<number> {
    const id = randomUUID();
    const rows =
      args.variantId === null
        ? await tx.$queryRaw<Array<{ quantity: number }>>`
            INSERT INTO "warehouse_stock"
              ("id", "warehouse_id", "product_id", "variant_id", "quantity", "store_id", "created_at", "updated_at")
            VALUES (${id}, ${args.warehouseId}, ${args.productId}, NULL, ${args.initialQty}, ${args.storeId}, now(), now())
            ON CONFLICT ("warehouse_id", "product_id") WHERE "variant_id" IS NULL
            DO UPDATE SET quantity = ${args.setExpr}, updated_at = now()
            RETURNING quantity
          `
        : await tx.$queryRaw<Array<{ quantity: number }>>`
            INSERT INTO "warehouse_stock"
              ("id", "warehouse_id", "product_id", "variant_id", "quantity", "store_id", "created_at", "updated_at")
            VALUES (${id}, ${args.warehouseId}, ${args.productId}, ${args.variantId}, ${args.initialQty}, ${args.storeId}, now(), now())
            ON CONFLICT ("warehouse_id", "product_id", "variant_id")
            DO UPDATE SET quantity = ${args.setExpr}, updated_at = now()
            RETURNING quantity
          `;

    // Stock changed: Ebda Chat must see availability (raw SQL bypasses the db write observer).
    await notifyCatalogChanged({ storeId: args.storeId, productIds: [args.productId] });
    return rows[0].quantity;
  }

  /**
   * Re-aggregate Product.inventory / ProductVariant.inventory from the SUM of
   * all warehouse_stock rows. Called after every WarehouseStock mutation,
   * INSIDE the same transaction as that mutation (`tx` is mandatory — this is
   * no longer safe to call standalone against the ALS-proxied `prisma`).
   *
   * Race-safety (cross-warehouse / cross-variant aggregate race): a single
   * `UPDATE … SET col = (SELECT SUM …) WHERE id = …` statement is NOT
   * race-safe on its own, despite Postgres locking the target row as part of
   * the UPDATE. Per the Postgres docs ("Read Committed Isolation Level"):
   * when this UPDATE blocks on a concurrent writer holding the SAME target
   * row and later unblocks, only the WHERE-clause row is re-checked against
   * the newly committed version (EvalPlanQual) — "it does not see effects of
   * [the concurrent transaction] on any other rows in the database". The
   * correlated SUM subquery scans a DIFFERENT table (`warehouse_stock` /
   * `product_variants`) using the ORIGINAL per-statement snapshot taken
   * before the block, so it can still miss the other transaction's just-
   * committed rows. Two DIFFERENT warehouses (or two DIFFERENT variants)
   * writing the SAME product never collide on the per-row upsert (different
   * rows), so both can reach this resync concurrently and one's SUM can be
   * computed from a stale snapshot — a lost update in the aggregate even
   * though every underlying warehouse_stock row is correct.
   *
   * Fix: take an explicit `SELECT … FOR UPDATE` row lock on the aggregate
   * target as its OWN statement, BEFORE the SUM-recompute UPDATE. Acquiring
   * the lock forces this transaction to wait for any concurrent syncer of
   * the same product/variant to commit; the FOLLOWING statement (the SUM
   * UPDATE) then gets a FRESH READ COMMITTED snapshot that includes that
   * transaction's committed warehouse_stock writes. This serializes
   * concurrent syncs of the same aggregate target and lets each SUM see the
   * others' contributions. Verified against real concurrency in
   * `tests/integration/warehouse/stock-race.test.ts` (cross-warehouse and
   * cross-variant-rollup cases) — RED before this lock, GREEN after.
   */
  static async syncAggregateInventory(
    storeId: string,
    productId: string,
    variantId: string | null,
    tx: Prisma.TransactionClient
  ): Promise<void> {
    // Every statement carries the store (review M9, Ruling WAREHOUSE-STORE-SCOPE-1): RLS already
    // limits ebda_app to the ambient store, but a raw statement naming a tenant table must not rely
    // on that alone. product_variants has no store_id, so it is scoped through its product.
    if (variantId) {
      // Lock the variant row first — separate statement so the following
      // SUM-update runs against a fresh snapshot once the lock is granted.
      await tx.$queryRaw`
        SELECT v."id" FROM "product_variants" v
         WHERE v."id" = ${variantId} AND v."product_id" = ${productId}
           AND EXISTS (SELECT 1 FROM "products" p WHERE p."id" = ${productId} AND p."store_id" = ${storeId})
        FOR UPDATE OF v`;

      await tx.$executeRaw`
        UPDATE "product_variants"
        SET inventory = (
          SELECT COALESCE(SUM("quantity"), 0) FROM "warehouse_stock"
          WHERE "store_id" = ${storeId} AND "product_id" = ${productId} AND "variant_id" = ${variantId}
        )
        WHERE "id" = ${variantId} AND "product_id" = ${productId}
          AND EXISTS (SELECT 1 FROM "products" p WHERE p."id" = ${productId} AND p."store_id" = ${storeId})
      `;

      // The parent `products.inventory` is deliberately NOT touched: for a variant
      // product it is unused and stays 0 (docs/architecture/inventory-model.md —
      // one line writes the variant row XOR the product row). Stock is read as
      // SUM(active variants) by effectiveInventory / ON_HAND_SQL.
    } else {
      // Base-product stock (no variant)
      await tx.$queryRaw`SELECT "id" FROM "products" WHERE "id" = ${productId} AND "store_id" = ${storeId} FOR UPDATE`;

      await tx.$executeRaw`
        UPDATE "products"
        SET inventory = (
          SELECT COALESCE(SUM("quantity"), 0) FROM "warehouse_stock"
          WHERE "store_id" = ${storeId} AND "product_id" = ${productId} AND "variant_id" IS NULL
        )
        WHERE "id" = ${productId} AND "store_id" = ${storeId}
      `;
    }
    // The stock a shopper can buy changed (raw SQL bypasses the db write observer).
    await notifyCatalogChanged({ storeId, productIds: [productId] });
  }

  // ─── Reconciliation (shadow WarehouseStock → authoritative aggregate) ───────

  /**
   * Resolve the "default" warehouse for a store — the one that absorbs the
   * reconciliation residual in `reconcileWarehouseStockToAggregate`.
   *
   * Selection order:
   *   1. `isDefault === true` wins outright, regardless of priority/active.
   *   2. Else the HIGHEST-`priority` warehouse among `isActive === true` ones.
   *   3. Else the first warehouse (createdAt asc) — even if inactive.
   *   4. `null` if the store has zero warehouses.
   *
   * Fix wave 1 (2026-07): the Task 2 brief specified "lowest priority" for
   * fallback #2 — that was wrong. The schema documents
   * `priority Int // Higher = preferred` with
   * `@@index([storeId, priority(sort: Desc)])`, and `routeOrder` (above)
   * already sorts `priority: 'desc'` (higher = preferred for order
   * fulfillment routing). Flipped to match: HIGHEST priority wins the
   * fallback, consistent with the schema + routeOrder's convention.
   */
  static async resolveDefaultWarehouse(
    storeId: string
  ): Promise<{ id: string; isDefault: boolean; priority: number; isActive: boolean } | null> {
    const warehouses = await prisma.warehouse.findMany({
      where: { storeId },
      select: { id: true, isDefault: true, priority: true, isActive: true },
      orderBy: [{ createdAt: 'asc' }],
    });

    if (warehouses.length === 0) return null;

    const explicitDefault = warehouses.find(w => w.isDefault);
    if (explicitDefault) return explicitDefault;

    const activeByHighestPriority = [...warehouses]
      .filter(w => w.isActive)
      .sort((a, b) => b.priority - a.priority)[0];
    if (activeByHighestPriority) return activeByHighestPriority;

    return warehouses[0];
  }

  /**
   * Reconcile the WarehouseStock shadow for one SKU (productId + optional
   * variantId) back to the authoritative `Product.inventory` /
   * `ProductVariant.inventory`.
   *
   * THE BUG this fixes: `Product.inventory`/`ProductVariant.inventory` has 4
   * writers, but only `setStock`/`adjustStock` (via `syncAggregateInventory`)
   * touch `WarehouseStock`. Any OTHER writer (e.g. order placement
   * decrementing the aggregate directly) moves the authoritative value
   * WITHOUT moving the shadow, so `SUM(WarehouseStock) != Product.inventory`
   * drifts. This method reconciles the shadow TO the aggregate — it never
   * writes `Product.inventory`/`ProductVariant.inventory` itself.
   *
   * Fast path: stores with zero warehouses (the common case) are a pure
   * no-op — `WarehouseStock` isn't in play for them at all.
   *
   * Locking discipline mirrors `syncAggregateInventory` (Task 1): take a
   * `SELECT … FOR UPDATE` lock on the aggregate row (Product or
   * ProductVariant — guaranteed to exist, unlike a possibly-absent
   * WarehouseStock row) BEFORE reading the SUM, inside one `withMoneyTx`
   * transaction. This serializes concurrent reconciles/adjustStock calls for
   * the same SKU exactly the way Task 1 serializes concurrent aggregate
   * syncs. The actual write reuses `upsertWarehouseStock` — the SAME atomic
   * `INSERT … ON CONFLICT … RETURNING` helper Task 1 built — applying the
   * diff as a relative delta to the default warehouse's row.
   *
   * Clamp-vs-negative decision (Ruling WAREHOUSE-NEG-1, supersedes the earlier allow-negative-on-default policy): a
   * SURPLUS goes to the default warehouse's row; a DEFICIT is spread over the SKU's rows (default first, then
   * priority desc, created_at asc), each giving at most its own quantity, so NO row ever goes negative and
   * SUM(rows) still equals the aggregate. If the rows cannot cover the deficit (the aggregate itself is below what the
   * rows hold) every row is floored at 0 and the shortfall is logged as `reconcile_shortfall` (alert), never negative.
   *
   * Deadlock-safety (fix wave 1, 2026-07): `setStock`/`adjustStock` lock
   * WarehouseStock (via `upsertWarehouseStock`'s own row lock/upsert) FIRST,
   * then the aggregate `FOR UPDATE` (inside `syncAggregateInventory`) SECOND.
   * This method acquires the aggregate `FOR UPDATE` first, then the
   * WarehouseStock upsert — the OPPOSITE order. A concurrent `adjustStock` +
   * `reconcile` on the same SKU/default-warehouse row can therefore deadlock
   * (Postgres 40P01). Rather than restructure the lock order here (which
   * would touch the Task-1-reviewed `adjustStock`/`setStock` code, or invert
   * this method's own two-lock sequence in a way that's easy to get subtly
   * wrong), this method is wrapped in `retryOnWriteConflict` at the call
   * site: reconcile is read-then-diff-then-write and idempotent (re-running
   * converges to the same `SUM == aggregate`), so retrying the whole
   * transaction on a deadlock/serialization failure is safe. Postgres may
   * pick EITHER side as the deadlock victim, so `setStock`/`adjustStock`
   * carry the same retry (`WAREHOUSE_WRITE_RETRY`, #937).
   *
   * Verified empirically against real docker Postgres: the raw
   * `$queryRaw`/`$executeRaw` calls this method and `upsertWarehouseStock`
   * use surface a genuine deadlock as the RAW Postgres error code `40P01`
   * on `err.code` directly (`PrismaClientKnownRequestError` passes the raw
   * DB error code through for a failed raw query) — NOT translated to
   * Prisma's `P2034` the way an ORM-level interactive-transaction conflict
   * is. `retryOnWriteConflict`'s default `RETRYABLE_CODES` only contains
   * `P2034`, so `40P01` (and, for the same reason, `40001`
   * serialization_failure) is passed via `extraRetryCodes` — the extension
   * point the helper already exposes for exactly this ("Only pass codes
   * that a transaction RE-RUN can actually resolve", which a
   * deadlock/serialization failure is). This is additive — it does not
   * touch the shared `RETRYABLE_CODES` set, so every other caller of
   * `retryOnWriteConflict` (cart.service, etc.) is unaffected.
   */
  static async reconcileWarehouseStockToAggregate(
    storeId: string,
    productId: string,
    variantId: string | null = null
  ): Promise<{ reconciled: boolean; diff: number }> {
    // A store on its Durable Object (Ruling CF-JOBS-4): the aggregate, the shadow sum and the writes are ONE section there.
    const doStock = await storeStock(storeId);
    if (doStock) return doStock.reconcileWarehouseSku({ productId, variantId });
    // Fast path: single-/no-warehouse stores (the majority of merchants)
    // have no WarehouseStock rows to drift — nothing to reconcile.
    const warehouseCount = await prisma.warehouse.count({ where: { storeId } });
    if (warehouseCount === 0) {
      return { reconciled: false, diff: 0 };
    }

    const defaultWarehouse = await WarehouseService.resolveDefaultWarehouse(storeId);
    if (!defaultWarehouse) {
      // Unreachable given warehouseCount > 0 above, but keep the null-safe
      // contract explicit rather than assuming resolveDefaultWarehouse's
      // internals.
      return { reconciled: false, diff: 0 };
    }

    return retryOnWriteConflict(
      () =>
        withMoneyTx(prisma, async tx => {
          let authoritative: number;

          if (variantId) {
            const rows = await tx.$queryRaw<Array<{ inventory: number }>>`
              SELECT "inventory" FROM "product_variants" WHERE "id" = ${variantId} FOR UPDATE
            `;
            if (rows.length === 0) {
              throw new AppError(404, 'VARIANT_NOT_FOUND', 'Variant not found');
            }
            authoritative = rows[0].inventory;
          } else {
            const rows = await tx.$queryRaw<Array<{ inventory: number }>>`
              SELECT "inventory" FROM "products" WHERE "id" = ${productId} AND "store_id" = ${storeId} FOR UPDATE
            `;
            if (rows.length === 0) {
              throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
            }
            authoritative = rows[0].inventory;
          }

          const sumRows = variantId
            ? await tx.$queryRaw<Array<{ sum: number }>>`
                SELECT COALESCE(SUM("quantity"), 0)::int AS sum FROM "warehouse_stock"
                WHERE "store_id" = ${storeId} AND "product_id" = ${productId} AND "variant_id" = ${variantId}
              `
            : await tx.$queryRaw<Array<{ sum: number }>>`
                SELECT COALESCE(SUM("quantity"), 0)::int AS sum FROM "warehouse_stock"
                WHERE "store_id" = ${storeId} AND "product_id" = ${productId} AND "variant_id" IS NULL
              `;
          // issue 2081: `store_id` is explicit — the SUM used to rely on RLS
          // (or on product_id FKing a single store) for its tenant scope.
          const currentSum = sumRows[0]?.sum ?? 0;
          const diff = authoritative - currentSum;

          if (diff === 0) {
            return { reconciled: false, diff: 0 };
          }

          if (diff > 0) {
            // Surplus: the default warehouse's row takes it (INSERT branch covers a row that did not exist yet).
            await WarehouseService.upsertWarehouseStock(tx, {
              warehouseId: defaultWarehouse.id,
              productId,
              variantId,
              storeId,
              setExpr: Prisma.sql`"warehouse_stock"."quantity" + ${diff}`,
              initialQty: diff,
            });
            return { reconciled: true, diff };
          }

          // Deficit (WAREHOUSE-NEG-1): spread it over the SKU's warehouse rows, default first, so NO row goes negative.
          // Order is shared with the Durable Object (packages/repo/src/do/stock-ops.ts reconcileToAggregate).
          const rows = variantId
            ? await tx.$queryRaw<Array<{ warehouse_id: string; quantity: number }>>`
                SELECT ws."warehouse_id", ws."quantity" FROM "warehouse_stock" ws
                JOIN "warehouses" w ON w."id" = ws."warehouse_id"
                WHERE ws."store_id" = ${storeId} AND ws."product_id" = ${productId} AND ws."variant_id" = ${variantId}
                ORDER BY (ws."warehouse_id" = ${defaultWarehouse.id}) DESC, w."priority" DESC, w."created_at" ASC, ws."warehouse_id" ASC
                FOR UPDATE OF ws
              `
            : await tx.$queryRaw<Array<{ warehouse_id: string; quantity: number }>>`
                SELECT ws."warehouse_id", ws."quantity" FROM "warehouse_stock" ws
                JOIN "warehouses" w ON w."id" = ws."warehouse_id"
                WHERE ws."store_id" = ${storeId} AND ws."product_id" = ${productId} AND ws."variant_id" IS NULL
                ORDER BY (ws."warehouse_id" = ${defaultWarehouse.id}) DESC, w."priority" DESC, w."created_at" ASC, ws."warehouse_id" ASC
                FOR UPDATE OF ws
              `;
          const { takes, shortfall } = planDeficit(
            rows.map(r => ({ id: r.warehouse_id, quantity: r.quantity })),
            -diff
          );
          for (const t of takes) {
            await WarehouseService.upsertWarehouseStock(tx, {
              warehouseId: t.id,
              productId,
              variantId,
              storeId,
              setExpr: Prisma.sql`"warehouse_stock"."quantity" - ${t.amount}`,
              initialQty: 0,
            });
          }
          if (shortfall > 0) {
            // Impossible to honour SUM == aggregate without a negative row (the aggregate itself is below what the
            // rows hold, or a row was already negative): leave every row at >= 0 and ALERT, never go negative.
            logger.error(
              {
                storeId,
                productId,
                variantId,
                aggregate: authoritative,
                shadowSum: currentSum,
                shortfall,
              },
              '[Warehouse] reconcile_shortfall: deficit exceeds the warehouse stock; rows floored at 0, shadow still above the aggregate (WAREHOUSE-NEG-1)'
            );
          }
          return { reconciled: true, diff };
        }),
      {
        retries: 3,
        label: 'reconcileWarehouseStockToAggregate',
        // Raw deadlock (40P01) / serialization-failure (40001) codes — see
        // docstring above for why these don't come through as P2034 here.
        extraRetryCodes: ['40P01', '40001'],
      }
    );
  }

  /**
   * Backfill: reconcile every SKU (productId + optional variantId) that has
   * ANY WarehouseStock row for the store. Batched to avoid loading the whole
   * store's stock table at once. Idempotent — a SKU that's already
   * consistent (or was just fixed) reconciles to `{ reconciled: false }` on
   * the next pass and is not counted again.
   *
   * Per-SKU isolation (fix wave 1, 2026-07): `reconcileWarehouseStockToAggregate`
   * throws `AppError(404)` if the product/variant row isn't found under lock
   * — e.g. a SOFT-deleted product (the reconcile lookup intentionally has no
   * `deletedAt: null` filter, since a soft-deleted product's aggregate is
   * still a real row to reconcile against if it exists) or a genuine
   * TOCTOU hard-delete race between listing the SKU and locking it. Without
   * a per-SKU try/catch, ONE bad SKU aborted the entire unattended admin
   * sweep. Each SKU's reconcile is now isolated: on any thrown error
   * (business AppError or otherwise) it's logged with productId/variantId
   * and counted as failed, and the loop continues — it never re-throws.
   * Soft-deleted / hard-deleted SKUs are handled this way (skip-via-catch)
   * rather than pre-filtered at the listing query, because the catch is the
   * single source of truth for "un-reconcilable" and also covers the TOCTOU
   * race a `deletedAt: null` pre-filter can't defend against.
   */
  static async backfillReconcileAll(
    storeId: string
  ): Promise<{ skusReconciled: number; skusFailed: number }> {
    // A store on its Durable Object (Ruling CF-JOBS-4): paged sections there, each reconciling up to 500 SKUs.
    const doStock = await storeStock(storeId);
    if (doStock) {
      let skusReconciled = 0;
      let skusFailed = 0;
      let afterKey: string | null = null;
      for (;;) {
        const page: Awaited<ReturnType<typeof doStock.reconcileWarehouseAll>> =
          await doStock.reconcileWarehouseAll({ limit: 500, afterKey });
        skusReconciled += page.skusReconciled;
        skusFailed += page.skusFailed;
        if (!page.more || !page.nextKey) break;
        afterKey = page.nextKey;
      }
      return { skusReconciled, skusFailed };
    }
    const warehouseCount = await prisma.warehouse.count({ where: { storeId } });
    if (warehouseCount === 0) {
      return { skusReconciled: 0, skusFailed: 0 };
    }

    const BATCH_SIZE = 100;
    let skip = 0;
    let skusReconciled = 0;
    let skusFailed = 0;

    for (;;) {
      const skus = await prisma.warehouseStock.findMany({
        where: { storeId },
        select: { productId: true, variantId: true },
        distinct: ['productId', 'variantId'],
        orderBy: [{ productId: 'asc' }, { variantId: 'asc' }],
        skip,
        take: BATCH_SIZE,
      });

      if (skus.length === 0) break;

      for (const sku of skus) {
        try {
          const result = await WarehouseService.reconcileWarehouseStockToAggregate(
            storeId,
            sku.productId,
            sku.variantId
          );
          if (result.reconciled) skusReconciled++;
        } catch (err) {
          skusFailed++;
          logger.error(
            {
              storeId,
              productId: sku.productId,
              variantId: sku.variantId,
              err: err instanceof Error ? err.message : String(err),
            },
            '[Warehouse] backfill reconcile: SKU failed, skipping'
          );
        }
      }

      if (skus.length < BATCH_SIZE) break;
      skip += BATCH_SIZE;
    }

    logger.info({ storeId, skusReconciled, skusFailed }, '[Warehouse] backfill reconcile complete');

    return { skusReconciled, skusFailed };
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
