import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';

const stub = (id: string) => env.STORE_DO.get(env.STORE_DO.idFromName(id));
const now = Date.now();
const seedRows = (sid: string) => ({
  store: { id: sid, slug: sid, name: sid, currency: 'EGP', createdAt: now, updatedAt: now },
  products: Array.from({ length: 5 }, (_, i) => ({
    id: `${sid}-p${i}`,
    storeId: sid,
    name: `P${i}`,
    nameAr: `م${i}`,
    slug: `p${i}`,
    price: 1000 + i,
    compareAtPrice: null,
    inventory: 10,
    status: 'active' as const,
    hasVariants: false,
    createdAt: now + i,
    updatedAt: now,
  })),
});
const day = new Date().toISOString().slice(0, 10);

async function populate(sid: string) {
  const s = stub(sid);
  await s.seed(seedRows(sid));
  await s.addCartItem(sid, 'sess', `${sid}-p1`, 2);
  await s.createOrder(sid, 'sess');
  return s;
}

describe('nightly backup alarm', () => {
  it('writes NDJSON + manifest to R2 and re-arms the alarm for +24h', async () => {
    const sid = 'bk-1';
    const s = await populate(sid);
    await s.ensureBackupAlarm();
    expect(await runDurableObjectAlarm(s)).toBe(true);
    const keys = (
      await env.STORE_BACKUPS.list({ prefix: `store-do-backups/${sid}/${day}/` })
    ).objects.map(o => o.key);
    expect(keys).toContain(`store-do-backups/${sid}/${day}/manifest.json`);
    for (const t of [
      'stores',
      'products',
      'product_variants',
      'carts',
      'cart_items',
      'orders',
      'order_items',
    ])
      expect(keys).toContain(`store-do-backups/${sid}/${day}/${t}.ndjson`);
    const manifest = JSON.parse(
      await (await env.STORE_BACKUPS.get(`store-do-backups/${sid}/${day}/manifest.json`))!.text()
    );
    expect(manifest.tables.products.rows).toBe(5);
    expect(manifest.tables.orders.rows).toBe(1);
    expect(manifest.tables.products.sha256).toMatch(/^[0-9a-f]{64}$/);
    // re-armed: an alarm is pending ~24h out
    const next = await runInDurableObject(s, async (_i, state) => state.storage.getAlarm());
    expect(next! - Date.now()).toBeGreaterThan(23 * 3600_000);
  });
});

describe('restore drill', () => {
  it('restores into a fresh DO with equal row counts and checksums for every table', async () => {
    const sid = 'bk-2';
    const s = await populate(sid);
    const manifest = await s.backupNow(sid);
    const target = stub('bk-2-restore');
    const r = await target.restoreFrom(sid, day);
    if (!r.ok) throw new Error(r.code);
    const res = r.data;
    for (const [t, m] of Object.entries(manifest.tables)) {
      expect(res[t], t).toMatchObject({ ok: true, rows: m.rows, sha256: m.sha256 });
    }
    expect(await target.rowCounts()).toEqual(await s.rowCounts());
    expect(await target.stock(`${sid}-p1`)).toBe(8); // the order's decrement survived
  });

  it('refuses a corrupted file (checksum differs from the manifest)', async () => {
    const sid = 'bk-3';
    const s = await populate(sid);
    await s.backupNow(sid);
    const key = `store-do-backups/${sid}/${day}/products.ndjson`;
    const body = await (await env.STORE_BACKUPS.get(key))!.text();
    await env.STORE_BACKUPS.put(key, body.replace('"P1"', '"HACKED"'));
    expect(await stub('bk-3-restore').restoreFrom(sid, day)).toMatchObject({
      ok: false,
      code: expect.stringMatching(/checksum/),
    });
  });

  it('refuses a day with no manifest (incomplete backup) and a non-empty target', async () => {
    expect(await stub('bk-4-restore').restoreFrom('nope', day)).toMatchObject({
      ok: false,
      code: expect.stringMatching(/no manifest/),
    });
    const sid = 'bk-5';
    const s = await populate(sid);
    await s.backupNow(sid);
    expect(await s.restoreFrom(sid, day)).toMatchObject({
      ok: false,
      code: expect.stringMatching(/empty/),
    });
  });
});
