/**
 * The COMBINATION: commit-before-respond (#1596) AND post-commit deferred work
 * (#1587), in one request, asserted by observed ORDER.
 *
 * Each change shipped with its own tests and each was correct alone. Neither
 * had a test for the two together, and "together" is where the only real
 * decision in the merge lives — there are three events and only one ordering
 * of them is right:
 *
 *     COMMIT  →  response released to the client  →  deferred work drains
 *
 * Get it wrong in one direction (drain before the commit) and you are back to
 * P2028: a return-confirmation email that silently never sends. Get it wrong
 * in the other (drain before the flush) and every merchant pays an email
 * round-trip of latency on the request that triggered it — a regression the
 * OLD commit-on-`finish` wiring did not have, so it would be a merge that made
 * things worse while both halves' own suites stayed green.
 *
 * This file drives the REAL `tenantContext` middleware — not a hand-rolled
 * copy of its wiring — over a real HTTP socket, and records four kinds of
 * event into one shared array:
 *
 *   - `commit` / `rollback` / `commit-failed` — from a fake interactive
 *     transaction standing in for `runInTenantContext` (no DB in a unit test);
 *   - `released`         — the captured `res.end` being replayed, i.e. the exact
 *     instant the response stops being held back. This, not `res.on('finish')`,
 *     is the event the ordering is about: `finish` fires when the kernel has
 *     the bytes, which is a macrotask later, so against a MOCKED (microtask-
 *     fast) transaction a correct drain can legitimately precede it. Against a
 *     real Postgres it does not — see the integration file;
 *   - `flush`            — `res.on('finish')`, kept for the streaming lane where
 *     it is the event that settles the transaction;
 *   - `client-received`  — pushed by the test client once it has the body;
 *   - `deferred:*`       — pushed from inside a `deferAfterTenantCommit` task.
 *
 * The real-Postgres half of this (fresh transaction, both GUCs re-established,
 * read-your-own-committed-write) is `tests/integration/deferred-work-lifecycle.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

/** Ordered log of tx + socket + deferred-work events for one request. */
let events: string[] = [];

/**
 * Recorded `runInTenantContext` invocations, in order. Call 0 is the REQUEST
 * transaction; every later call is one deferred task's own FRESH transaction,
 * which is what lets the GUC arguments be asserted separately.
 */
let txCalls: Array<{ storeId: string | undefined; userId: string | undefined }> = [];

/** Set per test to make the request transaction's COMMIT itself fail. */
let failCommit = false;

const runInTenantContextMock = vi.hoisted(() =>
  vi.fn(
    async (_storeId: string | undefined, _fn: () => Promise<unknown>, _userId?: string) => undefined
  )
);

vi.mock('@ebda/database', () => ({
  runInTenantContext: (...args: [string | undefined, () => Promise<unknown>, string?]) =>
    runInTenantContextMock(...args),
  // `after-tenant-commit.ts` imports this for the boot-time detector; the
  // middleware path never calls it.
  onClosedTenantTxAccess: vi.fn(),
}));

vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn().mockResolvedValue('sent') }));

import { tenantContext } from '../tenant-context';
import { deferAfterTenantCommit } from '../../lib/after-tenant-commit';

const STORE_ID = '3f1c2b7a-9d44-4c1e-8b62-0a5e7d9c1234';
const USER_ID = '7c9e6d51-2a83-4f0b-9d17-5e2c8a4b6def';

beforeEach(() => {
  events = [];
  txCalls = [];
  failCommit = false;
  runInTenantContextMock.mockReset();
  runInTenantContextMock.mockImplementation(
    async (storeId: string | undefined, fn: () => Promise<unknown>, userId?: string) => {
      const index = txCalls.length;
      txCalls.push({ storeId, userId });
      // The FIRST transaction of a request is the request's own; every later
      // one belongs to a drained task. Only the request transaction reports
      // commit/rollback, so the event log stays about the thing under test.
      const isRequestTx = index === 0;
      try {
        await fn();
      } catch (err) {
        if (isRequestTx) events.push('rollback');
        throw err;
      }
      if (isRequestTx && failCommit) {
        events.push('commit-failed');
        throw new Error('COMMIT failed: connection lost');
      }
      if (isRequestTx) events.push('commit');
      return undefined;
    }
  );
});

/** Mount `/stores/:storeId/probe` exactly as a store-scoped route is mounted. */
function buildApp(handler: (req: Request, res: Response, next: NextFunction) => void) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.on('finish', () => events.push('flush'));
    // Patched BEFORE `tenantContext` runs, so `request-transaction.ts` binds
    // THIS as its `originalEnd`. Replaying the captured response therefore
    // lands here, giving an exact marker for "the bytes are no longer held".
    const realEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
    res.end = function (this: Response, ...args: unknown[]): Response {
      events.push('released');
      realEnd(...args);
      return this;
    } as Response['end'];
    // Stand in for `authenticate`: `tenantContext` reads `req.user?.userId` to
    // set the `app.current_user_id` GUC, and carrying it into the deferred
    // task's fresh transaction is half of what this file proves.
    req.user = { userId: USER_ID, email: 'probe@example.test', role: 'store_admin' };
    next();
  });
  app.get('/stores/:storeId/probe', tenantContext, handler);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: err.message } });
  });
  return app;
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/** Poll until `check()` holds, or fail loudly with the event log. */
async function waitFor(check: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
  if (!check()) throw new Error(`waitFor timed out; events=${JSON.stringify(events)}`);
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * The event log without `flush`. `res.on('finish')` is a macrotask behind the
 * `res.end` that causes it, so on the buffered lane — where the transaction is
 * a microtask-fast mock — its position says nothing about the ordering under
 * test. `released` is the honest marker; see the header.
 */
const ordering = (): string[] => events.filter(e => e !== 'flush');

// ---------------------------------------------------------------------------
// The ordering itself
// ---------------------------------------------------------------------------

describe('COMMIT → response → deferred work (buffered lane)', () => {
  it('drains deferred work strictly after the commit AND after the flush', async () => {
    const app = buildApp((_req, res) => {
      void deferAfterTenantCommit('probe', async () => {
        events.push('deferred:ran');
      });
      res.status(201).json({ ok: true });
    });

    await withServer(app, async base => {
      const r = await fetch(`${base}/stores/${STORE_ID}/probe`);
      expect(r.status).toBe(201);
      await r.json();
      events.push('client-received');
    });
    await waitFor(() => events.includes('deferred:ran'));

    // Both halves in one line. `commit` before `released` is #1596;
    // `deferred:ran` after both is #1587 surviving the merge. Move the drain in
    // front of the release and this becomes
    // ['commit', 'deferred:ran', 'released'].
    expect(ordering().slice(0, 3)).toEqual(['commit', 'released', 'deferred:ran']);
    expect(events).toContain('client-received');
    // The response really did reach the socket, not just `res.end`.
    expect(events).toContain('flush');
  });

  it('re-establishes the SAME storeId and userId in the deferred task’s fresh transaction', async () => {
    const app = buildApp((_req, res) => {
      void deferAfterTenantCommit('probe', async () => {
        events.push('deferred:ran');
      });
      res.json({ ok: true });
    });

    await withServer(app, async base => {
      await (await fetch(`${base}/stores/${STORE_ID}/probe`)).json();
    });
    await waitFor(() => events.includes('deferred:ran'));

    // Two transactions: the request's, then one FRESH one per deferred task —
    // carrying the same GUC arguments, not a bare client. Escaping the
    // AsyncLocalStorage context to dodge P2028 would show up here as a missing
    // storeId/userId, i.e. a tenancy bug wearing a transaction bug's clothes.
    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]).toEqual({ storeId: STORE_ID, userId: USER_ID });
    expect(txCalls[1]).toEqual({ storeId: STORE_ID, userId: USER_ID });
  });

  it('drains multiple tasks in registration order, all after the release', async () => {
    const app = buildApp((_req, res) => {
      for (const label of ['first', 'second', 'third']) {
        void deferAfterTenantCommit(`probe.${label}`, async () => {
          events.push(`deferred:${label}`);
        });
      }
      res.json({ ok: true });
    });

    await withServer(app, async base => {
      await (await fetch(`${base}/stores/${STORE_ID}/probe`)).json();
    });
    await waitFor(() => events.includes('deferred:third'));

    expect(ordering()).toEqual([
      'commit',
      'released',
      'deferred:first',
      'deferred:second',
      'deferred:third',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Deferred work must not sit on the request's latency path
// ---------------------------------------------------------------------------

describe('holdResponse: the response waits for a task the client depends on (S5-12)', () => {
  it('a held task finishes after the commit and BEFORE the response is released', async () => {
    const app = buildApp((_req, res) => {
      void deferAfterTenantCommit(
        'probe.held',
        async () => {
          await sleep(30);
          events.push('deferred:held');
        },
        { holdResponse: true }
      );
      void deferAfterTenantCommit('probe.after', async () => {
        events.push('deferred:after');
      });
      res.json({ ok: true });
    });

    await withServer(app, async base => {
      const r = await fetch(`${base}/stores/${STORE_ID}/probe`);
      await r.json();
      events.push('client-received');
    });
    await waitFor(() => events.includes('deferred:after'));
    expect(ordering().slice(0, 4)).toEqual([
      'commit',
      'deferred:held',
      'released',
      'deferred:after',
    ]);
  });
});

describe('deferred work does not block the response', () => {
  it('the client has its body while a slow deferred task is still running', async () => {
    const app = buildApp((_req, res) => {
      void deferAfterTenantCommit('probe.slow', async () => {
        events.push('deferred:start');
        await sleep(250);
        events.push('deferred:end');
      });
      res.json({ ok: true });
    });

    const elapsed = await withServer(app, async base => {
      const t0 = Date.now();
      const r = await fetch(`${base}/stores/${STORE_ID}/probe`);
      await r.json();
      events.push('client-received');
      return Date.now() - t0;
    });
    await waitFor(() => events.includes('deferred:end'));

    // THE assertion: the response was delivered mid-task. Drain before the
    // release and `client-received` lands after `deferred:end` instead.
    expect(events.indexOf('client-received')).toBeLessThan(events.indexOf('deferred:end'));
    // ...and the client did not pay the task's 250ms. Generous bound so this
    // fails on a real regression, not on a loaded machine.
    expect(elapsed).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Failure paths: the queued work must be DROPPED, not run against ghosts
// ---------------------------------------------------------------------------

describe('a transaction that does not commit drops its deferred work', () => {
  it('a 5xx handler rolls back and the deferred task never runs', async () => {
    const app = buildApp((_req, res) => {
      void deferAfterTenantCommit('probe.shouldNotRun', async () => {
        events.push('deferred:ran');
      });
      res.status(500).json({ ok: false });
    });

    const status = await withServer(
      app,
      async base => (await fetch(`${base}/stores/${STORE_ID}/probe`)).status
    );
    // Give the drain every chance to (incorrectly) happen.
    await sleep(200);

    expect(status).toBe(500);
    expect(ordering()).toEqual(['rollback', 'released']);
    expect(events).not.toContain('deferred:ran');
    // Only the request transaction was ever opened — no fresh one for a task.
    expect(txCalls).toHaveLength(1);
  });

  it('a COMMIT that fails becomes a 500 AND drops the deferred task', async () => {
    failCommit = true;
    const app = buildApp((_req, res) => {
      void deferAfterTenantCommit('probe.shouldNotRun', async () => {
        events.push('deferred:ran');
      });
      res.status(201).json({ orderId: 'ord_1' });
    });

    const out = await withServer(app, async base => {
      const r = await fetch(`${base}/stores/${STORE_ID}/probe`);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    });
    await sleep(200);

    // #1596's headline, unchanged by the merge: the client is told the truth.
    expect(out.status).toBe(500);
    expect(out.body).not.toMatchObject({ orderId: 'ord_1' });
    // ...and #1587's drop rule covers a failed COMMIT, not just a 5xx handler:
    // the rows the task would react to were never written.
    expect(events).not.toContain('deferred:ran');
    expect(txCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// STREAMING lane — the deliberately excluded shape still drains
// ---------------------------------------------------------------------------

describe('streaming lane keeps commit-after-flush and still drains deferred work', () => {
  it('a chunked response arrives whole, commits after the flush, then drains', async () => {
    const chunks = ['header\n', 'row-1\n', 'row-2\n', 'row-3\n'];
    const app = buildApp(async (_req, res) => {
      void deferAfterTenantCommit('probe.afterStream', async () => {
        events.push('deferred:ran');
      });
      res.setHeader('Content-Type', 'text/csv');
      for (const c of chunks) {
        res.write(c);
        await sleep(5);
      }
      res.end();
    });

    const text = await withServer(app, async base =>
      (await fetch(`${base}/stores/${STORE_ID}/probe`)).text()
    );
    await waitFor(() => events.includes('deferred:ran'));

    // Not truncated — the exclusion exists to protect exactly this.
    expect(text).toBe(chunks.join(''));
    // Old order preserved on this lane (the response goes out first and
    // `res.on('finish')` is what settles the transaction), and the drain still
    // lands last. `flush` is deterministic here precisely because it is the
    // trigger, so it is asserted rather than filtered out.
    expect(events).toEqual(['released', 'flush', 'commit', 'deferred:ran']);
    expect(txCalls[1]).toEqual({ storeId: STORE_ID, userId: USER_ID });
  });
});

// ---------------------------------------------------------------------------
// Client disconnect
// ---------------------------------------------------------------------------

describe('client disconnect', () => {
  // issue 1604: a disconnect now ROLLS BACK (it used to commit whatever half
  // of the handler had run). The writes the deferred work would react to do
  // not exist, so it is dropped — the same decision as any rolled-back request.
  it('an aborted request rolls back and drops its deferred work', async () => {
    let released!: () => void;
    const gate = new Promise<void>(r => {
      released = r;
    });
    const app = buildApp(async (_req, res) => {
      void deferAfterTenantCommit('probe.afterAbort', async () => {
        events.push('deferred:ran');
      });
      await gate;
      res.json({ ok: true });
    });

    await withServer(app, async base => {
      const ac = new AbortController();
      const p = fetch(`${base}/stores/${STORE_ID}/probe`, { signal: ac.signal }).catch(
        () => undefined
      );
      await sleep(30);
      ac.abort();
      await p;
      await sleep(50);
      released();
      await waitFor(() => events.includes('rollback'));
      await sleep(50);
    });

    expect(events).toContain('rollback');
    expect(events).not.toContain('commit');
    expect(events).not.toContain('deferred:ran');
  });
});
