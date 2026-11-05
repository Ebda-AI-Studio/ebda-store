/**
 * Ruling NZ-BACKUP-1: the off-Cloudflare backup + restore drill. wrangler, age and R2 are replaced by fakes; the pipeline, tiers,
 * skip-if-unchanged, size guard, checksums and the drill's negative controls run for real.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../apps/api/src/lib/logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {} },
}));
// @ts-expect-error plain ESM
import * as B from '../../../scripts/ops/lib/cf-backup.mjs';
// @ts-expect-error plain ESM
import * as D from '../../../scripts/ops/lib/cf-drill.mjs';
import { routeCutover } from '../../../apps/api/src/cf/cutover';

const enc = (b: Buffer) => Buffer.concat([Buffer.from('AGE:'), Buffer.from(b).reverse()]);
const dec = (b: Buffer) => Buffer.from(b.subarray(4)).reverse();

function bucket() {
  const m = new Map<string, Buffer>();
  return {
    m,
    r2Get: async (k: string) => m.get(k) ?? null,
    r2Put: async (k: string, v: Buffer) => void m.set(k, Buffer.from(v)),
  };
}
function mkIo(b: ReturnType<typeof bucket>, state: { d1: string; store: string }) {
  return {
    ...b,
    encrypt: async (x: Buffer) => enc(x),
    exportD1: async () => ({
      raw: Buffer.from(state.d1),
      tables: { stores: { count: 1, digest: 'd' + state.d1.length } },
    }),
    listStoreIds: async () => ['s1'],
    exportStore: async () => ({
      raw: Buffer.from(state.store),
      tables: { products: { count: 1, digest: 'p' + state.store.length } },
    }),
  };
}
const at = (d: string) => new Date(`${d}T03:00:00Z`);

describe('tiers + keychain + size guard (pure)', () => {
  it('weekly on Sunday, monthly on the 1st', () => {
    expect(B.tiersFor(at('2026-11-04'))).toEqual(['daily']); // Wednesday
    expect(B.tiersFor(at('2026-11-08'))).toEqual(['daily', 'weekly']); // Sunday
    expect(B.tiersFor(at('2026-12-01'))).toEqual(['daily', 'monthly']);
    expect(B.tiersFor(at('2027-08-01'))).toEqual(['daily', 'weekly', 'monthly']); // Sunday the 1st
  });
  it('decodes a pure-hex Keychain output and leaves a real key alone', () => {
    const key = 'AGE-SECRET-KEY-1ABC\n# comment\n';
    const hex = Buffer.from(key).toString('hex');
    expect(B.decodeKeychainSecret(hex + '\n')).toBe(key);
    expect(B.decodeKeychainSecret(key)).toBe(key);
    expect(B.decodeKeychainSecret('abc')).toBe('abc'); // odd length is not hex
  });
  it('flags growth over 2x the median, a breach of the cap, and ignores noise below the floor', () => {
    const MB = 1024 * 1024;
    expect(
      B.sizeProblems({ uploaded: 10 * MB, history: [2 * MB, 3 * MB, 4 * MB], total: 1, cap: 1e9 })
    ).toHaveLength(1);
    expect(
      B.sizeProblems({ uploaded: 5 * MB, history: [3 * MB, 3 * MB, 3 * MB], total: 1, cap: 1e9 })
    ).toHaveLength(0);
    expect(
      B.sizeProblems({ uploaded: 500_000, history: [100, 100, 100], total: 1, cap: 1e9 })
    ).toHaveLength(0);
    expect(B.sizeProblems({ uploaded: 1, history: [], total: 2e9, cap: 1e9 })[0]).toMatch(/cap/);
    expect(B.sizeProblems({ uploaded: 50 * MB, history: [MB], total: 1, cap: 1e9 })).toHaveLength(
      0
    ); // too little history
  });
});

describe('runBackup', () => {
  it('stores, reads back, records raw/compressed/encrypted sizes and compresses before encrypting', async () => {
    const b = bucket();
    const r = await B.runBackup({
      io: mkIo(b, { d1: 'x'.repeat(5000), store: 'y'.repeat(5000) }),
      now: at('2026-11-04'),
    });
    expect(r.ok).toBe(true);
    const man = JSON.parse(b.m.get('cf/daily/2026-11-04/manifest.json')!.toString());
    const e = man.artifacts['d1-ebda-platform'];
    expect(e.rawBytes).toBe(5000);
    expect(e.gzBytes).toBeLessThan(200); // compressible input shrinks
    expect(dec(b.m.get(e.key)!).length).toBe(e.gzBytes); // what is encrypted is the gzip, not the raw
    expect(B.decompress(dec(b.m.get(e.key)!)).length).toBe(5000);
    expect(e.encSha256).toBe(B.sha256(b.m.get(e.key)!));
  });
  it('an unchanged artifact is referenced, not uploaded again; a changed one is uploaded', async () => {
    const b = bucket();
    const st = { d1: 'a'.repeat(3000), store: 'b'.repeat(3000) };
    await B.runBackup({ io: mkIo(b, st), now: at('2026-11-04') });
    const puts: string[] = [];
    const io2 = mkIo(b, st);
    const orig = io2.r2Put;
    io2.r2Put = async (k, v) => (puts.push(k), orig(k, v));
    const r = await B.runBackup({ io: io2, now: at('2026-11-05') });
    expect(r.reused).toBe(2);
    expect(puts.filter(k => k.endsWith('.age'))).toEqual([]);
    const man = JSON.parse(b.m.get('cf/daily/2026-11-05/manifest.json')!.toString());
    expect(man.artifacts['do-s1'].key).toBe('cf/daily/2026-11-04/do-s1.ndjson.gz.age');
    expect(man.artifacts['do-s1'].reused).toBe(true);
    st.store = 'c'.repeat(3000);
    const r3 = await B.runBackup({ io: mkIo(b, st), now: at('2026-11-06') });
    expect(r3.reused).toBe(1);
    expect(b.m.has('cf/daily/2026-11-06/do-s1.ndjson.gz.age')).toBe(true);
  });
  it('never references an object that is about to expire: after the reuse window it uploads again', async () => {
    const b = bucket();
    const st = { d1: 'a'.repeat(3000), store: 'b'.repeat(3000) };
    await B.runBackup({ io: mkIo(b, st), now: at('2026-11-01') });
    const r = await B.runBackup({ io: mkIo(b, st), now: at('2026-11-06') }); // 5 days later
    expect(r.reused).toBe(0);
    expect(b.m.has('cf/daily/2026-11-06/d1-ebda-platform.sql.gz.age')).toBe(true);
  });
  it('weekly and monthly get their own copy in their own prefix, never a reference into daily/', async () => {
    const b = bucket();
    const st = { d1: 'a'.repeat(3000), store: 'b'.repeat(3000) };
    await B.runBackup({ io: mkIo(b, st), now: at('2026-11-07') });
    await B.runBackup({ io: mkIo(b, st), now: at('2026-11-08') }); // Sunday, unchanged
    for (const e of Object.values(
      JSON.parse(b.m.get('cf/weekly/2026-11-08/manifest.json')!.toString()).artifacts
    ) as any[]) {
      expect(e.key.startsWith('cf/weekly/2026-11-08/')).toBe(true);
      expect(e.reused).toBe(false);
      expect(b.m.has(e.key)).toBe(true);
    }
  });
  it('a read-back that differs fails the run', async () => {
    const b = bucket();
    const io = mkIo(b, { d1: 'a', store: 'b' });
    io.r2Get = async (k: string) =>
      k.endsWith('.age') ? Buffer.from('corrupt') : (b.m.get(k) ?? null);
    await expect(B.runBackup({ io, now: at('2026-11-04') })).rejects.toThrow(/read-back/);
  });
  it('the size guard fails the run when cf/ exceeds the cap', async () => {
    const b = bucket();
    const r = await B.runBackup({
      io: mkIo(b, { d1: 'a'.repeat(100), store: 'b' }),
      now: at('2026-11-04'),
      cap: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/cap/);
  });
  it('the ledger forgets objects past their tier retention', async () => {
    const b = bucket();
    const st = { d1: 'a'.repeat(100), store: 'b' };
    await B.runBackup({ io: mkIo(b, st), now: at('2026-11-02') });
    await B.runBackup({ io: mkIo(b, { d1: 'z', store: 'z' }), now: at('2026-11-20') });
    const ledger = JSON.parse(b.m.get('cf/ledger.json')!.toString());
    expect(Object.keys(ledger.objects).some(k => k.includes('2026-11-02'))).toBe(false);
  });
});

describe('drill', () => {
  const tbl = (n: number) => ({ count: n, digest: 'dg' + n });
  async function seeded() {
    const b = bucket();
    const store =
      [
        JSON.stringify({ table: 'products', columns: ['id'], pk: ['id'], total: 1 }),
        JSON.stringify(['p1']),
      ].join('\n') + '\n';
    const io = {
      ...b,
      encrypt: async (x: Buffer) => enc(x),
      exportD1: async () => ({ raw: Buffer.from('SQL'), tables: { stores: tbl(1) } }),
      listStoreIds: async () => ['s1'],
      exportStore: async () => ({ raw: Buffer.from(store), tables: { products: tbl(1) } }),
    };
    await B.runBackup({ io, now: at('2026-11-04') });
    return b;
  }
  const targets = (over: any = {}) => ({
    decrypt: dec,
    loadD1: async () => ({ tables: { stores: tbl(1) }, stores: [] }),
    post: async (p: string) =>
      p.endsWith('__verify')
        ? { tables: { products: tbl(1) }, fk: { violations: 0, sample: [] } }
        : { ok: true },
    ...over,
  });
  it('passes on a faithful restore', async () => {
    const rep = await D.runDrill({ io: await seeded(), targets: targets() });
    expect(rep.pass).toBe(true);
    expect(D.formatReport(rep)).toContain('DRILL PASS');
  });
  it('negative control: one wrong digest in a restored StoreDO table fails the drill', async () => {
    const t = targets({
      post: async (p: string) =>
        p.endsWith('__verify') ? { tables: { products: tbl(2) }, fk: { violations: 0 } } : {},
    });
    const rep = await D.runDrill({ io: await seeded(), targets: t });
    expect(rep.pass).toBe(false);
    expect(D.formatReport(rep)).toMatch(/FAIL.*products want 1 got 2/);
  });
  it('negative control: a D1 table that is missing after restore fails', async () => {
    const rep = await D.runDrill({
      io: await seeded(),
      targets: targets({ loadD1: async () => ({ tables: {}, stores: [] }) }),
    });
    expect(rep.pass).toBe(false);
  });
  it('negative control: a corrupted object in the bucket fails before any restore', async () => {
    const b = await seeded();
    const k = [...b.m.keys()].find(x => x.endsWith('do-s1.ndjson.gz.age'))!;
    b.m.set(k, Buffer.from('AGE:tampered'));
    const rep = await D.runDrill({ io: b, targets: targets() });
    expect(rep.pass).toBe(false);
    expect(rep.checks[0].detail).toMatch(/checksum/);
  });
  it('the replay chunks rows into __import pages and sends the production import header', async () => {
    const calls: any[] = [];
    const rows = Array.from({ length: 2500 }, (_, i) => [`id${i}`]);
    await D.restoreStoreOverHttp(
      async (p: string, body: string) => (calls.push({ p, body }), { tables: {}, fk: {} }),
      's1',
      [{ table: 'products', columns: ['id'], pk: ['id'], rows }],
      'restore-drill-x'
    );
    const imports = calls.filter(c => c.p.endsWith('__import'));
    expect(imports).toHaveLength(3);
    expect(JSON.parse(imports[0].body.split('\n')[0])).toMatchObject({
      batch: 'restore-drill-x',
      table: 'products',
      page: 0,
      pk: ['id'],
    });
  });
  it('only ever writes to a loopback worker', () => {
    expect(() => D.assertLoopback('http://127.0.0.1:8798')).not.toThrow();
    expect(() => D.assertLoopback('https://api.ebda.app')).toThrow(/local worker/);
  });
});

describe('BACKUP_EXPORT_SECRET opens only the read-only actions', () => {
  const secret = 'b'.repeat(32);
  const id = '11111111-1111-4111-8111-111111111111';
  const call = (
    action: string,
    method: string,
    bearer: string,
    env: any = { BACKUP_EXPORT_SECRET: secret }
  ) =>
    routeCutover(
      new Request(`https://x/cutover/stores/${id}/${action}`, {
        method,
        headers: { authorization: `Bearer ${bearer}` },
      }),
      env
    );
  it('passes auth for __export / __tables, refuses __import / __seal / __unseal', async () => {
    expect((await call('__export', 'POST', secret))!.status).toBe(503); // past auth: STORE_DO is not bound in this test
    expect((await call('__tables', 'GET', secret))!.status).toBe(503);
    for (const a of ['__import', '__seal', '__unseal', '__rebase', '__auth', '__verify'])
      expect((await call(a, 'POST', secret))!.status).toBe(401);
  });
  it('a wrong bearer, or no secret on the Worker, refuses __export', async () => {
    expect((await call('__export', 'POST', 'z'.repeat(32)))!.status).toBe(401);
    expect((await call('__export', 'POST', secret, {}))!.status).toBe(503);
  });
});

describe('D1 export loading (first real nightly failed: "no such table: main.stores")', () => {
  // wrangler d1 export order: tables alphabetical, rows interleaved - a child INSERT before its parent's CREATE TABLE.
  const dump =
    "CREATE TABLE a_child (id TEXT PRIMARY KEY, s TEXT REFERENCES stores(id));\nINSERT INTO a_child VALUES ('1','x');\n" +
    "CREATE TABLE stores (id TEXT PRIMARY KEY);\nINSERT INTO stores VALUES ('x');\n";
  it('loads a dump whose child rows precede the parent table, and digests both tables', async () => {
    // @ts-expect-error plain ESM
    const io = await import('../../../scripts/ops/lib/cf-backup-io.mjs');
    const t = await io.d1Digests(dump);
    expect(Object.keys(t).sort()).toEqual(['a_child', 'stores']);
    expect(t.stores.count).toBe(1);
    expect(() => B.assertPlatformTables(t)).not.toThrow();
  });
  it('the guard fails loudly on zero tables or a database without stores', () => {
    expect(() => B.assertPlatformTables({})).toThrow(/ZERO tables/);
    expect(() => B.assertPlatformTables({ users: { count: 1, digest: 'd' } })).toThrow(
      /no `stores` table/
    );
  });
});

describe('export robustness (first real run: ECONNRESET after ~2 min, no output)', () => {
  const reset = () =>
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const okRes = (j: unknown) => ({ ok: true, status: 200, json: async () => j });
  const mk = (fetchImpl: any, logs: string[] = []) =>
    B.makeApiCall({
      apiUrl: 'https://x',
      secret: 's'.repeat(24),
      fetchImpl,
      sleep: async () => {},
      log: (m: string) => logs.push(m),
    });

  it('retries a connection reset once and then succeeds, logging the retry', async () => {
    let n = 0;
    const logs: string[] = [];
    const call = mk(
      async () => (++n === 1 ? Promise.reject(reset()) : okRes({ ok: true, tables: ['a'] })),
      logs
    );
    expect((await call('/cutover/stores/s1/__tables')).tables).toEqual(['a']);
    expect(n).toBe(2);
    expect(logs[0]).toMatch(/retry 1\/2 .*__tables.*ECONNRESET/);
  });
  it('retries 5xx and 429 but never a 4xx', async () => {
    let n = 0;
    const call = mk(async () =>
      ++n < 3
        ? { ok: false, status: n === 1 ? 503 : 429, json: async () => ({}) }
        : okRes({ ok: true })
    );
    await call('/p');
    expect(n).toBe(3);
    let m = 0;
    const c4 = mk(
      async () => (m++, { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })
    );
    await expect(c4('/p')).rejects.toThrow(/failed after 1 attempt/);
    expect(m).toBe(1);
  });
  it('always resetting: fails after 3 attempts with a message naming the target, table and offset', async () => {
    let n = 0;
    const call = mk(async () => (n++, Promise.reject(reset())));
    await expect(
      call('/cutover/stores/s1/__export', { table: 'orders', offset: 1500, limit: 500 })
    ).rejects.toThrow(
      /__export \[orders@1500\]: failed after 3 attempt\(s\): fetch failed \(ECONNRESET\)/
    );
    expect(n).toBe(3);
  });
  it('pages a table in chunks, advancing by the rows actually returned (the server may stop early on bytes)', async () => {
    const all = Array.from({ length: 7 }, (_, i) => [`id${i}`]);
    const offsets: number[] = [];
    const call = async (p: string, body?: any) => {
      if (p.endsWith('__tables')) return { tables: ['things'] };
      offsets.push(body.offset);
      const take = Math.min(body.limit, 3, all.length - body.offset); // server returns at most 3 rows
      return {
        columns: ['id'],
        pk: ['id'],
        total: all.length,
        offset: body.offset,
        rows: all.slice(body.offset, body.offset + take),
      };
    };
    const logs: string[] = [];
    const r = await B.exportStoreOverHttp(call, 's1', {
      pageRows: 500,
      log: (m: string) => logs.push(m),
    });
    expect(offsets).toEqual([0, 3, 6]);
    expect(r.tables.things.count).toBe(7);
    expect(logs.some(l => /things: 7 rows/.test(l))).toBe(true);
    expect(logs.some(l => /export done/.test(l))).toBe(true);
  });
  it('runBackup logs every phase', async () => {
    const logs: string[] = [];
    await B.runBackup({
      io: mkIo(bucket(), { d1: 'a'.repeat(100), store: 'b' }),
      now: at('2026-11-04'),
      log: (m: string) => logs.push(m),
    });
    for (const re of [
      /D1 export start/,
      /D1 export done/,
      /store s1 export start/,
      /compress/,
      /encrypt/,
      /R2 put/,
      /R2 read-back/,
    ])
      expect(
        logs.some(l => re.test(l)),
        String(re)
      ).toBe(true);
  });
  it('the notify job names the production environment so its secrets are visible, and warns when they are missing', async () => {
    const wf = (await import('node:fs')).readFileSync('.github/workflows/cf-backup.yml', 'utf8');
    const notify = wf.slice(wf.indexOf('notify-failure:'));
    expect(notify).toMatch(/environment: production/);
    expect(notify).toMatch(/NO ALERT SENT/);
  });
});

describe('D1 export is restorable in any order (first real drill: "no such table: main.stores")', () => {
  // A real-shaped wrangler export: the REAL platform schema, tables alphabetical with their rows interleaved, so children come first.
  async function realShapedExport() {
    const fs = await import('node:fs');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = 'packages/cf-schema/migrations/platform';
    const src = new DatabaseSync(':memory:');
    for (const f of fs
      .readdirSync(dir)
      .filter(n => n.endsWith('.sql'))
      .sort())
      src.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
    src.exec(
      "INSERT INTO stores (id, name, slug, owner_id, storage_backend) VALUES ('s1','S','s','o','do')"
    );
    const q = (v: any) =>
      v === null
        ? 'NULL'
        : typeof v === 'number'
          ? String(v)
          : `'${String(v).replace(/'/g, "''")}'`;
    const tables = src
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as any[];
    const out: string[] = ['PRAGMA defer_foreign_keys=TRUE;'];
    for (const t of tables) {
      out.push(t.sql + ';');
      for (const r of src.prepare(`SELECT * FROM "${t.name}"`).all() as any[])
        out.push(
          `INSERT INTO "${t.name}" (${Object.keys(r)
            .map(k => `"${k}"`)
            .join(',')}) VALUES (${Object.values(r).map(q).join(',')});`
        );
    }
    for (const o of src
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL"
      )
      .all() as any[])
      out.push(o.sql + ';');
    return out.join('\n') + '\n';
  }
  it('the raw alphabetical export does not load into a database that enforces foreign keys; the normalized artifact does', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    // @ts-expect-error plain ESM
    const io = await import('../../../scripts/ops/lib/cf-backup-io.mjs');
    const raw = await realShapedExport();
    const norm = io.normalizeD1Sql(raw);
    expect(norm.startsWith('PRAGMA defer_foreign_keys=TRUE;')).toBe(true);
    // schema first, then rows, then indexes/triggers; parents before children
    expect(norm.indexOf('CREATE TABLE')).toBeLessThan(norm.indexOf('INSERT INTO'));
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON'); // a restore target that enforces constraints
    db.exec(norm);
    expect((db.prepare('SELECT count(*) AS n FROM stores').get() as any).n).toBe(1);
    // content is preserved and the artifact is stable
    expect(await io.d1Digests(norm)).toEqual(await io.d1Digests(raw));
    expect(io.normalizeD1Sql(norm)).toBe(norm);
  });
  it('orders parents before children even when the child sorts first, and keeps BLOBs and floats exact', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    // @ts-expect-error plain ESM
    const io = await import('../../../scripts/ops/lib/cf-backup-io.mjs');
    const raw =
      "CREATE TABLE a_child (id TEXT PRIMARY KEY, s TEXT REFERENCES stores(id), n REAL, b BLOB);\nINSERT INTO a_child VALUES ('1','x',0.1,X'ff00');\n" +
      "CREATE TABLE stores (id TEXT PRIMARY KEY);\nINSERT INTO stores VALUES ('x');\n";
    expect(() => {
      const d = new DatabaseSync(':memory:');
      d.exec('PRAGMA foreign_keys = ON');
      d.exec(raw);
    }).toThrow(/no such table: main.stores/);
    const norm = io.normalizeD1Sql(raw);
    expect(norm.indexOf('CREATE TABLE stores')).toBeLessThan(norm.indexOf('CREATE TABLE a_child'));
    const d = new DatabaseSync(':memory:');
    d.exec('PRAGMA foreign_keys = ON');
    d.exec(norm);
    const row = d.prepare('SELECT n, hex(b) AS h FROM a_child').get() as any;
    expect(row.n).toBe(0.1);
    expect(row.h).toBe('FF00');
  });
});
