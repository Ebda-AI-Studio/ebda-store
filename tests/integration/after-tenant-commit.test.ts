/**
 * Post-response work vs. the per-request tenant transaction (P2028 guard)
 *
 * `middleware/tenant-context.ts` runs each store-scoped request inside ONE
 * Prisma interactive transaction held in AsyncLocalStorage and commits it on
 * `res.on('finish')` — AFTER the response is flushed. A fire-and-forget
 * promise started in the handler inherits that context, so its Prisma calls
 * land on an already-committed transaction:
 *
 *   Transaction API error: Transaction already closed: A query cannot be
 *   executed on a committed transaction.   (P2028)
 *
 * Every such call site wraps itself in a logging `.catch`, so the work
 * silently never happened. This suite:
 *
 *   1. REPRODUCES the defect with the raw `void prisma.…` pattern, so the
 *      class is pinned down by an executable fact rather than a comment.
 *   2. Proves `deferAfterTenantCommit` runs the same work successfully, and
 *      only AFTER the response has finished (revert the `withDeferredWork`
 *      wiring in tenant-context.ts and the ordering assertion reddens: the
 *      task runs inline, before the response).
 *   3. Proves the closed-transaction detector fires, so a site we missed is
 *      loud instead of silent.
 *   4. Proves a 5xx (rolled-back) request DROPS its deferred work.
 *
 * Runs only against a real Postgres (integration/CI); skipped otherwise.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import {
  prisma,
  runInTenantContext,
  withRlsBypass,
  onClosedTenantTxAccess,
  type ClosedTenantTxAccess,
} from '@force/database';
import { tenantContext } from '@api/middleware/tenant-context';
import { deferAfterTenantCommit } from '@api/lib/after-tenant-commit';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

interface Probe {
  outcome?: 'ok' | 'error';
  errorCode?: string;
  /** Set when the work ran; compared against `responseFinishedAt` for ordering. */
  ranAt?: number;
}

/** Issue one GET and wait for the response body to be fully consumed. */
function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

/** Poll until `check()` is true or the budget runs out. */
async function waitFor(check: () => boolean, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
}

describe.skipIf(!hasDb)('post-response work and the tenant transaction', () => {
  let storeId: string;
  let ownerId: string;
  let server: http.Server;
  let port: number;

  // Mutated by the routes below; reset per test.
  let probe: Probe;
  let responseFinishedAt: number | undefined;
  let deferredOrder: string[];

  beforeAll(async () => {
    const suffix = `${Date.now()}-${process.pid}`;
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `p2028-${suffix}@example.com`,
          passwordHash: 'x',
          firstName: 'P2028',
          lastName: 'Probe',
          role: 'store_admin',
        },
        select: { id: true },
      });
      ownerId = owner.id;
      const store = await tx.store.create({
        data: { name: 'P2028 Probe Store', slug: `p2028-${suffix}`, ownerId: owner.id },
        select: { id: true },
      });
      storeId = store.id;
    });

    const app = express();

    // (1) The defect, verbatim: a detached promise that queries Prisma once
    //     the response has flushed.
    app.get('/raw/:storeId', tenantContext, (_req, res) => {
      void (async () => {
        await new Promise(r => setTimeout(r, 25));
        await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
      })().then(
        () => {
          probe.outcome = 'ok';
        },
        (err: unknown) => {
          probe.outcome = 'error';
          probe.errorCode = (err as { code?: string })?.code;
        }
      );
      res.on('finish', () => {
        responseFinishedAt = Date.now();
      });
      res.json({ ok: true });
    });

    // (2) The same work, routed through the fix.
    app.get('/deferred/:storeId', tenantContext, (_req, res) => {
      void deferAfterTenantCommit('test.probe', async () => {
        await new Promise(r => setTimeout(r, 25));
        await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
        probe.outcome = 'ok';
        probe.ranAt = Date.now();
      }).catch((err: unknown) => {
        probe.outcome = 'error';
        probe.errorCode = (err as { code?: string })?.code;
      });
      res.on('finish', () => {
        responseFinishedAt = Date.now();
      });
      res.json({ ok: true });
    });

    // (3) Deferred work must observe rows the request wrote — it runs after
    //     the commit, in a fresh transaction, so an uncommitted read would
    //     come back empty.
    app.get('/writes-then-defers/:storeId', tenantContext, (_req, res) => {
      void (async () => {
        const created = await prisma.affiliate.create({
          data: {
            storeId,
            name: 'Deferred Read Probe',
            email: `deferred-read-${Date.now()}-${process.pid}@example.com`,
            referralCode: `dr${Date.now()}${process.pid}`,
            status: 'pending',
          },
          select: { id: true },
        });
        void deferAfterTenantCommit('test.readsOwnWrite', async () => {
          const found = await prisma.affiliate.findUnique({
            where: { id: created.id },
            select: { id: true },
          });
          probe.outcome = found ? 'ok' : 'error';
          probe.ranAt = Date.now();
        }).catch(() => {
          probe.outcome = 'error';
        });
        res.on('finish', () => {
          responseFinishedAt = Date.now();
        });
        res.json({ ok: true });
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ ok: false });
      });
    });

    // (4) Ordering: deferred tasks drain in registration order.
    app.get('/ordered/:storeId', tenantContext, (_req, res) => {
      for (const label of ['first', 'second', 'third']) {
        void deferAfterTenantCommit(`test.${label}`, async () => {
          await prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
          deferredOrder.push(label);
        });
      }
      res.json({ ok: true });
    });

    // (5) A handler that 5xx's rolls the transaction back — deferred work
    //     reacts to writes that no longer exist and must be dropped.
    app.get('/failing/:storeId', tenantContext, (_req, res) => {
      void deferAfterTenantCommit('test.shouldNotRun', async () => {
        deferredOrder.push('ran-after-rollback');
      });
      res.status(500).json({ ok: false });
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
    deferredOrder = [];
  });

  it('reproduces the defect: a bare fire-and-forget Prisma call fails with P2028', async () => {
    expect(await get(port, `/raw/${storeId}`)).toBe(200);
    await waitFor(() => probe.outcome !== undefined);

    expect(probe.outcome).toBe('error');
    expect(probe.errorCode).toBe('P2028');
  });

  it('deferAfterTenantCommit runs the same work successfully, after the response finished', async () => {
    expect(await get(port, `/deferred/${storeId}`)).toBe(200);
    await waitFor(() => probe.outcome !== undefined);

    expect(probe.errorCode).toBeUndefined();
    expect(probe.outcome).toBe('ok');
    // The whole point: it did NOT run inline inside the request. Revert the
    // `withDeferredWork` wiring in tenant-context.ts and this line reddens
    // (the task executes before the response, so ranAt < responseFinishedAt).
    expect(responseFinishedAt).toBeDefined();
    expect(probe.ranAt).toBeDefined();
    expect(probe.ranAt!).toBeGreaterThanOrEqual(responseFinishedAt!);
  });

  it('deferred work can read rows the request committed', async () => {
    expect(await get(port, `/writes-then-defers/${storeId}`)).toBe(200);
    await waitFor(() => probe.outcome !== undefined);

    expect(probe.outcome).toBe('ok');
  });

  it('drains deferred tasks in registration order', async () => {
    expect(await get(port, `/ordered/${storeId}`)).toBe(200);
    await waitFor(() => deferredOrder.length === 3);

    expect(deferredOrder).toEqual(['first', 'second', 'third']);
  });

  it('drops deferred work when the request rolled the transaction back', async () => {
    expect(await get(port, `/failing/${storeId}`)).toBe(500);
    // Give the drain every chance to (incorrectly) run.
    await new Promise(r => setTimeout(r, 500));

    expect(deferredOrder).toEqual([]);
  });

  it('reports a Prisma call made on an already-committed tenant transaction', async () => {
    const reports: ClosedTenantTxAccess[] = [];
    onClosedTenantTxAccess(info => {
      reports.push(info);
    });
    try {
      let detached: Promise<unknown> | undefined;
      await runInTenantContext(storeId, async () => {
        detached = (async () => {
          await new Promise(r => setTimeout(r, 25));
          return prisma.store.findUnique({ where: { id: storeId }, select: { id: true } });
        })();
      });
      await expect(detached).rejects.toMatchObject({ code: 'P2028' });
    } finally {
      onClosedTenantTxAccess(null);
    }

    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0].property).toBe('store');
    expect(reports[0].stack).toContain('after-tenant-commit.test');
  });

  it('runs inline (returning its result) when there is no tenant transaction', async () => {
    const run = vi.fn(async () => 'inline-result');
    await expect(deferAfterTenantCommit('test.inline', run)).resolves.toBe('inline-result');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
