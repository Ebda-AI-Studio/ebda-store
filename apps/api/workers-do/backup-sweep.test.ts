import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { StoreDO } from '../src/cf/store-do/store-do';
import { verifyWritten } from '../src/cf/store-do/backup';
import {
  backupD1,
  restoreD1FromBackup,
  type D1Writable,
  runBackupSweep,
  d1BackupKey,
  storeBackupManifestKey,
  type D1Like,
  type SweepEnv,
} from '../src/cf/ops/backup-sweep';

const e = env as unknown as SweepEnv & {
  STORE_BACKUPS: R2Bucket;
  PLATFORM_DB: D1Database;
  IDENTITY_DB: D1Database;
  STORE_DO: DurableObjectNamespace<StoreDO>;
};

const now = Date.now();
const seedStore = (id: string) =>
  e.STORE_DO.get(e.STORE_DO.idFromName(id)).seed({
    store: { id, slug: id, name: id, currency: 'EGP', createdAt: now, updatedAt: now },
    products: [
      {
        id: `${id}-p`,
        storeId: id,
        name: 'P',
        slug: 'p',
        price: 100,
        inventory: 5,
        status: 'active',
        hasVariants: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

describe('D1 backup (G8)', () => {
  it('exports every table with row counts + checksums and a schema file, and reads the manifest back', async () => {
    await e.PLATFORM_DB.exec(
      'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE hosts (host TEXT, store_id TEXT)'
    );
    await e.PLATFORM_DB.exec(
      "INSERT INTO users VALUES ('u1','a@x.eg'),('u2','b@x.eg'),('u3','c@x.eg'); INSERT INTO hosts VALUES ('a.ebda.app','s1')"
    );
    const m = await backupD1(
      'PLATFORM_DB',
      e.PLATFORM_DB as unknown as D1Like,
      e.STORE_BACKUPS as never,
      new Date('2026-11-01T03:00:00Z')
    );
    expect(m.tables.users.rows).toBe(3);
    expect(m.tables.hosts.rows).toBe(1);
    const users = await e.STORE_BACKUPS.get(
      d1BackupKey('PLATFORM_DB', '2026-11-01', 'users.ndjson')
    );
    expect((await users!.text()).trim().split('\n')).toHaveLength(4); // header + 3 rows
    const schema = await e.STORE_BACKUPS.get(
      d1BackupKey('PLATFORM_DB', '2026-11-01', 'schema.sql')
    );
    expect(await schema!.text()).toContain('CREATE TABLE users');
  });

  it('RESTORE DRILL: an export restores into an empty D1 with equal counts and checksums, and refuses a non-empty target', async () => {
    const src = e.IDENTITY_DB;
    await src.exec(
      'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, created_at INTEGER); CREATE TABLE passkeys (cred_id BLOB, user_id TEXT, pub TEXT)'
    );
    await src.exec(
      "INSERT INTO users VALUES ('u1','a@x.eg',1),('u2','b@x.eg',2); INSERT INTO passkeys VALUES (x'0a0b','u1','pk1')"
    );
    const m = await backupD1(
      'IDENTITY_DB',
      src as unknown as D1Like,
      e.STORE_BACKUPS as never,
      new Date('2026-11-05T03:00:00Z')
    );
    const dst = (env as unknown as { RESTORE_DB: D1Database }).RESTORE_DB;
    const res = await restoreD1FromBackup(
      'IDENTITY_DB',
      '2026-11-05',
      e.STORE_BACKUPS as never,
      dst as unknown as D1Writable
    );
    expect(res).toEqual({ passkeys: { rows: 1, ok: true }, users: { rows: 2, ok: true } });
    expect(Object.keys(m.tables).sort()).toEqual(['passkeys', 'users']);
    await expect(
      restoreD1FromBackup(
        'IDENTITY_DB',
        '2026-11-05',
        e.STORE_BACKUPS as never,
        dst as unknown as D1Writable
      )
    ).rejects.toThrow(/empty/);
  });

  it('fails when the rows read differ from the count (the assert can go red)', async () => {
    const lying: D1Like = {
      prepare: (sql: string) =>
        ({
          all: async () =>
            sql.includes('sqlite_master') && sql.includes('SELECT name')
              ? { results: [{ name: 't' }] }
              : { results: [] },
          sql,
        }) as never,
      batch: async () => [{ results: [{ n: 5 }] }, { results: [{ id: 1 }] }],
    };
    await expect(backupD1('X', lying, e.STORE_BACKUPS as never)).rejects.toThrow(
      /read 1 rows, count said 5/
    );
  });
});

describe('backup read-back (rule N11)', () => {
  it('passes for an intact write and throws when R2 silently dropped or corrupted a file', async () => {
    await seedStore('rb-a');
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName('rb-a'));
    const m = await stub.backupNow('rb-a');
    const day = m.takenAt.slice(0, 10);
    await verifyWritten(e.STORE_BACKUPS as never, 'rb-a', day, m);
    await e.STORE_BACKUPS.put(`store-do-backups/rb-a/${day}/products.ndjson`, '["id"]\n');
    await expect(verifyWritten(e.STORE_BACKUPS as never, 'rb-a', day, m)).rejects.toThrow(
      /products/
    );
    await e.STORE_BACKUPS.delete(`store-do-backups/rb-a/${day}/orders.ndjson`);
    await expect(verifyWritten(e.STORE_BACKUPS as never, 'rb-a', day, m)).rejects.toThrow();
  });
});

describe('backup sweep (G8)', () => {
  it('arms the alarm, flags a store with no backup yesterday, alerts, and writes a report', async () => {
    await seedStore('sweep-a');
    await e.STORE_BACKUPS.put(storeBackupManifestKey('sweep-a', '2026-10-30'), '{}');
    const alerts: string[] = [];
    const rep = await runBackupSweep(e, {
      listStoreIds: () => ['sweep-a'],
      alert: async (t, b) => void alerts.push(`${t}|${b}`),
      now: new Date('2026-11-02T03:00:00Z'),
      maxRetries: 0, // the in-sweep retry (P2-5) has its own tests; here the alarm-stopped signal must still page
    });
    expect(rep.stores.armed).toBe(1);
    expect(rep.stores.missingYesterday).toEqual(['sweep-a']);
    expect(rep.ok).toBe(false);
    expect(alerts).toHaveLength(1);
    await runInDurableObject(
      e.STORE_DO.get(e.STORE_DO.idFromName('sweep-a')),
      async (_i, state) => {
        expect(await state.storage.getAlarm()).not.toBeNull();
      }
    );
    expect(await e.STORE_BACKUPS.get('ops-reports/backup-sweep/2026-11-02.json')).not.toBeNull();
  });

  it('a brand-new store (no backup history) gets a baseline backup, not a P1 flag', async () => {
    await seedStore('sweep-new');
    const alerts: string[] = [];
    const rep = await runBackupSweep(e, {
      listStoreIds: () => ['sweep-new'],
      alert: async t => void alerts.push(t),
      now: new Date('2026-11-03T03:00:00Z'),
    });
    expect(rep.stores.missingYesterday).toEqual([]);
    expect(rep.stores.errors).toEqual([]);
    expect(alerts).toHaveLength(0);
    const listed = await e.STORE_BACKUPS.list({ prefix: 'store-do-backups/sweep-new/' });
    expect(listed.objects.length).toBeGreaterThan(0);
  });

  it('a store with history but no backup yesterday is still flagged (alarm stopped)', async () => {
    await seedStore('sweep-old');
    await e.STORE_BACKUPS.put(storeBackupManifestKey('sweep-old', '2026-10-30'), '{}');
    const rep = await runBackupSweep(e, {
      listStoreIds: () => ['sweep-old'],
      alert: async () => {},
      now: new Date('2026-11-03T03:00:00Z'),
      maxRetries: 0,
    });
    expect(rep.stores.missingYesterday).toEqual(['sweep-old']);
  });

  it('is green when yesterday has a manifest and D1 exports', async () => {
    await seedStore('sweep-b');
    await e.STORE_BACKUPS.put(storeBackupManifestKey('sweep-b', '2026-11-02'), '{}');
    const alerts: string[] = [];
    const rep = await runBackupSweep(e, {
      listStoreIds: () => ['sweep-b'],
      alert: async t => void alerts.push(t),
      now: new Date('2026-11-03T03:00:00Z'),
    });
    expect(rep.ok).toBe(true);
    expect(rep.d1.PLATFORM_DB.ok).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  it('StoreDO.backupNow writes a manifest whose counts equal the live row counts', async () => {
    await seedStore('sweep-c');
    const stub = e.STORE_DO.get(e.STORE_DO.idFromName('sweep-c'));
    const m = await stub.backupNow('sweep-c');
    const live = await stub.rowCounts();
    for (const [t, n] of Object.entries(live)) expect(m.tables[t].rows).toBe(n);
  });
});
