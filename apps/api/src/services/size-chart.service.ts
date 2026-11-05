import { Prisma } from '@ebda/database';
import { toPublicSizeChart, type PublicSizeChart, type SizeChart } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { invalidateStoreProductCaches } from '../lib/public-cache';
import { storeDb, storeWriter } from '../lib/repo-factory';

/**
 * Size charts (B0 Task 9). Store-owned tables linked from `products.size_chart_id` and
 * `categories.size_chart_id` (both FK ON DELETE SET NULL, so deleting a chart can never trip an
 * FK error and the PDP link simply disappears).
 *
 * CACHE CLASS: BOUNDED-stale (display content, never price/stock/permissions). The resolved chart
 * rides the PDP payload cache (`public:product:<store>:*` Redis, `products:<store>` Next tag) and
 * the `/size-guide` list rides the same `products:<store>` tag. Every chart write (create, update,
 * delete) calls `invalidateStoreProductCaches`, which clears both layers for the store; a product
 * or category write that changes `sizeChartId` busts the same function. Residual: the 60s edge
 * cache on the public responses, like every other PDP field.
 */

/** Columns the storefront needs. `storeId`/timestamps stay server-side. */
export const SIZE_CHART_PUBLIC_SELECT = {
  id: true,
  name: true,
  nameAr: true,
  unit: true,
  columns: true,
  rows: true,
  note: true,
  noteAr: true,
} as const satisfies Prisma.SizeChartSelect;

const ADMIN_SELECT = {
  ...SIZE_CHART_PUBLIC_SELECT,
  createdAt: true,
  updatedAt: true,
  // "Used by" counts for the admin list (live products only).
  _count: {
    select: {
      products: { where: { deletedAt: null } },
      categories: { where: { deletedAt: null } },
    },
  },
} as const satisfies Prisma.SizeChartSelect;

function notFound(): AppError {
  return new AppError(404, 'NOT_FOUND', 'Size chart not found');
}

/**
 * Refuse a `sizeChartId` from another store (or a stale id). The FK alone would accept any
 * existing chart id, so product and category writes call this before linking.
 */
export async function assertSizeChartInStore(
  storeId: string,
  sizeChartId: string | null | undefined
): Promise<void> {
  if (!sizeChartId) return;
  const found = await (
    await storeDb(storeId)
  ).sizeChart.findFirst({
    where: { id: sizeChartId, storeId },
    select: { id: true },
  });
  if (!found) throw new AppError(404, 'SIZE_CHART_NOT_FOUND', 'Size chart not found in this store');
}

/**
 * The PDP's chart: the product's own, else the first of its live categories (by category
 * position) that has one, else null. Malformed stored JSON resolves to null, never a 500.
 */
export function resolvePdpSizeChart(product: {
  sizeChart?: unknown;
  categories?: Array<{
    category?: { sizeChart?: unknown; deletedAt?: Date | null; position?: number } | null;
  }>;
}): PublicSizeChart | null {
  const own = toPublicSizeChart(product.sizeChart);
  if (own) return own;
  const cats = (product.categories ?? [])
    .map(c => c.category)
    .filter((c): c is NonNullable<typeof c> => !!c && !c.deletedAt)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const c of cats) {
    const chart = toPublicSizeChart(c.sizeChart);
    if (chart) return chart;
  }
  return null;
}

function writeData(data: SizeChart) {
  return {
    name: data.name,
    nameAr: data.nameAr,
    unit: data.unit,
    columns: data.columns as Prisma.InputJsonValue,
    rows: data.rows as Prisma.InputJsonValue,
    note: data.note,
    noteAr: data.noteAr,
  };
}

export class SizeChartService {
  static async list(storeId: string) {
    const db = await storeDb(storeId);
    return db.sizeChart.findMany({
      where: { storeId },
      orderBy: { createdAt: 'asc' },
      select: ADMIN_SELECT,
    });
  }

  static async get(storeId: string, id: string) {
    const db = await storeDb(storeId);
    const chart = await db.sizeChart.findFirst({
      where: { id, storeId },
      select: ADMIN_SELECT,
    });
    if (!chart) throw notFound();
    return chart;
  }

  static async create(storeId: string, data: SizeChart) {
    const chart = await (
      await storeWriter(storeId)
    ).sizeChart.create({
      data: { storeId, ...writeData(data) },
      select: ADMIN_SELECT,
    });
    // /size-guide lists every chart under the `products:<store>` tag.
    await invalidateStoreProductCaches(storeId);
    return chart;
  }

  static async update(storeId: string, id: string, data: SizeChart) {
    const w = await storeWriter(storeId);
    const existing = await w.sizeChart.findFirst({
      where: { id, storeId },
      select: { id: true },
    });
    if (!existing) throw notFound();
    const chart = await w.sizeChart.update({
      where: { id, storeId },
      data: writeData(data),
      select: ADMIN_SELECT,
    });
    // Every PDP that resolves to this chart (own or via a category) is in the product caches.
    await invalidateStoreProductCaches(storeId);
    return chart;
  }

  static async delete(storeId: string, id: string) {
    const w = await storeWriter(storeId);
    const existing = await w.sizeChart.findFirst({
      where: { id, storeId },
      select: { id: true },
    });
    if (!existing) throw notFound();
    // products.size_chart_id / categories.size_chart_id are ON DELETE SET NULL.
    await w.sizeChart.delete({ where: { id, storeId } });
    await invalidateStoreProductCaches(storeId);
  }

  /** Every valid chart in the store, for the storefront `/size-guide` page. */
  static async listPublic(storeId: string): Promise<PublicSizeChart[]> {
    const db = await storeDb(storeId); // pg today; the store's Durable Object once its flag says 'do' (CF-REPO-1)
    const rows = await db.sizeChart.findMany({
      where: { storeId },
      orderBy: { createdAt: 'asc' },
      select: SIZE_CHART_PUBLIC_SELECT,
    });
    return rows.map(toPublicSizeChart).filter((c): c is PublicSizeChart => c !== null);
  }
}
