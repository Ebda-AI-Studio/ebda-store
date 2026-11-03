/**
 * Store-directory reconciler (security review of #384): repairs D1 `stores` drift from Postgres, fail-closed.
 *
 * Cost: two reads of the `ebda_store_directory` definer (all stores incl. deleted, and live stores) plus ONE SELECT of D1;
 * a per-store read-back happens only for a store that DIFFERS. Runs hourly from the existing cron (cf/cron.ts).
 *
 * Rules, per store (Postgres = committed truth, D1 = what lookups read):
 *   - in Postgres, missing from D1            -> sync it in (corrected)
 *   - in D1, gone from Postgres               -> delete the D1 row (corrected)
 *   - `storage_backend = 'do'` rows (Ruling NZ-D14): D1 + the DO own them and Postgres is stale by design, so Postgres NEVER overwrites
 *       one, but the RESTRICTIVE direction is always applied: a Postgres row that is suspended / inactive / deleted closes the D1 row
 *       (status and deleted_at only) and alerts. A Postgres row that is ABSENT for a `do` store is alert-only, never a delete
 *   - differs in slug / status / plan / has-domain / has-pending-domain / deleted:
 *       D1 LESS restrictive than Postgres (e.g. D1 active, Postgres suspended or deleted) -> sync from Postgres (corrected)
 *       D1 MORE restrictive than Postgres (D1 suspended or deleted, Postgres active)    -> KEEP D1 (a store is never
 *       re-opened by a repair), record it as `keptRestrictive` and alert for a human to rule on
 * Every correction and every kept-restrictive case is logged and alerted.
 */
import { storeDirectory, withStore } from '@ebda/database';
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings } from '../cf/bindings';
import { syncStoreDirectoryFromPg } from './store-directory-sync';

interface D1Row {
  id: string;
  slug: string;
  status: string;
  plan: string;
  domain: string | null;
  pending_domain: string | null;
  has_domain: number;
  has_pending_domain: number;
  deleted: number;
  backend: string;
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

/** Close a `do` row in the restrictive direction only: status and deleted_at, nothing else. */
async function closeDoRow(
  d1: D1Like,
  id: string,
  pgStatus: string,
  d1Status: string,
  pgDeleted: boolean,
  d1Deleted: boolean
): Promise<void> {
  // never loosen: a deleted Postgres row can still say `active`, which must not overwrite a suspended D1 status (NZ-D21)
  const status = (RANK[pgStatus] ?? 99) >= (RANK[d1Status] ?? 99) ? pgStatus : d1Status;
  const deletedAt = pgDeleted && !d1Deleted ? Date.now() : null;
  await d1
    .prepare(
      `UPDATE "stores" SET "status" = ?, "deleted_at" = COALESCE("deleted_at", ?) WHERE "id" = ? AND "storage_backend" = 'do'`
    )
    .bind(status, deletedAt, id)
    .run();
}

export interface ReconcileReport {
  checked: number;
  corrected: Array<{ id: string; why: string }>;
  keptRestrictive: Array<{ id: string; why: string }>;
  /** `do` stores Postgres does not know: reported, never deleted. */
  alertOnly: Array<{ id: string; why: string }>;
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
    /** Postgres domain / pending_domain VALUES of one store, read back only for a store that has one (Ruling NZ-D18). */
    pgDomains?: (id: string) => Promise<{ domain: string | null; pendingDomain: string | null }>;
    alert?: (title: string, body: string) => Promise<unknown> | unknown;
  } = {}
): Promise<ReconcileReport> {
  const d1 =
    deps.d1 ??
    ((cfBindings() as { PLATFORM_DB?: D1Like } | undefined)?.PLATFORM_DB as D1Like | undefined);
  const report: ReconcileReport = { checked: 0, corrected: [], keptRestrictive: [], alertOnly: [] };
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
  const pgDomains =
    deps.pgDomains ??
    (async (id: string) => {
      const r = await withStore(id, tx =>
        tx.store.findUnique({ where: { id }, select: { domain: true, pendingDomain: true } })
      );
      return { domain: r?.domain ?? null, pendingDomain: r?.pendingDomain ?? null };
    });
  const lc = (v: string | null | undefined) => (v ? v.toLowerCase() : null);
  /** The directory definer only says WHETHER a store has a domain, so a domain moved A -> B keeps both flags: compare the VALUES. */
  const domainsDiffer = async (id: string, row: D1Row, pgHas: boolean): Promise<boolean> => {
    if (!pgHas && !row.domain && !row.pending_domain) return false;
    const pd = await pgDomains(id);
    return lc(pd.domain) !== lc(row.domain) || lc(pd.pendingDomain) !== lc(row.pending_domain);
  };
  const pgLive = deps.pgLive ?? (async () => storeDirectory());
  const [all, live] = await Promise.all([pgAll(), pgLive()]);
  const liveIds = new Set(live.map(s => s.id));
  const { results } = await d1
    .prepare(
      `SELECT id, slug, status, plan, lower(domain) AS domain, lower(pending_domain) AS pending_domain, (domain IS NOT NULL) AS has_domain, (pending_domain IS NOT NULL) AS has_pending_domain,
              (deleted_at IS NOT NULL) AS deleted, storage_backend AS backend FROM stores`
    )
    .bind()
    .all<D1Row>();
  const d1ById = new Map((results ?? []).map(r => [r.id, r]));
  const pgIds = new Set(all.map(s => s.id));
  report.checked = all.length;

  for (const s of all) {
    const pgDeleted = !liveIds.has(s.id);
    const row = d1ById.get(s.id);
    if (row?.backend === 'do') {
      // D1 + the DO own it (plan N-22): never overwritten from Postgres, but a stricter Postgres state is applied (NZ-D14).
      if (restrictiveness(s.status, pgDeleted) > restrictiveness(row.status, !!row.deleted)) {
        await closeDoRow(d1, s.id, s.status, row.status, pgDeleted, !!row.deleted);
        report.corrected.push({
          id: s.id,
          why: `do store closed to match Postgres (${pgDeleted ? 'deleted' : s.status})`,
        });
      }
      // Domains of a do store live in D1 only (Postgres is stale by design): never compared, never read from Postgres (NZ-D21).
      continue;
    }
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
    const domainDrift = await domainsDiffer(s.id, row, s.hasDomain || s.hasPendingDomain);
    if (same && !domainDrift) continue;
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
      why: `differed (status ${row.status} -> ${s.status}, deleted ${!!row.deleted} -> ${pgDeleted}${domainDrift ? ', domain values' : ''})`,
    });
  }
  for (const [id] of d1ById) {
    if (pgIds.has(id)) continue;
    if (d1ById.get(id)?.backend === 'do') {
      report.alertOnly.push({
        id,
        why: 'do store unknown to Postgres (never deleted by the reconciler)',
      });
      continue;
    }
    await d1.prepare('DELETE FROM "stores" WHERE "id" = ?').bind(id).run();
    report.corrected.push({ id, why: 'in D1, gone from Postgres' });
  }

  if (report.corrected.length || report.keptRestrictive.length || report.alertOnly.length) {
    logger.error(
      {
        corrected: report.corrected,
        keptRestrictive: report.keptRestrictive,
        alertOnly: report.alertOnly,
      },
      '[store-directory] D1 directory drift'
    );
    await alert(
      'Store directory drift between Postgres and D1',
      `corrected ${report.corrected.length}, kept-restrictive ${report.keptRestrictive.length}, alert-only ${report.alertOnly.length}: ` +
        JSON.stringify(
          [...report.corrected, ...report.keptRestrictive, ...report.alertOnly].slice(0, 20)
        )
    );
  }
  return report;
}
