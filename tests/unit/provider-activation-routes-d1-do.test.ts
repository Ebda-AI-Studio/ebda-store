/**
 * Provider activation on request (ruling PROVIDERS-ACTIVATION), ported from tests/integration/provider-activation.test.ts, over
 * HTTP through the REAL routers (payment-settings, shipping-carrier, provider-activation + admin), the REAL encryption, the REAL
 * provider gate and the REAL Kashier / Bosta adapters talking to local stubs. Data lives where production keeps it:
 *   - the activation requests, the store directory rows (`stores`) and the access gate: the PLATFORM D1 (real cf-schema migrations);
 *   - each store's payment / carrier connection: its OWN Durable Object schema (one node:sqlite world per store, so a second
 *     store provably cannot see the first one's rows).
 * `authenticate` is replaced by a header-driven identity (token mechanics are covered by auth-state tests); `authorize`,
 * `requireStoreAccess` (owner / staff check on the D1 gate), `requirePermission` and the owner check in the request route run
 * for real. The Postgres client throws on any use.
 *
 * Production's PROVIDERS-2 is simulated: the stub-suite seam is OFF and the catalog entry is flipped to `verified: false`.
 *   - an unverified provider: the merchant can save, test and (PROVIDERS-3) enable it; checkout offers it;
 *   - requesting activation records one row and enqueues the ops email; credentials never reach the mail;
 *   - a merchant cannot activate; another merchant cannot file a request for this store; a store_admin is refused the admin routes;
 *   - the super admin activates only after the store's latest test passed for the credentials stored now;
 *   - activation is per store; a rejection keeps a note, emails the merchant and can be re-filed;
 *   - the same flow for a shipping carrier.
 *
 * Mutations (each restored byte-identical):
 *   - provider-activation.service.ts activateForStore: drop the `passed` check -> "needs a passing test" case red;
 *   - provider-gate.ts activatedProvidersForStore: drop `storeId` from the where -> the "activation is scoped" assertion red;
 *   - (the route's own owner check is a second line behind requireStoreAccess, which already refuses a non-owner: the cross-merchant
 *     case pins the pair, and goes red if BOTH are dropped.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

const h = vi.hoisted(() => ({
  audit: [] as Array<Record<string, unknown>>,
  accounts: new Map<string, { role: string; email: string }>(),
  withStoreRepo: (_id: string, fn: () => unknown): unknown => fn(),
}));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // No tenant transaction on the platform D1 or a DO: a scope is the store's repo scope, as in production after the cutover.
  return {
    ...real,
    withStore: (id: string, fn: (tx: unknown) => unknown) => h.withStoreRepo(id, () => fn({})),
    withUser: (_u: string, fn: (tx: unknown) => unknown) => fn({}),
    runInTenantContext: (_i: unknown, fn: () => unknown) => fn(),
    runInStoreScope: (id: string, fn: () => unknown) => h.withStoreRepo(id, fn),
    runInUserScope: (_u: string, fn: () => unknown) => fn(),
    currentStoreId: () => undefined,
  };
});
vi.mock('@api/lib/identity-client', async importOriginal => ({
  ...(await importOriginal<object>()),
  getAccountState: async (id: string) => {
    const a = h.accounts.get(id);
    return a ? { role: a.role, status: 'active' } : null;
  },
  getAccountsBrief: async (ids: string[]) =>
    ids.flatMap(id => (h.accounts.has(id) ? [{ id, email: h.accounts.get(id)!.email }] : [])),
}));
vi.mock('@api/middleware/auth', async importOriginal => ({
  ...(await importOriginal<object>()),
  // identity comes from a header; authorize / rejectImpersonated stay real
  authenticate: (req: any, res: any, n: () => void) => {
    const id = String(req.headers['x-test-user']);
    const a = h.accounts.get(id);
    if (!a) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
    req.user = { userId: id, email: a.email, role: a.role };
    n();
  },
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/feature-gate', async importOriginal => ({
  ...(await importOriginal<object>()),
  requireFeature: () => (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/tenant-context', async importOriginal => {
  const pass = (_q: unknown, _s: unknown, n: () => void) => n();
  return {
    ...(await importOriginal<object>()),
    tenantContext: pass,
    paymentSettingsRouteContext: pass,
    shippingCarrierRouteContext: pass,
  };
});
vi.mock('@api/middleware/security', async importOriginal => ({
  ...(await importOriginal<object>()),
  auditLog: async (e: Record<string, unknown>) => void h.audit.push(e),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getProviderEntry, BRAND } from '@ebda/shared';
import paymentSettingsRoutes from '@api/routes/payment-settings.routes';
import shippingCarrierRoutes from '@api/routes/shipping-carrier.routes';
import providerActivationRoutes, {
  adminProviderActivationRoutes,
} from '@api/routes/provider-activation.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { emailQueue } from '@api/services/email-queue.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import {
  activatedProvidersForStore,
  isProviderUsableForStore,
} from '@api/services/payment-providers/provider-gate';
import { KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';
import { BostaStub, BOSTA_STUB } from '../stubs/bosta-stub';
import { serveStub, type ServedStub } from '../stubs/serve';
import { DoStores } from '../helpers/multi-store-do';
import { installPlatformD1, uninstallPlatformD1 } from '../helpers/platform-d1-rig';

const SECRET_KEY = KASHIER_STUB.secretKey;
const GOOD = {
  merchantId: KASHIER_STUB.merchantId,
  paymentApiKey: KASHIER_STUB.apiKey,
  secretKey: SECRET_KEY,
};

const worlds = new DoStores();
h.withStoreRepo = (id, fn) => worlds.withStoreRepo(id, fn);
let d1: DatabaseSync;
let app: Express;
let kashierServer: ServedStub;
let bostaServer: ServedStub;
const kashier = new KashierStub();
const bosta = new BostaStub();
let enqueue = vi.spyOn(emailQueue, 'enqueue');

type Actor = { id: string; userId: string; email: string };
function account(role: string, tag: string): { userId: string; email: string } {
  const userId = crypto.randomUUID();
  const email = `${tag}-${userId.slice(0, 6)}@test.local`;
  h.accounts.set(userId, { role, email });
  return { userId, email };
}
function mkStore(tag: string): Actor {
  const u = account('store_admin', `owner-${tag}`);
  const id = crypto.randomUUID();
  d1.prepare(
    `INSERT INTO stores (id, name, slug, owner_id, status) VALUES (?, ?, ?, ?, 'active')`
  ).run(id, `pa-${tag}`, `pa-${tag}-${id.slice(0, 6)}`, u.userId);
  const slug = `pa-${tag}-${id.slice(0, 6)}`;
  worlds.add(id).seedProfile({ name: `pa-${tag}`, slug, ownerId: u.userId });
  return { id, ...u };
}
const mkOperator = () => account('super_admin', 'op');

type Who = { userId: string };
const call = (method: 'get' | 'put' | 'post', who: Who, url: string, body: object = {}) => {
  const r = request(app)[method](url).set('x-test-user', who.userId);
  return method === 'get' ? r : r.send(body);
};
const pay = (s: { id: string }, path = '') =>
  `/api/v1/payment-settings/store/${s.id}/kashier${path}`;
const saveKashier = (s: Actor, fields: Record<string, string> = GOOD) =>
  call('put', s, pay(s, '/credentials'), { mode: 'sandbox', fields, activate: true });
const testKashier = (s: Actor) => call('post', s, pay(s, '/test'));
const toggleKashier = (s: Actor, enabled = true) => call('post', s, pay(s, '/toggle'), { enabled });
const requestUrl = (s: { id: string }, provider: string) =>
  `/api/v1/provider-activation/store/${s.id}/${provider}/request`;
const adminUrl = (s: { id: string }, provider: string, action: string) =>
  `/api/v1/admin/provider-activation/${s.id}/${provider}/${action}`;
const carrierCfg = (s: { id: string }) => `/api/v1/stores/${s.id}/shipping-carriers/configs/bosta`;
const carrierTest = (s: { id: string }) => `/api/v1/stores/${s.id}/shipping-carriers/test/bosta`;
const offered = (s: { id: string }) => {
  PaymentService.clearCache(s.id);
  return worlds.withStoreRepo(s.id, () => PaymentService.getAvailableProviders(s.id));
};
const requests = (s: { id: string }, provider = 'kashier') =>
  d1
    .prepare(
      `SELECT * FROM provider_activation_requests WHERE store_id = ? AND provider = ? ORDER BY requested_at ASC`
    )
    .all(s.id, provider) as Array<{ status: string }>;
const auditActions = (s: { id: string }) =>
  h.audit.filter(a => a.storeId === s.id).map(a => String(a.action));

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

/** A store with tested kashier credentials, ready to request activation. */
async function readyStore(tag: string): Promise<Actor> {
  const s = mkStore(tag);
  expect((await saveKashier(s)).status).toBe(200);
  expect((await testKashier(s)).body.data.test.ok).toBe(true);
  return s;
}

beforeAll(async () => {
  d1 = installPlatformD1();
  kashierServer = await serveStub(kashier.fetch);
  bostaServer = await serveStub(bosta.fetch);
  process.env.KASHIER_BASE_URL = kashierServer.url;
  process.env.BOSTA_BASE_URL = `${bostaServer.url}/api/v2`;
  app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(worlds.repoByPath());
  app.use('/api/v1/payment-settings', paymentSettingsRoutes);
  app.use('/api/v1/stores', shippingCarrierRoutes);
  app.use('/api/v1/provider-activation', providerActivationRoutes);
  app.use('/api/v1/admin', adminProviderActivationRoutes);
  app.use(errorHandler);
});
afterAll(async () => {
  await kashierServer.close();
  await bostaServer.close();
  delete process.env.KASHIER_BASE_URL;
  delete process.env.BOSTA_BASE_URL;
  uninstallPlatformD1();
});
beforeEach(() => {
  h.audit.length = 0;
  enqueue = vi.spyOn(emailQueue, 'enqueue').mockResolvedValue('queued-id');
});

describe('provider activation on request (platform D1 requests + per-store DO connections)', () => {
  it('an unverified provider (PROVIDERS-3): the merchant saves, tests and enables it; checkout offers it', async () => {
    const s = mkStore('save');
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
    const s = mkStore('req');
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
      expect(JSON.stringify(mail)).not.toContain(SECRET_KEY); // no credential ever reaches the mail

      const again = await call('post', s, requestUrl(s, 'kashier'));
      expect(again.status).toBe(200);
      expect(again.body.data.created).toBe(false);
      expect(requests(s)).toHaveLength(1);
      await awaitDeferredWork(2000);
      expect(enqueue).toHaveBeenCalledTimes(1);

      const list = await call('get', s, `/api/v1/provider-activation/store/${s.id}`);
      expect(list.body.data.requests).toHaveLength(1);
      expect(list.body.data.requests[0]).toMatchObject({
        provider: 'kashier',
        status: 'requested',
      });
      expect(list.body.data.requests[0].requestedAt).toBeTruthy();
      expect(auditActions(s).filter(a => a === 'provider_activation.requested')).toHaveLength(1);
    });
  });

  it('requests are refused for a verified provider, a manual one and an unknown one', async () => {
    const s = mkStore('refuse');
    await saveKashier(s);
    // production catalog: kashier is verified -> nothing to activate
    const verified = await call('post', s, requestUrl(s, 'kashier'));
    expect(verified.status).toBe(409);
    expect(verified.body.error.code).toBe('ALREADY_AVAILABLE');
    expect((await call('post', s, requestUrl(s, 'cod'))).status).toBe(422);
    expect((await call('post', s, requestUrl(s, 'nope'))).status).toBe(400);
  });

  it('a merchant cannot activate themselves; another merchant and a non-owner cannot touch this store', async () => {
    const s = await readyStore('self');
    await asProduction(async () => {
      expect((await call('post', s, requestUrl(s, 'kashier'))).status).toBe(201);
      for (const action of ['test', 'activate', 'reject']) {
        const res = await call('post', s, adminUrl(s, 'kashier', action), { note: 'let me in' });
        expect(res.status, action).toBe(403);
      }
      expect((await call('get', s, '/api/v1/admin/provider-activation')).status).toBe(403);
      expect(requests(s)[0].status).toBe('requested');
      // PROVIDERS-3: a request is not a gate any more; the passing test alone enables it
      expect((await toggleKashier(s)).status).toBe(200);

      // a second merchant (own store, own owner) cannot file a request for THIS store, nor read its list
      const other = mkStore('self-other');
      const cross = await call('post', other, requestUrl(s, 'kashier'));
      expect([403, 404]).toContain(cross.status);
      const peek = await call('get', other, `/api/v1/provider-activation/store/${s.id}`);
      expect([403, 404]).toContain(peek.status);
      // and nothing was written for the victim store by the attempt
      expect(requests(s)).toHaveLength(1);
      // an unauthenticated caller is refused before any store logic
      expect((await request(app).post(requestUrl(s, 'kashier'))).status).toBe(401);
    });
  });

  it('activation needs a passing test of the credentials stored now (never tested, stale, failing)', async () => {
    const op = mkOperator();
    await asProduction(async () => {
      // never tested: the save runs the check itself, so clear the proof to model "never tested"
      const fresh = mkStore('untested');
      await saveKashier(fresh);
      worlds.get(fresh.id).sqlite.exec(`UPDATE payment_configs SET connection_test = NULL`);
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
      const bad = mkStore('failing');
      await saveKashier(bad, { ...GOOD, secretKey: 'wrong-secret-key-value-123456' });
      await call('post', bad, requestUrl(bad, 'kashier'));
      const run1 = await call('post', op, adminUrl(bad, 'kashier', 'test'));
      expect(run1.status).toBe(200);
      expect(run1.body.data.test.ok).toBe(false);
      const closed = await call('post', op, adminUrl(bad, 'kashier', 'activate'));
      expect(closed.status).toBe(409);
      expect(requests(bad)[0].status).toBe('requested');
      expect(auditActions(bad)).not.toContain('provider_activation.activated');
    });
  });

  it('after activation the store can enable it and checkout offers it; another store still cannot be activated', async () => {
    const op = mkOperator();
    await asProduction(async () => {
      const a = mkStore('act-a');
      const b = await readyStore('act-b'); // same provider, tested, NEVER activated
      await saveKashier(a);
      await call('post', a, requestUrl(a, 'kashier'));

      const t = await call('post', op, adminUrl(a, 'kashier', 'test'));
      expect(t.status, JSON.stringify(t.body)).toBe(200);
      expect(t.body.data.test).toMatchObject({ ok: true, current: true });
      expect(JSON.stringify(t.body)).not.toContain(SECRET_KEY);
      const act = await call('post', op, adminUrl(a, 'kashier', 'activate'));
      expect(act.status, JSON.stringify(act.body)).toBe(200);
      expect(act.body.data.request.status).toBe('activated');

      expect((await toggleKashier(a)).status).toBe(200);
      expect(await offered(a)).toContain('kashier');
      expect(
        await worlds.withStoreRepo(a.id, () => isProviderUsableForStore('kashier', a.id))
      ).toBe(true);

      // the activation is scoped to the store that asked: A's row is never visible as B's
      expect([...(await activatedProvidersForStore(a.id))]).toEqual(['kashier']);
      expect((await activatedProvidersForStore(b.id)).size).toBe(0);

      // store B (PROVIDERS-3): activation is no longer a gate, B enables on its own passing test
      const on = await toggleKashier(b);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(await offered(b)).toContain('kashier');
      // and it cannot be activated without its own request: A's request never leaks across stores
      expect((await call('post', op, adminUrl(b, 'kashier', 'activate'))).status).toBe(404);
      expect(requests(b)).toHaveLength(0);

      expect(
        auditActions(a)
          .filter(x => x.startsWith('provider_activation.'))
          .sort()
      ).toEqual([
        'provider_activation.activated',
        'provider_activation.requested',
        'provider_activation.test_run',
      ]);

      // the list shows store, provider, requested-at and the last test, never a credential
      const list = await call('get', op, '/api/v1/admin/provider-activation?status=activated');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const mine = list.body.data.requests.find((r: { storeId: string }) => r.storeId === a.id);
      expect(mine).toMatchObject({ provider: 'kashier', kind: 'payments', status: 'activated' });
      expect(mine.lastTest).toMatchObject({ ok: true, current: true });
      expect(list.body.data.requests.some((r: { storeId: string }) => r.storeId === b.id)).toBe(
        false
      );
      expect(JSON.stringify(list.body)).not.toContain(SECRET_KEY);
    });
  });

  it('a rejection keeps it disabled, shows the note, emails the merchant, and can be re-filed', async () => {
    const op = mkOperator();
    await asProduction(async () => {
      const s = await readyStore('reject');
      await call('post', s, requestUrl(s, 'kashier'));

      const noNote = await call('post', op, adminUrl(s, 'kashier', 'reject'), { note: '' });
      expect(noNote.status).toBe(400);
      expect(requests(s)[0].status).toBe('requested');

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
      expect((await toggleKashier(s)).status).toBe(200);
      expect(await offered(s)).toContain('kashier');
      // activating a rejected request is impossible; re-filing makes a new open one
      expect((await call('post', op, adminUrl(s, 'kashier', 'activate'))).status).toBe(404);
      expect((await call('post', s, requestUrl(s, 'kashier'))).status).toBe(201);
      expect(requests(s).map(r => r.status)).toEqual(['rejected', 'requested']);
    });
  });

  it('shipping: the same flow for a carrier (save+test ok, enable, activation is per store, other store refused)', async () => {
    const op = mkOperator();
    await asProduction(async () => {
      const a = mkStore('ship-a');
      const b = mkStore('ship-b');
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
      // B never asked: nothing to activate, and A's activation does not touch B
      expect((await call('post', op, adminUrl(b, 'bosta', 'activate'))).status).toBe(404);
      // B's merchant cannot file a request against A
      expect([403, 404]).toContain((await call('post', b, requestUrl(a, 'bosta'))).status);

      expect((await call('put', a, carrierCfg(a), { enabled: true })).status).toBe(200);
      expect((await call('put', b, carrierCfg(b), { enabled: true })).status).toBe(200);
      expect(await worlds.withStoreRepo(a.id, () => isProviderUsableForStore('bosta', a.id))).toBe(
        true
      );
      expect(await worlds.withStoreRepo(b.id, () => isProviderUsableForStore('bosta', b.id))).toBe(
        true
      );
    });
  });
});
