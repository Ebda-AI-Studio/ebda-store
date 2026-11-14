import { AppError } from '../middleware/error-handler';
import { withStoreDb } from '../lib/jobs/store-db';
import type { StoreReads } from '../lib/repo-factory';
import { assertStoreOwner } from './store-deletion.service';
import { productionDeletionDeps } from './store-deletion.wiring';
import { buildStoreBundle, EXPORT_ROW_CAP, EXPORT_TABLES } from './store-export.service';

async function productionRead(storeId: string, table: string, take: number): Promise<unknown[]> {
  const orderBy = { id: 'asc' as const };
  return withStoreDb(storeId, async (db: StoreReads) => {
    const d = db as unknown as Record<string, { findMany(a: unknown): Promise<unknown[]> }>;
    switch (table) {
      case 'order':
        return d.order.findMany({ take, orderBy, include: { items: true } });
      case 'customer':
        return d.customer.findMany({
          take,
          orderBy,
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            notes: true,
            totalOrders: true,
            totalSpent: true,
            createdAt: true,
          },
        });
      default:
        if (!(table in d))
          throw new AppError(500, 'EXPORT_TABLE_UNKNOWN', `unknown export table ${table}`);
        return d[table].findMany({ take, orderBy });
    }
  });
}

export async function exportStoreBundle(input: {
  storeId: string;
  userId: string;
}): Promise<
  { ok: true; zip: Uint8Array; filename: string } | { ok: false; rows: number; cap: number }
> {
  const deps = productionDeletionDeps();
  const store = await assertStoreOwner(deps, input.storeId, input.userId);
  const r = await buildStoreBundle({
    storeId: store.id,
    tables: EXPORT_TABLES,
    read: productionRead,
    cap: EXPORT_ROW_CAP,
  });
  if (!r.ok) return r;
  await deps.audit({
    action: 'STORE_DATA_EXPORTED',
    userId: input.userId,
    storeId: store.id,
    details: { rows: r.rows },
  });
  return {
    ok: true,
    zip: r.zip,
    filename: `${store.slug}-export-${new Date().toISOString().slice(0, 10)}.zip`,
  };
}
