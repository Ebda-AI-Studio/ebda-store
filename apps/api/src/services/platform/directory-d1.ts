/**
 * NEON-ZERO (Ruling NZ-C-4): the store DIRECTORY listed from D1 `stores` (id order), for the platform-hub handlers and
 * cron sweeps that used `storeDirectory()` (a Postgres SECURITY DEFINER function). D1 is the directory of record once a
 * store lives on its Durable Object; callers use this only when `platformDb()` is bound, and never fall back to Postgres.
 */
import { d1All, fromMs } from './billing-d1';
import { AppError } from '../../middleware/error-handler';

export interface DirectoryStore {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  status: string;
  plan: string;
  ownerId: string;
  isDemo: boolean;
  storageBackend: 'pg' | 'do';
  deletedAt: Date | null;
}

interface Raw {
  id: string;
  name: string;
  name_ar: string | null;
  slug: string;
  status: string;
  plan: string;
  owner_id: string;
  is_demo: number;
  storage_backend: string;
  deleted_at: number | null;
}

/** Every store in the directory, id order; soft-deleted ones only with `includeDeleted`. A D1 outage is a 503. */
export async function listDirectoryStores(
  opts: { includeDeleted?: boolean } = {}
): Promise<DirectoryStore[]> {
  let rows: Raw[];
  try {
    rows = await d1All<Raw>(
      `SELECT id, name, name_ar, slug, status, plan, owner_id, is_demo, storage_backend, deleted_at
         FROM stores ${opts.includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY id`
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(503, 'PLATFORM_DIRECTORY_UNAVAILABLE', 'Store directory is unavailable');
  }
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    nameAr: r.name_ar,
    slug: r.slug,
    status: r.status,
    plan: r.plan,
    ownerId: r.owner_id,
    isDemo: Number(r.is_demo) === 1,
    storageBackend: r.storage_backend === 'do' ? 'do' : 'pg',
    deletedAt: fromMs(r.deleted_at),
  }));
}

/**
 * One page of the directory, newest first, optionally one owner's stores (the merchant's own store list). Soft-deleted rows are
 * excluded. Returns the ids (the caller reads each store's full record from its backend) and the total. A D1 outage is a 503.
 */
export async function pageDirectoryStoreIds(opts: {
  ownerId?: string;
  skip: number;
  take: number;
}): Promise<{ ids: string[]; total: number }> {
  try {
    const where = opts.ownerId
      ? 'WHERE deleted_at IS NULL AND owner_id = ?1'
      : 'WHERE deleted_at IS NULL';
    const args = opts.ownerId ? [opts.ownerId] : [];
    const rows = await d1All<{ id: string }>(
      `SELECT id FROM stores ${where} ORDER BY created_at DESC, id LIMIT ${Math.trunc(opts.take)} OFFSET ${Math.trunc(opts.skip)}`,
      ...args
    );
    const t = await d1All<{ n: number }>(`SELECT COUNT(*) AS n FROM stores ${where}`, ...args);
    return { ids: rows.map(r => r.id), total: Number(t[0]?.n ?? 0) };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(503, 'PLATFORM_DIRECTORY_UNAVAILABLE', 'Store directory is unavailable');
  }
}
