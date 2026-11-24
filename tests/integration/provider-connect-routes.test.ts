/**
 * "Connect a provider" over HTTP (Batch 0, plan 4.2/4.3): save credentials -> Test connection ->
 * enable, through the REAL payment-settings router, tenant context, encryption and audit log, on
 * a real Postgres with the code bound to an `ebda_app` login (strict RLS, no bypass), and the
 * REAL Kashier adapter talking to the local Kashier stub (never a real gateway).
 *
 *   - credentials are write-only: no response, and no column but the ciphertext, ever holds them;
 *   - enabling needs a successful Test connection of EXACTLY the stored credentials, and any edit
 *     of the active mode, or a mode switch, takes that away;
 *   - an unverified provider can be saved and tested by a merchant but enabled by nobody until Ebda
 *     activates it for the store (PROVIDERS-2 as relaxed by PROVIDERS-ACTIVATION);
 *   - the audit log names the changed fields, never their values.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { createPrismaClient, Prisma, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { inngest } from '@api/lib/inngest/client';
import paymentSettingsRoutes from '@api/routes/payment-settings.routes';
import providerActivationRoutes from '@api/routes/provider-activation.routes';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { errorHandler } from '@api/middleware/error-handler';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { getProviderEntry } from '@ebda/shared';
import { installTestIdentity } from '@api/lib/test-identity';
import { mintIdentityToken } from '../helpers/identity-session';
import { KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';
import { serveStub, type ServedStub } from '../stubs/serve';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);

/** Kashier is verified since 2026-10-08; these PROVIDERS-2 cases need an UNVERIFIED gateway with a
 *  working stub, so they flip the catalog entry for the duration of the case and restore it. */
async function asUnverifiedKashier<T>(fn: () => Promise<T>): Promise<T> {
  const entry = getProviderEntry('kashier')!;
  const was = entry.verified;
  (entry as { verified: boolean }).verified = false;
  try {
    return await fn();
  } finally {
    (entry as { verified: boolean }).verified = was;
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

// The credential routes sit behind requireRecentLogin (TEN-4): the merchant needs an identity-service token with a fresh sign-in
// (a legacy token has no auth_time and is refused there on purpose). One identity token per store owner, minted without a DB read.
const token = (userId: string, storeId: string) =>
  mintIdentityToken({
    userId,
    email: `${userId}@example.test`,
    stores: [{ id: storeId, role: 'owner' }],
  });

/** Long enough that the hint shows its last 4; distinctive so a leak is greppable. */
const SECRET_KEY = `${KASHIER_STUB.secretKey}`;
const API_KEY = `${KASHIER_STUB.apiKey}`;

describe.skipIf(!hasDb)('connect a provider: credentials, Test connection, enable gate', () => {
  let owner: AppPrismaClient;
  let app: Express;
  let stubServer: ServedStub;
  const stub = new KashierStub();
  const stores: Array<{ id: string; userId: string; jwt: string }> = [];

  async function mkStore(tag: string) {
    // Per-CALL unique (retry-safe): a retry gets a fresh store.
    const t = `${tag}-${run}-${crypto.randomUUID().slice(0, 6)}`;
    const user = await owner.user.create({
      data: {
        email: `pcr-${t}@test.local`,
        passwordHash: 'x',
        firstName: 'Pc',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    const store = await owner.store.create({
      data: { name: `pcr-${t}`, slug: `pcr-${t}`, ownerId: user.id, status: 'active' },
    });
    await planService.assignPlan(store.id, { planCode: 'comped' });
    const s = { id: store.id, userId: user.id, jwt: await token(user.id, store.id) };
    stores.push(s);
    return s;
  }

  const base = (s: { id: string }) => `/api/v1/payment-settings/store/${s.id}/kashier`;
  const put = (s: { id: string; jwt: string }, path: string, body: unknown) =>
    asApp(async () =>
      request(app)
        .put(path)
        .set('Authorization', `Bearer ${s.jwt}`)
        .send(body as object)
    );
  const post = (s: { id: string; jwt: string }, path: string, body: unknown = {}) =>
    asApp(async () =>
      request(app)
        .post(path)
        .set('Authorization', `Bearer ${s.jwt}`)
        .send(body as object)
    );
  // Turning a gateway ON is the confirm flow (the legacy /toggle refuses an unconfirmed ON): the server runs the
  // check, a pass returns a token, the token + an Idempotency-Key turn it on.
  const turnOn = async (s: { id: string; jwt: string }) => {
    const root = `/api/v1/provider-activation/store/${s.id}/kashier/activate`;
    const pv = await post(s, `${root}/preview`);
    if (pv.status !== 200 || pv.body.data.outcome !== 'ready') return pv;
    return asApp(async () =>
      request(app)
        .post(`${root}/confirm`)
        .set('Authorization', `Bearer ${s.jwt}`)
        .set('Idempotency-Key', `connect-${crypto.randomUUID()}`)
        .send({ confirmToken: pv.body.data.confirmToken })
    );
  };
  const get = (s: { id: string; jwt: string }) =>
    asApp(async () =>
      request(app)
        .get(`/api/v1/payment-settings/store/${s.id}`)
        .set('Authorization', `Bearer ${s.jwt}`)
    );
  const saveSandbox = (s: { id: string; jwt: string }, fields: Record<string, string>) =>
    put(s, `${base(s)}/credentials`, { mode: 'sandbox', fields, activate: true });
  const row = (s: { id: string }) =>
    owner.paymentConfig.findFirstOrThrow({ where: { storeId: s.id, provider: 'kashier' } });

  beforeAll(async () => {
    expect(installTestIdentity(), 'EBDA_TEST_IDENTITY_JWK + NODE_ENV=test').toBe(true);
    vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
    // the confirm step needs an Idempotency-Key claim, which lives in Redis
    await redis.connect().catch(() => undefined);
    stubServer = await serveStub(stub.fetch);
    process.env.KASHIER_BASE_URL = stubServer.url;
    app = express();
    app.use(express.json());
    app.use('/api/v1/payment-settings', paymentSettingsRoutes);
    app.use('/api/v1/provider-activation', providerActivationRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    const ids = stores.map(s => s.id);
    await owner.auditLog.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.paymentConfig
      .deleteMany({ where: { storeId: { in: ids } } })
      .catch(() => undefined);
    await owner.store.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await owner.user
      .deleteMany({ where: { id: { in: stores.map(s => s.userId) } } })
      .catch(() => undefined);
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
    await stubServer.close();
    delete process.env.KASHIER_BASE_URL;
  });

  it('saves credentials write-only: the response, the list and the hints never carry a secret', async () => {
    const s = await mkStore('wo');
    const res = await saveSandbox(s, {
      merchantId: KASHIER_STUB.merchantId,
      paymentApiKey: API_KEY,
      secretKey: SECRET_KEY,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.changed.sort()).toEqual(['merchantId', 'paymentApiKey', 'secretKey']);

    const list = await get(s);
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
    // The MID is not a secret: it is shown back so the merchant can check it.
    expect(cfg.credentialHints.sandbox.merchantId).toEqual({
      set: true,
      value: KASHIER_STUB.merchantId,
    });
    expect(cfg.webhookUrl).toMatch(new RegExp(`/api/v1/webhooks/payment/kashier/s/${s.id}$`));
    expect(cfg.isEnabled).toBe(false);

    // At rest: only ciphertext. Neither the blob nor the hints column contains the plaintext.
    const r = await row(s);
    expect(r.credentials).toBeTruthy();
    expect(r.credentials).not.toContain(SECRET_KEY);
    expect(JSON.stringify(r.credentialHints)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(r.credentialHints)).not.toContain(API_KEY);

    // A masked echo or an empty value keeps the stored secret (nothing changes).
    const echo = await saveSandbox(s, {
      secretKey: `****${SECRET_KEY.slice(-4)}`,
      paymentApiKey: '',
    });
    expect(echo.status).toBe(200);
    expect(echo.body.data.changed).toEqual([]);
  });

  it('enabling needs a passing Test connection of exactly the stored credentials', async () => {
    const s = await mkStore('gate');
    await saveSandbox(s, {
      merchantId: KASHIER_STUB.merchantId,
      paymentApiKey: API_KEY,
      secretKey: SECRET_KEY,
    });

    // PROVIDERS-3: the save already ran the check, so a proof of exactly these credentials exists.
    // Without a proof (cleared out of band) enabling is still refused.
    await owner.paymentConfig.updateMany({
      where: { storeId: s.id, provider: 'kashier' },
      data: { connectionTest: Prisma.DbNull },
    });
    const early = await post(s, `${base(s)}/toggle`, { enabled: true });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('CONNECTION_NOT_TESTED');

    const test = await post(s, `${base(s)}/test`);
    expect(test.status).toBe(200);
    expect(test.body.data.test).toMatchObject({ ok: true, code: 'ok' });
    expect(JSON.stringify(test.body)).not.toContain(SECRET_KEY);
    // The stub saw the documented harmless call and nothing that moves money.
    expect(stub.requests.some(r => r.path === '/v2/merchants/validate-credentials')).toBe(true);

    const on = await turnOn(s);
    expect(on.status).toBe(200);
    expect((await row(s)).isEnabled).toBe(true);

    // Rotating the active secret disables the gateway until it is tested again.
    const rotated = await saveSandbox(s, { secretKey: `${SECRET_KEY}-rotated` });
    expect(rotated.body.data.disabledUntilRetested).toBe(true);
    expect((await row(s)).isEnabled).toBe(false);
    const again = await post(s, `${base(s)}/toggle`, { enabled: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONNECTION_NOT_TESTED');

    // Disabling is always allowed.
    const off = await post(s, `${base(s)}/toggle`, { enabled: false });
    expect(off.status).toBe(200);
  });

  it('the old toggle refuses a merchant turning a tested gateway ON (409 CONFIRMATION_REQUIRED); OFF stays free', async () => {
    const s = await mkStore('legacy');
    await saveSandbox(s, {
      merchantId: KASHIER_STUB.merchantId,
      paymentApiKey: API_KEY,
      secretKey: SECRET_KEY,
    });
    expect((await post(s, `${base(s)}/test`)).body.data.test.ok).toBe(true);
    const on = await post(s, `${base(s)}/toggle`, { enabled: true });
    expect(on.status).toBe(409);
    expect(on.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await row(s)).isEnabled).toBe(false);
    expect((await turnOn(s)).status).toBe(200);
    expect((await post(s, `${base(s)}/toggle`, { enabled: false })).status).toBe(200);
  });

  it('switching an enabled gateway to the other mode is refused until that mode is tested', async () => {
    const s = await mkStore('mode');
    await saveSandbox(s, {
      merchantId: KASHIER_STUB.merchantId,
      paymentApiKey: API_KEY,
      secretKey: SECRET_KEY,
    });
    expect((await post(s, `${base(s)}/test`)).body.data.test.ok).toBe(true);
    expect((await turnOn(s)).status).toBe(200);

    const sw = await put(s, base(s), { testMode: false });
    expect(sw.status).toBe(409);
    expect(sw.body.error.code).toBe('CONNECTION_NOT_TESTED');
    expect((await row(s)).testMode).toBe(true);
  });

  it('refused credentials are reported and do not open the gate', async () => {
    const s = await mkStore('bad');
    await saveSandbox(s, {
      merchantId: KASHIER_STUB.merchantId,
      paymentApiKey: API_KEY,
      secretKey: 'definitely-not-the-stub-secret-key',
    });
    const test = await post(s, `${base(s)}/test`);
    expect(test.status).toBe(200);
    expect(test.body.data.test.ok).toBe(false);
    expect(test.body.data.test.code).toBe('bad_credentials');
    expect(JSON.stringify(test.body)).not.toContain('definitely-not-the-stub-secret-key');
    const on = await post(s, `${base(s)}/toggle`, { enabled: true });
    expect(on.status).toBe(409);
  });

  it('incomplete credentials never reach the gateway', async () => {
    const s = await mkStore('inc');
    await saveSandbox(s, { merchantId: KASHIER_STUB.merchantId });
    const before = stub.requests.length;
    const test = await post(s, `${base(s)}/test`);
    expect(test.body.data.test.code).toBe('incomplete');
    expect(stub.requests.length).toBe(before);
  });

  it('validates each field against the catalog (format, unknown fields)', async () => {
    const s = await mkStore('val');
    const bad = await saveSandbox(s, { merchantId: 'not-a-mid' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await saveSandbox(s, { apiKeyTypo: 'x' } as Record<string, string>);
    expect(unknown.status).toBe(422);
  });

  it('the generic update route refuses gateway keys (single writer)', async () => {
    const s = await mkStore('legacy');
    await saveSandbox(s, { merchantId: KASHIER_STUB.merchantId });
    const res = await put(s, base(s), { secretKey: 'sneaky-secret-value' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('USE_CREDENTIALS_ENDPOINT');
    expect((await row(s)).secretKey).toBeNull();
  });

  it('the audit log names the changed fields and never their values', async () => {
    const s = await mkStore('audit');
    await saveSandbox(s, {
      merchantId: KASHIER_STUB.merchantId,
      paymentApiKey: API_KEY,
      secretKey: SECRET_KEY,
    });
    await post(s, `${base(s)}/test`);
    const logs = await owner.auditLog.findMany({
      where: {
        storeId: s.id,
        action: {
          in: [
            'store_payment_config.credentials_updated',
            'store_payment_config.connection_tested',
          ],
        },
      },
    });
    // PROVIDERS-3: the save's automatic check and the manual Test connection are both audited.
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
    const s = await mkStore('soon');
    const prev = process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED; // run as production does
    try {
      await asUnverifiedKashier(async () => {
        const save = await saveSandbox(s, {
          merchantId: KASHIER_STUB.merchantId,
          paymentApiKey: API_KEY,
          secretKey: SECRET_KEY,
        });
        expect(save.status).toBe(200);
        // the automatic check ran on save: connected, in Arabic and English, no secret echoed
        expect(save.body.data.check).toMatchObject({ status: 'connected', ok: true });
        expect(save.body.data.check.messageAr).toBeTruthy();
        expect(save.body.data.check.messageEn).toBeTruthy();
        expect(JSON.stringify(save.body)).not.toContain(SECRET_KEY);
        expect((await row(s)).connectionTest).toMatchObject({ ok: true, mode: 'sandbox' });
        const on = await turnOn(s);
        expect(on.status, JSON.stringify(on.body)).toBe(200);
        expect((await row(s)).isEnabled).toBe(true);
      });
    } finally {
      process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = prev;
    }
  });

  it('PROVIDERS-3 at runtime: an enabled unverified row is offered at checkout', async () => {
    const s = await mkStore('runtime');
    await saveSandbox(s, {
      merchantId: KASHIER_STUB.merchantId,
      paymentApiKey: API_KEY,
      secretKey: SECRET_KEY,
    });
    expect((await post(s, `${base(s)}/test`)).body.data.test.ok).toBe(true);
    expect((await turnOn(s)).status).toBe(200);

    const prev = process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    try {
      await asUnverifiedKashier(async () => {
        PaymentService.clearCache(s.id);
        expect(await asApp(() => PaymentService.getAvailableProviders(s.id))).toContain('kashier');
      });
    } finally {
      process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = prev;
      PaymentService.clearCache(s.id);
    }
  });
});
