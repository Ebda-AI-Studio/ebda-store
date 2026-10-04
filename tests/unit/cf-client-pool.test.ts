/**
 * The leased Prisma client pool of a Worker isolate (packages/database/src/client-pool.ts).
 * No database: a PrismaClient connects lazily, and these tests never run a query that would.
 */
import { describe, it, expect } from 'vitest';
import { ClientPool, ClientPoolTimeout } from '../../packages/database/src/client-pool';
import { createIsolateDb, baseClient } from '../../packages/database/src/request-db';

const URL = 'postgresql://u:p@127.0.0.1:1/none';
const tick = () => new Promise(r => setTimeout(r, 0));

describe('ClientPool', () => {
  it('builds clients lazily, up to max, and reuses a released one', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 2 });
    expect(pool.stats().created).toBe(0);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a.client).not.toBe(b.client);
    expect(pool.stats()).toMatchObject({ created: 2, leased: 2, idle: 0 });
    await a.release();
    const c = await pool.acquire();
    expect(c.client).toBe(a.client); // reused: no third engine
    expect(pool.stats().created).toBe(2);
    await b.release();
    await c.release();
  });

  it('gives every lease its own connection scope, even on a reused client', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1 });
    const a = await pool.acquire();
    const first = a.scope;
    await a.release();
    const b = await pool.acquire();
    expect(b.client).toBe(a.client);
    expect(b.scope).not.toBe(first);
    expect(b.scope.opened).toBe(0); // nothing opens until a query runs
    await b.release();
  });

  it('queues beyond max in FIFO order and hands a freed client to the next waiter', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1 });
    const a = await pool.acquire();
    const order: string[] = [];
    const w1 = pool.acquire().then(l => (order.push('w1'), l));
    const w2 = pool.acquire().then(l => (order.push('w2'), l));
    await tick();
    expect(pool.stats().waiting).toBe(2);
    await a.release();
    const l1 = await w1;
    expect(l1.client).toBe(a.client);
    expect(order).toEqual(['w1']);
    await l1.release();
    const l2 = await w2;
    await l2.release();
    expect(order).toEqual(['w1', 'w2']);
    expect(pool.stats()).toMatchObject({ leased: 0, waiting: 0, created: 1 });
  });

  it('sheds load with ClientPoolTimeout instead of queueing forever, and leaves no waiter behind', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1, maxWaitMs: 30 });
    const a = await pool.acquire();
    await expect(pool.acquire()).rejects.toBeInstanceOf(ClientPoolTimeout);
    expect(pool.stats().waiting).toBe(0);
    await a.release();
    // the abandoned waiter must not swallow the next release
    const b = await pool.acquire();
    expect(b.client).toBe(a.client);
    await b.release();
  });

  it('release is idempotent', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1 });
    const a = await pool.acquire();
    await a.release();
    await a.release();
    expect(pool.stats()).toMatchObject({ leased: 0, idle: 1 });
  });

  it("a query with no lease is refused: it can never borrow another request's connection", async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1 });
    const a = await pool.acquire();
    const client = a.client;
    await a.release();
    await expect(client.$queryRaw`SELECT 1`).rejects.toThrow(/outside a request lease/);
  });
});

describe('a client whose Prisma dispatch was lost', () => {
  const stick = (client: unknown) => {
    // Prisma's request DataLoader: `tickActive` stays true when its nextTick dispatch is lost.
    const loader = (client as { _requestHandler: { dataloader: { tickActive: boolean } } })
      ._requestHandler.dataloader;
    loader.tickActive = true;
  };

  it('is dropped on release, not handed to the next request', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1 });
    const a = await pool.acquire();
    stick(a.client);
    await a.release();
    expect(pool.stats()).toMatchObject({ discarded: 1, created: 0, idle: 0 });
    const b = await pool.acquire();
    expect(b.client).not.toBe(a.client);
    await b.release();
    expect(pool.stats()).toMatchObject({ discarded: 1, created: 1, idle: 1 });
  });

  it('is replaced for a request already waiting for it', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1 });
    const a = await pool.acquire();
    const waiter = pool.acquire();
    await tick();
    stick(a.client);
    await a.release();
    const b = await waiter;
    expect(b.client).not.toBe(a.client);
    expect(pool.stats()).toMatchObject({ created: 1, leased: 1, discarded: 1 });
    await b.release();
  });
});

describe('createIsolateDb', () => {
  it('refuses `prisma` to a promise that outlives its request (it would run on the next request)', async () => {
    const db = createIsolateDb({ connectionString: URL, max: 1 });
    let open!: () => void;
    const gate = new Promise<void>(r => (open = r));
    let floating!: Promise<unknown>;
    await db.run(async () => {
      expect(baseClient()).toBeDefined();
      // a floating promise: started inside the request, awaited by nobody, reaches for `prisma` late
      floating = gate.then(() => baseClient());
      floating.catch(() => undefined);
    });
    open();
    await expect(floating).rejects.toThrow(/after its request ended/);
  });

  it('releases the lease (after beforeDisconnect) even when the request throws', async () => {
    const db = createIsolateDb({ connectionString: URL, max: 1 });
    const seen: string[] = [];
    await expect(
      db.run(
        async () => {
          throw new Error('boom');
        },
        { beforeDisconnect: async () => void seen.push('drained') }
      )
    ).rejects.toThrow('boom');
    expect(seen).toEqual(['drained']);
    expect(db.stats()).toMatchObject({ leased: 0, idle: 1 });
  });

  it('with waitUntil the release is deferred to it, and the client stays leased until then', async () => {
    const db = createIsolateDb({ connectionString: URL, max: 1 });
    let pending: Promise<unknown> | undefined;
    await db.run(async () => 1, { waitUntil: p => (pending = p) });
    await pending;
    expect(db.stats()).toMatchObject({ leased: 0, idle: 1 });
  });

  it("currentLease is the request's own lease, per concurrent run", async () => {
    const db = createIsolateDb({ connectionString: URL, max: 3 });
    const leases = await Promise.all(
      [1, 2, 3].map(() =>
        db.run(async () => {
          await tick();
          return db.currentLease();
        })
      )
    );
    expect(new Set(leases.map(l => l?.client)).size).toBe(3);
    expect(db.currentLease()).toBeUndefined();
  });
});
