// Ruling ICEBERG-BK-3: the off-account Mac pull of R2 ebda-db-backups (Iceberg audit #21 gap 3: backup bucket in the same account).
import { mkdtempSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM
import * as B from '../../../scripts/ops/lib/cf-backup.mjs';
// @ts-expect-error plain ESM
import { pullBackups } from '../../../scripts/ops/pull-cf-backups.mjs';

const enc = (b: Buffer) => Buffer.concat([Buffer.from('AGE:'), Buffer.from(b).reverse()]);
const at = (d: string) => new Date(`${d}T03:00:00Z`);

async function bucketWithBackups(days: string[], { identity = true } = {}) {
  const m = new Map<string, Buffer>();
  const io: any = {
    r2Get: async (k: string) => m.get(k) ?? null,
    r2Put: async (k: string, v: Buffer) => void m.set(k, Buffer.from(v)),
    encrypt: async (x: Buffer) => enc(x),
    exportD1: async () => ({
      raw: Buffer.from('PLATFORM'),
      tables: { stores: { count: 1, digest: 'a' } },
    }),
    exportIdentity: async () => ({
      raw: Buffer.from('IDENTITY'),
      tables: { users: { count: 1, digest: 'b' } },
    }),
    listStoreIds: async () => ['s1'],
    exportStore: async () => ({ raw: Buffer.from('STORE'), tables: {} }),
    media: {
      list: async () => [{ key: 'p/1.webp', etag: 'e1', size: 3 }],
      getSource: async () => Buffer.from('img'),
      put: async (k: string, v: Buffer) => void m.set(k, Buffer.from(v)),
      get: async (k: string) => m.get(k) ?? null,
    },
  };
  for (const d of days) await B.runBackup({ io, now: at(d) });
  await B.backupMedia({ io, now: at(days[days.length - 1]) });
  if (!identity) {
    const k = `cf/daily/${days[days.length - 1]}/manifest.json`;
    const man = JSON.parse(m.get(k)!.toString());
    delete man.artifacts['d1-ebda-identity'];
    m.set(k, Buffer.from(JSON.stringify(man)));
  }
  const gets: string[] = [];
  return { m, gets, get: async (k: string) => (gets.push(k), m.get(k) ?? null) };
}
const tmp = () => mkdtempSync(path.join(tmpdir(), 'pull-'));

describe('pullBackups', () => {
  it('pulls the newest daily set + media, verified, as hard links into a day folder', async () => {
    const b = await bucketWithBackups(['2026-11-10']);
    const root = tmp();
    const r = await pullBackups({ get: b.get, root, now: at('2026-11-10') });
    expect(r).toMatchObject({ day: '2026-11-10', artifacts: 3, media: 1 });
    const day = path.join(root, 'days/2026-11-10');
    expect(readdirSync(day).sort()).toEqual([
      'd1-ebda-identity.sql.gz.age',
      'd1-ebda-platform.sql.gz.age',
      'do-s1.ndjson.gz.age',
      'manifest.json',
    ]);
    expect(statSync(path.join(day, 'd1-ebda-identity.sql.gz.age')).nlink).toBe(2);
    expect(
      readFileSync(path.join(root, 'media/objects/e1/p/1.webp.age')).subarray(0, 4).toString()
    ).toBe('AGE:');
  });
  it('a second run downloads nothing that is already verified locally', async () => {
    const b = await bucketWithBackups(['2026-11-10']);
    const root = tmp();
    await pullBackups({ get: b.get, root, now: at('2026-11-10') });
    const r = await pullBackups({ get: b.get, root, now: at('2026-11-10') });
    expect(r.downloaded).toBe(0);
  });
  it('a tampered object fails the pull (sha256 against the manifest)', async () => {
    const b = await bucketWithBackups(['2026-11-10']);
    for (const k of b.m.keys())
      if (k.endsWith('d1-ebda-identity.sql.gz.age')) b.m.set(k, Buffer.from('x'));
    await expect(pullBackups({ get: b.get, root: tmp(), now: at('2026-11-10') })).rejects.toThrow(
      /sha256/
    );
  });
  it('a stale newest backup fails loudly', async () => {
    const b = await bucketWithBackups(['2026-11-05']);
    await expect(pullBackups({ get: b.get, root: tmp(), now: at('2026-11-10') })).rejects.toThrow(
      /5 days old/
    );
  });
  it('a backup set without ebda-identity fails', async () => {
    const b = await bucketWithBackups(['2026-11-10'], { identity: false });
    await expect(pullBackups({ get: b.get, root: tmp(), now: at('2026-11-10') })).rejects.toThrow(
      /no d1-ebda-identity/
    );
  });
  it('keeps the newest `keep` day folders and removes objects no day links to', async () => {
    const root = tmp();
    for (const d of ['2026-11-08', '2026-11-09', '2026-11-10']) {
      const b = await bucketWithBackups([d]);
      await pullBackups({ get: b.get, root, now: at(d), keep: 2 });
    }
    expect(readdirSync(path.join(root, 'days')).sort()).toEqual(['2026-11-09', '2026-11-10']);
    for (const f of readdirSync(path.join(root, 'objects')))
      expect(statSync(path.join(root, 'objects', f)).nlink).toBeGreaterThan(1);
    expect(existsSync(path.join(root, 'days/2026-11-08'))).toBe(false);
  });
});
