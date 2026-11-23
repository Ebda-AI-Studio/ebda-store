/**
 * Closed-store purge (Ruling NZ-D15B, plan N-24): the ONE place a closed Durable Object store is ever physically wiped.
 * Orchestration only; every effect is a port, so the rules below are tested without a Worker, an R2 bucket or a Durable Object.
 *
 * Eligibility (clock = RETENTION_YEARS, config/retention.ts): a closed store is due 7 years after its LAST fiscal document,
 * or 90 days after closure when it never issued one (no tax record to keep).
 * Per due store, in order, and any failure stops THAT store only:
 *   1. NOTICE: the owner is told, at least NOTICE_DAYS before the wipe (a store that has no contact is recorded as such and still
 *      waits the same days). A store is never wiped without a recorded notice that is NOTICE_DAYS old.
 *   2. EXPORT every fiscal record to the private archive (write-once: an existing archive is reused, never overwritten).
 *   3. VERIFY by reading the archive back: row count and sha256 must equal the manifest. Any mismatch aborts, alerts P1, deletes nothing.
 *   4. WIPE the Durable Object (it re-checks that it is closed and that its fiscal row count still equals the verified export),
 *      then hard-delete the directory row (frees the slug) and the store's platform rows.
 * DRY RUN is the default: the whole flow runs through step 3 (the export is real and idempotent) and logs `dry_run_verified`; nothing
 * is wiped. Live needs BOTH `CLOSED_STORE_PURGE_LIVE=true` and a date on or after PURGE_DRY_RUN_UNTIL (30 days after the ruling).
 */
import { RETENTION_YEARS } from '../config/retention';

const DAY_MS = 86_400_000;
export const PURGE_NO_FISCAL_DAYS = 90;
export const PURGE_NOTICE_DAYS = 30;
/** First 30 days after Ruling NZ-D15B (2026-11-24): dry run only, whatever the flag says. */
export const PURGE_DRY_RUN_UNTIL = Date.UTC(2026, 11, 24);

export interface ClosedStore {
  storeId: string;
  /** epoch ms the store was deleted/closed */
  closedAt: number;
}
export interface FiscalSummary {
  count: number;
  lastIssuedAt: number | null;
}
export interface ArchiveManifest {
  key: string;
  rows: number;
  sha256: string;
}
export interface PurgeLedger {
  noticeAt?: number;
  noticeOutcome?: 'sent' | 'no_contact';
  archive?: ArchiveManifest;
  wipedAt?: number;
}
export interface PurgePorts {
  listClosed(): Promise<ClosedStore[]>;
  fiscalSummary(storeId: string): Promise<FiscalSummary>;
  ledger: {
    get(storeId: string): Promise<PurgeLedger>;
    put(storeId: string, patch: Partial<PurgeLedger>): Promise<void>;
  };
  notifyOwner(s: ClosedStore, purgeAt: number): Promise<'sent' | 'no_contact'>;
  /** Write-once: when an archive exists for this store it is returned untouched. */
  exportFiscal(storeId: string): Promise<ArchiveManifest>;
  readBack(key: string): Promise<{ rows: number; sha256: string } | null>;
  wipe(storeId: string, expect: { fiscalDocuments: number }): Promise<void>;
  deleteDirectory(storeId: string): Promise<void>;
  alert(title: string, body: string): Promise<unknown> | unknown;
  log(msg: string, fields?: Record<string, unknown>): void;
}

export type PurgeOutcome =
  | 'not_due'
  | 'notice_sent'
  | 'waiting_notice'
  | 'dry_run_verified'
  | 'purged'
  | 'aborted';
export interface PurgeResult {
  storeId: string;
  outcome: PurgeOutcome;
  reason?: string;
}

const addYears = (t: number, years: number) => {
  const d = new Date(t);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
};

/** When a closed store becomes purgeable (epoch ms). */
export function purgeDueAt(s: ClosedStore, fiscal: FiscalSummary): number {
  return fiscal.lastIssuedAt != null
    ? addYears(fiscal.lastIssuedAt, RETENTION_YEARS)
    : s.closedAt + PURGE_NO_FISCAL_DAYS * DAY_MS;
}

/** Live only with the explicit flag AND after the dry-run period. */
export function purgeIsLive(env: { CLOSED_STORE_PURGE_LIVE?: string }, now: number): boolean {
  return env.CLOSED_STORE_PURGE_LIVE === 'true' && now >= PURGE_DRY_RUN_UNTIL;
}

export async function purgeOneClosedStore(
  p: PurgePorts,
  s: ClosedStore,
  now: number,
  live: boolean
): Promise<PurgeResult> {
  const abort = async (reason: string, alert = true): Promise<PurgeResult> => {
    p.log('[closed-store-purge] aborted', { storeId: s.storeId, reason });
    if (alert)
      await p.alert('Closed-store purge aborted, nothing deleted', `store ${s.storeId}: ${reason}`);
    return { storeId: s.storeId, outcome: 'aborted', reason };
  };
  try {
    const ledger = await p.ledger.get(s.storeId);
    // a wiped store whose directory delete failed last time: finish that step only (its DO can no longer be read)
    if (ledger.wipedAt) {
      await p.deleteDirectory(s.storeId);
      return { storeId: s.storeId, outcome: 'purged' };
    }
    const fiscal = await p.fiscalSummary(s.storeId);
    const dueAt = purgeDueAt(s, fiscal);
    if (now < dueAt - PURGE_NOTICE_DAYS * DAY_MS) return { storeId: s.storeId, outcome: 'not_due' };

    // 1. notice, at least NOTICE_DAYS before the wipe
    if (ledger.noticeAt === undefined) {
      const outcome = await p.notifyOwner(s, Math.max(dueAt, now + PURGE_NOTICE_DAYS * DAY_MS));
      await p.ledger.put(s.storeId, { noticeAt: now, noticeOutcome: outcome });
      return { storeId: s.storeId, outcome: 'notice_sent' };
    }
    if (now < dueAt || now < ledger.noticeAt + PURGE_NOTICE_DAYS * DAY_MS)
      return { storeId: s.storeId, outcome: 'waiting_notice' };

    // 2. export (write-once) and 3. read-back verification
    const manifest = ledger.archive ?? (await p.exportFiscal(s.storeId));
    if (!ledger.archive) await p.ledger.put(s.storeId, { archive: manifest });
    if (manifest.rows !== fiscal.count && fiscal.count > 0)
      return abort(`export has ${manifest.rows} rows, the store holds ${fiscal.count}`);
    const back = await p.readBack(manifest.key);
    if (!back) return abort(`archive ${manifest.key} cannot be read back`);
    if (back.rows !== manifest.rows || back.sha256 !== manifest.sha256)
      return abort(
        `archive read-back mismatch: rows ${back.rows}/${manifest.rows}, sha256 ${back.sha256 === manifest.sha256 ? 'equal' : 'DIFFERENT'}`
      );

    if (!live) {
      p.log('[closed-store-purge] DRY RUN: would wipe', {
        storeId: s.storeId,
        rows: manifest.rows,
        archive: manifest.key,
      });
      return { storeId: s.storeId, outcome: 'dry_run_verified' };
    }

    // 4. wipe, then the directory
    await p.wipe(s.storeId, { fiscalDocuments: fiscal.count });
    await p.ledger.put(s.storeId, { wipedAt: now });
    await p.deleteDirectory(s.storeId);
    p.log('[closed-store-purge] purged', { storeId: s.storeId, rows: manifest.rows });
    return { storeId: s.storeId, outcome: 'purged' };
  } catch (err) {
    return abort(`unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function runClosedStorePurge(
  p: PurgePorts,
  opts: { now: number; live: boolean }
): Promise<PurgeResult[]> {
  const results: PurgeResult[] = [];
  for (const s of await p.listClosed())
    results.push(await purgeOneClosedStore(p, s, opts.now, opts.live));
  return results;
}
