/**
 * Deferred post-response work vs. commit-before-respond — against a real Postgres.
 *
 * Two changes landed independently on `middleware/tenant-context.ts`:
 *
 *   - #1587 runs `deferAfterTenantCommit()` work AFTER the request's tenant
 *     transaction, in a FRESH transaction carrying the same GUCs (without it,
 *     a fire-and-forget promise inherits the closing transaction and dies with
 *     P2028 inside a swallowed `.catch` — that is what silently killed every
 *     return-confirmation email);
 *   - #1596 moved the COMMIT to BEFORE the response is flushed.
 *
 * Each was correct alone and each had its own tests. Nothing tested the two
 * TOGETHER, and together is where the ordering decision lives:
 *
 *     COMMIT  →  response released to the client  →  deferred work drains
 *
 * `apps/api/src/middleware/__tests__/deferred-work-lifecycle.test.ts` pins that
 * order on a socket with a fake transaction. This file pins the half a fake
 * transaction cannot reach:
 *
 *   1. the deferred task can READ THE ROW the request wrote — from a fresh
 *      transaction on a different connection, which is only possible if the
 *      COMMIT genuinely happened first;
 *   2. BOTH RLS GUCs (`app.current_store_id`, `app.current_user_id`) are
 *      re-established inside that fresh transaction, read back with
 *      `current_setting(...)` rather than inferred from a mock's arguments —
 *      escaping AsyncLocalStorage for a bare client would pass a mock and fail
 *      here, which is the whole point;
 *   3. a real HTTP client gets its response while the task is still running;
 *   4. a rolled-back request leaves NO row and drains NOTHING;
 *   5. the streaming lane still delivers every byte and still drains.
 *
 * Retry-safety (vitest `retry: 1` re-runs the body against the SAME database):
 * every row this file creates gets a per-CALL unique id, never a per-file one.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { prisma, withRlsBypass } from '@ebda/database';
import { tenantContext } from '@api/middleware/tenant-context';
import { deferAfterTenantCommit } from '@api/lib/after-tenant-commit';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

/** Per-CALL unique id — never hoisted to file scope (retry-safety). */
function uid(label: string): string {
  return `${label}-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Probe {
  outcome?: 'ok' | 'error';
  error?: string;
  /** Row id the request created, so the test can assert on it directly. */
  createdId?: string;
  /** Whether the deferred task could SEE that row. */
  sawOwnWrite?: boolean;
  /** `current_setting('app.current_store_id')` inside the deferred task. */
  gucStoreId?: string;
  /** `current_setting('app.current_user_id')` inside the deferred task. */
  gucUserId?: string;
  ranAt?: number;
  startedAt?: number;
  endedAt?: number;
}

interface GucRow {
  store: string | null;
  usr: string | null;
}

/** Read both RLS GUCs from whatever transaction is ambient right now. */
async function readGucs(): Promise<GucRow> {
  const rows = await prisma.$queryRawUnsafe<GucRow[]>(
    "SELECT current_setting('app.current_store_id', true) AS store, " +
      "current_setting('app.current_user_id', true) AS usr"
  );
  return rows[0];
}

/** Issue one GET and wait for the body to be fully consumed. */
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

/** Poll until `check()` holds or the budget runs out. */
async function waitFor(check: () => boolean, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
}

describe.skipIf(!hasDb)('deferred work vs. commit-before-respond', () => {
  let storeId: string;
  let ownerId: string;
  let server: http.Server;
  let port: number;

  let probe: Probe;
  let responseFinishedAt: number | undefined;
  /** Released by the test to let the /abort handler finish after a disconnect. */
  let abortGateRelease: (() => void) | undefined;

  /** Create one affiliate row on the AMBIENT (request) transaction. */
  async function createAffiliate(): Promise<string> {
    const tag = uid('deferred-probe');
    const row = await prisma.affiliate.create({
      data: {
        storeId,
        name: 'Deferred Lifecycle Probe',
        email: `${tag}@example.test`,
        referralCode: tag.replace(/[^a-z0-9]/g, '').slice(0, 40),
        status: 'pending',
      },
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    const suffix = uid('deferred-lifecycle');
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `${suffix}@example.test`,
          passwordHash: 'not-a-real-hash',
          firstName: 'Deferred',
          lastName: 'Lifecycle',
          role: 'store_admin',
        },
        select: { id: true },
      });
      ownerId = owner.id;
      const store = await tx.store.create({
        data: { name: 'Deferred Lifecycle Store', slug: suffix, ownerId: owner.id },
        select: { id: true },
      });
      storeId = store.id;
    });

    const app = express();
    // Stand in for `authenticate`: `tenantContext` reads `req.user?.userId` to
    // set `app.current_user_id`, and asserting that GUC is half this file.
    app.use((req, _res, next) => {
      req.user = { userId: ownerId, email: `${suffix}@example.test`, role: 'store_admin' };
      next();
    });

    // (1) Writes a row, then defers a task that must read it back and report
    //     the GUCs it is running under.
    app.get('/committed/:storeId', tenantContext, (_req, res) => {
      // Bind THIS request's probe: a task still in flight when the next test
      // starts must write to the probe it belongs to, never the next one's.
      const p = probe;
      void (async () => {
        const createdId = await createAffiliate();
        p.createdId = createdId;
        void deferAfterTenantCommit('test.readsOwnWrite', async () => {
          const found = await prisma.affiliate.findUnique({
            where: { id: createdId },
            select: { id: true },
          });
          const gucs = await readGucs();
          p.sawOwnWrite = found !== null;
          p.gucStoreId = gucs.store ?? undefined;
          p.gucUserId = gucs.usr ?? undefined;
          p.outcome = 'ok';
          p.ranAt = Date.now();
        }).catch((err: unknown) => {
          p.outcome = 'error';
          p.error = err instanceof Error ? err.message : String(err);
        });
        res.on('finish', () => {
          responseFinishedAt = Date.now();
        });
        res.status(201).json({ ok: true, id: createdId });
      })().catch(err => {
        p.outcome = 'error';
        p.error = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.status(500).json({ ok: false });
      });
    });

    // (2) A deliberately slow task: the client must not wait for it.
    app.get('/slow/:storeId', tenantContext, (_req, res) => {
      // Bind THIS request's probe: a task still in flight when the next test
      // starts must write to the probe it belongs to, never the next one's.
      const p = probe;
      void deferAfterTenantCommit('test.slow', async () => {
        p.startedAt = Date.now();
        await new Promise(r => setTimeout(r, 400));
        await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
        p.endedAt = Date.now();
        p.outcome = 'ok';
      }).catch(() => {
        p.outcome = 'error';
      });
      res.json({ ok: true });
    });

    // (3) Writes a row and THEN 5xxes: the transaction rolls back, so both the
    //     row and the deferred work must vanish.
    app.get('/failing/:storeId', tenantContext, (_req, res) => {
      // Bind THIS request's probe: a task still in flight when the next test
      // starts must write to the probe it belongs to, never the next one's.
      const p = probe;
      void (async () => {
        const createdId = await createAffiliate();
        p.createdId = createdId;
        void deferAfterTenantCommit('test.shouldNotRun', async () => {
          p.outcome = 'ok';
          p.ranAt = Date.now();
        });
        res.status(500).json({ ok: false });
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ ok: false });
      });
    });

    // (4) The escalated STREAMING lane, which still settles on `finish`.
    app.get('/streaming/:storeId', tenantContext, (_req, res) => {
      // Bind THIS request's probe: a task still in flight when the next test
      // starts must write to the probe it belongs to, never the next one's.
      const p = probe;
      void (async () => {
        void deferAfterTenantCommit('test.afterStream', async () => {
          const gucs = await readGucs();
          p.gucStoreId = gucs.store ?? undefined;
          p.gucUserId = gucs.usr ?? undefined;
          p.outcome = 'ok';
          p.ranAt = Date.now();
        }).catch(() => {
          p.outcome = 'error';
        });
        res.setHeader('Content-Type', 'text/csv');
        res.on('finish', () => {
          responseFinishedAt = Date.now();
        });
        for (let i = 0; i < 20; i++) {
          // A DB read BETWEEN chunks — the reason this lane may not commit
          // first. It must still be inside the tenant transaction.
          await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
          res.write(`row-${i}\n`);
        }
        res.end();
      })().catch(() => {
        if (!res.headersSent) res.status(500).end();
      });
    });

    // (5) Client disconnect: the handler is held open until the test releases
    //     it, well after the socket is gone.
    app.get('/abort/:storeId', tenantContext, (_req, res) => {
      // Bind THIS request's probe: a task still in flight when the next test
      // starts must write to the probe it belongs to, never the next one's.
      const p = probe;
      void (async () => {
        void deferAfterTenantCommit('test.afterAbort', async () => {
          await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
          p.outcome = 'ok';
          p.ranAt = Date.now();
        }).catch(() => {
          p.outcome = 'error';
        });
        await new Promise<void>(resolve => {
          abortGateRelease = resolve;
        });
        res.json({ ok: true });
      })().catch(() => undefined);
    });

    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>(r => server?.close(() => r()));
    await withRlsBypass(async tx => {
      await tx.affiliate.deleteMany({ where: { storeId } });
      await tx.store.deleteMany({ where: { id: storeId } });
      await tx.user.deleteMany({ where: { id: ownerId } });
    });
  });

  beforeEach(() => {
    probe = {};
    responseFinishedAt = undefined;
    abortGateRelease = undefined;
  });

  // -------------------------------------------------------------------------
  // The combination
  // -------------------------------------------------------------------------

  it('a 201 is a COMMITTED 201, and the deferred task then reads that very row', async () => {
    const res = await get(port, `/committed/${storeId}`);
    expect(res.status).toBe(201);

    // NO barrier. `withRlsBypass` opens its own transaction on its own
    // connection, so it cannot see an uncommitted row at all — this is the
    // commit-before-respond property, measured rather than asserted.
    const row = await withRlsBypass(tx =>
      tx.affiliate.findUnique({ where: { id: probe.createdId! }, select: { id: true } })
    );
    expect(row?.id).toBe(probe.createdId);

    await waitFor(() => probe.outcome !== undefined);
    expect(probe.error).toBeUndefined();
    expect(probe.outcome).toBe('ok');
    // The deferred task ran in a FRESH transaction and still saw the row: it
    // could not have, had it run before the COMMIT.
    expect(probe.sawOwnWrite).toBe(true);
    // ...and it ran after the response was on the wire.
    expect(responseFinishedAt).toBeDefined();
    expect(probe.ranAt!).toBeGreaterThanOrEqual(responseFinishedAt!);
  });

  it('the deferred task runs with BOTH RLS GUCs re-established', async () => {
    await get(port, `/committed/${storeId}`);
    await waitFor(() => probe.outcome !== undefined);

    // Read out of Postgres inside the task's own transaction. Reaching for a
    // bare Prisma client to escape the closed tenant transaction would trade a
    // transaction bug for a TENANCY bug, and it would look like this: empty.
    expect(probe.gucStoreId).toBe(storeId);
    expect(probe.gucUserId).toBe(ownerId);
  });

  it('does not block the response: the client is answered mid-task', async () => {
    const t0 = Date.now();
    const res = await get(port, `/slow/${storeId}`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);

    // The task sleeps 400ms. If the drain were awaited before releasing the
    // response, every merchant would pay that latency on the request that
    // triggered the email.
    //
    // Deliberately NOT asserted: that the task had already STARTED. It begins
    // with a real BEGIN round-trip, so on a fast loopback the client can be
    // answered a hair before the task's first statement — which is the
    // property holding even harder, not failing. Asserting it made this test
    // flake on file order (and vitest's `retry: 1` hid it once).
    expect(probe.endedAt).toBeUndefined();
    expect(elapsed).toBeLessThan(300);

    await waitFor(() => probe.outcome !== undefined);
    expect(probe.outcome).toBe('ok');
  });

  // -------------------------------------------------------------------------
  // Rollback drops both the row and the work
  // -------------------------------------------------------------------------

  it('a 5xx rolls back the row AND drops the deferred work', async () => {
    const res = await get(port, `/failing/${storeId}`);
    expect(res.status).toBe(500);
    // Give the drain every chance to (incorrectly) run.
    await new Promise(r => setTimeout(r, 500));

    expect(probe.outcome).toBeUndefined();
    expect(probe.ranAt).toBeUndefined();
    const row = await withRlsBypass(tx =>
      tx.affiliate.findUnique({ where: { id: probe.createdId! }, select: { id: true } })
    );
    // The row the deferred task would have reacted to genuinely does not exist.
    expect(row).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Streaming lane
  // -------------------------------------------------------------------------

  it('the streaming lane delivers every byte and still drains deferred work', async () => {
    const res = await get(port, `/streaming/${storeId}`);
    expect(res.status).toBe(200);

    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('row-0');
    // The last row is what a commit-first bug on this lane would cut off.
    expect(lines[19]).toBe('row-19');

    await waitFor(() => probe.outcome !== undefined);
    expect(probe.outcome).toBe('ok');
    expect(probe.gucStoreId).toBe(storeId);
    expect(probe.gucUserId).toBe(ownerId);
    expect(responseFinishedAt).toBeDefined();
    expect(probe.ranAt!).toBeGreaterThanOrEqual(responseFinishedAt!);
  });

  // -------------------------------------------------------------------------
  // Client disconnect
  // -------------------------------------------------------------------------

  // issue 1604: a disconnect ROLLS BACK (it used to commit whatever half of the
  // handler had run), so the deferred work — which would react to writes that
  // no longer exist — is dropped with it, exactly like any rollback.
  it('a client that disconnects rolls back and drops its deferred work', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/abort/${storeId}` }, res => {
        res.resume();
      });
      req.on('error', () => resolve());
      setTimeout(() => req.destroy(), 60);
      setTimeout(resolve, 200);
      req.on('close', () => undefined);
      setTimeout(() => {
        if (!abortGateRelease) reject(new Error('handler never reached the gate'));
      }, 5000);
    });

    await waitFor(() => abortGateRelease !== undefined);
    abortGateRelease!();

    // Give a (wrongly) queued task ample time to run before asserting it didn't.
    await new Promise(r => setTimeout(r, 500));
    expect(probe.outcome).toBeUndefined();
  });
});
