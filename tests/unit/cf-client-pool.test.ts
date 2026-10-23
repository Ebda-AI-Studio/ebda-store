/**
 * The leased Prisma client pool of a Worker isolate (packages/database/src/client-pool.ts).
 * No database: a PrismaClient connects lazily, and these tests never run a query that would.
 */
import { describe, it, expect, vi } from 'vitest';
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

/**
 * workerd CANCELS a request whose client disconnects: its pending promises never settle, so the
 * `finally` that releases its lease never runs. Measured on the preview API (2026-10-07): six
 * probes cut off by the client left `leased: 3` with nothing in flight; once all `max` clients were
 * held by dead requests the isolate answered every request 503 OVERLOADED after 20 s, which is
 * what the builder canvas's server render hit (no draft, no products, no editor overlay).
 */
describe('leases and waiters of requests that were cancelled', () => {
  const clock = () => {
    let t = 1_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('a lease never released (its request was cancelled) is reclaimed once stale: the pool serves again', async () => {
    const c = clock();
    const pool = new ClientPool({
      connectionString: URL,
      max: 1,
      staleLeaseMs: 50,
      maxWaitMs: 20,
      now: c.now,
    });
    const dead = await pool.acquire(); // its request is cancelled: release() is never called
    await expect(pool.acquire()).rejects.toBeInstanceOf(ClientPoolTimeout); // still young: busy
    c.advance(60);
    const next = await pool.acquire();
    expect(next.client).not.toBe(dead.client); // never hand out a client a live request may hold
    expect(pool.stats()).toMatchObject({ created: 1, leased: 1, abandoned: 1 });
    await next.release();
    expect(pool.stats()).toMatchObject({ created: 1, leased: 0, idle: 1 });
  });

  it('a reclaimed lease released late (a slow request, not a dead one) is dropped, not double-counted', async () => {
    const c = clock();
    const pool = new ClientPool({ connectionString: URL, max: 1, staleLeaseMs: 50, now: c.now });
    const slow = await pool.acquire();
    c.advance(60);
    const next = await pool.acquire();
    await slow.release();
    expect(pool.stats()).toMatchObject({ created: 1, leased: 1, idle: 0 });
    await next.release();
    expect(pool.stats()).toMatchObject({ created: 1, leased: 0, idle: 1 });
  });

  it('a live lease is never reclaimed while it is younger than staleLeaseMs', async () => {
    const c = clock();
    const pool = new ClientPool({
      connectionString: URL,
      max: 1,
      staleLeaseMs: 50,
      maxWaitMs: 20,
      now: c.now,
    });
    const a = await pool.acquire();
    c.advance(40);
    await expect(pool.acquire()).rejects.toBeInstanceOf(ClientPoolTimeout);
    expect(pool.stats()).toMatchObject({ abandoned: 0, leased: 1 });
    await a.release();
  });

  it('a waiter older than maxWaitMs (its request was cancelled, its timer never fired) does not swallow a freed client', async () => {
    const c = clock();
    const pool = new ClientPool({ connectionString: URL, max: 1, maxWaitMs: 10_000, now: c.now });
    const a = await pool.acquire();
    void pool.acquire().catch(() => undefined); // a waiter whose request is then cancelled
    await tick();
    c.advance(10_001); // the real timer is still pending, as it is in a cancelled request
    await a.release();
    expect(pool.stats()).toMatchObject({ leased: 0, idle: 1 });
    const b = await pool.acquire();
    expect(b.client).toBe(a.client);
    await b.release();
  });

  it('a waiter is served (not shed) when the lease it waited on went stale meanwhile', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1, staleLeaseMs: 30, maxWaitMs: 60 });
    const dead = await pool.acquire();
    const waited = await pool.acquire(); // at its deadline the dead lease is 60 ms old > 30
    expect(waited.client).not.toBe(dead.client);
    expect(pool.stats()).toMatchObject({ abandoned: 1, leased: 1, waiting: 0 });
    await waited.release();
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

/**
 * Incident 2026-10-22/23 (docs/incidents/2026-10-23-array-buffer-and-tail.md): a burst held every
 * client of an isolate for ~1 s each (CPU 9 ms of 720 ms wall), requests queued up to 20 s, p99
 * sat on exactly `maxWaitMs`, and 557 of 3,625 requests were abandoned by their clients while
 * waiting. A wait that long is never useful (the caller is gone) and an unbounded-by-count queue
 * holds one request's memory per waiter.
 */
describe('load shedding bounds the queue by count and by time', () => {
  it('defaults: a short wait, a queue bounded relative to max, a stale lease well under the 30 s tx limit', () => {
    const pool = new ClientPool({ connectionString: URL });
    expect(pool.maxWaitMs).toBe(6_000);
    expect(pool.staleLeaseMs).toBe(30_000);
    expect(pool.max).toBe(6);
    expect(pool.maxQueue).toBe(pool.max * 5);
  });

  it('refuses a request at once (no wait) when the queue is full, as a ClientPoolTimeout', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1, maxQueue: 2, maxWaitMs: 60_000 });
    const a = await pool.acquire();
    const w1 = pool.acquire();
    const w2 = pool.acquire();
    await tick();
    expect(pool.stats().waiting).toBe(2);
    await expect(pool.acquire()).rejects.toBeInstanceOf(ClientPoolTimeout);
    expect(pool.stats()).toMatchObject({ waiting: 2, shed: 1 });
    await a.release();
    const l1 = await w1;
    await l1.release();
    const l2 = await w2;
    await l2.release();
    expect(pool.stats()).toMatchObject({ leased: 0, waiting: 0 });
  });

  it('reports a RangeError raised under a lease (with the operation and the pool state) before Prisma wraps it', async () => {
    const seen: Array<{ op: string; msg: string; waiting: number }> = [];
    const pool = new ClientPool({
      connectionString: URL,
      max: 1,
      onAdapterError: (err, op, stats) =>
        seen.push({ op, msg: err.message, waiting: stats.waiting }),
    });
    const lease = await pool.acquire();
    lease.scope.get = () => Promise.reject(new RangeError('Invalid array buffer length'));
    await expect(lease.client.$queryRaw`SELECT 1`).rejects.toThrow(/Invalid array buffer length/);
    expect(seen).toEqual([{ op: 'queryRaw', msg: 'Invalid array buffer length', waiting: 0 }]);
    // an ordinary driver error is not this hook's business
    lease.scope.get = () => Promise.reject(new Error('connection terminated'));
    await expect(lease.client.$queryRaw`SELECT 1`).rejects.toThrow();
    expect(seen).toHaveLength(1);
    await lease.release();
  });
});

describe('dead waiters never fill the queue', () => {
  it('waiters of cancelled requests (older than maxWaitMs, timer never fired) are pruned before the cap check', async () => {
    let t = 1_000;
    const pool = new ClientPool({
      connectionString: URL,
      max: 1,
      maxQueue: 2,
      maxWaitMs: 100,
      staleLeaseMs: 10_000,
      now: () => t,
    });
    const a = await pool.acquire();
    const w1 = pool.acquire().catch(() => 'x');
    const w2 = pool.acquire().catch(() => 'x');
    await tick();
    expect(pool.stats().waiting).toBe(2);
    // Their requests were cancelled: simulate by ageing them without their timers firing.
    t += 150;
    const w3 = pool.acquire(); // would be shed if dead waiters counted
    await tick();
    expect(pool.stats().shed).toBe(0);
    await a.release();
    const l3 = await w3;
    await l3.release();
    void w1;
    void w2;
  });

  it('an aborted waiter leaves the queue at once and is never handed a slot', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1, maxQueue: 2, maxWaitMs: 60_000 });
    const a = await pool.acquire();
    const ac = new AbortController();
    const dead = pool.acquire(ac.signal);
    const live = pool.acquire();
    await tick();
    expect(pool.stats().waiting).toBe(2);
    ac.abort();
    await expect(dead).rejects.toBeInstanceOf(ClientPoolTimeout);
    expect(pool.stats().waiting).toBe(1);
    await a.release();
    const l = await live; // the freed slot went to the live waiter
    expect(pool.stats()).toMatchObject({ leased: 1, waiting: 0 });
    await l.release();
  });

  it('a request already aborted when it asks is refused without queueing', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1 });
    const a = await pool.acquire();
    const ac = new AbortController();
    ac.abort();
    await expect(pool.acquire(ac.signal)).rejects.toBeInstanceOf(ClientPoolTimeout);
    expect(pool.stats().waiting).toBe(0);
    await a.release();
  });

  it('a RangeError inside an interactive transaction is reported too', async () => {
    const seen: string[] = [];
    const pool = new ClientPool({
      connectionString: URL,
      max: 1,
      onAdapterError: (_e, op) => seen.push(op),
    });
    const lease = await pool.acquire();
    const fakeTx = {
      provider: 'postgres',
      adapterName: 'fake',
      options: { usePhantomQuery: false },
      queryRaw: () => Promise.reject(new RangeError('Invalid array buffer length')),
      executeRaw: () => Promise.resolve(0),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    };
    lease.scope.get = () =>
      Promise.resolve({ startTransaction: () => Promise.resolve(fakeTx) } as never);
    await expect(lease.client.$transaction(async tx => tx.$queryRaw`SELECT 1`)).rejects.toThrow(
      /Invalid array buffer length/
    );
    expect(seen).toContain('tx.queryRaw');
    await lease.release();
  });
});

/**
 * Incident 2026-10-23 recurrence (release b0ce749): "Invalid array buffer length" came back with
 * `site=prisma-adapter` EMPTY on all 13 events, so it is raised inside Prisma (query compiler /
 * interpreter), not by the driver adapter. The original stack is dropped by Prisma, so the pool
 * reports it one layer up, where the model, operation and the client's history are known, and
 * drops the client afterwards (it is the only one that saw the failure).
 */
describe('a Prisma-internal "Invalid array buffer length"', () => {
  it('is reported with model/operation/client history and the client is dropped on release, not reused', async () => {
    const seen: Array<{ model?: string; operation: string; uses: number; leased: number }> = [];
    const pool = new ClientPool({
      connectionString: URL,
      max: 1,
      onClientRangeError: (_err, ctx) =>
        seen.push({
          model: ctx.model,
          operation: ctx.operation,
          uses: ctx.clientUses,
          leased: ctx.pool.leased,
        }),
    });
    const lease = await pool.acquire();
    const first = lease.client;
    lease.scope.get = () => Promise.reject(new RangeError('Invalid array buffer length'));
    await expect(lease.client.$queryRaw`SELECT 1`).rejects.toThrow(/Invalid array buffer length/);
    expect(seen).toEqual([{ model: undefined, operation: '$queryRaw', uses: 1, leased: 1 }]);
    await lease.release();
    expect(pool.stats()).toMatchObject({ discarded: 1, idle: 0, created: 0 });
    const next = await pool.acquire();
    expect(next.client).not.toBe(first);
    await next.release();
  });

  it('an ordinary error neither reports nor drops the client', async () => {
    const seen: unknown[] = [];
    const pool = new ClientPool({
      connectionString: URL,
      max: 1,
      onClientRangeError: e => seen.push(e),
    });
    const lease = await pool.acquire();
    lease.scope.get = () => Promise.reject(new Error('connection terminated'));
    await expect(lease.client.$queryRaw`SELECT 1`).rejects.toThrow();
    await lease.release();
    expect(seen).toEqual([]);
    expect(pool.stats()).toMatchObject({ discarded: 0, idle: 1 });
  });
});

describe('a client poisoned after its release', () => {
  it('is dropped when next taken from idle, not handed out', async () => {
    const pool = new ClientPool({ connectionString: URL, max: 1 });
    const lease = await pool.acquire();
    const first = lease.client;
    let fail!: (e: Error) => void;
    let reached!: () => void;
    const at = new Promise<void>(r => (reached = r));
    lease.scope.get = () =>
      new Promise((_, rej) => {
        fail = rej;
        reached();
      });
    const late = first.$queryRaw`SELECT 1`.catch(() => undefined);
    await at; // the query is inside the adapter, waiting on its connection
    await lease.release(); // released while the query is still in flight
    fail(new RangeError('Invalid array buffer length'));
    await late; // fails after release -> poisons an IDLE client
    const next = await pool.acquire();
    expect(next.client).not.toBe(first);
    expect(pool.stats()).toMatchObject({ discarded: 1, created: 1 });
    await next.release();
  });
});

/**
 * Incident 2026-10-23, third round (release aaaafb3): the raw stack of "Invalid array buffer
 * length" was `new QueryCompiler` -> wasm -> Uint8Array.subarray, with pool stats `abandoned: 27`.
 * All clients of an isolate share ONE wasm instance; each client's QueryCompiler takes ~4.5 MB of
 * its linear memory (measured, node: 60 clients never disconnected = 316 MB RSS, the same 60
 * disconnected = 80 MB) and only `$disconnect()` (ClientEngine.stop -> queryCompiler.free())
 * returns it. A lease abandoned as stale (its request was cancelled) was never disconnected, so
 * every cancelled request leaked one compiler until the wasm memory hit the isolate's limit.
 */
describe('an abandoned (stale) lease frees its QueryCompiler', () => {
  const stubScope = (lease: { scope: { get: () => Promise<never> } }) => {
    const result = { columnNames: [], columnTypes: [], rows: [] };
    lease.scope.get = () =>
      Promise.resolve({
        queryRaw: () => Promise.resolve(result),
        executeRaw: () => Promise.resolve(0),
      } as never);
  };

  it('disconnects the abandoned client as it is replaced', async () => {
    let t = 1_000;
    const pool = new ClientPool({ connectionString: URL, max: 1, staleLeaseMs: 50, now: () => t });
    const dead = await pool.acquire();
    const spy = vi.spyOn(dead.client, '$disconnect');
    t += 60;
    const next = await pool.acquire();
    expect(spy).toHaveBeenCalledTimes(1);
    await next.release();
  });

  it('does not grow process memory by one compiler per cancelled request', async () => {
    let t = 1_000;
    const pool = new ClientPool({ connectionString: URL, max: 1, staleLeaseMs: 50, now: () => t });
    const cycle = async () => {
      const lease = await pool.acquire(); // never released: its request was cancelled
      stubScope(lease);
      await lease.client.$queryRaw`SELECT 1`;
      t += 60;
    };
    await cycle(); // first client pays for the wasm module itself
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 25; i++) await cycle();
    const grown = (process.memoryUsage().rss - before) / 1e6;
    // Leaked: 25 x ~4.5 MB = ~110 MB. Freed: a few MB.
    expect(grown).toBeLessThan(50);
    expect(pool.stats().abandoned).toBe(25);
  }, 60_000);
});
