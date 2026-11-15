import { beforeAll, describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';
import type { MerchantSubject } from '../src/cf/erasure';
import {
  exportFiscalToArchive,
  FiscalArchiveError,
  listArchivedStores,
  loadArchive,
  manifestKey,
  pageArchivedDocuments,
  type FiscalExportSource,
  type R2ArchiveBucket,
} from '../src/lib/fiscal-archive-store';
import { ensurePlatformIndex } from './platform-index';

// Ruling FISCAL-ARCHIVE-1: a DO store's fiscal records are exported to the platform archive (R2) before its directory row is retired,
// and the super-admin reads them from there after the store is gone. Real StoreDO + R2 on workerd.
const e = env as unknown as { STORE_DO: DurableObjectNamespace<StoreDO>; STORE_BACKUPS: R2Bucket };
const r2 = e.STORE_BACKUPS as unknown as R2ArchiveBucket;
beforeAll(ensurePlatformIndex);
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Stub = ReturnType<typeof stubFor>;
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: Stub, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const val = (a: Answer) => {
  if (!a.ok) throw new Error(`refused ${a.code}`);
  return decodeRpc<any>(a.json);
};

async function closedStore(id: string) {
  const stub = stubFor(id);
  await op(stub, id, 'cancel', { orderId: 'nope' });
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner')`,
      id,
      id
    );
    s.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', ?, 'Widget', 'widget', 1000, 50, 'active')`,
      id
    );
  });
  const orders: string[] = [];
  for (let i = 0; i < 3; i++)
    orders.push(
      val(
        await op(stub, id, 'createOrder', {
          lines: [{ productId: 'p1', quantity: 1 }],
          shippingAddress: { name: 'Mona Adel', phone: `0100000000${i + 1}` },
        })
      ).orderId
    );
  await runInDurableObject(stub, (_i, s) => {
    for (const o of orders)
      s.storage.sql.exec(
        `UPDATE orders SET status = 'delivered', payment_status = 'paid' WHERE id = ?`,
        o
      );
  });
  await stub.closeIfNoMoneyInFlight(id);
  return stub;
}

const source = (
  id: string,
  stub: Stub,
  over: Partial<FiscalExportSource> = {}
): FiscalExportSource => ({
  async page(section, after, limit) {
    const r = await stub.fiscalExportPage(id, section, after, limit);
    if (!r.ok) throw new Error(r.code);
    return r.data;
  },
  billing: async () => [],
  storeName: async () => 'Shop',
  ...over,
});

describe('fiscal archive of a deleted DO store', () => {
  it('exports documents + numbering with a checksum manifest, readable with NO store DO involved', async () => {
    const id = 'fa-export-1';
    const stub = await closedStore(id);
    const { manifest, written } = await exportFiscalToArchive(id, source(id, stub), r2);
    expect(written).toBe(true);
    expect(manifest.counts.documents).toBe(3);
    expect(manifest.counts.counters).toBeGreaterThan(0);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    // retention: every document keeps >= 5y; manifest records the latest
    expect(manifest.retainUntilMax!).toBeGreaterThan(Date.now() + 5 * 365 * 86_400_000);

    // the super-admin reads it from the archive alone (the DO is not touched here)
    const a = (await loadArchive(r2, id))!;
    expect(a.documents).toHaveLength(3);
    expect(a.documents.every(d => d.number && /^(RCT|INV)-\d{6}$/.test(d.number))).toBe(true);
    const listed = await listArchivedStores(r2);
    expect(listed.stores.find(s => s.storeId === id)).toMatchObject({
      documentCount: 3,
      storeExists: false,
    });
    // PII: the receipts name no buyer; ETA rows keep the signed document but never the ETA error text
    expect(JSON.stringify(a.documents.map(d => d.payload))).not.toMatch(/Mona|01000000001/);
    for (const x of a.eta) {
      expect(x).toHaveProperty('document');
      expect(x).not.toHaveProperty('error_message');
    }
  });

  it('keyset pagination + filters over the archived documents', async () => {
    const id = 'fa-export-2';
    const stub = await closedStore(id);
    await exportFiscalToArchive(id, source(id, stub), r2);
    const a = (await loadArchive(r2, id))!;
    const p1 = pageArchivedDocuments(a.documents, { limit: 2 });
    expect(p1.documents).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = pageArchivedDocuments(a.documents, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.documents).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.documents, ...p2.documents].map(d => d.id)).size).toBe(3);
    const one = a.documents[0]!;
    expect(
      pageArchivedDocuments(a.documents, { q: one.number! }).documents.map(d => d.id)
    ).toContain(one.id);
    expect(pageArchivedDocuments(a.documents, { docType: 'credit_note' }).documents).toHaveLength(
      0
    );
  });

  it('is idempotent: a retry writes nothing new and returns the same manifest', async () => {
    const id = 'fa-export-3';
    const stub = await closedStore(id);
    const first = await exportFiscalToArchive(id, source(id, stub), r2);
    const again = await exportFiscalToArchive(id, source(id, stub), r2);
    expect(again.written).toBe(false);
    expect(again.manifest.sha256).toBe(first.manifest.sha256);
  });

  it('an export failure throws (the deletion fails closed) and leaves NO manifest', async () => {
    const id = 'fa-export-fail';
    const stub = await closedStore(id);
    await expect(
      exportFiscalToArchive(
        id,
        source(id, stub, {
          page: async () => {
            throw new Error('do down');
          },
        }),
        r2
      )
    ).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    expect(await r2.get(manifestKey(id))).toBeNull();
    await expect(exportFiscalToArchive(id, source(id, stub), undefined)).rejects.toBeInstanceOf(
      FiscalArchiveError
    );
  });

  it('refuses to overwrite a longer archive with a shorter export', async () => {
    const id = 'fa-export-shrink';
    const stub = await closedStore(id);
    await exportFiscalToArchive(id, source(id, stub), r2);
    const full = source(id, stub);
    await expect(
      exportFiscalToArchive(
        id,
        {
          ...full,
          page: async (s, a, l) => {
            const r = await full.page(s, a, l);
            return s === 'documents' ? { rows: r.rows.slice(0, 1), next: null } : r;
          },
        },
        r2
      )
    ).rejects.toMatchObject({ code: 'WOULD_SHRINK' });
    expect((await loadArchive(r2, id))!.documents).toHaveLength(3);
  });

  it('a tampered data object is detected on read (checksum), never rendered', async () => {
    const id = 'fa-export-tamper';
    const stub = await closedStore(id);
    await exportFiscalToArchive(id, source(id, stub), r2);
    await e.STORE_BACKUPS.put(`fiscal-archive/v1/data/${id}.ndjson.gz`, new Uint8Array([1, 2, 3]));
    await expect(loadArchive(r2, id)).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
  });

  it('PDPL merchant erasure of the closed DO leaves the archive intact (it is retained-fiscal, not erasable)', async () => {
    const id = 'fa-export-erase';
    const stub = await closedStore(id);
    const { manifest } = await exportFiscalToArchive(id, source(id, stub), r2);
    const m: MerchantSubject = {
      kind: 'merchant',
      requestId: 'r',
      storeId: id,
      ownerUserId: 'owner',
    };
    await stub.eraseSubject(m);
    const a = (await loadArchive(r2, id))!;
    expect(a.manifest.sha256).toBe(manifest.sha256);
    expect(a.documents).toHaveLength(3);
  });
});
