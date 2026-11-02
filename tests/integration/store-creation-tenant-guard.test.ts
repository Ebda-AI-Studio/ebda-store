/**
 * Every path that creates a NEW store, run the way production runs it: the request is bound
 * to the guarded app client (`createPrismaClient`, code-level tenant guard R-EBDA-003) on the
 * strict-RLS role `ebda_app` (R-EBDA-001), exactly as the Worker shell binds one per request.
 *
 * Why this file exists (P0, 2026-10-08): POST /onboarding/store returned 500
 * `TenantScopeViolation: Store.create refused: a new store must be owned by the ambient user`
 * for EVERY new merchant, because `ProvisioningService.provisionStore` inserted the store row
 * in a transaction with no user scope. The in-process onboarding suites stayed green: the
 * integration setup makes the process `prisma` the OWNER-ROLE client (no guard, BYPASSRLS),
 * so they never ran the guard, and the HTTP suite that does runs only on the weekly full lane.
 *
 * Paths, each through its real route or entry point:
 *   1. merchant profile + identity session -> POST /onboarding/store (self-serve, no tenant context)
 *   2. super_admin POST /admin/stores (ProvisioningService, platform-operator hatch)
 *   3. store_admin POST /stores (StoreService.create, an additional store)
 *   4. ProvisioningService.provisionStore called with no ambient scope at all (jobs, scripts)
 *
 * Sessions: merchants and super admins sign in at the identity service (Rulings ID-1/ID-2), so this in-process app installs the
 * same test identity stand-in as the API server and every user gets the ES256 token the identity service would issue.
 *
 * Mutation proof (run by hand, recorded in the commit body): in provisioning.service.ts replace
 * `scopeTransaction(tx, { userId: owner.id }, () => tx.store.create(...))` with the bare
 * `tx.store.create(...)` -> paths 1 and 4 go red with the guard's TenantScopeViolation (path 2
 * stays green: a super_admin runs under the platform-operator hatch, which admits the insert).
 * In store.service.ts drop the `withUser(ownerId, ...)` around `prisma.store.create` -> path 3
 * goes red. The welcome-mail assertion in path 2 is a positive check only: the bare `void`
 * it replaced failed with P2028 once in this harness but not reliably (a race with the
 * request client's release), so it is not claimed as a mutation proof.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, withRlsBypass, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import authRoutes from '@api/routes/auth.routes';
import onboardingRoutes from '@api/routes/onboarding.routes';
import adminRoutes from '@api/routes/admin.routes';
import storeRoutes from '@api/routes/store.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { ProvisioningService } from '@api/services/provisioning.service';
import { EmailService } from '@api/services/email.service';
import { installTestIdentity } from '@api/lib/test-identity';
import { hasDb } from '../helpers/bundle-fixtures';
import { identityTokenFor } from '../helpers/identity-session';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
/** Run as production does: the guarded client, on the strict-RLS role `ebda_app`. */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const run = crypto.randomUUID().slice(0, 8);
const emails: string[] = [];
const mkEmail = (tag: string) => {
  const e = `scg-${tag}-${run}-${crypto.randomUUID().slice(0, 4)}@test.local`;
  emails.push(e);
  return e;
};
const mkSlug = (tag: string) => `scg-${tag}-${run}-${crypto.randomUUID().slice(0, 4)}`;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // One guarded ebda_app client per request, held until the response is sent (the Worker
  // shell's `runWithRequestDb`), so every route below runs under BOTH tenant layers.
  app.use((req: Request, res: Response, next: NextFunction) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  // Mounted exactly as apps/api/src/routes/index.ts mounts them.
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/admin', tenantContext, adminRoutes);
  app.use('/api/v1/onboarding', onboardingRoutes);
  app.use('/api/v1/stores', tenantContext, storeRoutes);
  app.use(errorHandler);
  return app;
}

describe.skipIf(!hasDb)('store creation under the tenant guard + strict RLS (ebda_app)', () => {
  let app: Express;
  process.env.STORES_PER_ACCOUNT_PER_DAY = '10';
  const api = () => request(app);

  // Merchants sign up, verify and sign in at the identity service (Rulings ID-1/ID-2); the Store only holds the profile row the
  // signup writes (role store_admin, storeId NULL, no credential). Write that row, then take the identity token. The signup /
  // verification mail itself is the identity service's flow (merchant-signup.service createIdentity is unit-tested with a stub).
  async function verifiedMerchant(tag: string) {
    const email = mkEmail(tag);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: '!identity',
        firstName: 'Mona',
        lastName: 'Hassan',
        role: 'store_admin',
        emailVerified: true,
        storeId: null,
      },
      select: { id: true },
    });
    // No Store login here (Ruling ID-1; api.test.ts and mfa.test.ts assert the 409): the session comes from the identity service.
    return { email, id: user.id, jwt: await identityTokenFor(user.id) };
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function storeOf(id: string) {
    return prisma.store.findUniqueOrThrow({
      where: { id },
      select: { ownerId: true, status: true, plan: true, slug: true },
    });
  }

  beforeAll(() => {
    expect(installTestIdentity(), 'EBDA_TEST_IDENTITY_JWK + NODE_ENV=test').toBe(true);
    app = buildApp();
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    const ids = users.map(u => u.id);
    await prisma.store.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.verificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it('1. a new merchant (identity session) creates her first store (onboarding)', async () => {
    const m = await verifiedMerchant('onb');
    const slug = mkSlug('onb');
    const res = await api()
      .post('/api/v1/onboarding/store')
      .set(bearer(m.jwt))
      .send({ name: 'متجر منى', slug, language: 'ar' });
    expect(res.body?.error?.code, JSON.stringify(res.body)).toBeUndefined();
    expect(res.status).toBe(201);
    const store = await storeOf(res.body.data.store.id);
    expect(store).toMatchObject({ ownerId: m.id, status: 'inactive', slug });
    // The provisioning rows written in the new store's scope landed too.
    const [cod, category, sub] = await Promise.all([
      prisma.paymentConfig.count({ where: { storeId: res.body.data.store.id, provider: 'cod' } }),
      prisma.category.count({ where: { storeId: res.body.data.store.id } }),
      prisma.storeSubscription.findUnique({ where: { storeId: res.body.data.store.id } }),
    ]);
    expect(cod).toBe(1);
    expect(category).toBe(1);
    expect(sub?.status).toBe('trialing');

    // The onboarding state the next step reads resolves the new store under the same layers.
    const state = await api().get('/api/v1/onboarding/state').set(bearer(m.jwt));
    expect(state.status).toBe(200);
  });

  it('2. a super_admin provisions a store for a new owner (POST /admin/stores)', async () => {
    const adminEmail = mkEmail('sa');
    const admin = await withRlsBypass(tx =>
      tx.user.create({
        data: {
          email: adminEmail,
          passwordHash: 'x',
          firstName: 'Super',
          lastName: 'Admin',
          role: 'super_admin',
          emailVerified: true,
          mfaEnabled: true,
        },
      })
    );
    const token = await identityTokenFor(admin.id);
    const ownerEmail = mkEmail('prov-owner');
    const slug = mkSlug('prov');
    // The welcome mail is post-response work: it must still reach the send step (it used to
    // die with P2028 on the request's released client). The transport itself is stubbed.
    const send = vi.spyOn(EmailService, 'sendForStore').mockResolvedValue(undefined as never);
    const res = await api()
      .post('/api/v1/admin/stores')
      .set(bearer(token))
      .send({ storeName: 'Provisioned', storeSlug: slug, ownerEmail, ownerName: 'New Owner' });
    expect(res.body?.error?.code, JSON.stringify(res.body)).toBeUndefined();
    expect(res.status).toBe(201);
    const owner = await prisma.user.findFirstOrThrow({ where: { email: ownerEmail } });
    const store = await storeOf(res.body.data.store.id);
    expect(store).toMatchObject({ ownerId: owner.id, slug, status: 'active' });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        res.body.data.store.id,
        expect.objectContaining({ to: ownerEmail })
      )
    );
    send.mockRestore();
  });

  it('3. a store_admin adds a store through POST /stores (StoreService.create)', async () => {
    const m = await verifiedMerchant('post');
    const res = await api()
      .post('/api/v1/stores')
      .set(bearer(m.jwt))
      .send({ name: `Second Shop ${crypto.randomUUID().slice(0, 6)}`, slug: mkSlug('post') });
    expect(res.body?.error?.code, JSON.stringify(res.body)).toBeUndefined();
    expect(res.status).toBe(201);
    expect((await storeOf(res.body.data.store.id)).ownerId).toBe(m.id);
  });

  it('4. provisionStore with NO ambient scope (jobs, scripts) creates the store as its owner', async () => {
    const ownerEmail = mkEmail('bare');
    const slug = mkSlug('bare');
    const r = await asApp(() =>
      ProvisioningService.provisionStore({
        storeName: 'Bare',
        storeSlug: slug,
        plan: 'professional',
        growthTrial: true,
        status: 'inactive',
        ownerEmail,
        ownerName: 'Bare Owner',
      })
    );
    expect(r.store.slug).toBe(slug);
    expect((await storeOf(r.store.id)).ownerId).toBe(r.owner.id);
  });
});
