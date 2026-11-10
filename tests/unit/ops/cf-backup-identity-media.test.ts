// Iceberg audit #21 (2026-11-10): the nightly backup skipped D1 ebda-identity and R2 ebda-media (Rulings ICEBERG-BK-1/2).
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs ops library, no type declarations
import * as B from '../../../scripts/ops/lib/cf-backup.mjs';
// @ts-expect-error -- plain .mjs ops library, no type declarations
import * as D from '../../../scripts/ops/lib/cf-drill.mjs';
// @ts-expect-error -- plain .mjs ops library, no type declarations
import { restR2 } from '../../../scripts/ops/lib/cf-backup-io.mjs';

const enc = (b: Buffer) => Buffer.concat([Buffer.from('AGE:'), Buffer.from(b).reverse()]);
const dec = (b: Buffer) => Buffer.from(b.subarray(4)).reverse();
const tbl = (n: number) => ({ count: n, digest: 'dg' + n });
const at = (d: string) => new Date(`${d}T03:00:00Z`);

function bucket() {
  const m = new Map<string, Buffer>();
  return {
    m,
    r2Get: async (k: string) => m.get(k) ?? null,
    r2Put: async (k: string, v: Buffer) => void m.set(k, Buffer.from(v)),
  };
}
function dbIo(b: ReturnType<typeof bucket>, identityTables: any = { users: tbl(2) }) {
  return {
    ...b,
    encrypt: async (x: Buffer) => enc(x),
    exportD1: async () => ({ raw: Buffer.from('PLATFORM'), tables: { stores: tbl(1) } }),
    exportIdentity: async () => ({ raw: Buffer.from('IDENTITY'), tables: identityTables }),
    listStoreIds: async () => ['s1'],
    exportStore: async () => ({
      raw: Buffer.from(
        JSON.stringify({ table: 'products', columns: ['id'], pk: ['id'], total: 0 }) + '\n'
      ),
      tables: { products: { count: 0, digest: 'e' } },
    }),
  };
}

describe('D1 ebda-identity is part of every backup set', () => {
  it('uploads d1-ebda-identity encrypted, lists it in a v2 manifest and counts stores correctly', async () => {
    const b = bucket();
    const r = await B.runBackup({ io: dbIo(b), now: at('2026-11-10') });
    expect(r.ok).toBe(true);
    expect(r.stores).toBe(1);
    const man = JSON.parse(b.m.get('cf/daily/2026-11-10/manifest.json')!.toString());
    expect(man.version).toBe(2);
    const e = man.artifacts['d1-ebda-identity'];
    expect(e.key).toBe('cf/daily/2026-11-10/d1-ebda-identity.sql.gz.age');
    expect(e.tables.users.count).toBe(2);
    const stored = b.m.get(e.key)!;
    expect(stored.subarray(0, 4).toString()).toBe('AGE:'); // never stored in clear
    expect(B.decompress(dec(stored)).toString()).toBe('IDENTITY');
  });
  it('assertIdentityTables refuses an empty or wrong database', () => {
    expect(() => B.assertIdentityTables({})).toThrow(/ZERO tables/);
    expect(() => B.assertIdentityTables({ stores: tbl(1) })).toThrow(/no `users` table/);
    expect(B.assertIdentityTables({ users: tbl(1) })).toEqual({ users: tbl(1) });
  });
});

describe('restore drill restores ebda-identity into a scratch D1', () => {
  const targets = (over: any = {}) => ({
    decrypt: dec,
    loadD1: async () => ({ tables: { stores: tbl(1) }, stores: [] }),
    loadIdentity: async () => ({ tables: { users: tbl(2) } }),
    post: async (p: string) =>
      p.endsWith('__verify')
        ? { tables: { products: { count: 0, digest: 'e' } }, fk: { violations: 0, sample: [] } }
        : { ok: true },
    ...over,
  });
  it('passes when the scratch D1 matches the manifest row counts and digests', async () => {
    const b = bucket();
    await B.runBackup({ io: dbIo(b), now: at('2026-11-10') });
    const rep = await D.runDrill({ io: b, targets: targets() });
    expect(rep.pass).toBe(true);
    expect(D.formatReport(rep)).toMatch(/D1 identity: 1\/1 tables equal .*2 rows/);
  });
  it('negative control: a lost identity row fails the drill', async () => {
    const b = bucket();
    await B.runBackup({ io: dbIo(b), now: at('2026-11-10') });
    const rep = await D.runDrill({
      io: b,
      targets: targets({ loadIdentity: async () => ({ tables: { users: tbl(1) } }) }),
    });
    expect(rep.pass).toBe(false);
    expect(D.formatReport(rep)).toMatch(/users want 2 got 1/);
  });
  it('a v2 manifest without the identity artifact fails; a v1 manifest is reported, not failed', async () => {
    for (const [version, pass] of [
      [2, false],
      [1, true],
    ] as const) {
      const b = bucket();
      await B.runBackup({ io: dbIo(b), now: at('2026-11-10') });
      const k = 'cf/daily/2026-11-10/manifest.json';
      const man = JSON.parse(b.m.get(k)!.toString());
      delete man.artifacts['d1-ebda-identity'];
      man.version = version;
      b.m.set(k, Buffer.from(JSON.stringify(man)));
      const rep = await D.runDrill({ io: b, targets: targets() });
      expect(rep.pass).toBe(pass);
    }
  });
});

describe('R2 ebda-media incremental copy', () => {
  function media(src: Record<string, { body: string; etag: string }>) {
    const dst = new Map<string, Buffer>();
    const reads: string[] = [];
    const io = {
      encrypt: async (x: Buffer) => enc(x),
      media: {
        list: async () =>
          Object.entries(src).map(([key, o]) => ({
            key,
            etag: o.etag,
            size: Buffer.byteLength(o.body),
          })),
        getSource: async (k: string) => (reads.push(k), src[k] ? Buffer.from(src[k].body) : null),
        put: async (k: string, v: Buffer) => void dst.set(k, Buffer.from(v)),
        get: async (k: string) => dst.get(k) ?? null,
      },
    };
    return { io, dst, reads };
  }
  const manifestOf = (dst: Map<string, Buffer>) =>
    JSON.parse(dst.get('media/manifest.json')!.toString());

  it('first run copies every object encrypted and writes a manifest of key + etag', async () => {
    const src = {
      'a/1.webp': { body: 'one', etag: 'e1' },
      'b/2.webp': { body: 'two', etag: 'e2' },
    };
    const { io, dst } = media(src);
    const r = await B.backupMedia({ io, now: at('2026-11-10') });
    expect(r).toMatchObject({ ok: true, sourceObjects: 2, copied: 2, unchanged: 0 });
    const man = manifestOf(dst);
    expect(man.objects['a/1.webp']).toMatchObject({
      etag: 'e1',
      backupKey: 'media/objects/e1/a/1.webp.age',
      size: 3,
    });
    expect(dec(dst.get('media/objects/e1/a/1.webp.age')!).toString()).toBe('one');
  });
  it('second run reads only new or changed objects; overwritten keys keep their older copy; deletions are marked, not removed', async () => {
    const src: Record<string, { body: string; etag: string }> = {
      'a/1.webp': { body: 'one', etag: 'e1' },
      'b/2.webp': { body: 'two', etag: 'e2' },
      'c/3.webp': { body: 'three', etag: 'e3' },
    };
    const m = media(src);
    await B.backupMedia({ io: m.io, now: at('2026-11-10') });
    m.reads.length = 0;
    src['b/2.webp'] = { body: 'TWO', etag: 'e2b' };
    src['d/4.webp'] = { body: 'four', etag: 'e4' };
    delete src['c/3.webp'];
    const r = await B.backupMedia({ io: m.io, now: at('2026-11-11') });
    expect(m.reads.sort()).toEqual(['b/2.webp', 'd/4.webp']);
    expect(r).toMatchObject({ copied: 2, unchanged: 1, markedDeleted: 1, liveObjects: 3 });
    const man = manifestOf(m.dst);
    expect(man.objects['b/2.webp'].previous).toEqual(['media/objects/e2/b/2.webp.age']);
    expect(m.dst.has('media/objects/e2/b/2.webp.age')).toBe(true);
    expect(man.objects['c/3.webp'].deletedAt).toBe('2026-11-11T03:00:00.000Z');
    expect(m.dst.has('media/objects/e3/c/3.webp.age')).toBe(true);
  });
  it('a read-back that differs fails the run', async () => {
    const m = media({ 'a/1.webp': { body: 'one', etag: 'e1' } });
    m.io.media.get = async (k: string) => (k.endsWith('.age') ? Buffer.from('corrupt') : null);
    await expect(B.backupMedia({ io: m.io, now: at('2026-11-10') })).rejects.toThrow(/read-back/);
  });
  it('a short read (size differs from the listing) fails instead of storing a truncated image', async () => {
    const m = media({ 'a/1.webp': { body: 'one', etag: 'e1' } });
    m.io.media.getSource = async () => Buffer.from('o');
    await expect(B.backupMedia({ io: m.io, now: at('2026-11-10') })).rejects.toThrow(
      /listing said 3/
    );
  });
  it('checkpoints the manifest during a long run, so a crash part-way resumes', async () => {
    const src: Record<string, { body: string; etag: string }> = {};
    for (let i = 0; i < B.MEDIA_CHECKPOINT_EVERY + 3; i++)
      src[`k${i}`] = { body: `b${i}`, etag: `e${i}` };
    const m = media(src);
    let puts = 0;
    const put = m.io.media.put;
    m.io.media.put = async (k: string, v: Buffer) => {
      if (k === 'media/manifest.json') puts++;
      return put(k, v);
    };
    await B.backupMedia({ io: m.io, now: at('2026-11-10') });
    expect(puts).toBe(2); // one checkpoint + the final write
  });
  it('the size guard flags media/ over its cap', async () => {
    const m = media({ 'a/1.webp': { body: 'x'.repeat(100), etag: 'e1' } });
    const r = await B.backupMedia({ io: m.io, now: at('2026-11-10'), cap: 10 });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/cap/);
  });
});

describe('restR2 (Cloudflare REST API)', () => {
  it('follows the list cursor, URL-encodes each key segment, and throttles after every success', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.includes('/objects?') && !url.includes('cursor='))
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ key: 'a b/1.webp', etag: 'e1', size: '3' }],
            result_info: { is_truncated: true, cursor: 'c1' },
          })
        );
      if (url.includes('cursor=c1'))
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ key: 'z', etag: 'e2', size: 1 }],
            result_info: null,
          })
        );
      return new Response('abc');
    };
    const r = restR2({
      accountId: 'acc',
      token: 't',
      rps: 2,
      fetchImpl,
      sleep: async (ms: number) => void sleeps.push(ms),
    })('ebda-media');
    expect(await r.list()).toEqual([
      { key: 'a b/1.webp', etag: 'e1', size: 3 },
      { key: 'z', etag: 'e2', size: 1 },
    ]);
    expect((await r.get('a b/1.webp'))!.toString()).toBe('abc');
    expect(calls[2]).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc/r2/buckets/ebda-media/objects/a%20b/1.webp'
    );
    expect(sleeps.length).toBeGreaterThan(0); // 3 calls at 2 rps: the 2nd and 3rd waited
  });
  it('a 429 waits the server Retry-After (capped at 300 s) and retries; the quota is shared with the wrangler calls', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = async () =>
      ++n === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '900' } })
        : new Response('ok');
    const r = restR2({
      accountId: 'acc',
      token: 't',
      fetchImpl,
      sleep: async (ms: number) => void sleeps.push(ms),
    })('b');
    expect((await r.get('k'))!.toString()).toBe('ok');
    expect(sleeps).toContain(300_000);
  });
  it('a failed list throws with the HTTP status instead of returning an empty bucket', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403 });
    const r = restR2({ accountId: 'acc', token: 't', fetchImpl, sleep: async () => {} })(
      'ebda-media'
    );
    await expect(r.list()).rejects.toThrow(/HTTP 403/);
  });
});
