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
const { runAsImpersonator, enterImpersonation } = await import('@api/lib/impersonation-context');

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

  it('the scope entered by authenticate (enterWith) reaches code that runs after next()', async () => {
    inserted.length = 0;
    await new Promise<void>(resolve => {
      // what `authenticate` does, then the handler continuing asynchronously
      setImmediate(() => {
        enterImpersonation('sa9');
        setTimeout(async () => {
          await auditLog({ action: 'x', resourceType: 'y' });
          resolve();
        }, 1);
      });
    });
    expect(inserted[0].details.impersonatedBy).toBe('sa9');
  });
});

// ── wiring ────────────────────────────────────────────────────────────────────
const SRC = path.resolve(__dirname, '../../apps/api/src/routes');

/** The registration of `router.<method>(<path>, ...)` up to the handler (`async (`), i.e. its middleware chain. */
function chainOf(file: string, method: string, routePath: string): string {
  const text = readFileSync(path.join(SRC, file), 'utf8');
  const start = text.indexOf(`router.${method}(\n  '${routePath}',`);
  if (start < 0) throw new Error(`route not found: ${method} ${routePath} in ${file}`);
  const end = text.indexOf('async (', start);
  return text.slice(start, end);
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
];

describe('the audit list (S-2) has the guard in its own chain', () => {
  it.each(GUARDED)('%s %s %s (%s)', (file, method, routePath) => {
    expect(chainOf(file, method, routePath)).toContain('rejectImpersonated');
  });

  it('11 routes here + the 14 that already had it: the table is not empty', () => {
    expect(GUARDED.length).toBe(11);
  });
});
