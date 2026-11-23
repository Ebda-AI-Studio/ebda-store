/**
 * The real ports of the closed-store purge (Ruling NZ-D15B, lib/closed-store-purge.ts): the platform D1 directory, the StoreDO RPC
 * (closedFiscalPage / purgeClosedStore), the private bucket (write-once archive + per-store ledger) and the platform mailer.
 * Nothing here decides anything; the rules live in the tested core. This module is wired ONLY by the `closed-store-purge` job.
 */
import { createHash } from 'node:crypto';
import { prisma } from '@ebda/database';
import { d1All, d1Run } from '../services/platform/billing-d1';
import { StorageService } from '../services/storage.service';
import { sendClosedStorePurgeNoticeEmail } from '../services/platform-mailer';
import { sendAlert } from '../services/alerts.service';
import { STORE_SCOPED_TABLES } from '../cf/erasure/platform-subject';
import { storeDo } from './store-backend';
import { retireStoreDirectoryRow } from './store-directory-sync';
import logger from './logger';
import type { ArchiveManifest, ClosedStore, PurgeLedger, PurgePorts } from './closed-store-purge';

type Answer<T> = { ok: true; data: T } | { ok: false; code: string; status: number };
interface PurgeStub {
  closedFiscalPage(
    storeId: string,
    afterSerial: number,
    limit: number
  ): Promise<
    Answer<{ rows: Array<Record<string, unknown>>; count: number; lastIssuedAt: number | null }>
  >;
  purgeClosedStore(
    storeId: string,
    expect: { fiscalDocuments: number }
  ): Promise<Answer<{ wiped: true }>>;
}
const stub = (storeId: string) => storeDo(storeId) as unknown as PurgeStub;
const must = <T>(a: Answer<T>, what: string): T => {
  if (!a.ok) throw new Error(`${what}: ${a.code} (${a.status})`);
  return a.data;
};

const archiveKey = (storeId: string) => `closed-store-archive/${storeId}/fiscal.ndjson`;
const ledgerKey = (storeId: string) => `closed-store-purge/${storeId}/ledger.json`;
const PAGE = 200;

/** NDJSON of every fiscal record, in serial order, plus row count and sha256 of exactly those bytes. */
function summarise(bytes: Buffer): { rows: number; sha256: string } {
  const text = bytes.toString('utf8');
  return {
    rows: text === '' ? 0 : text.split('\n').filter(l => l !== '').length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function readObject(key: string): Promise<Buffer | null> {
  try {
    return (await StorageService.getPrivate(key)).body;
  } catch (err) {
    if (
      /NoSuchKey|NOT_FOUND|404/.test(
        `${(err as { name?: string }).name ?? ''} ${(err as Error).message}`
      )
    )
      return null;
    throw err;
  }
}

export function closedStorePurgePorts(): PurgePorts {
  return {
    async listClosed(): Promise<ClosedStore[]> {
      const rows = await d1All<{ id: string; deleted_at: number }>(
        `SELECT "id", "deleted_at" FROM "stores" WHERE "deleted_at" IS NOT NULL AND "storage_backend" = 'do' ORDER BY "deleted_at" LIMIT 500`
      );
      return rows.map(r => ({ storeId: r.id, closedAt: Number(r.deleted_at) }));
    },
    async fiscalSummary(storeId) {
      const d = must(await stub(storeId).closedFiscalPage(storeId, 0, 1), 'fiscal summary');
      return { count: d.count, lastIssuedAt: d.lastIssuedAt };
    },
    ledger: {
      async get(storeId): Promise<PurgeLedger> {
        const b = await readObject(ledgerKey(storeId));
        return b ? (JSON.parse(b.toString('utf8')) as PurgeLedger) : {};
      },
      async put(storeId, patch) {
        const current = await this.get(storeId);
        await StorageService.putPrivateAt(
          ledgerKey(storeId),
          Buffer.from(JSON.stringify({ ...current, ...patch })),
          'application/json'
        );
      },
    },
    async notifyOwner(s, purgeAt) {
      try {
        const row = (
          await d1All<{ owner_id: string; name: string }>(
            'SELECT "owner_id", "name" FROM "stores" WHERE "id" = ?1',
            s.storeId
          )
        )[0];
        const owner = row
          ? await prisma.user.findUnique({ where: { id: row.owner_id }, select: { email: true } })
          : null;
        const email = owner?.email;
        // an erased owner carries a placeholder address: there is no one to tell
        if (!email || /@anonymized\.(local|invalid)$/.test(email)) return 'no_contact';
        await sendClosedStorePurgeNoticeEmail({
          email,
          storeName: row!.name,
          purgeAt: new Date(purgeAt),
        });
        return 'sent';
      } catch (err) {
        logger.warn({ err, storeId: s.storeId }, '[closed-store-purge] owner notice failed');
        throw err; // not recorded as sent: the next run tries again
      }
    },
    async exportFiscal(storeId): Promise<ArchiveManifest> {
      const key = archiveKey(storeId);
      const existing = await readObject(key);
      if (existing) return { key, ...summarise(existing) }; // write-once: a verified archive is never replaced
      const lines: string[] = [];
      let after = 0;
      for (;;) {
        const page = must(
          await stub(storeId).closedFiscalPage(storeId, after, PAGE),
          'fiscal page'
        );
        if (!page.rows.length) break;
        for (const r of page.rows) lines.push(JSON.stringify(r));
        after = Number(page.rows[page.rows.length - 1]!.serial);
      }
      const bytes = Buffer.from(lines.length ? lines.join('\n') + '\n' : '', 'utf8');
      await StorageService.putPrivateAt(key, bytes, 'application/x-ndjson', { ifAbsent: true });
      return { key, ...summarise(bytes) };
    },
    async readBack(key) {
      const b = await readObject(key);
      return b ? summarise(b) : null;
    },
    async wipe(storeId, expect) {
      must(await stub(storeId).purgeClosedStore(storeId, expect), 'store wipe');
    },
    async deleteDirectory(storeId) {
      for (const t of STORE_SCOPED_TABLES)
        await d1Run(`DELETE FROM "${t}" WHERE "store_id" = ?1`, storeId);
      await retireStoreDirectoryRow(storeId, { soft: false });
    },
    alert: (title, body) => sendAlert({ level: 'p1', source: 'closed-store-purge', title, body }),
    log: (msg, fields) => logger.info(fields ?? {}, msg),
  };
}
