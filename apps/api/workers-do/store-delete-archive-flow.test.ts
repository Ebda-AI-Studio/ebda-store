import { beforeAll, describe, expect, it } from 'vitest';
import { env, applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import { decodeRpc, encodeRpc } from '@ebda-src/repo';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { setCfBindings, type CfBindings } from '../src/cf/bindings';
import { StoreService } from '../src/services/store.service';
import {
  loadArchive,
  listArchivedStores,
  type R2ArchiveBucket,
} from '../src/lib/fiscal-archive-store';
import { renderFiscalDocumentHtml } from '../src/services/fiscal-document-render';

// Ruling FISCAL-ARCHIVE-1, REAL FLOW: StoreService.delete over a real StoreDO + D1 + R2 on workerd.
const e = env as unknown as {
  PLATFORM_DB: D1Database;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  STORE_DO: DurableObjectNamespace<StoreDO>;
  STORE_BACKUPS: R2Bucket;
};
const stubFor = (name: string) => e.STORE_DO.get(e.STORE_DO.idFromName(name));
type Stub = ReturnType<typeof stubFor>;
type Answer = { ok: true; json: string } | { ok: false; code: string; status: number };
const op = async (stub: Stub, store: string, name: string, args: object) =>
  (await stub.moneyOp(store, name, encodeRpc(args))) as Answer;
const val = (a: Answer) => {
  if (!a.ok) throw new Error(`refused ${a.code}`);
  return decodeRpc<any>(a.json);
};
const bindings = (failPut: boolean): CfBindings =>
  new Proxy(e as unknown as CfBindings, {
    get: (t, k) =>
      k === 'STORE_BACKUPS' && failPut
        ? {
            ...e.STORE_BACKUPS,
            put: async () => {
              throw new Error('r2 put refused');
            },
            get: (key: string) => e.STORE_BACKUPS.get(key),
            list: (o: unknown) => e.STORE_BACKUPS.list(o as never),
          }
        : (t as any)[k],
  });

async function liveStore(id: string) {
  await e.PLATFORM_DB.prepare(
    "INSERT INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?1, 'Shop', ?1, 'owner-del', 'do')"
  )
    .bind(id)
    .run();
  const stub = stubFor(id);
  await op(stub, id, 'cancel', { orderId: 'nope' });
  await runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(
      `INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES (?, 'Shop', ?, 'owner-del')`,
      id,
      id
    );
    s.storage.sql.exec(
      `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', ?, 'Widget', 'widget', 1000, 50, 'active')`,
      id
    );
    s.storage.sql.exec(
      `INSERT INTO eta_receipts (id, store_id, order_id, kind, status, environment, document, error_message) VALUES ('eta1', ?, 'o', 'sale', 'accepted', 'prod', '{"signed":"payload"}', 'echoes buyer')`,
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
  return stub;
}
const directory = (id: string) =>
  e.PLATFORM_DB.prepare('SELECT deleted_at FROM stores WHERE id = ?1')
    .bind(id)
    .first<{ deleted_at: number | null }>();

beforeAll(async () => {
  setCfBindings(bindings(false));
  await applyD1Migrations(e.PLATFORM_DB, e.TEST_PLATFORM_MIGRATIONS as never);
  // production shape: platform families moved to D1, store creation on DO (a DO store has no Postgres row)
  process.env.STORE_CREATE_ON_DO = '1';
  for (const f of ['billing', 'access', 'platform'])
    await e.PLATFORM_DB.prepare(
      'INSERT INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"at":1}\')'
    )
      .bind(`m-${f}`, `platform_cutover.${f}`)
      .run();
});

describe('StoreService.delete of a DO store archives its fiscal records first', () => {
  it('archive write fails -> 503 FISCAL_ARCHIVE_FAILED, store reopened and accepting writes, directory row NOT retired', async () => {
    const id = 'del-fail-1';
    const stub = await liveStore(id);
    setCfBindings(bindings(true));
    await expect(StoreService.delete(id)).rejects.toMatchObject({ code: 'FISCAL_ARCHIVE_FAILED' });
    setCfBindings(bindings(false));
    expect((await directory(id))!.deleted_at).toBeNull();
    expect(await e.STORE_BACKUPS.get(`fiscal-archive/v1/manifests/${id}.json`)).toBeNull();
    // reopened: a new sale is accepted (a closed store answers 410 STORE_CLOSED)
    const again = await op(stub, id, 'createOrder', {
      lines: [{ productId: 'p1', quantity: 1 }],
      shippingAddress: { name: 'Sara', phone: '01000000009' },
    });
    expect(again.ok).toBe(true);
  });

  it('success -> manifest counts equal the DO rows, the signed ETA document is kept, directory retired, and the tax archive lists + renders the deleted store', async () => {
    const id = 'del-ok-1';
    const stub = await liveStore(id);
    await StoreService.delete(id);
    expect((await directory(id))!.deleted_at).not.toBeNull();

    const n = (q: string) =>
      runInDurableObject(stub, (_i, s) => Number((s.storage.sql.exec(q).toArray()[0] as any).n));
    const a = (await loadArchive(e.STORE_BACKUPS as unknown as R2ArchiveBucket, id))!;
    expect(a.manifest.counts.documents).toBe(await n('SELECT count(*) AS n FROM fiscal_documents'));
    expect(a.manifest.counts.eta).toBe(await n('SELECT count(*) AS n FROM eta_receipts'));
    expect(a.documents.length).toBe(3);
    expect(a.eta[0]).toMatchObject({ id: 'eta1', document: '{"signed":"payload"}' });
    expect(a.eta[0]).not.toHaveProperty('error_message');

    const listed = await listArchivedStores(e.STORE_BACKUPS as unknown as R2ArchiveBucket);
    expect(listed.stores.find(s => s.storeId === id)).toMatchObject({
      documentCount: 3,
      storeExists: false,
    });
    const html = renderFiscalDocumentHtml(a.documents[0]!, 'en');
    expect(html).toContain(a.documents[0]!.number!);
    // delete is idempotent
    await StoreService.delete(id).catch(() => undefined);
    expect(
      (await loadArchive(e.STORE_BACKUPS as unknown as R2ArchiveBucket, id))!.manifest.sha256
    ).toBe(a.manifest.sha256);
  });
});
