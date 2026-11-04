/**
 * NEON-ZERO-1 (N-10d): the ONE place an audit row is written, and where it goes.
 *
 *   store-scoped, store on its Durable Object  -> that StoreDO `audit_logs` (append-only `create`, row id fixed by us)
 *   store-less (failed login, super-admin act)  -> D1 `platform_audit_log` once the `audit` marker exists (cutover.ts)
 *   an IMPERSONATED store-scoped row            -> ALSO D1 `platform_audit_log` (the cross-store view a super-admin needs)
 *   everything else (Postgres store, no D1)     -> the Postgres definer, same transaction/savepoint as the caller, as before
 *
 * Contract (Ruling NZ-10D-1): a DO / D1 audit write NEVER throws into the caller and NEVER blocks it for long (3 s cap),
 * and a row is never lost silently: a failed or timed-out write is put on the jobs queue as `audit-write-retry` carrying
 * the WHOLE row (its id is fixed, every sink is idempotent on id, so a late original plus a retry is one row). If even the
 * enqueue fails the row is parked in R2 and a P1 pages (rows are never logged: they carry IP, user agent and details). The dead-letter handler parks the row in R2 and pages.
 * The Postgres leg keeps its old behaviour (throws; the caller's savepoint decides).
 * `details.impersonatedBy` (BE:S-2) travels inside `details` untouched on every leg.
 */
import { randomUUID } from 'node:crypto';
import { cfBindings } from '../cf/bindings';
import logger from '../lib/logger';
import { auditStoreLessOnD1 } from './platform/cutover';
import { sendAlert } from './alerts.service';

export interface AuditEntry {
  action: string;
  userId?: string | null;
  storeId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  details?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/** An entry with its identity fixed: what is queued and replayed. `createdAt` is epoch ms. */
export interface AuditRow extends AuditEntry {
  id: string;
  createdAt: number;
}

export interface AuditWriteRetryMessage {
  kind: 'audit-write-retry';
  row: AuditRow;
}

export const isAuditWriteRetry = (v: unknown): v is AuditWriteRetryMessage =>
  typeof v === 'object' &&
  v !== null &&
  (v as { kind?: unknown }).kind === 'audit-write-retry' &&
  typeof (v as { row?: { id?: unknown } }).row?.id === 'string' &&
  typeof (v as { row?: { action?: unknown } }).row?.action === 'string';

export const AUDIT_WRITE_TIMEOUT_MS = 3000;
type Target = 'pg' | 'do' | 'd1';

const detailsOf = (row: AuditRow): Record<string, unknown> => {
  const d = row.details;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
};
const isImpersonated = (row: AuditRow) => typeof detailsOf(row).impersonatedBy === 'string';

/** Where this row is written. Throws only when a home cannot be decided (the caller queues the row). */
export async function auditTargets(row: AuditRow): Promise<Target[]> {
  if (row.storeId) {
    const { storeWritesToDo } = await import('../lib/repo-factory.js');
    if (await storeWritesToDo(row.storeId)) return isImpersonated(row) ? ['do', 'd1'] : ['do'];
    return ['pg'];
  }
  return (await auditStoreLessOnD1()) ? ['d1'] : ['pg'];
}

async function writeDo(row: AuditRow): Promise<void> {
  const { storeWriter } = await import('../lib/repo-factory.js');
  const w = await storeWriter(row.storeId!);
  try {
    await (
      w as unknown as Record<string, { create(a: unknown): Promise<unknown> }>
    ).auditLog.create({
      data: {
        id: row.id,
        action: row.action,
        userId: row.userId ?? null,
        storeId: row.storeId ?? null,
        resourceType: row.resourceType,
        resourceId: row.resourceId ?? null,
        details: row.details ?? {},
        ipAddress: row.ip ?? null,
        userAgent: row.userAgent ?? null,
        createdAt: new Date(row.createdAt),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return; // the same row already landed (retry after a timeout)
    throw e;
  }
}

async function writeD1(row: AuditRow): Promise<void> {
  const { d1Run } = await import('./platform/billing-d1.js');
  await d1Run(
    `INSERT OR IGNORE INTO platform_audit_log (id, actor_id, action, target_type, target_id, store_id, meta, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    row.id,
    row.userId ?? null,
    row.action,
    row.resourceType,
    row.resourceId ?? null,
    row.storeId ?? null,
    JSON.stringify({
      details: row.details ?? {},
      ipAddress: row.ip ?? null,
      userAgent: row.userAgent ?? null,
    }),
    row.createdAt
  );
}

const withCap = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error('audit write timed out')), AUDIT_WRITE_TIMEOUT_MS)
    ),
  ]);

/** Deliver to the DO / D1 targets (throws on the first failure; every target is idempotent on `row.id`). */
export async function deliverAuditRow(row: AuditRow, targets: Target[]): Promise<void> {
  for (const t of targets) {
    if (t === 'do') await writeDo(row);
    else if (t === 'd1') await writeD1(row);
  }
}

/** Put a row that could not be written on the jobs queue; if that fails too, park it in R2 and page (the row itself is never logged). Never throws. */
export async function queueAuditRetry(row: AuditRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn(
    { err, auditId: row.id, action: row.action },
    '[audit] write failed; queued for retry'
  );
  try {
    const q = cfBindings()?.JOBS_QUEUE;
    if (!q) throw new Error('JOBS_QUEUE binding missing');
    await q.send({ kind: 'audit-write-retry', row } satisfies AuditWriteRetryMessage, {
      contentType: 'json',
    });
  } catch (e) {
    // LAST RESORT: the row carries IP, user agent and free-form details, so it is NEVER logged. Park it in R2; if that
    // fails too, page with the ids only (the row is lost, and the page says so).
    const parked = await putDeadLetter(row);
    logger.error(
      { err: e, auditId: row.id, action: row.action, storeId: row.storeId ?? null, parked },
      '[audit] write failed and could not be queued'
    );
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'audit.write_at_risk',
      title: 'Audit row could not be written or queued',
      body: `action ${row.action} store ${row.storeId ?? '-'} id ${row.id}: ${message}. ${
        parked
          ? `Parked at R2 audit-dead-letter/${row.id}.json: re-apply it.`
          : 'NOT parked: the row is LOST.'
      }`,
      context: { auditId: row.id, action: row.action, storeId: row.storeId ?? null, parked },
    }).catch(() => undefined);
  }
}

/**
 * Write one audit row. `pgInsert` is the Postgres definer call (injected: lib/definer.ts owns it and imports this module).
 */
export async function appendAudit(
  entry: AuditEntry,
  pgInsert: (row: AuditRow) => Promise<void>
): Promise<void> {
  const row: AuditRow = { ...entry, id: randomUUID(), createdAt: Date.now() };
  let targets: Target[];
  try {
    targets = await withCap(auditTargets(row));
  } catch (err) {
    await queueAuditRetry(row, err);
    return;
  }
  if (targets.length === 1 && targets[0] === 'pg') return pgInsert(row);
  try {
    await withCap(deliverAuditRow(row, targets));
  } catch (err) {
    await queueAuditRetry(row, err);
  }
}

/**
 * Queue handler for one retry. The home is decided AGAIN (a store may have moved since), and a row whose home is now
 * Postgres goes through `pgInsert`. Returns 'done' or 'retry'.
 */
export async function applyAuditRetry(
  m: AuditWriteRetryMessage,
  deps: { pgInsert: (row: AuditRow) => Promise<void> }
): Promise<'done' | 'retry'> {
  try {
    const targets = await auditTargets(m.row);
    if (targets.length === 1 && targets[0] === 'pg') await deps.pgInsert(m.row);
    else await deliverAuditRow(m.row, targets);
    return 'done';
  } catch (err) {
    logger.warn({ err, auditId: m.row.id }, '[audit] retry failed; will redeliver');
    return 'retry';
  }
}

interface R2PutLike {
  put(key: string, value: string): Promise<unknown>;
}

/** Park the row in the private bucket. Returns whether it is there. Never throws, never logs the row. */
async function putDeadLetter(row: AuditRow): Promise<boolean> {
  try {
    const r2 = cfBindings()?.STORE_BACKUPS as R2PutLike | undefined;
    if (!r2?.put) return false;
    await r2.put(`audit-dead-letter/${row.id}.json`, JSON.stringify(row));
    return true;
  } catch (e) {
    logger.error({ err: e, auditId: row.id }, '[audit] dead-letter park failed');
    return false;
  }
}

/** Dead letter: park the row in R2 (private bucket) and page. Ids only in the log and the page. Never throws. */
export async function parkDeadAuditRow(row: AuditRow): Promise<void> {
  const parked = await putDeadLetter(row);
  logger.error(
    { auditId: row.id, action: row.action, storeId: row.storeId ?? null, parked },
    '[audit] retry exhausted'
  );
  await sendAlert({
    level: 'p1',
    scope: 'platform',
    source: 'audit.retry_exhausted',
    title: 'Audit row could not be written after every retry',
    body: `action ${row.action} store ${row.storeId ?? '-'} id ${row.id}. ${
      parked
        ? `Parked at R2 audit-dead-letter/${row.id}.json: re-apply it.`
        : 'NOT parked: the row is LOST.'
    }`,
    context: { auditId: row.id, action: row.action, storeId: row.storeId ?? null, parked },
  }).catch(() => undefined);
}
