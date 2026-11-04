/**
 * NEON-ZERO-1 (N-10d): the Cloudflare half of the weekly audit retention (lib/inngest/functions/audit-log-archive.ts).
 * Rows older than the cutoff are exported to R2 (JSONL, same bucket and prefix as the Postgres archive) and then deleted:
 *   - D1 `platform_audit_log` (store-less rows and the impersonation mirror)
 *   - `audit_logs` of every store on its Durable Object
 * Export BEFORE delete, ascending by id, and the delete is `created_at < cutoff AND id <= <last exported id>`: every row it
 * removes was exported in this or an earlier page (the pages walk the same filtered set in id order), so a crash between the
 * two leaves rows exported twice (harmless), never deleted un-exported.
 */
import { doStoreIdList } from '../lib/store-backend';

export type PutArchive = (key: string, body: string) => Promise<void>;
const PAGE = 1000;

export async function archivePlatformAuditD1(
  cutoff: Date,
  put: PutArchive,
  stamp: string
): Promise<number> {
  const { d1All, d1Run } = await import('./platform/billing-d1.js');
  let after = '';
  let total = 0;
  for (let page = 0; ; page++) {
    const rows = await d1All<{ id: string }>(
      'SELECT * FROM platform_audit_log WHERE created_at < ?1 AND id > ?2 ORDER BY id LIMIT ?3',
      cutoff.getTime(),
      after,
      PAGE
    );
    if (rows.length === 0) break;
    await put(
      `audit-archive/${stamp}-d1-${String(page).padStart(5, '0')}.jsonl`,
      rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    );
    after = rows[rows.length - 1].id;
    await d1Run(
      'DELETE FROM platform_audit_log WHERE created_at < ?1 AND id <= ?2',
      cutoff.getTime(),
      after
    );
    total += rows.length;
    if (rows.length < PAGE) break;
  }
  return total;
}

export async function archiveStoreAuditDo(
  cutoff: Date,
  put: PutArchive,
  stamp: string
): Promise<{ stores: number; rows: number }> {
  const { storeDb, storeWriter } = await import('../lib/repo-factory.js');
  let rows = 0;
  let stores = 0;
  for (const storeId of await doStoreIdList()) {
    const db = await storeDb(storeId);
    let after = '';
    for (let page = 0; ; page++) {
      const found = await db.auditLog.findMany({
        where: { createdAt: { lt: cutoff }, id: { gt: after } },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      if (found.length === 0) break;
      await put(
        `audit-archive/${stamp}-store-${storeId}-${String(page).padStart(5, '0')}.jsonl`,
        found.map(r => JSON.stringify(r)).join('\n') + '\n'
      );
      after = found[found.length - 1].id;
      await (
        await storeWriter(storeId)
      ).auditLog.deleteMany({
        where: { createdAt: { lt: cutoff }, id: { lte: after } },
      });
      rows += found.length;
      if (found.length < PAGE) break;
    }
    stores++;
  }
  return { stores, rows };
}
