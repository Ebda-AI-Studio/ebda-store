/**
 * Ruling NZ-AN-1: where a store's per-store analytics (search_query_daily, product_daily_views, qr_scan_daily, notification_logs,
 * gsc_daily_metrics) live. A store whose backend is its Durable Object serves them from the DO ONLY after the controller's copy
 * (`scripts/cf/copy-analytics-to-do.mjs`) wrote the D1 marker `platform_cutover.analytics`; before it, every store (DO or not)
 * stays on Postgres, so no row is split between the two. While the copy runs the family is frozen: a WRITE for a DO store is
 * refused with a retryable 503 (callers that fail open swallow it), a read keeps going to Postgres.
 *
 * Postgres stores never move with the marker: their tables come to the DO with `migrate-store-to-do` when the store flips.
 */
import {
  storeDb,
  storeMoney,
  storeWriter,
  storeWritesToDo,
  type MoneyClient,
  type StoreReads,
  type StoreWrites,
} from './repo-factory';
import { platformFamilyOnD1, platformFamilyOnD1ForWrite } from '../services/platform/cutover';

export async function analyticsOnDo(storeId: string, mode: 'read' | 'write'): Promise<boolean> {
  if (!(await storeWritesToDo(storeId))) return false;
  return mode === 'write'
    ? platformFamilyOnD1ForWrite('analytics')
    : platformFamilyOnD1('analytics');
}

/** The DO op client when this store's analytics are on its DO, else null (Postgres path). */
export async function analyticsMoney(
  storeId: string,
  mode: 'read' | 'write'
): Promise<MoneyClient | null> {
  if (!(await analyticsOnDo(storeId, mode))) return null;
  const money = await storeMoney(storeId);
  if (!money) throw new Error(`analytics: no DO client for DO store ${storeId}`);
  return money;
}

/** A write of per-store analytics rows: the store's DO writer when its analytics moved, else `pg()` (unchanged Postgres code). */
export async function analyticsWrite<T>(
  storeId: string,
  onDo: (w: StoreWrites) => Promise<T>,
  pg: () => Promise<T>
): Promise<T> {
  if (await analyticsOnDo(storeId, 'write')) return onDo(await storeWriter(storeId));
  return pg();
}

/** A read of per-store analytics rows: the store's DO reader when its analytics moved, else `pg()`. */
export async function analyticsRead<T>(
  storeId: string,
  onDo: (r: StoreReads) => Promise<T>,
  pg: () => Promise<T>
): Promise<T> {
  if (await analyticsOnDo(storeId, 'read')) return onDo(await storeDb(storeId));
  return pg();
}
