/**
 * Wiring of the platform fiscal archive (lib/fiscal-archive-store.ts, Ruling FISCAL-ARCHIVE-1) to the real StoreDO, D1 and R2.
 * `archiveDoStoreFiscal` is the FAIL-CLOSED step of a DO store's deletion: it throws when the export did not complete and verify,
 * after raising a P1 alert, so the caller refuses the deletion (and reopens the store) instead of retiring the directory row.
 * Read side: `archiveBucket()` for the super-admin routes. Also the admin-only backfill entry (`backfillOne`).
 */
import { cfBindings } from '../cf/bindings';
import { sendAlert } from '../services/alerts.service';
import { AppError } from '../middleware/error-handler';
import logger from './logger';
import { storeDo } from './store-backend';
import {
  billingRetainUntil,
  exportFiscalToArchive,
  FiscalArchiveError,
  readManifest,
  type ArchiveManifest,
  type FiscalExportSource,
  type R2ArchiveBucket,
} from './fiscal-archive-store';

interface D1Like {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}
type Row = Record<string, unknown>;

export const archiveBucket = (): R2ArchiveBucket | undefined =>
  cfBindings()?.STORE_BACKUPS as R2ArchiveBucket | undefined;

/** Ebda's own subscription VAT ledger row -> the archive's `billing` line (mirrors store-closure `archiveBillingEventsFromD1`). */
// pq-allow(unused-export): pure mapper pinned by tests/unit/fiscal-archive-do.test.ts
export function billingLine(b: Row): Row {
  const vat = (() => {
    try {
      return typeof b.vat === 'string' ? (JSON.parse(b.vat) as Row) : null;
    } catch {
      return null;
    }
  })();
  const rate = vat?.rateBps === undefined || vat.rateBps === '' ? null : Number(vat.rateBps);
  const created = Number(b.created_at);
  const amount = Number(b.amount_minor);
  const vatMinor = Number(b.vat_minor);
  return {
    id: b.id,
    issued_at: created,
    currency: b.currency,
    net_amount: Math.max(0, amount - vatMinor),
    vat_amount: Math.max(0, vatMinor),
    total_amount: Math.max(0, amount),
    vat_rate_bps: Number.isInteger(rate) ? rate : null,
    seller_trn: (vat?.trn as string | undefined) ?? null,
    retain_until: billingRetainUntil(created),
    payload: JSON.stringify({
      version: 1,
      reason: 'store_deleted',
      billingEventId: b.id,
      type: b.type,
      status: b.status,
      planCode: b.plan_code,
      billingInterval: b.billing_interval,
      forPeriodEnd: b.for_period_end,
      provider: b.provider,
      providerRef: b.provider_ref,
      relatedEventId: b.related_event_id,
      vat: vat,
    }),
  };
}

function realSource(storeId: string, d1: D1Like | undefined): FiscalExportSource {
  const stub = storeDo(storeId) as unknown as {
    fiscalExportPage(
      id: string,
      section: 'documents' | 'eta' | 'counters',
      after: string | null,
      limit: number
    ): Promise<
      | { ok: true; data: { rows: Row[]; next: string | null } }
      | { ok: false; code: string; status: number }
    >;
  };
  return {
    async page(section, after, limit) {
      const r = await stub.fiscalExportPage(storeId, section, after, limit);
      if (!r.ok) throw new FiscalArchiveError('EXPORT_FAILED', `${section}: ${r.code}`);
      return r.data;
    },
    async billing() {
      if (!d1) throw new FiscalArchiveError('EXPORT_FAILED', 'PLATFORM_DB binding missing');
      const { results } = await d1
        .prepare('SELECT * FROM billing_events WHERE store_id = ?1 ORDER BY created_at, id')
        .bind(storeId)
        .all<Row>();
      return results.map(billingLine);
    },
    async storeName() {
      const row = await d1
        ?.prepare('SELECT name FROM stores WHERE id = ?1')
        .bind(storeId)
        .first<{ name: string | null }>();
      return row?.name ?? null;
    },
  };
}

export async function archiveDoStoreFiscal(
  storeId: string,
  deps: {
    source?: FiscalExportSource;
    r2?: R2ArchiveBucket;
    alert?: (title: string, body: string) => Promise<unknown> | unknown;
  } = {}
): Promise<{ manifest: ArchiveManifest; written: boolean }> {
  const alert =
    deps.alert ??
    ((title: string, body: string) =>
      sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'store.delete.fiscal_archive',
        title,
        body,
      }));
  try {
    const src = deps.source ?? realSource(storeId, cfBindings()?.PLATFORM_DB as D1Like | undefined);
    const out = await exportFiscalToArchive(storeId, src, deps.r2 ?? archiveBucket());
    logger.info(
      { storeId, written: out.written, counts: out.manifest.counts },
      '[STORE_DELETE] fiscal archive exported'
    );
    return out;
  } catch (err) {
    const code = err instanceof FiscalArchiveError ? err.code : 'EXPORT_FAILED';
    logger.error(
      { storeId, code, err: (err as Error).message },
      '[STORE_DELETE] fiscal archive failed'
    );
    await Promise.resolve(
      alert(
        'Store deletion refused: fiscal archive export failed',
        `store ${storeId}: ${code}. The store was NOT deleted (its directory row stays, the Durable Object is reopened). Fix and retry the delete; it is idempotent.`
      )
    ).catch(() => undefined);
    throw new AppError(
      503,
      'FISCAL_ARCHIVE_FAILED',
      'The fiscal records could not be archived, so the store was not deleted. Retry.'
    );
  }
}

/**
 * BACKFILL (admin-only path; Ruling FISCAL-ARCHIVE-1): a DO store deleted BEFORE the archive existed keeps its closed DO and a
 * retired (soft-deleted) D1 directory row. `apply:false` only READS (counts, existing manifest). `apply:true` exports. Refuses a store
 * whose directory row is not a retired DO store, so a live store can never be "archived" by mistake.
 */
export async function backfillOne(
  storeId: string,
  apply: boolean
): Promise<{
  storeId: string;
  mode: 'dry-run' | 'applied';
  existing: ArchiveManifest | null;
  counts: { documents: number; eta: number; counters: number; billing: number };
  written?: boolean;
}> {
  const d1 = cfBindings()?.PLATFORM_DB as D1Like | undefined;
  const row = await d1
    ?.prepare('SELECT storage_backend, deleted_at FROM stores WHERE id = ?1')
    .bind(storeId)
    .first<{ storage_backend: string; deleted_at: number | null }>();
  if (!row || row.storage_backend !== 'do' || row.deleted_at === null)
    throw new AppError(
      409,
      'NOT_A_DELETED_DO_STORE',
      'Only a deleted Durable Object store can be backfilled'
    );
  const src = realSource(storeId, d1);
  if (apply) {
    const out = await archiveDoStoreFiscal(storeId, { source: src });
    return {
      storeId,
      mode: 'applied',
      existing: out.manifest,
      counts: out.manifest.counts,
      written: out.written,
    };
  }
  const count = async (s: 'documents' | 'eta' | 'counters') => {
    let n = 0;
    let after: string | null = null;
    do {
      const p = await src.page(s, after, 500);
      n += p.rows.length;
      after = p.next;
    } while (after);
    return n;
  };
  const [documents, eta, counters, billing] = await Promise.all([
    count('documents'),
    count('eta'),
    count('counters'),
    src.billing().then(b => b.length),
  ]);
  const r2 = archiveBucket();
  return {
    storeId,
    mode: 'dry-run',
    existing: r2 ? await readManifest(r2, storeId) : null,
    counts: { documents, eta, counters, billing },
  };
}
