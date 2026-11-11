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
 *
 * NEON-ZERO (Ruling NZ-C-10): with no Postgres (no Hyperdrive binding, or the directory read fails) the Postgres side is SKIPPED, never
 * thrown: the tick reconciles D1 against each `do` store's own StoreDO instead (slug and status of the DO record vs the D1 row). The
 * same restrictive rule applies: a DO that is stricter than D1 closes the D1 row (status only), anything else is alert-only. A DO
 * that cannot be read is alert-only. The report says `postgresSkipped`. Cost if wrong: a Postgres outage silences the Postgres
 * drift repair for that tick (it runs again the next hour).
 */
import { storeDirectory, withStore } from '@ebda/database';
import { hasStoresOnBackend } from './store-backend';
import logger from './logger';
import { sendAlert } from '../services/alerts.service';
import { cfBindings } from '../cf/bindings';
import { syncStoreDirectoryFromPg } from './store-directory-sync';
import { copyStoreSettings, storeDb } from './repo-factory';

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
  name: string;
  name_ar: string | null;
  template: string | null;
  look: string | null;
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
class NoPostgresStores extends Error {}

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
  /** True when the Postgres side was skipped (no Postgres): the DO side ran instead. */
  postgresSkipped?: boolean;
}

/** One `do` store's DO record, or null when the DO has none. Throws when the DO cannot be read. */
type DoRecord = (id: string) => Promise<{
  slug: string;
  status: string;
  /** The mirror columns D1 and the DO's `store_profile` both carry (Ruling NZ-D8). Absent = not compared. */
  name?: string;
  nameAr?: string | null;
  template?: string | null;
  look?: string | null;
} | null>;
const readDoRecord: DoRecord = async id => {
  const r = await (
    await storeDb(id)
  ).store.findUnique({
    where: { id },
    select: { slug: true, status: true, name: true, nameAr: true, template: true, look: true },
  });
  return r
    ? {
        slug: r.slug,
        status: String(r.status),
        name: r.name,
        nameAr: r.nameAr ?? null,
        template: r.template ? String(r.template) : null,
        look: r.look ?? null,
      }
    : null;
};

/**
 * D1 `stores` owns template / look / name / nameAr of a `do` store and the DO's `store_profile` holds a COPY (Ruling NZ-D8:
 * one writer, `storeUpdateOnDo` writes D1 first, then the DO). A DO copy that failed leaves D1 ahead and fails the request
 * (the retry converges), but nothing detected a copy nobody retried. Push D1's value to the DO and report it.
 */
type MirrorRepair = (id: string, fields: Record<string, unknown>) => Promise<void>;
export function mirrorDrift(
  row: Pick<D1Row, 'name' | 'name_ar' | 'template' | 'look'>,
  rec: NonNullable<Awaited<ReturnType<DoRecord>>>
): Record<string, string | null> {
  const drift: Record<string, string | null> = {};
  if (rec.name !== undefined && rec.name !== row.name) drift.name = row.name;
  if (rec.nameAr !== undefined && (rec.nameAr ?? null) !== (row.name_ar ?? null))
    drift.nameAr = row.name_ar ?? null;
  if (rec.template !== undefined && (rec.template ?? null) !== (row.template ?? null))
    drift.template = row.template;
  if (rec.look !== undefined && (rec.look ?? null) !== (row.look ?? null))
    drift.look = row.look ?? null;
  return drift;
}

/** D1 vs each live `do` store's own DO (the only reconciliation possible without Postgres). */
async function reconcileDoSide(
  d1: D1Like,
  rows: D1Row[],
  report: ReconcileReport,
  doRecord: DoRecord,
  repair: MirrorRepair,
  /** In the Postgres tick the status of a `do` row is already reconciled against Postgres: the DO side only checks the mirror. */
  mirrorOnly = false
): Promise<void> {
  for (const row of rows) {
    if (row.backend !== 'do' || row.deleted) continue;
    if (!mirrorOnly) report.checked++;
    let rec: Awaited<ReturnType<DoRecord>>;
    try {
      rec = await doRecord(row.id);
    } catch (err) {
      report.alertOnly.push({
        id: row.id,
        why: `StoreDO could not be read: ${(err as Error).message}`,
      });
      continue;
    }
    if (!rec) {
      report.alertOnly.push({ id: row.id, why: 'do store has no StoreDO record' });
      continue;
    }
    let drift = mirrorDrift(row, rec);
    if (Object.keys(drift).length > 0) {
      try {
        // The D1 snapshot is from the start of the tick: a merchant edit since then must not be overwritten on the DO with
        // the older value (nor raise a false alert). Re-read the DO, then the ONE D1 row (the authority, read last), right before repairing and compare
        // again; a changed or already-converged store is skipped. Residual: an edit between this re-read and the push.
        const freshRec = await doRecord(row.id);
        const { results: fresh } = await d1
          .prepare(
            'SELECT name, name_ar, template, look FROM stores WHERE id = ? AND deleted_at IS NULL'
          )
          .bind(row.id)
          .all<Pick<D1Row, 'name' | 'name_ar' | 'template' | 'look'>>();
        drift = fresh?.[0] && freshRec ? mirrorDrift(fresh[0], freshRec) : {};
        if (Object.keys(drift).length > 0) {
          await repair(row.id, drift);
          report.corrected.push({
            id: row.id,
            why: `DO copy re-pushed from D1 (${Object.keys(drift).join(', ')})`,
          });
        }
      } catch (err) {
        report.alertOnly.push({
          id: row.id,
          why: `DO copy differs from D1 (${Object.keys(drift).join(', ')}) and could not be repaired: ${(err as Error).message}`,
        });
      }
    }
    if (mirrorOnly) continue;
    if (rec.slug !== row.slug) {
      report.alertOnly.push({ id: row.id, why: `slug differs (D1 ${row.slug}, DO ${rec.slug})` });
    }
    if (rec.status !== row.status) {
      if (restrictiveness(rec.status, false) > restrictiveness(row.status, false)) {
        await closeDoRow(d1, row.id, rec.status, row.status, false, false);
        report.corrected.push({ id: row.id, why: `D1 closed to match the DO (${rec.status})` });
      } else {
        report.keptRestrictive.push({
          id: row.id,
          why: `D1 ${row.status} is stricter than the DO ${rec.status}`,
        });
      }
    }
  }
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
    /** Test seam: one `do` store's StoreDO record (slug, status, mirror columns). */
    doRecord?: DoRecord;
    /** Test seam: push D1's mirror values to the store's DO (default: `copyStoreSettings`). */
    repairMirror?: MirrorRepair;
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
      (await storeDirectory(undefined, { includeDeleted: true, postgresOnly: true })).map(s => ({
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
  const pgLive = deps.pgLive ?? (async () => storeDirectory(undefined, { postgresOnly: true }));
  const d1Select = `SELECT id, slug, status, plan, lower(domain) AS domain, lower(pending_domain) AS pending_domain, (domain IS NOT NULL) AS has_domain, (pending_domain IS NOT NULL) AS has_pending_domain,
              (deleted_at IS NOT NULL) AS deleted, storage_backend AS backend, name, name_ar, template, look FROM stores`;
  let all: Awaited<ReturnType<typeof pgAll>>;
  let live: Awaited<ReturnType<typeof pgLive>>;
  try {
    // Ruling NZ-PG-8: no `pg` store in the D1 directory = there is no Postgres side to compare, and Postgres may be gone:
    // the cron must not open a connection for it.
    if (!deps.pgAll && !(await hasStoresOnBackend('pg'))) throw new NoPostgresStores();
    [all, live] = await Promise.all([pgAll(), pgLive()]);
  } catch (err) {
    // No Postgres: reconcile D1 against the StoreDOs and never throw (see the header).
    if (err instanceof NoPostgresStores)
      logger.info('[store-directory] no Postgres store: reconciling D1 against the StoreDOs only');
    else
      logger.warn(
        { err },
        '[store-directory] Postgres directory unavailable: reconciling D1 against the StoreDOs only'
      );
    report.postgresSkipped = true;
    const { results: d1Rows } = await d1.prepare(d1Select).bind().all<D1Row>();
    await reconcileDoSide(
      d1,
      d1Rows ?? [],
      report,
      deps.doRecord ?? readDoRecord,
      deps.repairMirror ?? copyStoreSettings
    );
    await finish(report, alert);
    return report;
  }
  const liveIds = new Set(live.map(s => s.id));
  const { results } = await d1.prepare(d1Select).bind().all<D1Row>();
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

  // Postgres is stale by design for a `do` store, so the mirror columns are checked against the DO, never against Postgres.
  await reconcileDoSide(
    d1,
    [...d1ById.values()].filter(r => r.backend === 'do'),
    report,
    deps.doRecord ?? readDoRecord,
    deps.repairMirror ?? copyStoreSettings,
    true
  );
  await finish(report, alert);
  return report;
}

async function finish(
  report: ReconcileReport,
  alert: (title: string, body: string) => Promise<unknown> | unknown
): Promise<void> {
  if (report.corrected.length || report.keptRestrictive.length || report.alertOnly.length) {
    logger.error(
      {
        corrected: report.corrected,
        keptRestrictive: report.keptRestrictive,
        alertOnly: report.alertOnly,
      },
      '[store-directory] D1 directory drift'
    );
    // an alert that cannot be sent is logged, never thrown: the tick must not fail on its own reporting
    await Promise.resolve(
      alert(
        report.postgresSkipped
          ? 'Store directory drift between D1 and the StoreDOs'
          : 'Store directory drift between Postgres and D1',
        `corrected ${report.corrected.length}, kept-restrictive ${report.keptRestrictive.length}, alert-only ${report.alertOnly.length}: ` +
          JSON.stringify(
            [...report.corrected, ...report.keptRestrictive, ...report.alertOnly].slice(0, 20)
          )
      )
    ).catch(err => logger.error({ err }, '[store-directory] drift alert could not be sent'));
  }
}
