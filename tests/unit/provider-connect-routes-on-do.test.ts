/**
 * "Connect a provider" over HTTP on a store's Durable Object (ported from tests/integration/provider-connect-routes.test.ts):
 * save credentials -> Test connection -> enable, through the REAL payment-settings router, the REAL encryption and the REAL
 * Kashier adapter talking to the local Kashier stub (never a real gateway), against the real DO schema on SQLite with the real
 * prisma-lite client. Authentication, MFA, store access and tenant context are pass-throughs (their coverage lives elsewhere);
 * the role check runs for real. The Postgres client throws on any use, so a read or write that slipped to it fails the test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

const h = vi.hoisted(() => ({ audit: [] as Array<Record<string, unknown>> }));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  const boom = (what: string) => () => {
    throw new Error(`Postgres touched: ${what}`);
  };
  return {
    ...real,
    prisma: new Proxy(
      {},
      {
        get: (_t, p) =>
          // the ownership check reads the store's directory row (D1 in production): one fixed owner here
          p === 'store'
            ? {
                findUnique: async (a: { where: { id: string } }) => ({
                  id: a.where.id,
                  ownerId: 'owner-1',
                }),
              }
            : boom(`prisma.${String(p)}`)(),
      }
    ),
    runInTenantContext: boom('runInTenantContext'),
    withStore: async (_s: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    withUser: async (_u: string, fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: unknown, _s: unknown, n: () => void) => n(),
  authorize: () => (_q: unknown, _s: unknown, n: () => void) => n(),
  authenticate: (req: { user?: unknown }, _s: unknown, n: () => void) => {
    req.user = { userId: 'owner-1', role: 'store_admin' };
    n();
  },
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: unknown, _s: unknown, n: () => void) => n(),
  checkStoreAccess: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: unknown, _s: unknown, n: () => void) => n(),
  paymentSettingsRouteContext: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: async (e: Record<string, unknown>) => void h.audit.push(e),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { withRepo } from '@api/lib/repo-factory';
import { getProviderEntry } from '@ebda/shared';
import paymentSettingsRoutes from '@api/routes/payment-settings.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';
import { serveStub, type ServedStub } from '../stubs/serve';

const STORE = '19b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const SECRET_KEY = `${KASHIER_STUB.secretKey}`;
const API_KEY = `${KASHIER_STUB.apiKey}`;
const BASE = `/api/v1/payment-settings/store/${STORE}/kashier`;

const sqlite = openSqlite();
let repo: { storeId: string; backend: 'do'; db: never; writer: never };
let app: Express;
let stubServer: ServedStub;
const stub = new KashierStub();
const rows = (sql: string, ...p: unknown[]) => sqlite.prepare(sql).all(...(p as never[])) as any[];
const row = () => rows(`SELECT * FROM payment_configs WHERE provider = 'kashier'`)[0];

/** Kashier is verified since 2026-10-08; the PROVIDERS-3 cases need an UNVERIFIED gateway with a working stub. */
async function asUnverifiedKashier<T>(fn: () => Promise<T>): Promise<T> {
  const entry = getProviderEntry('kashier')!;
  const was = entry.verified;
  (entry as { verified: boolean }).verified = false;
  const prev = process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
  delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED; // run as production does
  try {
    return await fn();
  } finally {
    (entry as { verified: boolean }).verified = was;
    if (prev === undefined) delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    else process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = prev;
  }
}

beforeAll(async () => {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId: STORE }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, { ...m, actorRole: 'store_admin' })
  ) as never;
  repo = { storeId: STORE, backend: 'do', db: c, writer: c };
  stubServer = await serveStub(stub.fetch);
  process.env.KASHIER_BASE_URL = stubServer.url;
  app = express();
  app.use(express.json());
  app.use((_q, _s, next) => void withRepo(repo as never, async () => next()));
  app.use('/api/v1/payment-settings', paymentSettingsRoutes);
  app.use(errorHandler);
});
afterAll(async () => {
  await stubServer.close();
  delete process.env.KASHIER_BASE_URL;
});
beforeEach(() => {
  h.audit.length = 0;
  sqlite.exec('DELETE FROM payment_configs');
});

const put = (path: string, body: unknown) =>
  request(app)
    .put(path)
    .send(body as object);
const post = (path: string, body: unknown = {}) =>
  request(app)
    .post(path)
    .send(body as object);
const saveSandbox = (fields: Record<string, string>) =>
  put(`${BASE}/credentials`, { mode: 'sandbox', fields, activate: true });
const full = {
  merchantId: KASHIER_STUB.merchantId,
  paymentApiKey: API_KEY,
  secretKey: SECRET_KEY,
};

describe('connect a provider on the DO: credentials, Test connection, enable gate', () => {
  it('saves credentials write-only: the response, the list and the hints never carry a secret', async () => {
    const res = await saveSandbox(full);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.changed.sort()).toEqual(['merchantId', 'paymentApiKey', 'secretKey']);
    const list = await request(app).get(`/api/v1/payment-settings/store/${STORE}`);
    expect(list.status).toBe(200);
    for (const body of [JSON.stringify(res.body), JSON.stringify(list.body)]) {
      expect(body).not.toContain(SECRET_KEY);
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain('"credentials"');
    }
    const cfg = list.body.data.storeConfigs.find(
      (c: { provider: string }) => c.provider === 'kashier'
    );
    expect(cfg.credentialHints.sandbox.secretKey).toEqual({
      set: true,
      last4: SECRET_KEY.slice(-4),
    });
    expect(cfg.credentialHints.sandbox.merchantId).toEqual({
      set: true,
      value: KASHIER_STUB.merchantId,
    });
    expect(cfg.webhookUrl).toMatch(new RegExp(`/api/v1/webhooks/payment/kashier/s/${STORE}$`));
    expect(cfg.isEnabled).toBe(false);
    // At rest: only ciphertext
    const r = row();
    expect(r.credentials).toBeTruthy();
    expect(String(r.credentials)).not.toContain(SECRET_KEY);
    expect(String(r.credential_hints)).not.toContain(SECRET_KEY);
    expect(String(r.credential_hints)).not.toContain(API_KEY);
    // A masked echo or an empty value keeps the stored secret
    const echo = await saveSandbox({ secretKey: `****${SECRET_KEY.slice(-4)}`, paymentApiKey: '' });
    expect(echo.status).toBe(200);
    expect(echo.body.data.changed).toEqual([]);
  });

  it('enabling needs a passing Test connection of exactly the stored credentials', async () => {
    await saveSandbox(full);
    // the save already ran the check; without a proof (cleared out of band) enabling is refused
    sqlite.exec(`UPDATE payment_configs SET connection_test = NULL WHERE provider = 'kashier'`);
    const early = await post(`${BASE}/toggle`, { enabled: true });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('CONNECTION_NOT_TESTED');

    const test = await post(`${BASE}/test`);
    expect(test.status).toBe(200);
    expect(test.body.data.test).toMatchObject({ ok: true, code: 'ok' });
    expect(JSON.stringify(test.body)).not.toContain(SECRET_KEY);
    expect(stub.requests.some(r => r.path === '/v2/merchants/validate-credentials')).toBe(true);

    expect((await post(`${BASE}/toggle`, { enabled: true })).status).toBe(200);
    expect(row().is_enabled).toBe(1);

    // Rotating the active secret disables the gateway until it is tested again
    const rotated = await saveSandbox({ secretKey: `${SECRET_KEY}-rotated` });
    expect(rotated.body.data.disabledUntilRetested).toBe(true);
    expect(row().is_enabled).toBe(0);
    const again = await post(`${BASE}/toggle`, { enabled: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONNECTION_NOT_TESTED');
    expect((await post(`${BASE}/toggle`, { enabled: false })).status).toBe(200); // disabling is always allowed
  });

  it('switching an enabled gateway to the other mode is refused until that mode is tested', async () => {
    await saveSandbox(full);
    expect((await post(`${BASE}/test`)).body.data.test.ok).toBe(true);
    expect((await post(`${BASE}/toggle`, { enabled: true })).status).toBe(200);
    const sw = await put(BASE, { testMode: false });
    expect(sw.status).toBe(409);
    expect(sw.body.error.code).toBe('CONNECTION_NOT_TESTED');
    expect(row().test_mode).toBe(1);
  });

  it('refused credentials are reported and do not open the gate', async () => {
    await saveSandbox({ ...full, secretKey: 'definitely-not-the-stub-secret-key' });
    const test = await post(`${BASE}/test`);
    expect(test.status).toBe(200);
    expect(test.body.data.test).toMatchObject({ ok: false, code: 'bad_credentials' });
    expect(JSON.stringify(test.body)).not.toContain('definitely-not-the-stub-secret-key');
    expect((await post(`${BASE}/toggle`, { enabled: true })).status).toBe(409);
  });

  it('incomplete credentials never reach the gateway', async () => {
    await saveSandbox({ merchantId: KASHIER_STUB.merchantId });
    const before = stub.requests.length;
    const test = await post(`${BASE}/test`);
    expect(test.body.data.test.code).toBe('incomplete');
    expect(stub.requests.length).toBe(before);
  });

  it('validates each field against the catalog (format, unknown fields)', async () => {
    const bad = await saveSandbox({ merchantId: 'not-a-mid' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await saveSandbox({ apiKeyTypo: 'x' })).status).toBe(422);
  });

  it('the generic update route refuses gateway keys (single writer)', async () => {
    await saveSandbox({ merchantId: KASHIER_STUB.merchantId });
    const res = await put(BASE, { secretKey: 'sneaky-secret-value' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('USE_CREDENTIALS_ENDPOINT');
    expect(row().secret_key).toBeNull();
  });

  it('the audit log names the changed fields and never their values', async () => {
    await saveSandbox(full);
    await post(`${BASE}/test`);
    const logs = h.audit.filter(a =>
      [
        'store_payment_config.credentials_updated',
        'store_payment_config.connection_tested',
      ].includes(String(a.action))
    );
    expect(logs.map(l => l.action).sort()).toEqual([
      'store_payment_config.connection_tested',
      'store_payment_config.connection_tested',
      'store_payment_config.credentials_updated',
    ]);
    const all = JSON.stringify(logs);
    expect(all).toContain('secretKey');
    expect(all).not.toContain(SECRET_KEY);
    expect(all).not.toContain(API_KEY);
  });

  it('PROVIDERS-3: an unverified provider connects, is checked on save, and enables on a passing check', async () => {
    await asUnverifiedKashier(async () => {
      const save = await saveSandbox(full);
      expect(save.status).toBe(200);
      expect(save.body.data.check).toMatchObject({ status: 'connected', ok: true });
      expect(save.body.data.check.messageAr).toBeTruthy();
      expect(save.body.data.check.messageEn).toBeTruthy();
      expect(JSON.stringify(save.body)).not.toContain(SECRET_KEY);
      expect(JSON.parse(row().connection_test)).toMatchObject({ ok: true, mode: 'sandbox' });
      const on = await post(`${BASE}/toggle`, { enabled: true });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(row().is_enabled).toBe(1);
    });
  });

  it('PROVIDERS-3 at runtime: an enabled unverified row is offered at checkout', async () => {
    await saveSandbox(full);
    expect((await post(`${BASE}/test`)).body.data.test.ok).toBe(true);
    expect((await post(`${BASE}/toggle`, { enabled: true })).status).toBe(200);
    await asUnverifiedKashier(async () => {
      PaymentService.clearCache(STORE);
      expect(
        await withRepo(repo as never, () => PaymentService.getAvailableProviders(STORE))
      ).toContain('kashier');
    });
    PaymentService.clearCache(STORE);
  });
});
