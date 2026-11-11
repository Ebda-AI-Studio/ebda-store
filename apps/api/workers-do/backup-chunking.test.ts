// P2-4 (2026-11-12 data-jobs audit): backup + restore must not hold a whole database in memory. Paged by primary key into parts,
// written / restored part by part; legacy single-file backups still restore; the D1 export no longer throws above a row cap.
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { buildBackup, dumpTables, backupKey } from '../src/cf/store-do/backup';
import {
  backupD1,
  restoreD1FromBackup,
  d1BackupKey,
  type D1Like,
  type D1Writable,
} from '../src/cf/ops/backup-sweep';
import type { BackupManifest } from '../src/cf/store-do/backup';

const e = env as unknown as {
  STORE_BACKUPS: R2Bucket;
  PLATFORM_DB: D1Database;
  IDENTITY_DB: D1Database;
  RESTORE_DB: D1Database;
  STORE_DO: DurableObjectNamespace<StoreDO>;
};
const stub = (n: string) => e.STORE_DO.get(e.STORE_DO.idFromName(n));
const now = Date.now();

const seed = async (id: string, n: number) => {
  await stub(id).seed({
    store: { id, slug: id, name: id, currency: 'EGP', createdAt: now, updatedAt: now },
    products: Array.from({ length: n }, (_, i) => ({
      id: `${id}-p${String(i).padStart(4, '0')}`,
      storeId: id,
      name: `P${i}`,
      slug: `p${i}`,
      price: 100,
      inventory: 5,
      status: 'active',
      hasVariants: false,
      createdAt: now,
      updatedAt: now,
    })),
  });
  // a child row so the foreign key check has something to verify
  await runInDurableObject(stub(id), (_i, s) => {
    // restoreFrom (PR 641) leaves a do_flags 'gold_reprice' = 0 row behind; a source that carries it re-exports byte-equal.
    s.storage.sql.exec(`INSERT OR IGNORE INTO do_flags (name, value) VALUES ('gold_reprice', 0)`);
    return s.storage.sql.exec(
      `INSERT INTO product_variants (id, product_id, title, sku, price) VALUES ('v1', ?, 'V', 'S-1', 100)`,
      `${id}-p0000`
    );
  });
};

const fkOn = () =>
  runInDurableObject(
    stub('probe-fk'),
    (_i, s) => s.storage.sql.exec('PRAGMA foreign_keys').toArray()[0].foreign_keys
  );

describe('StoreDO paged backup (P2-4a)', () => {
  it('writes a large table as bounded parts, reads them back, and restores row for row', async () => {
    await seed('ck-src', 120);
    const m = (await runInDurableObject(stub('ck-src'), (d: StoreDO) =>
      d.backupNow('ck-src', { snapshotRows: 10, partRows: 25 })
    )) as BackupManifest;
    const prod = m.tables.products;
    expect(prod.parts!.length).toBe(5); // 120 rows / 25 per part
    expect(Math.max(...prod.parts!.map(p => p.rows))).toBeLessThanOrEqual(25);
    expect(prod.rows).toBe(120);
    expect(m.tables.product_variants.parts).toBeUndefined(); // one page: legacy single file
    const day = m.takenAt.slice(0, 10);
    expect(await e.STORE_BACKUPS.get(backupKey('ck-src', day, 'products.ndjson'))).toBeNull();

    const res = await stub('ck-dst').restoreFrom('ck-src', day);
    expect(JSON.stringify(res).slice(0, 300)).toContain('"ok":true');
    if (res.ok) expect(Object.entries(res.data).filter(([, t]) => !t.ok)).toEqual([]);
    const ids = (n: string) =>
      runInDurableObject(stub(n), (_i, s) =>
        s.storage.sql
          .exec('SELECT id FROM products ORDER BY id')
          .toArray()
          .map(r => r.id)
      );
    expect(await ids('ck-dst')).toEqual(await ids('ck-src'));
    expect(await fkOn()).toBe(1);
  });

  it('a corrupt part fails the restore AND leaves the target empty (compensating rollback)', async () => {
    await seed('ck2-src', 60);
    const m = (await runInDurableObject(stub('ck2-src'), (d: StoreDO) =>
      d.backupNow('ck2-src', { snapshotRows: 10, partRows: 20 })
    )) as BackupManifest;
    const day = m.takenAt.slice(0, 10);
    await e.STORE_BACKUPS.put(
      backupKey('ck2-src', day, m.tables.products.parts![2].file),
      '["id"]\n'
    );
    const res = await stub('ck2-dst').restoreFrom('ck2-src', day);
    expect(res.ok).toBe(false);
    const left = await runInDurableObject(stub('ck2-dst'), (_i, s) => ({
      p: s.storage.sql.exec('SELECT count(*) AS n FROM products').toArray()[0].n,
      f: s.storage.sql.exec('PRAGMA foreign_keys').toArray()[0].foreign_keys,
    }));
    expect(left).toEqual({ p: 0, f: 1 });
  });

  it('a paged restore that FAILS its foreign key check empties every table, customer logins included, and a retry succeeds', async () => {
    const S = 'ck4-src';
    await seed(S, 60);
    await runInDurableObject(stub(S), (_i, s) => {
      s.storage.sql.exec(
        `INSERT INTO _cauth_users (id, email, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'a@x.com', 'h', 'A', 'B', 1, 1)`
      );
    });
    await runInDurableObject(stub(S), (_i, s) => s.storage.sync());
    await runInDurableObject(stub(S), (_i, s) => {
      // a variant whose product does not exist: written with foreign keys off, as a torn backup would carry it
      s.storage.sql.exec('PRAGMA foreign_keys = OFF');
      s.storage.sql.exec(
        `INSERT INTO product_variants (id, product_id, title, sku, price) VALUES ('orphan', 'no-such-product', 'V', 'S-2', 1)`
      );
    });
    await runInDurableObject(stub(S), (_i, s) => s.storage.sync());
    await runInDurableObject(stub(S), (_i, s) => s.storage.sql.exec('PRAGMA foreign_keys = ON'));
    const opts = { snapshotRows: 10, partRows: 20 };
    await runInDurableObject(stub(S), (d: StoreDO) => d.backupNow(S, opts));
    const day = new Date().toISOString().slice(0, 10);

    const bad = await stub('ck4-dst').restoreFrom(S, day);
    expect(JSON.stringify(bad)).toMatch(/dangling foreign key/);
    const counts = () =>
      runInDurableObject(stub('ck4-dst'), (_i, s) => ({
        users: s.storage.sql.exec('SELECT count(*) AS n FROM _cauth_users').toArray()[0].n,
        products: s.storage.sql.exec('SELECT count(*) AS n FROM products').toArray()[0].n,
        fk: s.storage.sql.exec('PRAGMA foreign_keys').toArray()[0].foreign_keys,
      }));
    expect(await counts()).toEqual({ users: 0, products: 0, fk: 1 });

    // fix the source, back it up again (same day: overwrites), and the SAME target restores
    await runInDurableObject(stub(S), (_i, s) =>
      s.storage.sql.exec(`DELETE FROM product_variants WHERE id = 'orphan'`)
    );
    await runInDurableObject(stub(S), (d: StoreDO) => d.backupNow(S, opts));
    const good = await stub('ck4-dst').restoreFrom(S, day);
    expect(JSON.stringify(good)).toContain('"ok":true');
    expect(await counts()).toEqual({ users: 1, products: 60, fk: 1 });
  });

  it('a legacy single-file backup (written before parts existed) still restores', async () => {
    await seed('ck3-src', 8);
    const { manifest, files } = await runInDurableObject(stub('ck3-src'), async (_i, s) =>
      buildBackup('ck3-src', dumpTables(s.storage.sql as never))
    );
    const day = manifest.takenAt.slice(0, 10);
    for (const [n, b] of Object.entries(files))
      await e.STORE_BACKUPS.put(backupKey('ck3-src', day, n), b);
    await e.STORE_BACKUPS.put(backupKey('ck3-src', day, 'manifest.json'), JSON.stringify(manifest));
    expect(manifest.tables.products.parts).toBeUndefined();
    const res = await stub('ck3-dst').restoreFrom('ck3-src', day);
    expect(JSON.stringify(res).slice(0, 300)).toContain('"ok":true');
    if (res.ok) expect(Object.entries(res.data).filter(([, t]) => !t.ok)).toEqual([]);
  });
});

describe('D1 paged export (P2-4b)', () => {
  it('pages a table past the page size into parts, no throw, and restores from them', async () => {
    await e.IDENTITY_DB.exec(
      'CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE small (a TEXT, b TEXT)'
    );
    await e.IDENTITY_DB.exec(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 250) INSERT INTO big SELECT x, 'v' || x FROM c; INSERT INTO small VALUES ('a','b')"
    );
    const m = await backupD1(
      'IDENTITY_DB',
      e.IDENTITY_DB as unknown as D1Like,
      e.STORE_BACKUPS as never,
      new Date('2026-11-06T03:00:00Z'),
      100
    );
    expect(m.tables.big.rows).toBe(250);
    expect(m.tables.big.parts!.map(p => p.rows)).toEqual([100, 100, 50]);
    expect(m.tables.small.parts).toBeUndefined();
    const res = await restoreD1FromBackup(
      'IDENTITY_DB',
      '2026-11-06',
      e.STORE_BACKUPS as never,
      e.RESTORE_DB as unknown as D1Writable
    );
    expect(res).toEqual({ big: { rows: 250, ok: true }, small: { rows: 1, ok: true } });
  });

  it('exports a table above the old 100,000-row cap instead of throwing', async () => {
    await e.PLATFORM_DB.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, v TEXT)');
    await e.PLATFORM_DB.exec(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 100001) INSERT INTO audit_log SELECT x, 'v' FROM c"
    );
    const m = await backupD1(
      'PLATFORM_DB',
      e.PLATFORM_DB as unknown as D1Like,
      e.STORE_BACKUPS as never,
      new Date('2026-11-07T03:00:00Z')
    );
    expect(m.tables.audit_log.rows).toBe(100_001);
    expect(m.tables.audit_log.parts!.length).toBe(21);
    const stored = JSON.parse(
      await (await e.STORE_BACKUPS.get(
        d1BackupKey('PLATFORM_DB', '2026-11-07', 'manifest.json')
      ))!.text()
    );
    expect(stored.tables.audit_log.parts).toHaveLength(21);
  }, 120_000);

  it('pages a BLOB-keyed table (no scalar cursor) without losing or repeating a row', async () => {
    await e.PLATFORM_DB.exec('CREATE TABLE keys (k BLOB PRIMARY KEY, v TEXT)');
    await e.PLATFORM_DB.exec(
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 230) INSERT INTO keys SELECT randomblob(8), 'v' || x FROM c"
    );
    const m = await backupD1(
      'PLATFORM_DB',
      e.PLATFORM_DB as unknown as D1Like,
      e.STORE_BACKUPS as never,
      new Date('2026-11-08T03:00:00Z'),
      100
    );
    expect(m.tables.keys.rows).toBe(230);
    let n = 0;
    const seen = new Set<string>();
    for (const p of m.tables.keys.parts!) {
      const body = await (await e.STORE_BACKUPS.get(
        d1BackupKey('PLATFORM_DB', '2026-11-08', p.file)
      ))!.text();
      for (const l of body.split('\n').filter(Boolean).slice(1)) {
        n++;
        seen.add(l);
      }
    }
    expect(n).toBe(230);
    expect(seen.size).toBe(230);
  });
});
