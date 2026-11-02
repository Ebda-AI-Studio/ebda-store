/**
 * Store-directory reconciler (security review of #384): repairs D1 `stores` drift from Postgres, fail-closed.
 *
 * Cost: two reads of the `ebda_store_directory` definer (all stores incl. deleted, and live stores) plus ONE SELECT of D1;
 * a per-store read-back happens only for a store that DIFFERS. Runs hourly from the existing cron (cf/cron.ts).
 *
 * Rules, per store (Postgres = committed truth, D1 = what lookups read):
 *   - in Postgres, missing from D1            -> sync it in (corrected)
 *   - in D1, gone from Postgres               -> delete the D1 row (corrected)
 *   - differs in slug / status / plan / has-domain / has-pending-domain / deleted:
 *       D1 LESS restrictive than Postgres (e.g. D1 active, Postgres suspended or deleted) -> sync from Postgres (corrected)
 *       D1 MORE restrictive than Postgres (D1 suspended or deleted, Postgres active)    -> KEEP D1 (a store is never
 *       re-opened by a repair), record it as `keptRestrictive` and alert for a human to rule on
 * Every correction and every kept-restrictive case is logged and alerted.
 */
import { storeDirectory } from '@ebda/database';
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings } from '../cf/bindings';
import { syncStoreDirectoryFromPg } from './store-directory-sync';

interface D1Row {
  id: string;
  slug: string;
  status: string;
  plan: string;
  has_domain: number;
  has_pending_domain: number;
  deleted: number;
}
interface D1Like {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

/** Higher = more restrictive. `deleted` beats every status. */
const RANK: Record<string, number> = { active: 0, inactive: 1, suspended: 2 };
const restrictiveness = (status: string, deleted: boolean): number =>
  deleted ? 99 : (RANK[status] ?? 99);

export interface ReconcileReport {
  checked: number;
  corrected: Array<{ id: string; why: string }>;
  keptRestrictive: Array<{ id: string; why: string }>;
}

export async function reconcileStoreDirectory(
  deps: {
    d1?: D1Like;
    pgAll?: () => Promise<
      Array<{
        id: string;
        slug: string;
        status: string;
        plan: string;
        hasDomain: boolean;
        hasPendingDomain: boolean;
      }>
    >;
    pgLive?: () => Promise<Array<{ id: string }>>;
    sync?: (id: string) => Promise<void>;
    alert?: (title: string, body: string) => Promise<unknown> | unknown;
  } = {}
): Promise<ReconcileReport> {
  const d1 =
    deps.d1 ??
    ((cfBindings() as { PLATFORM_DB?: D1Like } | undefined)?.PLATFORM_DB as D1Like | undefined);
  const report: ReconcileReport = { checked: 0, corrected: [], keptRestrictive: [] };
  if (!d1) return report;
  const sync = deps.sync ?? syncStoreDirectoryFromPg;
  const alert =
    deps.alert ??
    ((title: string, body: string) =>
      sendAlert({ level: 'p1', source: 'store-directory-reconcile', title, body }));
  const pgAll =
    deps.pgAll ??
    (async () =>
      (await storeDirectory(undefined, { includeDeleted: true })).map(s => ({
        id: s.id,
        slug: s.slug,
        status: s.status,
        plan: s.plan,
        hasDomain: s.hasDomain,
        hasPendingDomain: s.hasPendingDomain,
      })));
  const pgLive = deps.pgLive ?? (async () => storeDirectory());
  const [all, live] = await Promise.all([pgAll(), pgLive()]);
  const liveIds = new Set(live.map(s => s.id));
  const { results } = await d1
    .prepare(
      `SELECT id, slug, status, plan, (domain IS NOT NULL) AS has_domain, (pending_domain IS NOT NULL) AS has_pending_domain,
              (deleted_at IS NOT NULL) AS deleted FROM stores`
    )
    .bind()
    .all<D1Row>();
  const d1ById = new Map((results ?? []).map(r => [r.id, r]));
  const pgIds = new Set(all.map(s => s.id));
  report.checked = all.length;

  for (const s of all) {
    const pgDeleted = !liveIds.has(s.id);
    const row = d1ById.get(s.id);
    if (!row) {
      await sync(s.id);
      report.corrected.push({ id: s.id, why: 'missing from D1' });
      continue;
    }
    const same =
      row.slug === s.slug &&
      row.status === s.status &&
      row.plan === s.plan &&
      !!row.has_domain === s.hasDomain &&
      !!row.has_pending_domain === s.hasPendingDomain &&
      !!row.deleted === pgDeleted;
    if (same) continue;
    const d1R = restrictiveness(row.status, !!row.deleted);
    const pgR = restrictiveness(s.status, pgDeleted);
    if (d1R > pgR) {
      report.keptRestrictive.push({
        id: s.id,
        why: `D1 ${row.deleted ? 'deleted' : row.status} is stricter than Postgres ${pgDeleted ? 'deleted' : s.status}`,
      });
      continue;
    }
    await sync(s.id);
    report.corrected.push({
      id: s.id,
      why: `differed (status ${row.status} -> ${s.status}, deleted ${!!row.deleted} -> ${pgDeleted})`,
    });
  }
  for (const [id] of d1ById) {
    if (pgIds.has(id)) continue;
    await d1.prepare('DELETE FROM "stores" WHERE "id" = ?').bind(id).run();
    report.corrected.push({ id, why: 'in D1, gone from Postgres' });
  }

  if (report.corrected.length || report.keptRestrictive.length) {
    logger.error(
      { corrected: report.corrected, keptRestrictive: report.keptRestrictive },
      '[store-directory] D1 directory drift'
    );
    await alert(
      'Store directory drift between Postgres and D1',
      `corrected ${report.corrected.length}, kept-restrictive ${report.keptRestrictive.length}: ` +
        JSON.stringify([...report.corrected, ...report.keptRestrictive].slice(0, 20))
    );
  }
  return report;
}
