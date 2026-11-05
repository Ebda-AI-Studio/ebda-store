/**
 * BE:S-2 (Ruling FP-3): an impersonated session is read-only for credential, money, domain and staff routes, and every audit
 * row written during an impersonated request names the impersonating super_admin.
 *
 * Two halves: (1) the guard and the audit attribution are executed; (2) a WIRING table proves each route of the audit's list
 * really has `rejectImpersonated` in its own registration chain (a source scan: these routers need a database to execute, so the
 * chain is read, not run - the guard itself is run in (1)).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';

const inserted: Array<{ details: Record<string, unknown> }> = [];
vi.mock('@api/lib/definer', () => ({
  insertAuditLog: async (row: { details: Record<string, unknown> }) => {
    inserted.push(row);
  },
}));
vi.mock('@api/lib/savepoint', () => ({ withSavepoint: (fn: () => unknown) => fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { rejectImpersonated } = await import('@api/middleware/auth');
const { auditLog } = await import('@api/middleware/security');
const { runWithImpersonation: runAsImpersonator } = await import('@api/lib/impersonation-context');

function runGuard(user: Record<string, unknown>) {
  let status = 0;
  let body: unknown;
  let nexted = false;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  } as unknown as Response;
  rejectImpersonated({ user } as unknown as Request, res, () => {
    nexted = true;
  });
  return { status, body, nexted };
}

describe('rejectImpersonated', () => {
  it('403 IMPERSONATION_FORBIDDEN for an impersonation token', () => {
    const r = runGuard({ userId: 'm1', role: 'store_admin', impersonatedBy: 'sa1' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: 'IMPERSONATION_FORBIDDEN' } });
    expect(r.nexted).toBe(false);
  });
  it('lets a real session through', () => {
    expect(runGuard({ userId: 'm1', role: 'store_admin' }).nexted).toBe(true);
  });
});

describe('auditLog names the impersonator', () => {
  it('adds details.impersonatedBy inside an impersonated request', async () => {
    inserted.length = 0;
    await runAsImpersonator('sa1', () =>
      auditLog({ action: 'payment.refunded', resourceType: 'payment', details: { amount: 5 } })
    );
    expect(inserted[0].details).toEqual({ amount: 5, impersonatedBy: 'sa1' });
  });

  it('adds nothing for an ordinary request', async () => {
    inserted.length = 0;
    await auditLog({ action: 'x', resourceType: 'y', details: { a: 1 } });
    expect(inserted[0].details).toEqual({ a: 1 });
  });

  it('a caller that already set the field keeps its value; an explicit entry field wins over the scope', async () => {
    inserted.length = 0;
    await runAsImpersonator('sa1', async () => {
      await auditLog({ action: 'x', resourceType: 'y', details: { impersonatedBy: 'explicit' } });
      await auditLog({ action: 'x', resourceType: 'y', impersonatedBy: 'sa2' });
    });
    expect(inserted[0].details.impersonatedBy).toBe('explicit');
    expect(inserted[1].details.impersonatedBy).toBe('sa2');
  });

  it('the scope authenticate opens reaches async code that runs after next()', async () => {
    inserted.length = 0;
    await new Promise<void>(resolve => {
      // what `authenticate` does: the rest of the request runs INSIDE the scope
      runAsImpersonator('sa9', () =>
        setTimeout(async () => {
          await auditLog({ action: 'x', resourceType: 'y' });
          resolve();
        }, 1)
      );
    });
    expect(inserted[0].details.impersonatedBy).toBe('sa9');
  });
});

describe('workerd-safe: no AsyncLocalStorage.enterWith in code that runs on Workers', () => {
  it('lib/impersonation-context.ts does not call it (workerd throws "enterWith() is not implemented")', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/lib/impersonation-context.ts'),
      'utf8'
    );
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\.enterWith\(/);
  });
});

// ── wiring ────────────────────────────────────────────────────────────────────
const SRC = path.resolve(__dirname, '../../apps/api/src/routes');

/** The registration of `router.<method>(<path>, ...)` up to the handler (`async (`), i.e. its middleware chain. */
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

/** The guard is either named in the chain or comes with billing's `writeGuard` array (which contains it, see billing.routes.ts). */
function guarded(file: string, chain: string): boolean {
  if (chain.includes('rejectImpersonated')) return true;
  if (file !== 'billing.routes.ts' || !chain.includes('...writeGuard')) return false;
  const text = readFileSync(path.join(SRC, file), 'utf8');
  return /const writeGuard = \[[^\]]*rejectImpersonated/.test(text);
}

const GUARDED: Array<[string, string, string, string]> = [
  ['merchant-key.routes.ts', 'post', '/:id/integrations/merchant-keys', 'mint a durable MCP key'],
  ['payment.routes.ts', 'post', '/refund', 'refund'],
  ['payment.routes.ts', 'post', '/retry/:paymentId', 'retry a payment'],
  ['payment-settings.routes.ts', 'post', '/store/:storeId', 'create a provider'],
  ['payment-settings.routes.ts', 'put', '/store/:storeId/:provider', 'update / rename a provider'],
  ['payment-settings.routes.ts', 'delete', '/store/:storeId/:provider', 'delete a provider'],
  ['payment-settings.routes.ts', 'post', '/store/:storeId/:provider/toggle', 'enable a provider'],
  [
    'payment-settings.routes.ts',
    'put',
    '/store/:storeId/:provider/credentials',
    'swap credentials',
  ],
  ['payment-settings.routes.ts', 'post', '/store/:storeId/:provider/test', 'test credentials'],
  ['store.routes.ts', 'put', '/:id/domain', 'repoint the live domain'],
  ['staff.routes.ts', 'post', '/', 'add staff'],
  // billing: every money / stored-card write (reads keep the plain guard)
  ...[
    ['post', '/checkout'],
    ['get', '/checkout/return'],
    ['put', '/trial-plan'],
    ['post', '/card-setup'],
    ['post', '/payment-method'],
    ['post', '/payment-claims'],
    ['post', '/instapay-plan'],
    ['post', '/receipts'],
    ['post', '/receipts/:receiptId/submit'],
    ['post', '/change-plan'],
    ['post', '/cancel'],
    ['post', '/resume'],
    ['post', '/checkout/stub-confirm'],
  ].map(
    ([m, p]) => ['billing.routes.ts', m, p, 'billing write'] as [string, string, string, string]
  ),
  // other credential / payout writes an owner can reach
  ['agent-credential.routes.ts', 'post', '/:id/integrations/agent-key', 'mint an agent key'],
  ['agent-credential.routes.ts', 'delete', '/:id/integrations/agent-key', 'revoke an agent key'],
  ['merchant-webhooks.routes.ts', 'post', '/:id/rotate-secret', 'rotate a webhook secret'],
  [
    'shipping-carrier.routes.ts',
    'put',
    '/:storeId/shipping-carriers/configs/:carrier',
    'carrier credentials',
  ],
  [
    'shipping-carrier.routes.ts',
    'delete',
    '/:storeId/shipping-carriers/configs/:carrier',
    'carrier credentials',
  ],
  [
    'shipping-carrier.routes.ts',
    'post',
    '/:storeId/shipping-carriers/webhook-secret/:carrier/rotate',
    'carrier webhook secret',
  ],
  ['eta.routes.ts', 'put', '/:storeId/eta/connection', 'tax-authority credentials'],
  ['eta.routes.ts', 'post', '/:storeId/eta/connection/check', 'tax-authority credentials'],
  ['affiliate.routes.ts', 'post', '/:storeId/affiliates/:id/payouts', 'affiliate payout'],
];

describe('the audit list (S-2) has the guard in its own chain', () => {
  it.each(GUARDED)('%s %s %s (%s)', (file, method, routePath) => {
    expect(guarded(file, chainOf(file, method, routePath))).toBe(true);
  });

  it('the table is not empty', () => {
    expect(GUARDED.length).toBeGreaterThan(30);
  });

  it('every billing write route in billing.routes.ts is in the table (no write added without the guard)', () => {
    const text = readFileSync(path.join(SRC, 'billing.routes.ts'), 'utf8');
    const writes = [...text.matchAll(/router\.(post|put|patch|delete)\(\s*'([^']+)'/g)].map(
      m => m[2]
    );
    const listed = GUARDED.filter(g => g[0] === 'billing.routes.ts').map(g => g[2]);
    expect(writes.filter(w => !listed.includes(w))).toEqual([]);
  });
});
