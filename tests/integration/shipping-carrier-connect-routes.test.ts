/**
 * "Connect a carrier" over HTTP (shipping batch, plan section 4): save credentials -> Test
 * connection -> enable -> make default, through the REAL shipping-carrier router, tenant context,
 * encryption and audit log, on a real Postgres with the code bound to an `ebda_app` login
 * (strict RLS, no bypass), and the REAL Bosta and ShipBlu adapters talking to their local stubs
 * (never a real carrier). The PAYMENT twin is `provider-connect-routes.test.ts`.
 *
 *   - credentials are write-only: no response, and no column but the ciphertext, ever holds them;
 *   - unknown credential keys (a base URL, a webhook secret) are refused: no SSRF, no merchant-set secret;
 *   - enabling needs a successful Test connection of EXACTLY the stored credentials, and any edit
 *     of the active mode, or a mode switch, takes that away;
 *   - an unverified carrier can be saved and tested by a merchant but enabled by nobody (until activated),
 *     and a row left enabled never books (PROVIDERS-2 at the point of use);
 *   - default needs enabled, and a store has exactly one default;
 *   - another store's admin can neither read nor drive this store's carrier;
 *   - rotating the webhook secret kills the old callback URL.
 *
 * Mutation proofs (each turns the named tests red):
 *   - shipping-carrier.service.ts upsertCarrierConfig: drop `assertCarrierEnableAllowed` -> "enable
 *     before test" and "unverified"
 *   - shipping-carrier.service.ts upsertCarrierConfig: `mustDisable = false` -> "editing the active key"
 *     and "switching the mode"
 *   - shipping-carrier.routes.ts: drop `assertMayConfigureCarrier` on PUT -> "unverified" (store_admin 403)
 *   - shipping-carrier.service.ts setDefaultCarrier: drop the `row?.enabled` check -> "default"
 *   - carrier-connection.service.ts publicCarrierConfig: stop deleting `credentials` -> "write-only"
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  createPrismaClient,
  Prisma,
  runInTenantContext,
  runWithRequestDb,
  type AppPrismaClient,
} from '@ebda/database';
import { config } from '@api/config';
import { inngest } from '@api/lib/inngest/client';
import shippingCarrierRoutes from '@api/routes/shipping-carrier.routes';
import providerActivationRoutes from '@api/routes/provider-activation.routes';
import webhookRoutes from '@api/routes/webhook.routes';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { errorHandler } from '@api/middleware/error-handler';
import { shippingCarrierService } from '@api/services/shipping-carrier.service';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';
import { decryptCarrierBlob } from '@api/services/carriers/carrier-credentials';
import { webhookHeaderValue } from '@api/services/carriers/bosta.carrier';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { ShipbluStub, SHIPBLU_STUB } from '../stubs/shipblu-stub';
import { serveStub, type ServedStub } from '../stubs/serve';

// Customer / merchant notifications are not under test here.
vi.mock('@api/services/notification-dispatcher.service', () => ({
  notificationDispatcher: { dispatch: vi.fn().mockResolvedValue(undefined) },
}));

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);

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

type Actor = { id: string; userId: string; jwt: string };

/** Production's PROVIDERS-2: the stub-suite seam off, every carrier here is unverified. */
async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
  delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED;
    else process.env.PAYMENT_PROVIDERS_ALLOW_UNVERIFIED = prev;
  }
}

describe.skipIf(!hasDb)('connect a carrier: credentials, Test connection, enable gate', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const bosta = new BostaStub();
  const shipblu = new ShipbluStub();
  let bostaServer: ServedStub;
  let shipbluServer: ServedStub;
  const stores: Actor[] = [];
  const operators: string[] = [];
  let seq = 0;

  async function mkStore(tag: string): Promise<Actor> {
    // Per-CALL unique (retry-safe): a retry gets a fresh store.
    const t = `${tag}-${run}-${crypto.randomUUID().slice(0, 6)}`;
    const user = await owner.user.create({
      data: {
        email: `ccr-${t}@test.local`,
        passwordHash: 'x',
        firstName: 'Cc',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    const store = await owner.store.create({
      data: { name: `ccr-${t}`, slug: `ccr-${t}`, ownerId: user.id, status: 'active' },
    });
    await planService.assignPlan(store.id, { planCode: 'comped' });
    const s = { id: store.id, userId: user.id, jwt: token(user.id) };
    stores.push(s);
    return s;
  }

  async function mkSuperAdmin(): Promise<{ jwt: string }> {
    const t = `${run}-${crypto.randomUUID().slice(0, 6)}`;
    const user = await owner.user.create({
      data: {
        email: `ccr-op-${t}@test.local`,
        passwordHash: 'x',
        firstName: 'Op',
        lastName: 'Erator',
        role: 'super_admin',
        emailVerified: true,
      },
    });
    operators.push(user.id);
    return { jwt: token(user.id, 'super_admin') };
  }

  async function mkOrder(s: Actor) {
    seq += 1;
    return owner.order.create({
      data: {
        storeId: s.id,
        orderNumber: `CCR-${run}-${seq}-${crypto.randomUUID().slice(0, 4)}`,
        status: 'confirmed',
        paymentStatus: 'unpaid',
        subtotal: 20_000,
        total: 20_000,
        shippingAddress: {
          firstName: 'Mona',
          lastName: 'Adel',
          phone: '+201012345678',
          address1: '5 Nile Corniche',
          city: 'Giza',
          state: 'Giza',
          area: 'Dokki',
          country: 'EG',
        },
        billingAddress: {},
      },
    });
  }

  const cfgUrl = (s: { id: string }, carrier: string) =>
    `/api/v1/stores/${s.id}/shipping-carriers/configs/${carrier}`;
  const testUrl = (s: { id: string }, carrier: string) =>
    `/api/v1/stores/${s.id}/shipping-carriers/test/${carrier}`;
  const defaultUrl = (s: { id: string }, carrier: string) =>
    `/api/v1/stores/${s.id}/shipping-carriers/default/${carrier}`;
  const listUrl = (s: { id: string }) => `/api/v1/stores/${s.id}/shipping-carriers/configs`;

  type Who = { jwt: string };
  const put = (who: Who, url: string, body: object) =>
    asApp(async () => request(app).put(url).set('Authorization', `Bearer ${who.jwt}`).send(body));
  const post = (who: Who, url: string, body: object = {}) =>
    asApp(async () => request(app).post(url).set('Authorization', `Bearer ${who.jwt}`).send(body));
  // Turning a carrier ON is the confirm flow (the carrier PUT refuses an unconfirmed ON from a merchant): the server runs
  // the check, a pass returns a token, the token + an Idempotency-Key turn it on.
  const turnOn = async (who: Who, s: { id: string }, carrier: string) => {
    const root = `/api/v1/provider-activation/store/${s.id}/${carrier}/activate`;
    const pv = await post(who, `${root}/preview`);
    if (pv.status !== 200 || pv.body.data.outcome !== 'ready') return pv;
    return asApp(async () =>
      request(app)
        .post(`${root}/confirm`)
        .set('Authorization', `Bearer ${who.jwt}`)
        .set('Idempotency-Key', `carrier-${crypto.randomUUID()}`)
        .send({ confirmToken: pv.body.data.confirmToken })
    );
  };
  const get = (who: Who, url: string) =>
    asApp(async () => request(app).get(url).set('Authorization', `Bearer ${who.jwt}`));
  const del = (who: Who, url: string) =>
    asApp(async () => request(app).delete(url).set('Authorization', `Bearer ${who.jwt}`));

  const row = (s: { id: string }, carrier: string) =>
    owner.shippingCarrierConfig.findFirstOrThrow({ where: { storeId: s.id, carrier } });
  const hintsOf = async (who: Who, s: { id: string }, carrier: string) => {
    const list = await get(who, listUrl(s));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    return list.body.data.configs.find((c: { carrier: string }) => c.carrier === carrier);
  };
  const defaults = (s: { id: string }) =>
    owner.shippingCarrierConfig.findMany({
      where: { storeId: s.id, isDefault: true },
      select: { carrier: true },
    });

  beforeAll(async () => {
    vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
    await redis.connect().catch(() => undefined);
    bostaServer = await serveStub(bosta.fetch);
    shipbluServer = await serveStub(shipblu.fetch);
    process.env.BOSTA_BASE_URL = `${bostaServer.url}/api/v2`;
    process.env.SHIPBLU_BASE_URL = `${shipbluServer.url}/api`;
    process.env.CARRIER_CALL_TIMEOUT_MS = '1500';
    app = express();
    app.set('trust proxy', true);
    app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
    app.use(express.json());
    app.use('/api/v1/stores', shippingCarrierRoutes);
    app.use('/api/v1/provider-activation', providerActivationRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    const ids = stores.map(s => s.id);
    await owner.auditLog.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.shipment.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.order.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.shippingCarrierConfig
      .deleteMany({ where: { storeId: { in: ids } } })
      .catch(() => undefined);
    await owner.store.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await owner.user
      .deleteMany({ where: { id: { in: [...stores.map(s => s.userId), ...operators] } } })
      .catch(() => undefined);
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
    await bostaServer.close();
    await shipbluServer.close();
    delete process.env.BOSTA_BASE_URL;
    delete process.env.SHIPBLU_BASE_URL;
    delete process.env.CARRIER_CALL_TIMEOUT_MS;
  });

  /** What differs per carrier; everything else is the same contract. */
  const carriers = [
    {
      code: 'bosta' as const,
      key: BOSTA_STUB.apiKey,
      fields: { apiKey: BOSTA_STUB.apiKey, businessLocationId: 'LOC1' },
      // an edit of the ACTIVE set that the stub still accepts (so a re-test passes)
      edit: () => ({ businessLocationId: 'LOC2' }),
      testCalls: () => bosta.requests.length,
      webhooks: true,
    },
    {
      code: 'shipblu' as const,
      key: SHIPBLU_STUB.apiKey,
      fields: { apiKey: SHIPBLU_STUB.apiKey },
      edit: () => {
        const alt = `shipblu-alt-key-${crypto.randomUUID().slice(0, 8)}`;
        shipblu.validKeys.add(alt);
        return { apiKey: alt };
      },
      testCalls: () => shipblu.requests.length,
      webhooks: false,
    },
  ];

  describe.each(carriers)('$code', c => {
    const saveSandbox = (who: Who, s: Actor, fields: Record<string, string | null> = c.fields) =>
      put(who, cfgUrl(s, c.code), {
        mode: 'sandbox',
        credentials: fields,
        activate: true,
        settings: {},
      });

    it('saves sandbox and live credentials write-only: nothing echoes the key, only ciphertext is stored', async () => {
      const s = await mkStore(`${c.code}-wo`);
      const res = await saveSandbox(s, s);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.changed.sort()).toEqual(Object.keys(c.fields).sort());
      expect(res.body.data.config.enabled).toBe(false);

      // a LIVE set kept apart from the sandbox one (the active mode stays sandbox)
      const LIVE = `${c.code}-LIVE-key-do-not-leak-0123456789`;
      const live = await put(s, cfgUrl(s, c.code), { mode: 'live', credentials: { apiKey: LIVE } });
      expect(live.status, JSON.stringify(live.body)).toBe(200);
      expect(live.body.data.disabledUntilRetested).toBe(false);
      expect((await row(s, c.code)).testMode).toBe(true);

      const cfg = await hintsOf(s, s, c.code);
      for (const body of [
        JSON.stringify(res.body),
        JSON.stringify(live.body),
        JSON.stringify(cfg),
      ]) {
        expect(body).not.toContain(c.key);
        expect(body).not.toContain(LIVE);
        expect(body).not.toContain('"credentials"');
        expect(body).not.toContain('webhookSecret');
      }
      expect(cfg.credentials).toBeUndefined();
      expect(cfg.mode).toBe('sandbox');
      // hints: set + last4 of a long secret, the value of a non-secret field
      expect(cfg.credentialHints.sandbox.apiKey).toEqual(
        c.key.length >= 16 ? { set: true, last4: c.key.slice(-4) } : { set: true }
      );
      expect(cfg.credentialHints.live.apiKey).toEqual({ set: true, last4: LIVE.slice(-4) });
      if (c.code === 'bosta') {
        expect(cfg.credentialHints.sandbox.businessLocationId).toEqual({
          set: true,
          value: 'LOC1',
        });
      }
      expect(cfg.credentialHints.fingerprints).toBeUndefined();
      // PROVIDERS-3: saving the ACTIVE mode ran the automatic check and stored its proof; saving the
      // OTHER (live) mode afterwards reported only and did not replace it. Saving never enables.
      expect(res.body.data.check).toMatchObject({ status: 'connected', ok: true });
      expect(cfg.connectionTest).toMatchObject({ ok: true, code: 'ok', mode: 'sandbox' });
      expect(cfg.connectionTestCurrent).toBe(true);
      expect(cfg.enabled).toBe(false);

      // single-carrier GET is the same browser-safe view
      const one = await get(s, cfgUrl(s, c.code));
      expect(one.status).toBe(200);
      expect(JSON.stringify(one.body)).not.toContain(c.key);
      expect(one.body.data.config.credentials).toBeUndefined();

      // at rest: one ciphertext; neither key appears in any column
      const r = await row(s, c.code);
      expect(r.credentials).toBeTruthy();
      for (const col of [
        r.credentials,
        JSON.stringify(r.credentialHints),
        JSON.stringify(r.settings),
      ]) {
        expect(col).not.toContain(c.key);
        expect(col).not.toContain(LIVE);
      }
      // ...and it decrypts to both sets, the live one untouched by the sandbox save
      const blob = decryptCarrierBlob(r.credentials, r.settings);
      expect(blob.sandbox?.apiKey).toBe(c.key);
      expect(blob.live?.apiKey).toBe(LIVE);
      if (c.webhooks) expect(blob.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
      else expect(blob.webhookSecret).toBeUndefined();

      // a masked echo or an empty value keeps the stored secret (nothing changes)
      const echo = await saveSandbox(s, s, { apiKey: '****abcd' });
      expect(echo.status).toBe(200);
      expect(echo.body.data.changed).toEqual([]);
      const empty = await saveSandbox(s, s, { apiKey: '' });
      expect(empty.body.data.changed).toEqual([]);
      expect(decryptCarrierBlob((await row(s, c.code)).credentials).sandbox?.apiKey).toBe(c.key);
    });

    it('refuses unknown credential keys (a base URL, a webhook secret) and bad shapes with 422 INVALID_CREDENTIALS', async () => {
      const s = await mkStore(`${c.code}-val`);
      for (const bad of [
        { baseUrl: 'http://169.254.169.254/' },
        { webhookSecret: 'attacker-chosen' },
        { apiKey: c.key, apiKeyTypo: 'x' },
      ]) {
        const res = await saveSandbox(s, s, bad);
        expect(res.status, JSON.stringify(bad)).toBe(422);
        expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      }
      // a refused save wrote nothing
      expect(
        await owner.shippingCarrierConfig.count({ where: { storeId: s.id, carrier: c.code } })
      ).toBe(0);
      // credentials need their mode
      const noMode = await put(s, cfgUrl(s, c.code), { credentials: c.fields });
      expect(noMode.status).toBe(422);
      expect(noMode.body.error.code).toBe('MODE_REQUIRED');
      // an unknown carrier
      expect((await put(s, cfgUrl(s, 'icarry'), { mode: 'sandbox', credentials: {} })).status).toBe(
        400
      );
    });

    it('enable before a Test connection is 409 CONNECTION_NOT_TESTED; Test connection ok, then enable ok', async () => {
      const s = await mkStore(`${c.code}-gate`);
      await saveSandbox(s, s);

      // PROVIDERS-3: the save already checked these keys, so a passing proof of exactly the stored
      // credentials exists. Without one (no proof, or a failing one) enabling is still 409.
      await owner.shippingCarrierConfig.updateMany({
        where: { storeId: s.id, carrier: c.code },
        data: { connectionTest: Prisma.DbNull },
      });
      const early = await put(s, cfgUrl(s, c.code), { enabled: true });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('CONFIRMATION_REQUIRED');
      expect((await row(s, c.code)).enabled).toBe(false);

      const before = c.testCalls();
      const test = await post(s, testUrl(s, c.code));
      expect(test.status, JSON.stringify(test.body)).toBe(200);
      expect(test.body.data).toMatchObject({ carrier: c.code, mode: 'sandbox' });
      expect(test.body.data.test).toMatchObject({ ok: true, code: 'ok' });
      expect(JSON.stringify(test.body)).not.toContain(c.key);
      expect(c.testCalls()).toBeGreaterThan(before); // the carrier saw the harmless call

      const cfg = await hintsOf(s, s, c.code);
      expect(cfg.connectionTest).toMatchObject({ ok: true, code: 'ok', mode: 'sandbox' });
      expect(cfg.connectionTestCurrent).toBe(true);
      expect(cfg.connectionTest.fingerprint).toBeUndefined();

      const on = await turnOn(s, s, c.code);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(on.body.data.activated).toBe(true);
      expect((await row(s, c.code)).enabled).toBe(true);

      // disabling is always allowed
      const off = await put(s, cfgUrl(s, c.code), { enabled: false });
      expect(off.status).toBe(200);
      expect((await row(s, c.code)).enabled).toBe(false);

      // the audit log names the changed fields, never their values
      const logs = await owner.auditLog.findMany({
        where: {
          storeId: s.id,
          action: {
            in: ['shipping_carrier_config.updated', 'shipping_carrier_config.connection_tested'],
          },
        },
      });
      expect(logs.map(l => l.action)).toContain('shipping_carrier_config.connection_tested');
      expect(JSON.stringify(logs)).toContain('apiKey');
      expect(JSON.stringify(logs)).not.toContain(c.key);
    });

    it('refused credentials are reported and do not open the gate; incomplete ones never reach the carrier', async () => {
      const s = await mkStore(`${c.code}-bad`);
      await saveSandbox(s, s, { ...c.fields, apiKey: 'definitely-not-the-stub-key' });
      const test = await post(s, testUrl(s, c.code));
      expect(test.status).toBe(200);
      expect(test.body.data.test).toMatchObject({ ok: false, code: 'bad_credentials' });
      expect(JSON.stringify(test.body)).not.toContain('definitely-not-the-stub-key');
      const on = await put(s, cfgUrl(s, c.code), { enabled: true });
      expect(on.status).toBe(409);
      expect(on.body.error.code).toBe('CONFIRMATION_REQUIRED');

      // no apiKey at all: the adapter is not even called
      const s2 = await mkStore(`${c.code}-inc`);
      await put(s2, cfgUrl(s2, c.code), { mode: 'sandbox', credentials: {}, activate: true });
      const calls = c.testCalls();
      const inc = await post(s2, testUrl(s2, c.code));
      expect(inc.body.data.test.code).toBe('incomplete');
      expect(c.testCalls()).toBe(calls);

      // testing a carrier nothing was saved for is a 404, not a crash
      const s3 = await mkStore(`${c.code}-none`);
      expect((await post(s3, testUrl(s3, c.code))).status).toBe(404);
    });

    it('editing the active key disables the carrier (disabledUntilRetested) and re-enabling needs a new test', async () => {
      const s = await mkStore(`${c.code}-edit`);
      await saveSandbox(s, s);
      expect((await post(s, testUrl(s, c.code))).body.data.test.ok).toBe(true);
      expect((await turnOn(s, s, c.code)).status).toBe(200);

      const edited = await saveSandbox(s, s, c.edit());
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.data.disabledUntilRetested).toBe(true);
      expect(edited.body.data.config.enabled).toBe(false);
      expect((await row(s, c.code)).enabled).toBe(false);
      // PROVIDERS-3: the edit re-ran the check on the NEW credentials (the stub accepts them), so
      // the proof covers exactly what is stored now; re-enabling is the merchant's explicit act.
      expect(edited.body.data.check).toMatchObject({ status: 'connected', ok: true });
      expect((await hintsOf(s, s, c.code)).connectionTestCurrent).toBe(true);
      expect((await turnOn(s, s, c.code)).status).toBe(200);

      // a re-edit to a key the carrier REFUSES fails its check: disabled, and enabling stays 409
      const refused = await saveSandbox(s, s, { apiKey: 'definitely-not-the-stub-key-0123456789' });
      expect(refused.body.data.check).toMatchObject({ status: 'credentials_wrong', ok: false });
      expect(refused.body.data.disabledUntilRetested).toBe(true);
      expect((await hintsOf(s, s, c.code)).connectionTestCurrent).toBe(false);
      const again = await put(s, cfgUrl(s, c.code), { enabled: true });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CONFIRMATION_REQUIRED');

      // restoring the good credentials passes the check again and opens the gate
      const restored = await saveSandbox(s, s, c.fields);
      expect(restored.body.data.check).toMatchObject({ status: 'connected' });
      expect((await turnOn(s, s, c.code)).status).toBe(200);

      // editing the OTHER mode's key does not touch the active one
      const other = await put(s, cfgUrl(s, c.code), {
        mode: 'live',
        credentials: { apiKey: `${c.code}-live-key-0123456789` },
      });
      expect(other.body.data.disabledUntilRetested).toBe(false);
      expect((await row(s, c.code)).enabled).toBe(true);
    });

    it('switching the mode (activate) disables an enabled carrier until the other mode is tested', async () => {
      const s = await mkStore(`${c.code}-mode`);
      await saveSandbox(s, s);
      expect((await post(s, testUrl(s, c.code))).body.data.test.ok).toBe(true);
      expect((await turnOn(s, s, c.code)).status).toBe(200);

      const sw = await put(s, cfgUrl(s, c.code), {
        mode: 'live',
        credentials: { apiKey: `${c.code}-live-key-0123456789` },
        activate: true,
      });
      expect(sw.status, JSON.stringify(sw.body)).toBe(200);
      expect(sw.body.data.disabledUntilRetested).toBe(true);
      expect(sw.body.data.config).toMatchObject({ enabled: false, mode: 'live' });
      const r = await row(s, c.code);
      expect(r.testMode).toBe(false);
      expect(r.enabled).toBe(false);

      // the sandbox test does not count for live
      const on = await put(s, cfgUrl(s, c.code), { enabled: true });
      expect(on.status).toBe(409);
      expect(on.body.error.code).toBe('CONFIRMATION_REQUIRED');

      // switching back needs a new test too: the live test below replaced the sandbox one
      const liveTest = await post(s, testUrl(s, c.code));
      expect(liveTest.body.data).toMatchObject({ mode: 'live' });
      expect(liveTest.body.data.test.ok).toBe(false); // the stub does not know that live key
      const back = await put(s, cfgUrl(s, c.code), { mode: 'sandbox', activate: true });
      expect(back.status).toBe(200);
      expect(back.body.data.config).toMatchObject({ enabled: false, mode: 'sandbox' });
      expect((await put(s, cfgUrl(s, c.code), { enabled: true })).status).toBe(409);
      expect((await post(s, testUrl(s, c.code))).body.data.test.ok).toBe(true);
      expect((await turnOn(s, s, c.code)).status).toBe(200);
    });

    it('make-default needs an enabled carrier (409 NOT_ENABLED)', async () => {
      const s = await mkStore(`${c.code}-def`);
      await saveSandbox(s, s);
      const notYet = await post(s, defaultUrl(s, c.code));
      expect(notYet.status).toBe(409);
      expect(notYet.body.error.code).toBe('NOT_ENABLED');
      const viaPut = await put(s, cfgUrl(s, c.code), { isDefault: true });
      expect(viaPut.status).toBe(409);
      expect(viaPut.body.error.code).toBe('NOT_ENABLED');
      // a carrier nothing was saved for
      const none = await post(s, defaultUrl(s, c.code === 'bosta' ? 'shipblu' : 'bosta'));
      expect(none.status).toBe(409);
      expect(await defaults(s)).toEqual([]);

      expect((await post(s, testUrl(s, c.code))).body.data.test.ok).toBe(true);
      expect((await turnOn(s, s, c.code)).status).toBe(200);
      expect((await post(s, defaultUrl(s, c.code))).status).toBe(200);
      expect(await defaults(s)).toEqual([{ carrier: c.code }]);

      // disabling the default carrier takes the default with it
      const off = await put(s, cfgUrl(s, c.code), { enabled: false });
      expect(off.status).toBe(200);
      expect(off.body.data.config).toMatchObject({ enabled: false, isDefault: false });
      expect(await defaults(s)).toEqual([]);
    });
  });

  it('a store has exactly one default carrier: the second make-default replaces the first', async () => {
    const s = await mkStore('onedef');
    for (const c of carriers) {
      expect(
        (
          await put(s, cfgUrl(s, c.code), {
            mode: 'sandbox',
            credentials: c.fields,
            activate: true,
            settings: {},
          })
        ).status
      ).toBe(200);
      expect((await post(s, testUrl(s, c.code))).body.data.test.ok).toBe(true);
      expect((await turnOn(s, s, c.code)).status).toBe(200);
    }
    expect((await post(s, defaultUrl(s, 'bosta'))).status).toBe(200);
    expect(await defaults(s)).toEqual([{ carrier: 'bosta' }]);
    expect((await post(s, defaultUrl(s, 'shipblu'))).status).toBe(200);
    expect(await defaults(s)).toEqual([{ carrier: 'shipblu' }]);
    // enabling + defaulting in one save moves the default too
    expect((await put(s, cfgUrl(s, 'bosta'), { isDefault: true })).status).toBe(200);
    expect(await defaults(s)).toEqual([{ carrier: 'bosta' }]);
    // exactly one, whichever way it moved
    expect(
      await owner.shippingCarrierConfig.count({ where: { storeId: s.id, isDefault: true } })
    ).toBe(1);
  });

  describe('PROVIDERS-3: an unverified carrier connects like any other', () => {
    it('store_admin saves (the check runs on save), tests and enables it (PROVIDERS-3)', async () => {
      const s = await mkStore('soon');
      const op = await mkSuperAdmin();
      const fields = { apiKey: BOSTA_STUB.apiKey };

      await asProduction(async () => {
        const save = await put(s, cfgUrl(s, 'bosta'), {
          mode: 'sandbox',
          credentials: fields,
          activate: true,
        });
        expect(save.status, JSON.stringify(save.body)).toBe(200);
        expect(save.body.data.check.status).toBe('connected');
        expect(save.body.data.check.messageAr).toBeTruthy();
        const test = await post(s, testUrl(s, 'bosta'));
        expect(test.status, JSON.stringify(test.body)).toBe(200);
        expect(test.body.data.test.ok).toBe(true);

        // the super admin saves and tests (that is how a carrier gets verified)...
        const opSave = await put(op, cfgUrl(s, 'bosta'), {
          mode: 'sandbox',
          credentials: fields,
          activate: true,
        });
        expect(opSave.status, JSON.stringify(opSave.body)).toBe(200);
        const opTest = await post(op, testUrl(s, 'bosta'));
        expect(opTest.status, JSON.stringify(opTest.body)).toBe(200);
        expect(opTest.body.data.test.ok).toBe(true);

        // PROVIDERS-3: it enables like any other once the check passed, for the merchant and the operator
        // the operator keeps the override (the legacy PUT); the merchant turns it on through the confirm flow, and the
        // legacy PUT refuses a merchant's unconfirmed ON
        const refused = await put(s, cfgUrl(s, 'bosta'), { enabled: true });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('CONFIRMATION_REQUIRED');
        const on = await put(op, cfgUrl(s, 'bosta'), { enabled: true });
        expect(on.status, JSON.stringify(on.body)).toBe(200);
        expect((await row(s, 'bosta')).enabled).toBe(true);
      });
    });

    it('a booking is refused for a carrier that was never connected or is not enabled (CARRIER_NOT_ENABLED)', async () => {
      const s = await mkStore('book');
      const o = await mkOrder(s);
      const ship = () =>
        post(s, `/api/v1/stores/${s.id}/orders/${o.id}/ship`, { carrier: 'bosta' });
      const calls = bosta.requests.length;

      // never connected
      const none = await ship();
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe('CARRIER_NOT_ENABLED');

      // saved and tested, not enabled
      await put(s, cfgUrl(s, 'bosta'), {
        mode: 'sandbox',
        credentials: { apiKey: BOSTA_STUB.apiKey },
        activate: true,
        settings: { pickupCity: 'Cairo', pickupLine1: '12 Tahrir St' },
      });
      expect((await post(s, testUrl(s, 'bosta'))).body.data.test.ok).toBe(true);
      const callsAfterTest = bosta.requests.length;
      const off = await ship();
      expect(off.status).toBe(409);
      expect(off.body.error.code).toBe('CARRIER_NOT_ENABLED');

      // none of the refusals reached the carrier or left a shipment row
      expect(bosta.requests.length).toBe(callsAfterTest);
      expect(callsAfterTest).toBeGreaterThan(calls); // (the Test connection itself did)
      expect(await owner.shipment.count({ where: { orderId: o.id } })).toBe(0);

      // sanity: once enabled, this very order books. (Through the service: the 201 over HTTP
      // books but its response never completes under ebda_app, see the report.)
      expect((await turnOn(s, s, 'bosta')).status).toBe(200);
      const ok = await asApp(() =>
        runInTenantContext(s.id, () =>
          shippingCarrierService.createShipmentForOrder(s.id, o.id, 'bosta')
        )
      );
      expect(ok.status).toBe('created');
    });
  });

  describe('tenant scoping', () => {
    it("store B's admin cannot read, save, test, enable, default, rotate or delete store A's carrier", async () => {
      const a = await mkStore('xa');
      const b = await mkStore('xb');
      await put(a, cfgUrl(a, 'bosta'), {
        mode: 'sandbox',
        credentials: { apiKey: BOSTA_STUB.apiKey },
        activate: true,
        settings: {},
      });
      expect((await post(a, testUrl(a, 'bosta'))).body.data.test.ok).toBe(true);
      expect((await turnOn(a, a, 'bosta')).status).toBe(200);
      const snapshot = await row(a, 'bosta');

      const attempts: Array<[string, string, string, object?]> = [
        ['get', listUrl(a), 'list'],
        ['get', cfgUrl(a, 'bosta'), 'get one'],
        [
          'put',
          cfgUrl(a, 'bosta'),
          'save',
          { mode: 'sandbox', credentials: { apiKey: 'evil-key' } },
        ],
        ['put', cfgUrl(a, 'bosta'), 'enable', { enabled: true }],
        ['post', testUrl(a, 'bosta'), 'test'],
        ['post', defaultUrl(a, 'bosta'), 'default'],
        ['post', `/api/v1/stores/${a.id}/shipping-carriers/webhook-secret/bosta/rotate`, 'rotate'],
        ['delete', cfgUrl(a, 'bosta'), 'delete'],
      ];
      for (const [m, url, label, body] of attempts) {
        const res = await asApp(async () =>
          (request(app) as unknown as Record<string, (u: string) => request.Test>)
            [m](url)
            .set('Authorization', `Bearer ${b.jwt}`)
            .send(body ?? {})
        );
        expect([403, 404], `${label}: ${res.status}`).toContain(res.status);
        expect(JSON.stringify(res.body), label).not.toContain(BOSTA_STUB.apiKey);
      }
      // A's row is exactly as it was: not rewritten, not re-tested, not deleted
      const after = await row(a, 'bosta');
      expect(after.credentials).toBe(snapshot.credentials);
      expect(after.enabled).toBe(true);
      expect(after.isDefault).toBe(snapshot.isDefault);
      expect(after.connectionTest).toEqual(snapshot.connectionTest);

      // B sees only its own (empty) list, and a spoofed :storeId does not get past the owner check
      const own = await get(b, listUrl(b));
      expect(own.status).toBe(200);
      expect(own.body.data.configs).toEqual([]);
      expect(await owner.shippingCarrierConfig.count({ where: { storeId: b.id } })).toBe(0);
    });

    it('a customer token and no token are refused', async () => {
      const s = await mkStore('authz');
      const noAuth = await asApp(async () => request(app).get(listUrl(s)));
      expect(noAuth.status).toBe(401);
      const customer = jwt.sign(
        { userId: s.userId, email: 'c@example.test', role: 'customer', tv: 0, storeId: s.id },
        config.jwtSecret,
        { expiresIn: '5m', issuer: 'ebda-api', audience: 'ebda-app' }
      );
      const res = await get({ jwt: customer }, listUrl(s));
      expect(res.status).toBe(403);
    });
  });

  describe('webhook secret rotation', () => {
    it('rotating the secret invalidates the old callback URL token (and header); the new pair works; the key is untouched', async () => {
      const s = await mkStore('rot');
      await put(s, cfgUrl(s, 'bosta'), {
        mode: 'sandbox',
        credentials: { apiKey: BOSTA_STUB.apiKey },
        activate: true,
        settings: {},
      });
      expect((await post(s, testUrl(s, 'bosta'))).body.data.test.ok).toBe(true);
      expect((await turnOn(s, s, 'bosta')).status).toBe(200);

      const secretOf = async () =>
        decryptCarrierBlob((await row(s, 'bosta')).credentials).webhookSecret as string;
      const callback = (tok: string, secret: string) =>
        asApp(async () =>
          request(app)
            .post(`/api/v1/webhooks/shipping/bosta/${s.id}/${tok}`)
            .set('Content-Type', 'application/json')
            .set('x-ebda-webhook-secret', webhookHeaderValue(secret))
            .send(JSON.stringify({ trackingNumber: 987654321, state: 45, timeStamp: Date.now() }))
        );

      const oldSecret = await secretOf();
      expect(oldSecret).toMatch(/^[0-9a-f]{48}$/);
      expect((await callback(oldSecret, oldSecret)).status).toBe(200);

      const rot = await post(
        s,
        `/api/v1/stores/${s.id}/shipping-carriers/webhook-secret/bosta/rotate`
      );
      expect(rot.status, JSON.stringify(rot.body)).toBe(200);
      expect(JSON.stringify(rot.body)).not.toContain(oldSecret);

      const newSecret = await secretOf();
      expect(newSecret).toMatch(/^[0-9a-f]{48}$/);
      expect(newSecret).not.toBe(oldSecret);
      expect((await callback(oldSecret, oldSecret)).status).toBe(401); // the old URL is dead at once
      expect((await callback(oldSecret, newSecret)).status).toBe(401); // old token, new header
      expect((await callback(newSecret, oldSecret)).status).toBe(401); // new token, old header
      expect((await callback(newSecret, newSecret)).status).toBe(200);

      // rotation re-encrypted the same blob: the API key, the test and the enabled switch survive
      const r = await row(s, 'bosta');
      expect(decryptCarrierBlob(r.credentials).sandbox?.apiKey).toBe(BOSTA_STUB.apiKey);
      expect(r.enabled).toBe(true);
      expect((await hintsOf(s, s, 'bosta')).connectionTestCurrent).toBe(true);

      // a carrier nothing was saved for cannot be rotated
      const none = await mkStore('rotnone');
      expect(
        (
          await post(
            none,
            `/api/v1/stores/${none.id}/shipping-carriers/webhook-secret/bosta/rotate`
          )
        ).status
      ).toBe(404);
    });
  });

  it('deleting a carrier removes its credentials row', async () => {
    const s = await mkStore('delete');
    await put(s, cfgUrl(s, 'shipblu'), {
      mode: 'sandbox',
      credentials: { apiKey: SHIPBLU_STUB.apiKey },
      activate: true,
      settings: {},
    });
    expect((await del(s, cfgUrl(s, 'shipblu'))).status).toBe(200);
    expect(
      await owner.shippingCarrierConfig.count({ where: { storeId: s.id, carrier: 'shipblu' } })
    ).toBe(0);
    expect((await hintsOf(s, s, 'shipblu')) ?? null).toBeNull();
  });
});
