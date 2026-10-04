/**
 * Tenant isolation behind a TRANSACTION-MODE POOLER (R-EBDA-001, SP4 Stage 1a).
 *
 * Hyperdrive (and pgbouncer, Neon's pooler) hand a server connection to a
 * different client after every COMMIT. If the store GUC were set at session
 * level it would survive on that server connection and the NEXT tenant would
 * read the PREVIOUS tenant's rows. This test starts a real pgbouncer in
 * transaction mode with a pool of 2 server connections, so connections are
 * certainly reused across tenants, then drives interleaved requests for two
 * stores through the production code path (`runWithRequestDb` with `max: 1`,
 * `runInTenantContext`) as the `ebda_app` role, and asserts that no request
 * ever sees a row of another store and that a request without a tenant context
 * sees nothing.
 *
 * A NEGATIVE CONTROL proves the harness can detect a leak: a session-level
 * `set_config(..., false)` through the same pooler does leak, so a green result
 * is meaningful. Mutation check: flipping one `set_config(..., true)` in
 * packages/database/src/tenant-gucs.ts to `false` turns the isolation test red.
 *
 * Skipped when the `pgbouncer` binary is not installed (CI installs it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  createPrismaClient,
  createIsolateDb,
  runWithRequestDb,
  runInTenantContext,
  prisma,
  type AppPrismaClient,
  type IsolateDb,
} from '@force/database';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw'; // same as the CI role step: roles are cluster-wide, so tests must not rotate it
const PREFIX = 'rlspool-';
const PGBOUNCER = ['/usr/sbin/pgbouncer', '/usr/bin/pgbouncer', '/usr/local/bin/pgbouncer'].find(
  p => fs.existsSync(p)
);
const haveBouncer = !!PGBOUNCER || spawnSync('pgbouncer', ['--version']).status === 0;
// CI sets REQUIRE_PGBOUNCER so a missing binary FAILS the job instead of silently skipping the proof.
const requireBouncer = process.env.REQUIRE_PGBOUNCER === '1';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>(r => {
      const c = net.connect(port, '127.0.0.1', () => {
        c.destroy();
        r(true);
      });
      c.on('error', () => r(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('pgbouncer did not start');
}

describe.runIf(requireBouncer && !haveBouncer)('pgbouncer is required in this environment', () => {
  it('the pgbouncer binary is installed (REQUIRE_PGBOUNCER=1)', () => {
    expect(
      haveBouncer,
      'install pgbouncer: the pooler isolation proof cannot be skipped here'
    ).toBe(true);
  });
});

describe.skipIf(!haveBouncer)('tenant isolation behind a transaction-mode pooler', () => {
  let owner: AppPrismaClient;
  let proc: ChildProcess | undefined;
  let dir = '';
  let poolerUrl = '';
  let controlUrl = '';
  let storeA = '';
  let storeB = '';
  const markerA = `${PREFIX}A`;
  const markerB = `${PREFIX}B`;

  const makeApp = () => createPrismaClient({ connectionString: poolerUrl, max: 1 });

  // The Workers design (SP4 Stage 2): pooled, reused clients leased per request, a connection per request.
  let shared: IsolateDb;
  type Mode = 'client per request' | 'leased clients';
  const read = (storeId: string | null) => () => {
    const q = () => prisma.storeFaq.findMany({ select: { storeId: true, question: true } });
    return storeId ? runInTenantContext(storeId, q) : q();
  };

  /** One "request": its own connection (max 1), its own tenant transaction. */
  async function request(storeId: string | null, mode: Mode = 'client per request') {
    return mode === 'leased clients'
      ? shared.run(read(storeId))
      : runWithRequestDb(makeApp, read(storeId));
  }

  beforeAll(async () => {
    const o = new URL(OWNER_URL);
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2 });
    await owner.$executeRawUnsafe(`ALTER ROLE ebda_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
    const [{ verifier }] = await owner.$queryRawUnsafe<Array<{ verifier: string }>>(
      `SELECT rolpassword AS verifier FROM pg_authid WHERE rolname = 'ebda_app'`
    );

    await owner.$executeRawUnsafe(`DELETE FROM public.store_faqs WHERE question LIKE '${PREFIX}%'`);
    await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
    await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
    const mkStore = async (tag: string) => {
      const u = await owner.user.create({
        data: {
          email: `${PREFIX}${tag}-${crypto.randomUUID()}@test.com`,
          passwordHash: 'x',
          firstName: tag,
          lastName: 'T',
          role: 'store_admin',
        },
      });
      return owner.store.create({
        data: { slug: `${PREFIX}${tag.toLowerCase()}`, name: `Pool ${tag}`, ownerId: u.id },
      });
    };
    storeA = (await mkStore('A')).id;
    storeB = (await mkStore('B')).id;
    for (let i = 0; i < 3; i++) {
      await owner.storeFaq.create({
        data: { storeId: storeA, question: `${markerA}-${i}`, answer: 'a' },
      });
      await owner.storeFaq.create({
        data: { storeId: storeB, question: `${markerB}-${i}`, answer: 'a' },
      });
    }

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebda-pgb-'));
    const port = await freePort();
    fs.writeFileSync(path.join(dir, 'userlist.txt'), `"ebda_app" "${verifier}"\n`);
    fs.writeFileSync(
      path.join(dir, 'pgbouncer.ini'),
      [
        '[databases]',
        `pooled = host=${o.hostname} port=${o.port || 5432} dbname=${o.pathname.slice(1)}`,
        // The negative control gets its OWN server pool (pools are per database alias), so
        // the session state it deliberately leaks can never reach the real tests.
        `control = host=${o.hostname} port=${o.port || 5432} dbname=${o.pathname.slice(1)} pool_size=1`,
        '[pgbouncer]',
        'listen_addr = 127.0.0.1',
        `listen_port = ${port}`,
        'unix_socket_dir =',
        'auth_type = scram-sha-256',
        `auth_file = ${path.join(dir, 'userlist.txt')}`,
        'pool_mode = transaction',
        // tiny pool => server connections are DEFINITELY reused across tenants
        'default_pool_size = 2',
        'min_pool_size = 0',
        'reserve_pool_size = 0',
        'max_client_conn = 400',
        'server_reset_query =',
        'server_reset_query_always = 0',
        'ignore_startup_parameters = extra_float_digits,options',
        `logfile = ${path.join(dir, 'pgbouncer.log')}`,
        `pidfile = ${path.join(dir, 'pgbouncer.pid')}`,
        '',
      ].join('\n')
    );
    // pgbouncer refuses to run as root (a sandbox/CI container may): drop to `postgres`.
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    let drop: { uid?: number; gid?: number } = {};
    if (asRoot) {
      const uid = Number(spawnSync('id', ['-u', 'postgres']).stdout.toString().trim());
      const gid = Number(spawnSync('id', ['-g', 'postgres']).stdout.toString().trim());
      drop = { uid, gid };
      fs.chownSync(dir, uid, gid);
      for (const f of fs.readdirSync(dir)) fs.chownSync(path.join(dir, f), uid, gid);
    }
    proc = spawn(PGBOUNCER ?? 'pgbouncer', [path.join(dir, 'pgbouncer.ini')], {
      stdio: 'ignore',
      ...drop,
    });
    await waitForPort(port);
    poolerUrl = `postgresql://ebda_app:${APP_PASSWORD}@127.0.0.1:${port}/pooled`;
    controlUrl = `postgresql://ebda_app:${APP_PASSWORD}@127.0.0.1:${port}/control`;
    shared = createIsolateDb({ connectionString: poolerUrl, max: 6 });
  }, 60_000);

  afterAll(async () => {
    proc?.kill('SIGTERM');
    if (owner) {
      await owner.$executeRawUnsafe(
        `DELETE FROM public.store_faqs WHERE question LIKE '${PREFIX}%'`
      );
      await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
      await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
      await owner.$disconnect();
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('negative control: a SESSION-level set_config leaks across clients through the pooler', async () => {
    // Poison the control pool's single server connection with store A.
    const poison = Array.from({ length: 4 }, () => new pg.Client({ connectionString: controlUrl }));
    await Promise.all(poison.map(c => c.connect()));
    await Promise.all(
      poison.map(c => c.query(`SELECT set_config('app.current_store_id', $1, false)`, [storeA]))
    );
    await Promise.all(poison.map(c => c.end()));

    // A later client that sets NOTHING now inherits store A on the pooled connection.
    let leaks = 0;
    for (let i = 0; i < 20; i++) {
      const c = new pg.Client({ connectionString: controlUrl });
      await c.connect();
      const r = await c.query(
        `SELECT question FROM public.store_faqs WHERE question LIKE '${PREFIX}%'`
      );
      leaks += r.rowCount ?? 0;
      await c.end();
    }
    expect(leaks, 'the harness must be able to observe a session-level leak').toBeGreaterThan(0);
  }, 60_000);

  it.each<Mode>(['client per request', 'leased clients'])(
    'interleaved requests for two stores (and contextless ones) never see another tenant (%s)',
    async mode => {
      const plan: Array<string | null> = [];
      for (let i = 0; i < 300; i++) plan.push(i % 3 === 0 ? null : i % 3 === 1 ? storeA : storeB);

      // 20 requests in flight at a time over a 2-connection server pool.
      const results: Array<{ s: string | null; rows: Awaited<ReturnType<typeof request>> }> = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          while (next < plan.length) {
            const s = plan[next++];
            results.push({ s, rows: await request(s, mode) });
          }
        })
      );

      const violations: string[] = [];
      for (const { s, rows } of results) {
        if (s === null) {
          if (rows.length !== 0) violations.push(`contextless request saw ${rows.length} rows`);
          continue;
        }
        const mine = s === storeA ? markerA : markerB;
        if (rows.length !== 3) violations.push(`store request saw ${rows.length} rows (want 3)`);
        for (const r of rows) {
          if (r.storeId !== s || !r.question.startsWith(mine)) {
            violations.push(
              `store ${s === storeA ? 'A' : 'B'} saw ${r.question} (store ${r.storeId})`
            );
          }
        }
      }
      expect(violations).toEqual([]);
      expect(results.filter(r => r.s === null)).toHaveLength(100);
    },
    120_000
  );

  it('leased clients: overlapping requests hold different connections and clients, and release them', async () => {
    const seen = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        shared.run(async () => {
          const lease = shared.currentLease()!;
          const pids = await lease.client.$transaction(async tx => {
            const a = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            await tx.$queryRaw`SELECT pg_sleep(0.2)`; // overlap: all 6 hold a server connection now
            const b = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            return [a[0].pid, b[0].pid];
          });
          return { i, lease, pids };
        })
      )
    );
    // Inside one transaction the connection never changes ...
    for (const r of seen) expect(r.pids[0]).toBe(r.pids[1]);
    // ... overlapping transactions use different server connections (this pooler has 2) ...
    expect(new Set(seen.map(r => r.pids[0])).size).toBe(2);
    // ... on 6 different request scopes and 6 different clients (a client serves one request at a time).
    expect(new Set(seen.map(r => r.lease.scope.id)).size).toBe(6);
    expect(new Set(seen.map(r => r.lease.client)).size).toBe(6);
    for (const r of seen) expect(r.lease.scope.opened).toBe(1);
    // A request that never queries never opens a connection.
    const idle = await shared.run(async () => shared.currentLease()!.scope);
    expect(idle.opened).toBe(0);
    // Everything is back: nothing leased, nothing waiting, no more clients than the pool allows.
    const st = shared.stats();
    expect(st.leased).toBe(0);
    expect(st.waiting).toBe(0);
    expect(st.created).toBeLessThanOrEqual(st.max);
  }, 30_000);

  it('leased clients: a client is REUSED by the next request on a fresh connection', async () => {
    const one = await shared.run(async () => {
      await prisma.$queryRaw`SELECT 1`;
      return shared.currentLease()!;
    });
    const two = await shared.run(async () => {
      await prisma.$queryRaw`SELECT 1`;
      return shared.currentLease()!;
    });
    expect(two.client).toBe(one.client); // same engine: no per-request client construction
    expect(two.scope.id).not.toBe(one.scope.id); // new per-request connection
  });

  it('leased clients: more concurrent requests than clients wait, none is lost, none is shared', async () => {
    const small = createIsolateDb({ connectionString: poolerUrl, max: 2 });
    const running = { now: 0, peak: 0 };
    const out = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        small.run(async () => {
          running.now++;
          running.peak = Math.max(running.peak, running.now);
          await small.currentLease()!.client.$queryRaw`SELECT pg_sleep(0.05)`;
          running.now--;
          return i;
        })
      )
    );
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(running.peak).toBeLessThanOrEqual(2);
    expect(small.stats()).toMatchObject({ created: 2, leased: 0, waiting: 0 });
  }, 30_000);

  it('leased clients: a pool timeout sheds load instead of queueing forever', async () => {
    const tiny = createIsolateDb({ connectionString: poolerUrl, max: 1, maxWaitMs: 100 });
    const hold = tiny.run(() => new Promise<void>(r => setTimeout(r, 400)));
    await new Promise(r => setTimeout(r, 20));
    await expect(tiny.run(async () => 1)).rejects.toThrow(/no database client available/);
    await hold;
    expect(tiny.stats()).toMatchObject({ leased: 0, waiting: 0 });
  });

  it('leased clients: a nested transaction inside a tenant transaction does not deadlock', async () => {
    // withMoneyTx inside runInTenantContext opens a SECOND transaction on a second connection.
    const db = createIsolateDb({ connectionString: poolerUrl, max: 1, connectionsPerRequest: 2 });
    const rows = await db.run(() =>
      runInTenantContext(storeA, async () => {
        const outer = await prisma.storeFaq.findMany({ select: { storeId: true } });
        const inner = await prisma.$transaction(async tx => tx.storeFaq.findMany());
        return { outer: outer.length, inner: inner.length };
      })
    );
    expect(rows).toEqual({ outer: 3, inner: 3 });
  }, 20_000);

  it("leased clients: with ONE connection per request the same nesting waits for pg's connect timeout", async () => {
    // The negative control for the test above (and the reason connectionsPerRequest is not 1).
    const db = createIsolateDb({
      connectionString: `${poolerUrl}?connect_timeout=2`,
      max: 1,
      connectionsPerRequest: 1,
    });
    await expect(
      db.run(() =>
        runInTenantContext(storeA, async () =>
          prisma.$transaction(async tx => tx.storeFaq.findMany())
        )
      )
    ).rejects.toThrow(/timeout/i);
  }, 20_000);

  it('leased clients: a query with no lease is refused, not run on a stray socket', async () => {
    const lease = await shared.run(async () => shared.currentLease()!);
    // the lease is over: its client's adapter is unbound
    await expect(lease.client.$queryRaw`SELECT 1`).rejects.toThrow(/outside a request lease/);
  });

  it('a tenant transaction leaves no store on the server connection for the next client', async () => {
    for (let i = 0; i < 10; i++) await request(i % 2 ? storeA : storeB);
    const probes = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const c = new pg.Client({ connectionString: poolerUrl });
        await c.connect();
        const r = await c.query(
          `SELECT current_setting('app.current_store_id', true) AS s, current_setting('app.current_user_id', true) AS u`
        );
        await c.end();
        return r.rows[0] as { s: string | null; u: string | null };
      })
    );
    for (const p of probes) {
      expect(p.s ?? '').toBe('');
      expect(p.u ?? '').toBe('');
    }
  }, 60_000);
});
