/**
 * TEN-4 coverage: every credential-class route runs `requireRecentLogin`, and that guard refuses a token with a stale or missing
 * `auth_time`. One negative case per route, run through the route's OWN middleware chain (so a route that loses the guard, or a
 * new guarded route nobody listed here, fails this file). The positive path (a fresh sign-in passes) is exercised by the
 * integration and workerd suites with identity tokens (tests/helpers/identity-session.ts, workers-test/helpers.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import merchantKeyRoutes from '@api/routes/merchant-key.routes';
import agentCredentialRoutes from '@api/routes/agent-credential.routes';
import paymentSettingsRoutes from '@api/routes/payment-settings.routes';
import staffRoutes from '@api/routes/staff.routes';
import notificationRoutes from '@api/routes/notification.routes';
import { requireRecentLogin, STEP_UP_MAX_AGE_SECONDS } from '@api/middleware/require-mfa';

type Layer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
};

/** The guarded routes, enumerated from the route files (`requireRecentLogin,` in each chain). */
const GUARDED: Array<{ family: string; router: unknown; method: string; path: string }> = [
  {
    family: 'merchant keys',
    router: merchantKeyRoutes,
    method: 'post',
    path: '/:id/integrations/merchant-keys',
  },
  {
    family: 'merchant keys',
    router: merchantKeyRoutes,
    method: 'put',
    path: '/:id/integrations/merchant-mcp/write-switch',
  },
  {
    family: 'merchant keys',
    router: merchantKeyRoutes,
    method: 'delete',
    path: '/:id/integrations/merchant-keys/:keyId',
  },
  {
    family: 'agent key',
    router: agentCredentialRoutes,
    method: 'post',
    path: '/:id/integrations/agent-key',
  },
  {
    family: 'agent key',
    router: agentCredentialRoutes,
    method: 'delete',
    path: '/:id/integrations/agent-key',
  },
  {
    family: 'payment settings',
    router: paymentSettingsRoutes,
    method: 'post',
    path: '/store/:storeId',
  },
  {
    family: 'payment settings',
    router: paymentSettingsRoutes,
    method: 'put',
    path: '/store/:storeId/:provider/credentials',
  },
  { family: 'staff', router: staffRoutes, method: 'post', path: '/' },
  { family: 'staff', router: staffRoutes, method: 'delete', path: '/invites/:inviteId' },
  { family: 'staff', router: staffRoutes, method: 'delete', path: '/:userId' },
  {
    family: 'notification channels',
    router: notificationRoutes,
    method: 'put',
    path: '/:storeId/notifications/configs/:channel',
  },
  {
    family: 'notification channels',
    router: notificationRoutes,
    method: 'delete',
    path: '/:storeId/notifications/configs/:channel',
  },
];

const chainOf = (router: unknown, method: string, path: string) =>
  (router as { stack: Layer[] }).stack
    .find(l => l.route?.path === path && l.route.methods[method])
    ?.route?.stack.map(h => h.handle as (...a: unknown[]) => unknown) ?? null;

/** Run one handler as Express would; resolves with what it passed to next(). */
const run = (h: (...a: unknown[]) => unknown, req: Partial<Request>) =>
  new Promise<unknown>(resolve => {
    const next: NextFunction = err => resolve(err ?? 'next');
    void h(req, {} as Response, next);
  });

describe('credential-class routes are behind requireRecentLogin (TEN-4)', () => {
  it('the list covers every guarded route in the route files (a new guarded route must be added here)', () => {
    const dir = join(__dirname, '../../apps/api/src/routes');
    let found = 0;
    for (const f of readdirSync(dir))
      if (f.endsWith('.routes.ts'))
        found += (readFileSync(join(dir, f), 'utf8').match(/^\s*requireRecentLogin,/gm) ?? [])
          .length;
    expect(found).toBe(GUARDED.length);
  });

  for (const g of GUARDED) {
    describe(`${g.family}: ${g.method.toUpperCase()} ${g.path}`, () => {
      const chain = chainOf(g.router, g.method, g.path);

      it('has requireRecentLogin in its chain', () => {
        expect(chain, 'route not found').not.toBeNull();
        expect(chain!.includes(requireRecentLogin as never)).toBe(true);
      });

      it('refuses a token with no auth_time (403 STEP_UP_REQUIRED)', async () => {
        const guard = chain!.find(h => h === (requireRecentLogin as never))!;
        expect(await run(guard, {})).toMatchObject({ statusCode: 403, code: 'STEP_UP_REQUIRED' });
      });

      it('refuses a stale sign-in (older than the step-up window)', async () => {
        const guard = chain!.find(h => h === (requireRecentLogin as never))!;
        const stale = Math.floor(Date.now() / 1000) - STEP_UP_MAX_AGE_SECONDS - 60;
        const req = { accountsAuthTime: stale } as Partial<Request>;
        expect(await run(guard, req)).toMatchObject({ statusCode: 403, code: 'STEP_UP_REQUIRED' });
      });

      it('lets a fresh sign-in through', async () => {
        const guard = chain!.find(h => h === (requireRecentLogin as never))!;
        const req = { accountsAuthTime: Math.floor(Date.now() / 1000) } as Partial<Request>;
        expect(await run(guard, req)).toBe('next');
      });
    });
  }

  it('the guard itself is unchanged: fail closed on a missing claim', () => {
    const next = vi.fn();
    requireRecentLogin({} as Request, {} as Response, next);
    expect(next.mock.calls[0][0]).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
});
