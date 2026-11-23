/**
 * The real ports of the closed-store purge (Ruling NZ-D15B, lib/closed-store-purge.ts): the platform D1 directory, the StoreDO RPC
 * (closedFiscalPage / purgeClosedStore), the private bucket (write-once archive + per-store ledger) and the platform mailer.
 * Nothing here decides anything; the rules live in the tested core. This module is wired ONLY by the `closed-store-purge` job.
 */
import { createHash } from 'node:crypto';
import { d1All, d1Run } from '../services/platform/billing-d1';
import { StorageService } from '../services/storage.service';
import { sendClosedStorePurgeNoticeEmail } from '../services/platform-mailer';
import { sendAlert } from '../services/alerts.service';
import { PLATFORM_RECORDS_LAST_AT_SQL, tombstoneStatements } from './store-tombstone';
import { storeDo } from './store-backend';
import { getAccountsBrief } from './identity-client';
import logger from './logger';
import {
  ledgerForClosure,
  type ArchiveManifest,
  type ClosedStore,
  type PurgeLedger,
  type PurgePorts,
} from './closed-store-purge';

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

// One archive and one ledger PER CLOSURE (closedAt in the name): a store id that is re-created and closed again never reuses, or
// is judged by, an earlier closure's archive or ledger.
const archiveKey = (s: ClosedStore) =>
  `closed-store-archive/${s.storeId}/fiscal-${s.closedAt}.ndjson`;
const ledgerKey = (s: ClosedStore) => `closed-store-purge/${s.storeId}/ledger-${s.closedAt}.json`;
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
        `SELECT "id", "deleted_at" FROM "stores" WHERE "deleted_at" IS NOT NULL AND "storage_backend" = 'do' AND "slug" NOT LIKE 'purged-%' ORDER BY "deleted_at" LIMIT 500`
      );
      return rows.map(r => ({ storeId: r.id, closedAt: Number(r.deleted_at) }));
    },
    async fiscalSummary(storeId) {
      const d = must(await stub(storeId).closedFiscalPage(storeId, 0, 1), 'fiscal summary');
      return { count: d.count, lastIssuedAt: d.lastIssuedAt };
    },
    async platformRecordsLastAt(storeId) {
      const r = (await d1All<{ last: number | null }>(PLATFORM_RECORDS_LAST_AT_SQL, storeId))[0];
      return r?.last == null ? null : Number(r.last);
    },
    ledger: {
      async get(s): Promise<PurgeLedger> {
        const b = await readObject(ledgerKey(s));
        if (!b) return {};
        // a ledger of another closure is ignored (the key already carries closedAt; this is the second lock)
        return ledgerForClosure(JSON.parse(b.toString('utf8')) as PurgeLedger, s);
      },
      async put(s, patch) {
        const current = await this.get(s);
        await StorageService.putPrivateAt(
          ledgerKey(s),
          Buffer.from(JSON.stringify({ ...current, ...patch, closedAt: s.closedAt })),
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
        // the identity service answers for a live owner; an erased or unknown owner is simply absent from the result
        const email = row ? (await getAccountsBrief([row.owner_id]))[0]?.email : undefined;
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
    async exportFiscal(s): Promise<ArchiveManifest> {
      const storeId = s.storeId;
      const key = archiveKey(s);
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
      // TOMBSTONE, never DELETE: billing_events, instapay_receipts, manual_payment_claims ... reference stores(id) ON DELETE CASCADE
      for (const st of tombstoneStatements(storeId)) await d1Run(st.sql, ...st.params);
    },
    alert: (title, body) => sendAlert({ level: 'p1', source: 'closed-store-purge', title, body }),
    log: (msg, fields) => logger.info(fields ?? {}, msg),
  };
}
