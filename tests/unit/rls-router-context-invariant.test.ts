/**
 * RLS Phase 1a regression guard (audit F2 / docs/plans/done/2026-07-02-rls-cutover.md).
 *
 * Background: `apps/api/src/routes/index.ts` mounts ~30 store-scoped
 * routers at BARE prefixes (`/stores`, `/`, `/admin`) rather than
 * `/stores/:storeId/...`. Express only populates `req.params` for params
 * declared in the MOUNT path, so the `tenantContext` middleware passed at
 * those bare mounts was silently a no-op — RLS tenant context was never
 * set for those routers, even though every route within them declares its
 * own `:storeId` (or legacy `:id`) path param.
 *
 * The original Phase 1a fix (PR #499) registered
 * `router.param('storeId'|'id', tenantContext)` INSIDE every affected
 * sub-router file. Express resolves the named param for the matched route
 * BEFORE invoking `.param()` callbacks (verified against express@4.22 —
 * see the live sanity check in this file), so this correctly sets tenant
 * context regardless of how bare the parent mount is. But `tenantContext`
 * → `runInTenantContext` holds a `basePrisma.$transaction` (30s timeout)
 * open for the FULL request, which is harmful for routers that:
 *   (a) already call `runInTenantContext` / `withRlsBypass` per-query
 *       internally (double-nests a second transaction / DB connection), or
 *   (b) do external I/O in-request (Gemini, courier APIs, Resend) that can now blow the 30s tx timeout, or
 *   (c) do fire-and-forget work that outlives the response (the tx
 *       settles as soon as the handler is done — since 2026-09-08 that is
 *       BEFORE the response is flushed, see
 *       middleware/request-transaction.ts — and the detached work then hits
 *       "transaction already closed" (P2028). The supported way to do such
 *       work is `deferAfterTenantCommit`, lib/after-tenant-commit.ts).
 *
 * REWORKED 2026-07-02 (surgical follow-up, same PR #499, blast-radius
 * review): the `router.param(...)` wrapping was REVERTED on every router
 * matching (a)/(b)/(c) above — see the per-mount comments in
 * routes/index.ts for the specific reason each one was reverted. Those
 * routers are now CONTEXT-LESS again (fail-open under the current
 * BYPASSRLS role — same behavior as before PR #499) and are Phase 2
 * candidates: they need per-route (not per-router) tenant-context wiring,
 * or their inner withRlsBypass/runInTenantContext calls rewired to the
 * ALS-aware `prisma` proxy, before it's safe to wrap them.
 *
 * This test is a lightweight static + behavioral regression guard — NOT a
 * full integration test (those require the ebda_app CI job planned for
 * RLS-3). It:
 *   1. Asserts the live Express dependency still resolves route params
 *      before firing `router.param()` callbacks (the core assumption the
 *      whole fix rests on).
 *   2. Asserts every router file that SURVIVED the surgical rework still
 *      contains its expected `router.param(...)` registration(s), so a
 *      future edit can't silently drop the wiring.
 *   3. Documents (and guards) the Phase-2 context-less set so a future
 *      change doesn't silently re-wrap one of them without re-auditing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import express from 'express';

const ROUTES_DIR = path.resolve(__dirname, '../../apps/api/src/routes');

function routerParamRegex(paramName: string): RegExp {
  // Matches router.param('storeId', tenantContext) allowing for either
  // quote style and incidental whitespace.
  return new RegExp(`router\\.param\\(\\s*['"]${paramName}['"]\\s*,\\s*tenantContext\\s*\\)`);
}

describe('RLS Phase 1a — router.param context wiring (audit F2)', () => {
  it('sanity check: Express resolves route params before invoking router.param callbacks', async () => {
    // Reproduces the exact bare-mount shape used across routes/index.ts:
    // an outer middleware at the bare prefix (which never sees the param)
    // plus an inner router.param registration (which does).
    const calls: Array<{ where: string; storeId: string | undefined }> = [];

    const outerNoopMiddleware = (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction
    ) => {
      calls.push({ where: 'outer-bare-mount', storeId: req.params.storeId });
      next();
    };

    const sub = express.Router();
    sub.param('storeId', (req: express.Request, _res, next, value: string) => {
      calls.push({ where: 'router.param', storeId: value });
      expect(req.params.storeId).toBe(value); // param already resolved
      next();
    });
    sub.get('/:storeId/coupons', (req, res) => {
      calls.push({ where: 'handler', storeId: req.params.storeId });
      res.json({ ok: true });
    });

    const app = express();
    app.use('/stores', outerNoopMiddleware, sub);

    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(
        `http://127.0.0.1:${port}/stores/11111111-1111-1111-1111-111111111111/coupons`
      );
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }

    expect(calls.map(c => c.where)).toEqual(['outer-bare-mount', 'router.param', 'handler']);
    // The outer bare-mount middleware never sees storeId (the bug F2 found).
    expect(calls[0].storeId).toBeUndefined();
    // router.param and the handler both see it resolved (the fix).
    expect(calls[1].storeId).toBe('11111111-1111-1111-1111-111111111111');
    expect(calls[2].storeId).toBe('11111111-1111-1111-1111-111111111111');
  });

  // KEPT (surgical rework, 2026-07-02, PR #499): router files whose OWN
  // routes declare `:storeId`, are mounted at a bare '/stores' or '/'
  // prefix in routes/index.ts, do fast DB-only work, and have NO inner
  // runInTenantContext/withRlsBypass call anywhere in their handlers or the
  // services they call. Safe to wrap the whole request in the RLS tx.
  const storeIdFixedFiles = [
    'coupon.routes.ts',
    'shipping.routes.ts',
    'tax.routes.ts',
    'loyalty.routes.ts',
    'pwa.routes.ts',
    'bulk.routes.ts',
    'variant.routes.ts',
    'abandoned-cart.routes.ts',
    'affiliate.routes.ts',
    'pages.routes.ts',
    'blog.routes.ts',
    'locations.routes.ts',
    'warehouse.routes.ts',
  ];

  // No router in the current kept-set uses the legacy ':id' param name or
  // needs BOTH ':id' and ':storeId' registered — every survivor above uses
  // ':storeId' only. (store used ':id'; feature.routes.ts used both — both were REVERTED, see below.)

  it.each(storeIdFixedFiles)('%s registers router.param(storeId, tenantContext)', file => {
    const source = readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
    expect(source).toMatch(routerParamRegex('storeId'));
  });

  it('every kept file also imports tenantContext from the middleware', () => {
    for (const file of storeIdFixedFiles) {
      const source = readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
      expect(source).toMatch(
        /import\s*{\s*tenantContext\s*}\s*from\s*['"]\.\.\/middleware\/tenant-context['"]/
      );
    }
  });

  // REVERTED 2026-07-02 (surgical follow-up, same PR #499): these routers
  // had `router.param(...)` wrapping added in Phase 1a, then reverted
  // because they either (a) already call runInTenantContext/withRlsBypass
  // per-query internally (double-nesting risk), (b) do external I/O
  // in-request (Gemini, courier APIs, Resend, SMS provider),
  // or (c) do fire-and-forget work that can outlive the request tx. They
  // are CONTEXT-LESS today (same as before PR #499 — fail-open under the
  // current BYPASSRLS role) and are Phase 2 candidates: see the per-mount
  // comment in routes/index.ts for the specific reason each one is here.
  const phase2ContextLessFiles = [
    'insights.routes.ts', // (b) Gemini generateInsightNarration in-request
    'finance.routes.ts', // (a) accounting services self-manage context per-query
    'backorders.routes.ts', // (a) same
    'expenses.routes.ts', // (a) same
    'purchase-orders.routes.ts', // (a) same
    'smart-layer.routes.ts', // (a) same
    'stock-adjustments.routes.ts', // (a) same
    'suppliers.routes.ts', // (a) same
    'recommendation.routes.ts', // (c) fire-and-forget recalculateFBT (no await)
    'inventory.routes.ts', // (a) barcode-scan.service reconcileCountSession calls runInTenantContext internally
    'feature.routes.ts', // (a) featureService.readFromDb calls withRlsBypass internally
    'notification.routes.ts', // (a)+(b) notificationConfigService.readFromDb withRlsBypass + testConnection external SMS API
    'store.routes.ts', // (b) domain provisioning calls Vercel/Cloudflare/Resend APIs in-request
    'newsletter.routes.ts', // (b) chunked loop of StoreMailer.sendBrandedEmail calls in-request
  ];

  it.each(phase2ContextLessFiles)(
    '%s stays context-less (no router.param(..., tenantContext) — Phase 2 candidate)',
    file => {
      const source = readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
      expect(source).not.toMatch(routerParamRegex('storeId'));
      expect(source).not.toMatch(routerParamRegex('id'));
    }
  );

  // SP7: the shipping-carrier router calls courier APIs in-request AND must run under strict
  // RLS, so it picks its context per request (`shippingCarrierRouteContext`: reads one
  // transaction, carrier calls and writes store scope) and registers it itself.
  const scopedByOwnContextFiles = ['shipping-carrier.routes.ts'];

  it.each(scopedByOwnContextFiles)(
    '%s registers router.param(storeId, shippingCarrierRouteContext)',
    file => {
      const source = readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
      expect(source).toMatch(
        /router\.param\(\s*['"]storeId['"]\s*,[\s\S]*?shippingCarrierRouteContext\(/
      );
    }
  );

  it('kept-set + phase2 context-less set together account for every router touched by PR #499', () => {
    // admin.routes.ts is intentionally excluded from both lists — it was
    // never fixed (see the comment in routes/index.ts above the '/admin'
    // mount) because it reuses ':id' for unrelated cross-tenant entities.
    expect(
      storeIdFixedFiles.length + phase2ContextLessFiles.length + scopedByOwnContextFiles.length
    ).toBe(28);
  });
});
