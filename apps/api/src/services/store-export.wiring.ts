import { AppError } from '../middleware/error-handler';
import { withStoreDb } from '../lib/jobs/store-db';
import type { StoreReads } from '../lib/repo-factory';
import {
  assertStoreOwner,
  consumeStoreExportToken,
  issueStoreExportToken,
  verifyStoreExportToken,
} from './store-deletion.service';
import { productionDeletionDeps } from './store-deletion.wiring';
import {
  buildStoreBundle,
  EXPORT_ITEMS_PER_ORDER,
  EXPORT_ROW_CAP,
  EXPORT_TABLES,
} from './store-export.service';

/** Step 1 of the export: the owner gets a single-use token (the same step-up as the delete). */
export function exportPreview(input: { storeId: string; userId: string }) {
  return issueStoreExportToken(input, productionDeletionDeps());
}

async function productionRead(storeId: string, table: string, take: number): Promise<unknown[]> {
  const orderBy = { id: 'asc' as const };
  return withStoreDb(storeId, async (db: StoreReads) => {
    const d = db as unknown as Record<string, { findMany(a: unknown): Promise<unknown[]> }>;
    switch (table) {
      case 'order':
        // m3: the items ride along, so the row cap alone does not bound the bundle: cap the lines per order too
        return d.order.findMany({
          take,
          orderBy,
          include: { items: { take: EXPORT_ITEMS_PER_ORDER, orderBy: { id: 'asc' } } },
        });
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
  confirmToken: string;
}): Promise<
  { ok: true; zip: Uint8Array; filename: string } | { ok: false; rows: number; cap: number }
> {
  const deps = productionDeletionDeps();
  const store = await assertStoreOwner(deps, input.storeId, input.userId);
  // The bundle carries up to 20k customers' names, phones and emails: a session alone is not enough (step-up token, single use).
  if (!verifyStoreExportToken(input)) throw invalidToken();
  const r = await buildStoreBundle({
    storeId: store.id,
    tables: EXPORT_TABLES,
    read: productionRead,
    cap: EXPORT_ROW_CAP,
  });
  if (!r.ok) return r;
  if (!(await consumeStoreExportToken(input.confirmToken))) throw invalidToken();
  await deps.audit({
    action: 'STORE_DATA_EXPORTED',
    userId: input.userId,
    storeId: store.id,
    details: { rows: r.rows },
  });
  // Every export is told to the OWNER on the address the identity service holds for the owner account: never one a request supplied.
  await deps
    .notifyOwner('exported', {
      to: store.ownerId ? await deps.ownerEmail(store.ownerId).catch(() => null) : null,
      storeName: store.name,
      slug: store.slug,
    })
    .catch(() => undefined);
  return {
    ok: true,
    zip: r.zip,
    filename: `${store.slug}-export-${new Date().toISOString().slice(0, 10)}.zip`,
  };
}

function invalidToken() {
  return new AppError(
    400,
    'CONFIRM_TOKEN_INVALID',
    'The confirmation expired or is invalid. Review and confirm again.'
  );
}
