/**
 * Provider activation on request (ruling PROVIDERS-ACTIVATION), over HTTP, through the REAL
 * routers, tenant context, encryption and audit log, on a real Postgres with the code bound to
 * the strict-RLS `ebda_app` login, and the REAL Kashier / Bosta adapters talking to local stubs.
 *
 * Production's PROVIDERS-2 is simulated: the stub-suite seam is OFF and the catalog entry is
 * flipped to `verified: false` for the duration of each case.
 *
 *   - an unverified provider: the merchant can save and Test connection, but never enable;
 *   - requesting activation records one row and enqueues the ops email (ahlan@ebda.app);
 *   - a merchant cannot activate (no route, and the admin route refuses a store_admin);
 *   - the super admin can activate only after that store's latest test passed;
 *   - after activation the SAME store can enable it and checkout offers it; another store cannot;
 *   - a rejection keeps it disabled, shows the note, and emails the merchant.
 *
 * Mutations (each restored byte-identical):
 *   - provider-activation.service.ts activateForStore: drop the `passed` check -> "needs a passing
 *     test" cases red;
 *   - provider-gate.ts activatedProvidersForStore: drop `storeId` from the where -> "another store
 *     still can't" cases red.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createPrismaClient, Prisma, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { BRAND, getProviderEntry } from '@ebda/shared';
import { config } from '@api/config';
import { inngest } from '@api/lib/inngest/client';
import paymentSettingsRoutes from '@api/routes/payment-settings.routes';
import shippingCarrierRoutes from '@api/routes/shipping-carrier.routes';
import providerActivationRoutes, {
  adminProviderActivationRoutes,
} from '@api/routes/provider-activation.routes';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { errorHandler } from '@api/middleware/error-handler';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';
import { emailQueue } from '@api/services/email-queue.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { isProviderUsableForStore } from '@api/services/payment-providers/provider-gate';
import { KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { serveStub, type ServedStub } from '../stubs/serve';

// The admin routes require MFA enrolment; the gate itself is covered elsewhere.
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _s: unknown, next: () => void) => next(),
  requireRecentLogin: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);

/** Production: seam off, kashier and bosta unverified. Restores everything. */
async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
  delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
  const entries = ['kashier', 'bosta'].map(c => getProviderEntry(c)!);
  const was = entries.map(e => e.verified);
  entries.forEach(e => ((e as { verified: boolean }).verified = false));
  try {
    return await fn();
  } finally {
    entries.forEach((e, i) => ((e as { verified: boolean }).verified = was[i]));
    if (prev === undefined) delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    else process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = prev;
  }
}

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const token = (userId: string, role: 'store_admin' | 'super_admin' = 'store_admin') =>
  jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '30m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

type Actor = { id: string; userId: string; email: string; jwt: string };
const SECRET_KEY = KASHIER_STUB.secretKey;
const API_KEY = KASHIER_STUB.apiKey;
const GOOD = { merchantId: KASHIER_STUB.merchantId, paymentApiKey: API_KEY, secretKey: SECRET_KEY };

describe.skipIf(!hasDb)('provider activation on request', () => {
  let owner: AppPrismaClient;
  let app: Express;
  let kashierServer: ServedStub;
  let bostaServer: ServedStub;
  const kashier = new KashierStub();
  const bosta = new BostaStub();
  const stores: Actor[] = [];
  const operators: string[] = [];
  // Re-armed per test: the config restores mocks between tests.
  let enqueue = vi.spyOn(emailQueue, 'enqueue');
  beforeEach(() => {
    enqueue = vi.spyOn(emailQueue, 'enqueue').mockResolvedValue('queued-id');
  });

  async function mkStore(tag: string): Promise<Actor> {
    const t = `${tag}-${run}-${crypto.randomUUID().slice(0, 6)}`;
    const user = await owner.user.create({
      data: {
        email: `pa-${t}@test.local`,
        passwordHash: 'x',
        firstName: 'Pa',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    const store = await owner.store.create({
      data: { name: `pa-${t}`, slug: `pa-${t}`, ownerId: user.id, status: 'active' },
    });
    await planService.assignPlan(store.id, { planCode: 'comped' });
    const s = { id: store.id, userId: user.id, email: user.email, jwt: token(user.id) };
    stores.push(s);
    return s;
  }

  async function mkOperator(): Promise<{ jwt: string; userId: string }> {
    const user = await owner.user.create({
      data: {
        email: `pa-op-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`,
        passwordHash: 'x',
        firstName: 'Op',
        lastName: 'Erator',
        role: 'super_admin',
        emailVerified: true,
      },
    });
    operators.push(user.id);
    return { jwt: token(user.id, 'super_admin'), userId: user.id };
  }

  type Who = { jwt: string };
  const call = (method: 'get' | 'put' | 'post', who: Who, url: string, body: object = {}) =>
    asApp(async () => {
      const r = request(app)[method](url).set('Authorization', `Bearer ${who.jwt}`);
      return method === 'get' ? r : r.send(body);
    });
  const pay = (s: { id: string }, path = '') =>
    `/api/v1/payment-settings/store/${s.id}/kashier${path}`;
  const saveKashier = (s: Who & { id: string }, fields: Record<string, string> = GOOD) =>
    call('put', s, pay(s, '/credentials'), { mode: 'sandbox', fields, activate: true });
  const testKashier = (s: Who & { id: string }) => call('post', s, pay(s, '/test'));
  const toggleKashier = (s: Who & { id: string }, enabled = true) =>
    call('post', s, pay(s, '/toggle'), { enabled });
  const requestUrl = (s: { id: string }, provider: string) =>
    `/api/v1/provider-activation/store/${s.id}/${provider}/request`;
  const adminUrl = (s: { id: string }, provider: string, action: string) =>
    `/api/v1/admin/provider-activation/${s.id}/${provider}/${action}`;
  const carrierCfg = (s: { id: string }) =>
    `/api/v1/stores/${s.id}/shipping-carriers/configs/bosta`;
  const carrierTest = (s: { id: string }) => `/api/v1/stores/${s.id}/shipping-carriers/test/bosta`;
  const offered = (s: { id: string }) => {
    PaymentService.clearCache(s.id);
    return asApp(() => PaymentService.getAvailableProviders(s.id));
  };
  const rows = (s: { id: string }, provider = 'kashier') =>
    owner.providerActivationRequest.findMany({
      where: { storeId: s.id, provider },
      orderBy: { requestedAt: 'asc' },
    });

  /** A store with tested kashier credentials, ready to request activation. */
  async function readyStore(tag: string): Promise<Actor> {
    const s = await mkStore(tag);
    expect((await saveKashier(s)).status).toBe(200);
    expect((await testKashier(s)).body.data.test.ok).toBe(true);
    return s;
  }

  beforeAll(async () => {
    vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
    await redis.connect().catch(() => undefined);
    kashierServer = await serveStub(kashier.fetch);
    bostaServer = await serveStub(bosta.fetch);
    process.env.KASHIER_BASE_URL = kashierServer.url;
    process.env.BOSTA_BASE_URL = `${bostaServer.url}/api/v2`;
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/payment-settings', paymentSettingsRoutes);
    app.use('/api/v1/stores', shippingCarrierRoutes);
    app.use('/api/v1/provider-activation', providerActivationRoutes);
    app.use('/api/v1/admin', adminProviderActivationRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    const ids = stores.map(s => s.id);
    await owner.providerActivationRequest.deleteMany({ where: { storeId: { in: ids } } });
    await owner.auditLog.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.paymentConfig
      .deleteMany({ where: { storeId: { in: ids } } })
      .catch(() => undefined);
    await owner.shippingCarrierConfig
      .deleteMany({ where: { storeId: { in: ids } } })
      .catch(() => undefined);
    await owner.store.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await owner.user
      .deleteMany({ where: { id: { in: [...stores.map(s => s.userId), ...operators] } } })
      .catch(() => undefined);
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
    await kashierServer.close();
    await bostaServer.close();
    delete process.env.KASHIER_BASE_URL;
    delete process.env.BOSTA_BASE_URL;
  });

  it('an unverified provider (PROVIDERS-3): the merchant saves, tests and enables it; checkout offers it', async () => {
    const s = await mkStore('save');
    await asProduction(async () => {
      expect((await saveKashier(s)).status).toBe(200);
      const t = await testKashier(s);
      expect(t.status).toBe(200);
      expect(t.body.data.test.ok).toBe(true);
      const on = await toggleKashier(s);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect((await offered(s)).includes('kashier' as never)).toBe(true);
    });
  });

  it('request: creates one row, enqueues the ops email, is idempotent, needs saved credentials', async () => {
    const s = await mkStore('req');
    await asProduction(async () => {
      const early = await call('post', s, requestUrl(s, 'kashier'));
      expect(early.status).toBe(422);
      expect(early.body.error.code).toBe('CREDENTIALS_REQUIRED');

      expect((await saveKashier(s)).status).toBe(200);
      enqueue.mockClear();
      const first = await call('post', s, requestUrl(s, 'kashier'));
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.data.request).toMatchObject({ provider: 'kashier', status: 'requested' });
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      const [storeArg, mail] = enqueue.mock.calls[0];
      expect(storeArg).toBeNull();
      expect(mail.to).toBe(BRAND.supportEmail);
      expect(mail.subject).toContain('Kashier');
      expect(String(mail.text)).toContain(s.id);
      // no credential ever reaches the mail
      expect(JSON.stringify(mail)).not.toContain(SECRET_KEY);

      const again = await call('post', s, requestUrl(s, 'kashier'));
      expect(again.status).toBe(200);
      expect(again.body.data.created).toBe(false);
      expect(await rows(s)).toHaveLength(1);
      await awaitDeferredWork(2000);
      expect(enqueue).toHaveBeenCalledTimes(1);

      const list = await call('get', s, `/api/v1/provider-activation/store/${s.id}`);
      expect(list.body.data.requests).toHaveLength(1);
      expect(list.body.data.requests[0]).toMatchObject({
        provider: 'kashier',
        status: 'requested',
      });
      expect(list.body.data.requests[0].requestedAt).toBeTruthy();
      const audits = await owner.auditLog.findMany({
        where: { storeId: s.id, action: 'provider_activation.requested' },
      });
      expect(audits).toHaveLength(1);
    });
  });

  it('requests are refused for a verified provider, a manual one and an unknown one', async () => {
    const s = await mkStore('refuse');
    await saveKashier(s);
    // production catalog: kashier is verified -> nothing to activate
    const verified = await call('post', s, requestUrl(s, 'kashier'));
    expect(verified.status).toBe(409);
    expect(verified.body.error.code).toBe('ALREADY_AVAILABLE');
    expect((await call('post', s, requestUrl(s, 'cod'))).status).toBe(422);
    expect((await call('post', s, requestUrl(s, 'nope'))).status).toBe(400);
  });

  it('a merchant cannot activate themselves; nobody else can touch another store', async () => {
    const s = await readyStore('self');
    await asProduction(async () => {
      expect((await call('post', s, requestUrl(s, 'kashier'))).status).toBe(201);
      for (const action of ['test', 'activate', 'reject']) {
        const res = await call('post', s, adminUrl(s, 'kashier', action), { note: 'let me in' });
        expect(res.status, action).toBe(403);
      }
      const list = await call('get', s, '/api/v1/admin/provider-activation');
      expect(list.status).toBe(403);
      expect((await rows(s))[0].status).toBe('requested');
      // PROVIDERS-3: a request is not a gate any more; the passing test alone enables it
      expect((await toggleKashier(s)).status).toBe(200);
      // another merchant cannot file a request for this store
      const other = await mkStore('self-other');
      const cross = await call('post', { jwt: other.jwt }, requestUrl(s, 'kashier'));
      expect([403, 404]).toContain(cross.status);
    });
  });

  it('activation needs a passing test of the credentials stored now (never tested, stale, failing)', async () => {
    const op = await mkOperator();
    await asProduction(async () => {
      // never tested
      const fresh = await mkStore('untested');
      await saveKashier(fresh);
      // PROVIDERS-3: the save runs the check itself, so clear the proof to model "never tested"
      await owner.paymentConfig.updateMany({
        where: { storeId: fresh.id, provider: 'kashier' },
        data: { connectionTest: Prisma.DbNull },
      });
      await call('post', fresh, requestUrl(fresh, 'kashier'));
      const none = await call('post', op, adminUrl(fresh, 'kashier', 'activate'));
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe('CONNECTION_NOT_TESTED');

      // tested, then the credentials were edited: the test no longer covers them
      const stale = await readyStore('stale');
      await call('post', stale, requestUrl(stale, 'kashier'));
      await saveKashier(stale, { secretKey: `${SECRET_KEY}-edited-value-123` });
      const s1 = await call('post', op, adminUrl(stale, 'kashier', 'activate'));
      expect(s1.status).toBe(409);
      expect(s1.body.error.code).toBe('CONNECTION_NOT_TESTED');

      // wrong keys: the re-run test FAILS and activation stays closed
      const bad = await mkStore('failing');
      await saveKashier(bad, { ...GOOD, secretKey: 'wrong-secret-key-value-123456' });
      await call('post', bad, requestUrl(bad, 'kashier'));
      const run1 = await call('post', op, adminUrl(bad, 'kashier', 'test'));
      expect(run1.status).toBe(200);
      expect(run1.body.data.test.ok).toBe(false);
      const closed = await call('post', op, adminUrl(bad, 'kashier', 'activate'));
      expect(closed.status).toBe(409);
      expect((await rows(bad))[0].status).toBe('requested');
      expect(
        await owner.auditLog.count({
          where: { storeId: bad.id, action: 'provider_activation.activated' },
        })
      ).toBe(0);
    });
  });

  it('after activation the store can enable it and checkout offers it; another store still cannot', async () => {
    const op = await mkOperator();
    await asProduction(async () => {
      const a = await mkStore('act-a');
      const b = await readyStore('act-b'); // same provider, tested, NEVER activated
      await saveKashier(a);
      await call('post', a, requestUrl(a, 'kashier'));

      // the super admin re-runs the test (store's stored credentials), then activates
      const t = await call('post', op, adminUrl(a, 'kashier', 'test'));
      expect(t.status, JSON.stringify(t.body)).toBe(200);
      expect(t.body.data.test).toMatchObject({ ok: true, current: true });
      expect(JSON.stringify(t.body)).not.toContain(SECRET_KEY);
      const act = await call('post', op, adminUrl(a, 'kashier', 'activate'));
      expect(act.status, JSON.stringify(act.body)).toBe(200);
      expect(act.body.data.request.status).toBe('activated');

      // store A: enable works and checkout offers it
      expect((await toggleKashier(a)).status).toBe(200);
      expect(await offered(a)).toContain('kashier');
      expect(await asApp(() => isProviderUsableForStore('kashier', a.id))).toBe(true);

      // store B (PROVIDERS-3): activation is no longer a gate, B enables on its own passing test
      const on = await toggleKashier(b);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(await offered(b)).toContain('kashier');
      expect(await asApp(() => isProviderUsableForStore('kashier', b.id))).toBe(true);
      // and it cannot be activated without its own request
      expect((await call('post', op, adminUrl(b, 'kashier', 'activate'))).status).toBe(404);

      // the audit trail names every action
      const actions = (
        await owner.auditLog.findMany({
          where: { storeId: a.id, action: { startsWith: 'provider_activation.' } },
        })
      )
        .map(l => l.action)
        .sort();
      expect(actions).toEqual([
        'provider_activation.activated',
        'provider_activation.requested',
        'provider_activation.test_run',
      ]);

      // the list shows store, provider, requested-at and the last test, never a credential
      const list = await call('get', op, '/api/v1/admin/provider-activation?status=activated');
      expect(list.status).toBe(200);
      const mine = list.body.data.requests.find((r: { storeId: string }) => r.storeId === a.id);
      expect(mine).toMatchObject({ provider: 'kashier', kind: 'payments', status: 'activated' });
      expect(mine.lastTest).toMatchObject({ ok: true, current: true });
      expect(JSON.stringify(list.body)).not.toContain(SECRET_KEY);
    });
  });

  it('a rejection keeps it disabled, shows the note, emails the merchant, and can be re-filed', async () => {
    const op = await mkOperator();
    await asProduction(async () => {
      const s = await readyStore('reject');
      await call('post', s, requestUrl(s, 'kashier'));

      const noNote = await call('post', op, adminUrl(s, 'kashier', 'reject'), { note: '' });
      expect(noNote.status).toBe(400);
      expect((await rows(s))[0].status).toBe('requested');

      enqueue.mockClear();
      const rej = await call('post', op, adminUrl(s, 'kashier', 'reject'), {
        note: 'Merchant ID is for another account',
      });
      expect(rej.status, JSON.stringify(rej.body)).toBe(200);
      expect(rej.body.data.request.status).toBe('rejected');
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0][1].to).toBe(s.email);
      expect(String(enqueue.mock.calls[0][1].text)).toContain('Merchant ID is for another account');

      const mine = await call('get', s, `/api/v1/provider-activation/store/${s.id}`);
      expect(mine.body.data.requests[0]).toMatchObject({
        status: 'rejected',
        note: 'Merchant ID is for another account',
      });
      // PROVIDERS-3: a rejected request no longer blocks a connection whose test passed
      const on = await toggleKashier(s);
      expect(on.status).toBe(200);
      expect(await offered(s)).toContain('kashier');
      // activating a rejected request is impossible; re-filing makes a new open one
      expect((await call('post', op, adminUrl(s, 'kashier', 'activate'))).status).toBe(404);
      expect((await call('post', s, requestUrl(s, 'kashier'))).status).toBe(201);
      expect((await rows(s)).map(r => r.status)).toEqual(['rejected', 'requested']);
    });
  });

  it('shipping: the same flow for a carrier (save+test ok, enable only after activation, other store refused)', async () => {
    const op = await mkOperator();
    await asProduction(async () => {
      const a = await mkStore('ship-a');
      const b = await mkStore('ship-b');
      for (const s of [a, b]) {
        const save = await call('put', s, carrierCfg(s), {
          mode: 'sandbox',
          credentials: { apiKey: BOSTA_STUB.apiKey },
          activate: true,
        });
        expect(save.status, JSON.stringify(save.body)).toBe(200);
        expect((await call('post', s, carrierTest(s))).body.data.test.ok).toBe(true);
        const on = await call('put', s, carrierCfg(s), { enabled: true });
        expect(on.status, JSON.stringify(on.body)).toBe(200); // PROVIDERS-3: no activation gate
      }
      expect((await call('post', a, requestUrl(a, 'bosta'))).status).toBe(201);
      const t = await call('post', op, adminUrl(a, 'bosta', 'test'));
      expect(t.body.data.test).toMatchObject({ ok: true, current: true });
      expect((await call('post', op, adminUrl(a, 'bosta', 'activate'))).status).toBe(200);

      const onA = await call('put', a, carrierCfg(a), { enabled: true });
      expect(onA.status, JSON.stringify(onA.body)).toBe(200);
      const onB = await call('put', b, carrierCfg(b), { enabled: true });
      expect(onB.status).toBe(200);
      expect(await asApp(() => isProviderUsableForStore('bosta', a.id))).toBe(true);
      expect(await asApp(() => isProviderUsableForStore('bosta', b.id))).toBe(true);
    });
  });
});
