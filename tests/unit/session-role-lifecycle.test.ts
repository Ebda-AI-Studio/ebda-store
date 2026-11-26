/**
 * Backfill audit 2026-11-12 (auth/tenancy): TEN-2 impersonator live check + end route, TEN-3 credential-writer guards,
 * TEN-4 recent-login step-up, ID-05 cross-site logout. (ID-02 lives in accounts-token-auth.test.ts, ID-07 in
 * staff-invite-flow.test.ts, ID-06 / ID-08 in apps/accounts/test.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';

const h = vi.hoisted(() => ({
  revokedSids: new Set<string>(),
  accounts: new Map<string, { role: string; status: string } | null>(),
  down: false,
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { isJtiDenied: async () => false, getUserTokenVersion: async () => 0 },
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/lib/definer', () => ({ getUserState: async () => null }));
vi.mock('@api/lib/accounts-token', () => ({
  isAccountsToken: () => false,
  verifyAccountsToken: async () => {
    throw new Error('unused');
  },
  sessionRevoked: async (sid: string) => {
    if (h.down) throw new Error('identity down');
    return h.revokedSids.has(sid);
  },
}));
vi.mock('@api/lib/identity-client', () => ({
  getAccountState: async (id: string) => {
    if (h.down) throw new Error('identity down');
    return h.accounts.get(id) ?? null;
  },
}));

const { assertImpersonatorLive, isCrossSiteAdminRequest } = await import('@api/middleware/auth');
const { requireRecentLogin, STEP_UP_MAX_AGE_SECONDS } = await import('@api/middleware/require-mfa');

beforeEach(() => {
  h.revokedSids = new Set();
  h.accounts = new Map([['sa-1', { role: 'super_admin', status: 'active' }]]);
  h.down = false;
});

describe('TEN-2: the impersonation token is only as alive as the impersonator', () => {
  const tok = { impersonatedBy: 'sa-1', impSid: 'sid-sa' };
  it('passes while the admin session lives and the account is an active super_admin', async () => {
    await expect(assertImpersonatorLive(tok)).resolves.toBeUndefined();
  });
  it('a revoked impersonator session kills it', async () => {
    h.revokedSids.add('sid-sa');
    await expect(assertImpersonatorLive(tok)).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_REVOKED',
    });
  });
  it.each([
    ['demoted', { role: 'store_admin', status: 'active' }],
    ['suspended', { role: 'super_admin', status: 'suspended' }],
    ['deleted', null],
  ])('an impersonator who is %s kills it', async (_n, acct) => {
    h.accounts.set('sa-1', acct);
    await expect(assertImpersonatorLive(tok)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('fails closed (503) when the identity service cannot answer', async () => {
    h.down = true;
    await expect(assertImpersonatorLive(tok)).rejects.toMatchObject({ statusCode: 503 });
  });
  it('is a no-op for an ordinary token', async () => {
    h.accounts.clear();
    await expect(assertImpersonatorLive({})).resolves.toBeUndefined();
  });
});

describe('TEN-4: requireRecentLogin', () => {
  const run = (authTime?: number) => {
    const next = vi.fn();
    requireRecentLogin({ accountsAuthTime: authTime } as unknown as Request, {} as Response, next);
    return next.mock.calls[0]?.[0] as { statusCode?: number; code?: string } | undefined;
  };
  const nowS = () => Math.floor(Date.now() / 1000);
  it('lets a fresh sign-in through', () => expect(run(nowS() - 60)).toBeUndefined());
  it('403 STEP_UP_REQUIRED once the sign-in is older than the window (403, not a refresh-looping 401)', () =>
    expect(run(nowS() - STEP_UP_MAX_AGE_SECONDS - 5)).toMatchObject({
      statusCode: 403,
      code: 'STEP_UP_REQUIRED',
    }));
  it('refuses a session with no auth_time (fail closed)', () =>
    expect(run(undefined)).toMatchObject({ statusCode: 403, code: 'STEP_UP_REQUIRED' }));
});

describe('ID-05: cross-site detection for the logout of an identity session', () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as Request;
  it('refuses a non-platform Origin', () =>
    expect(isCrossSiteAdminRequest(req({ origin: 'https://evil.example' }))).toBe(true));
  it('accepts the platform admin origin', () =>
    expect(isCrossSiteAdminRequest(req({ origin: 'https://store.ebda.app' }))).toBe(false));
  it('with no Origin, refuses only a browser-declared cross-site request', () => {
    expect(isCrossSiteAdminRequest(req({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
    expect(isCrossSiteAdminRequest(req({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isCrossSiteAdminRequest(req({}))).toBe(false);
  });
});

// ── wiring: each credential writer has its guards IN its own chain (source scan, as impersonation-guards.test.ts) ──
const SRC = path.resolve(__dirname, '../../apps/api/src/routes');
function chainOf(file: string, method: string, routePath: string): string {
  const text = readFileSync(path.join(SRC, file), 'utf8');
  const re = new RegExp(
    `router\\.${method}\\(\\s*'${routePath.replace(/[/:.]/g, c => '\\' + c)}',`
  );
  const m = re.exec(text);
  if (!m) throw new Error(`route not found: ${method} ${routePath} in ${file}`);
  const rest = text.slice(m.index);
  const ends = [rest.indexOf('async ('), rest.indexOf('(_req')].filter(i => i > 0);
  return rest.slice(0, Math.min(...ends));
}

const NOTIF = '/:storeId/notifications/configs/:channel';
const STEP_UP: Array<[string, string, string]> = [
  ['merchant-key.routes.ts', 'post', '/:id/integrations/merchant-keys'],
  ['merchant-key.routes.ts', 'put', '/:id/integrations/merchant-mcp/write-switch'],
  ['merchant-key.routes.ts', 'delete', '/:id/integrations/merchant-keys/:keyId'],
  ['agent-credential.routes.ts', 'post', '/:id/integrations/agent-key'],
  ['agent-credential.routes.ts', 'delete', '/:id/integrations/agent-key'],
  ['staff.routes.ts', 'post', '/'],
  ['staff.routes.ts', 'delete', '/:userId'],
  ['staff.routes.ts', 'delete', '/invites/:inviteId'],
  ['notification.routes.ts', 'put', NOTIF],
  ['notification.routes.ts', 'delete', NOTIF],
  ['payment-settings.routes.ts', 'put', '/store/:storeId/:provider/credentials'],
  ['payment-settings.routes.ts', 'post', '/store/:storeId'],
];
const NO_IMPERSONATION: Array<[string, string, string]> = [
  ['notification.routes.ts', 'put', NOTIF],
  ['notification.routes.ts', 'delete', NOTIF],
  ['merchant-key.routes.ts', 'put', '/:id/integrations/merchant-mcp/write-switch'],
  ['merchant-key.routes.ts', 'delete', '/:id/integrations/merchant-keys/:keyId'],
  ['merchant-webhooks.routes.ts', 'post', '/'],
  ['merchant-webhooks.routes.ts', 'patch', '/:id'],
  ['merchant-webhooks.routes.ts', 'delete', '/:id'],
];
describe('TEN-3 / TEN-4 wiring', () => {
  it.each(NO_IMPERSONATION)('%s %s %s: rejectImpersonated in its chain', (f, m, p) => {
    expect(chainOf(f, m, p)).toContain('rejectImpersonated');
  });
  it.each(STEP_UP)('%s %s %s: requireRecentLogin in its chain', (f, m, p) => {
    expect(chainOf(f, m, p)).toContain('requireRecentLogin');
  });
});
