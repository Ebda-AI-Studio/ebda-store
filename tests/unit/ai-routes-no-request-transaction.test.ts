/**
 * EBDA-API-2G (issue 2469) — "Transaction already closed … timeout was
 * 30000 ms, however 66772 ms passed", breadcrumb `prisma.aiUsage.create()`.
 *
 * `tenantContext` holds one interactive transaction from BEGIN to the response
 * commit and Prisma expires it 30s after BEGIN. An AI handler that awaits a
 * slow Gemini call inside it writes its usage row and COMMITS on an expired
 * transaction. The AI WRITES therefore run under `storeScopeContext` (one short
 * transaction per query) instead.
 *
 * The AI READS stay on `tenantContext`, and `aiRouteContext` is what splits
 * them: one short transaction PER QUERY is the wrong trade for a pure-read
 * handler that fans out with `Promise.all`, because each query then takes its
 * own pooled connection (`connection_limit=15`). Both halves are asserted here.
 *
 * The database here is a small model of exactly those rules: a clock the handler
 * advances (no real 66s wait), a transaction that expires 30s after it opened,
 * `runInStoreScope` giving each query a fresh one, and a count of how many
 * transactions a request opened — the real middleware and the real
 * request-transaction lifecycle run on top of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  clock: { now: 0 },
  queriesOnExpiredTx: 0,
  committedWrites: 0,
  /** Transactions opened by the request — one per pooled connection taken. */
  txOpened: 0,
}));

vi.mock('@ebda/database', async () => {
  const { AsyncLocalStorage: ALS } = await import('async_hooks');
  const TX_TIMEOUT_MS = 30_000;
  const tx = new ALS<{ openedAt: number }>();
  const scope = new ALS<{ storeId: string }>();
  const closed = () =>
    new Error(
      `Transaction already closed: A commit cannot be executed on an expired transaction. ` +
        `The timeout for this transaction was ${TX_TIMEOUT_MS} ms`
    );
  const expired = (t: { openedAt: number }) => h.clock.now - t.openedAt > TX_TIMEOUT_MS;
  /** One Prisma model call, routed exactly as the real `prisma` proxy routes it. */
  const query = async () => {
    const open = tx.getStore();
    if (open) {
      // Joins the request transaction — no second connection taken.
      if (expired(open)) {
        h.queriesOnExpiredTx++;
        throw closed();
      }
    } else if (scope.getStore()) {
      // `scopedOp`: its own short tenant transaction, always fresh — and its
      // own pooled connection for as long as it runs.
      h.txOpened++;
    } else {
      // no context at all: auto-commit, nothing to expire
    }
    h.committedWrites++;
    return { id: 'u1' };
  };
  return {
    runInTenantContext: async (_s: string, fn: () => Promise<unknown>) =>
      tx.run({ openedAt: h.clock.now }, async () => {
        h.txOpened++;
        const t = tx.getStore()!;
        const result = await fn();
        if (expired(t)) throw closed(); // the COMMIT
        return result;
      }),
    runInStoreScope: (storeId: string, fn: () => unknown) => scope.run({ storeId }, fn),
    prisma: { aiUsage: { create: query }, product: { count: query } },
    Prisma: {},
  };
});
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prisma } from '@ebda/database';
import { tenantContext, storeScopeContext, aiRouteContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';

const STORE = '11111111-1111-4111-8111-111111111111';

/** Routes shaped like the two halves of the AI router. */
function appWith(contextMiddleware: express.RequestHandler) {
  const router = express.Router({ mergeParams: true });
  // A WRITE: slow model call, then record usage.
  router.post('/translate', async (_req, res, next) => {
    try {
      h.clock.now += 66_772; // the Gemini call that took 66.8s
      await prisma.aiUsage.create({ data: {} } as never);
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });
  // A READ: no third party, but a fan-out of concurrent queries — the shape of
  // every `/results/*` handler (the real `/results/seo` awaits 6 at once).
  router.get('/results/seo', async (_req, res, next) => {
    try {
      await Promise.all([prisma.product.count(), prisma.product.count()]);
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  });
  const a = express();
  a.use(`/stores/:storeId/ai`, contextMiddleware, router);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  h.clock.now = 1_000;
  h.queriesOnExpiredTx = 0;
  h.committedWrites = 0;
  h.txOpened = 0;
});

describe('EBDA-API-2G reproduction', () => {
  it('under tenantContext a >30s model call writes on an expired transaction and the request 500s', async () => {
    const res = await request(appWith(tenantContext)).post(`/stores/${STORE}/ai/translate`);
    expect(res.status).toBe(500);
    expect(h.queriesOnExpiredTx).toBe(1);
    expect(h.committedWrites).toBe(0);
  });

  it('under storeScopeContext the same slow call succeeds and the usage row is written', async () => {
    const res = await request(appWith(storeScopeContext)).post(`/stores/${STORE}/ai/translate`);
    expect(res.status).toBe(200);
    expect(h.queriesOnExpiredTx).toBe(0);
    expect(h.committedWrites).toBe(1);
  });

  it('storeScopeContext passes a request with no usable store id straight through (no scope, no throw)', async () => {
    const res = await request(appWith(storeScopeContext)).post('/stores/public/ai/translate');
    expect(res.status).toBe(200);
  });
});

/**
 * `storeScopeContext` fixes the write half and BREAKS the read half: one short
 * transaction per query means one pooled connection per query, so a read
 * handler's `Promise.all` multiplies its connection demand. `GET /ai/results/seo`
 * fans out 6 queries and the admin AI-tools page fires 9 such endpoints on
 * mount — ~30 concurrent transactions against `connection_limit=15`, which
 * starves unrelated requests on the pod until they fail P2024. Hence the split.
 */
describe('aiRouteContext splits the router by method', () => {
  it('a write still runs outside the request transaction, so the >30s model call lands', async () => {
    const res = await request(appWith(aiRouteContext)).post(`/stores/${STORE}/ai/translate`);
    expect(res.status).toBe(200);
    expect(h.queriesOnExpiredTx).toBe(0);
    expect(h.committedWrites).toBe(1);
  });

  it('a read fan-out shares ONE transaction', async () => {
    const res = await request(appWith(aiRouteContext))
      .get(`/stores/${STORE}/ai/results/seo`)
      .set('Authorization', 'Bearer merchant'); // an admin read carries a credential (an anonymous one takes no transaction, LAZY-TX-3)
    expect(res.status).toBe(200);
    expect(h.committedWrites).toBe(2); // two queries...
    expect(h.txOpened).toBe(1); // ...one transaction, one connection
  });

  it('the same read under storeScopeContext takes a connection PER QUERY (the regression)', async () => {
    const res = await request(appWith(storeScopeContext)).get(`/stores/${STORE}/ai/results/seo`);
    expect(res.status).toBe(200);
    expect(h.txOpened).toBe(2); // one transaction per query — pool pressure
  });
});

describe('the routes that await Gemini are mounted outside the request transaction', () => {
  const index = readFileSync(path.resolve(__dirname, '../../apps/api/src/routes/index.ts'), 'utf8');

  it('/stores/:storeId/ai uses aiRouteContext, not tenantContext', () => {
    expect(index).toContain("router.use('/stores/:storeId/ai', aiRouteContext, aiRoutes);");
    expect(index).not.toContain("'/stores/:storeId/ai', tenantContext");
  });

  /**
   * `aiRouteContext` sends GETs into the request transaction, which is only safe
   * while every GET handler in ai.routes.ts is a pure DB read — a new GET that
   * awaits the model would resurrect EBDA-API-2G. Derive the model-calling
   * identifiers from the file's OWN imports of AI modules (so the list grows by
   * itself as AI helpers are added) and assert no GET block mentions one.
   */
  it('no GET handler in ai.routes.ts reaches a model call', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/routes/ai.routes.ts'),
      'utf8'
    );

    const modelCallers = [...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)]
      .filter(m => /(^|\/)ai([-./]|$)/.test(m[2]))
      .flatMap(m =>
        m[1].split(',').map(
          n =>
            n
              .trim()
              .split(/\s+as\s+/)
              .pop() ?? ''
        )
      )
      .filter(Boolean);
    // Guard the guard: if the import scan silently matches nothing, the
    // assertion below would pass vacuously forever.
    expect(modelCallers).toContain('AIService');

    const starts = [...src.matchAll(/^router\.(get|post|put|patch|delete)\(/gm)];
    const offenders = starts.flatMap((m, i) => {
      if (m[1] !== 'get') return [];
      const block = src.slice(m.index ?? 0, starts[i + 1]?.index ?? src.length);
      const hits = modelCallers.filter(name => new RegExp(`\\b${name}\\b`).test(block));
      return hits.length ? [`${block.split('\n')[0].trim()} → ${hits.join(', ')}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it('campaign ai-draft is mounted before the tenant-scoped campaign router', () => {
    const draft = index.indexOf("router.use('/stores/:storeId/campaigns', campaignAiDraftRouter);");
    const scoped = index.indexOf(
      "router.use('/stores/:storeId/campaigns', tenantContext, campaignRoutes);"
    );
    expect(draft).toBeGreaterThan(-1);
    expect(scoped).toBeGreaterThan(draft);
  });

  it('campaign.routes.ts no longer registers ai-draft on the tenant-scoped router', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/routes/campaign.routes.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/\brouter\.post\(\s*'\/ai-draft'/);
    expect(src).toMatch(/campaignAiDraftRouter\.post\(\s*'\/ai-draft'/);
  });

  /**
   * The assertion above is NOT sufficient on its own: an Express `use` mount is
   * a PREFIX match, so ANY earlier tenantContext mount that captures
   * `/stores/<uuid>/...` opens the request transaction and the request reaches
   * these routers inside it (`/stores/:storeId` + customersRoutes is exactly
   * that — it matched, answered nothing, and fell through). So check every
   * mount, not just the campaign one.
   */
  const TX_OPENING_MOUNT = /^router\.use\(\s*'([^']+)'\s*,\s*tenantContext\b/;
  const CAPTURES_STORE_ID = /(^|\/):(storeId|id)(\/|$)/;

  /** Does this mount path prefix-match `url`? `:param` matches one segment. */
  function prefixMatches(mountPath: string, url: string): boolean {
    const mount = mountPath.split('/').filter(Boolean);
    const target = url.split('/').filter(Boolean);
    if (mount.length > target.length) return false;
    return mount.every((seg, i) => seg.startsWith(':') || seg === target[i]);
  }

  it.each([
    ['ai-draft', 'campaignAiDraftRouter', 'campaigns/ai-draft'],
    ['test send', 'campaignTestSendRouter', 'campaigns/c1/test'],
    ['AI router', 'aiRoutes', 'ai/translate'],
  ])(
    'no tenantContext mount captures the %s path before its own mount',
    (_label, routerName, tail) => {
      const url = `/stores/11111111-1111-4111-8111-111111111111/${tail}`;
      const lines = index.split('\n');
      const own = lines.findIndex(l => l.includes(`${routerName});`));
      expect(own).toBeGreaterThan(-1);

      const capturedBy = lines.slice(0, own).flatMap((line, i) => {
        const m = TX_OPENING_MOUNT.exec(line.trim());
        if (!m) return [];
        // A bare mount (e.g. '/stores') declares no param, so tenantContext
        // there is a no-op and opens nothing — see the F2 note in index.ts.
        if (!CAPTURES_STORE_ID.test(m[1])) return [];
        return prefixMatches(m[1], url) ? [`line ${i + 1}: ${line.trim()}`] : [];
      });
      expect(capturedBy).toEqual([]);
    }
  );
});

describe('a prefix-capturing tenantContext mount in front of the AI router', () => {
  /**
   * Models the real fall-through: `/stores/:storeId` + customersRoutes matches
   * every `/stores/<uuid>/*` URL, so when it answers nothing the request
   * continues to later mounts with the transaction already open.
   * `storeScopeContext` cannot rescue it — the prisma proxy resolves
   * `tenantStorage` before `storeScope` (mirrored by the mock above).
   */
  function appWith(order: 'draft-first' | 'capture-first') {
    const draft = express.Router({ mergeParams: true });
    draft.post('/ai-draft', storeScopeContext, async (_req, res, next) => {
      try {
        h.clock.now += 66_772; // the Gemini call
        await prisma.aiUsage.create({ data: {} } as never);
        res.json({ success: true });
      } catch (e) {
        next(e);
      }
    });
    // Stands in for customersRoutes: only declares `/customers/*` paths.
    const customers = express.Router({ mergeParams: true });
    customers.get('/customers', (_req, res) => {
      res.json({ success: true });
    });

    const a = express();
    const mountDraft = () => a.use('/stores/:storeId/campaigns', draft);
    const mountCapture = () => a.use('/stores/:storeId', tenantContext, customers);
    if (order === 'draft-first') {
      mountDraft();
      mountCapture();
    } else {
      mountCapture();
      mountDraft();
    }
    a.use(errorHandler);
    return a;
  }

  const url = `/stores/${STORE}/campaigns/ai-draft`;

  it('swallows the store scope and reproduces the 30s failure when mounted first', async () => {
    const res = await request(appWith('capture-first')).post(url);
    expect(res.status).toBe(500);
    expect(h.queriesOnExpiredTx).toBe(1);
    expect(h.committedWrites).toBe(0);
  });

  it('is harmless once the AI router is mounted above it', async () => {
    const res = await request(appWith('draft-first')).post(url);
    expect(res.status).toBe(200);
    expect(h.queriesOnExpiredTx).toBe(0);
    expect(h.committedWrites).toBe(1);
  });
});
