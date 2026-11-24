/**
 * Staff invite consent (lens-2, 2026-09-22 security audit): adding a staff
 * member used to create an account the invitee could not discover — no
 * invite-token flow, and when the owner left the password field blank the
 * generated password was known to nobody. Every add now mails the invitee: a
 * brand-new account is created at the identity service, which mails the
 * set-password code (Ruling ID-1/ID-13); an account that already exists
 * elsewhere gets a short notice only.
 *
 * The identity service (accounts) is not reachable from this in-process harness, so a recording fake stands in for its
 * `inviteUser` / `getAccountState`. What the Store owns is asserted for real: the id handshake, the profile row, the seat,
 * the membership and which mail the Store itself sends. The code mail, the set-password redemption and the credential live in
 * accounts: apps/accounts/test/rpc.test.ts (inviteUser) and tests/unit/staff-invite-flow.test.ts (Store half with mocks).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { withRlsBypass, prisma } from '@ebda/database';
import staffRoutes from '@api/routes/staff.routes';
import authRoutes from '@api/routes/auth.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import {
  clearCapturedMail,
  latestCapturedMailTo,
  tokenFromCapturedMail,
} from '@api/services/platform-mailer';
import { configureIdentityClient } from '@api/lib/identity-client';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import type { AccountsRpc } from '@api/cf/bindings';
import { hasDb, type FixtureStore } from '../helpers/bundle-fixtures';
import { installTestIdentity } from '@api/lib/test-identity';
import { identityTokenFor } from '../helpers/identity-session';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/stores/:storeId/staff', tenantContext, staffRoutes);
  app.use('/api/v1/auth', authRoutes);
  app.use(errorHandler);
  return app;
}

async function seedPlainStore(suffix: string): Promise<FixtureStore> {
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `staff-invite-owner-${suffix}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'store_admin',
        firstName: 'Owner',
        lastName: 'Fixture',
      },
    });
    const store = await tx.store.create({
      data: {
        name: `Staff Invite Fixture ${suffix}`,
        slug: `staff-invite-${suffix}`,
        template: 'qamar',
        currency: 'EGP',
        ownerId: owner.id,
        status: 'active',
      },
    });
    return { storeId: store.id, ownerId: owner.id };
  });
}

describe.skipIf(!hasDb)('staff invite consent', () => {
  let app: Express;

  type Invite = Parameters<NonNullable<AccountsRpc['inviteUser']>>[0];
  const invites: Invite[] = [];
  /** Accounts the fake identity service "holds": id -> verified staff (set once the invitee has finished the code step). */
  const verifiedStaff = new Set<string>();

  beforeAll(() => {
    // staff add / remove sit behind requireRecentLogin (TEN-4): the owner signs in through an identity token with a fresh auth_time
    expect(installTestIdentity(), 'EBDA_TEST_IDENTITY_JWK + NODE_ENV=test').toBe(true);
    app = buildApp();
    configureIdentityClient({
      inviteUser: async input => {
        invites.push(input);
        return { id: input.id, created: true };
      },
      getAccountState: async id => ({
        id,
        email: `${id}@example.test`,
        emailVerified: verifiedStaff.has(id),
        mfaEnabled: false,
        mfaEnrolledAt: null,
        status: 'active',
        role: 'staff',
        firstName: '',
        lastName: '',
        phone: null,
        language: 'ar',
      }),
    });
  });
  afterAll(() => configureIdentityClient(undefined));

  // The invite mail goes out via `cfWaitUntil` — fire-and-forget outside a
  // real Workers request (no `waitUntilStore` context in this bare Express
  // harness), so it can still be in flight when the HTTP response returns.
  async function waitForMailTo(email: string) {
    return vi.waitFor(
      () => {
        const m = latestCapturedMailTo(email);
        if (!m) throw new Error('invite mail not captured yet');
        return m;
      },
      { timeout: 5000, interval: 25 }
    );
  }

  const profile = (email: string) =>
    prisma.user.findFirst({
      where: { email, storeId: null },
      select: { id: true, role: true, emailVerified: true },
    });

  it('a brand-new staff account is created at the identity service (which mails the code); the Store binds profile + seat only', async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const store = await seedPlainStore(run);
    const token = await identityTokenFor(store.ownerId);
    const staffEmail = `new-staff-${run}@example.com`;
    clearCapturedMail();
    invites.length = 0;

    const res = await request(app)
      .post(`/api/v1/stores/${store.storeId}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: staffEmail, firstName: 'Sara', lastName: 'Ali' });

    expect(res.status).toBe(201);
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ email: staffEmail, role: 'staff', firstName: 'Sara' });
    const user = await profile(staffEmail);
    expect(user).toMatchObject({ role: 'staff', emailVerified: false });
    expect(invites[0].id, 'the profile carries the id THIS request generated').toBe(user!.id);
    expect(
      await prisma.storeStaff.count({ where: { storeId: store.storeId, userId: user!.id } })
    ).toBe(1);

    // The set-password code is the identity service's mail, so the Store sends none of its own for a new account.
    await awaitDeferredWork(5000);
    expect(latestCapturedMailTo(staffEmail)).toBeFalsy();

    // And the Store holds no password for the account (placeholder hash): no password signs in here.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: 'NewStr0ng!Passw0rd' });
    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('an owner-supplied password is never forwarded or stored: the invitee sets it through the identity service', async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const store = await seedPlainStore(run);
    const token = await identityTokenFor(store.ownerId);
    const staffEmail = `owner-set-${run}@example.com`;
    clearCapturedMail();
    invites.length = 0;

    const res = await request(app)
      .post(`/api/v1/stores/${store.storeId}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: staffEmail,
        firstName: 'Sara',
        lastName: 'Ali',
        password: 'OwnerChosen!9',
      });
    expect(res.status).toBe(201);

    expect(invites).toHaveLength(1);
    expect(JSON.stringify(invites[0])).not.toContain('OwnerChosen!9');
    await awaitDeferredWork(5000);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: 'OwnerChosen!9' });
    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('adding an EXISTING verified staff account to a second store sends a notice, not a new invitation or password link', async () => {
    const runA = crypto.randomUUID().slice(0, 8);
    const runB = crypto.randomUUID().slice(0, 8);
    const storeA = await seedPlainStore(runA);
    const storeB = await seedPlainStore(runB);
    const staffEmail = `shared-staff-${runA}@example.com`;
    invites.length = 0;

    const firstAdd = await request(app)
      .post(`/api/v1/stores/${storeA.storeId}/staff`)
      .set('Authorization', `Bearer ${await identityTokenFor(storeA.ownerId)}`)
      .send({ email: staffEmail, firstName: 'Omar', lastName: 'Said' });
    expect(firstAdd.status).toBe(201);
    // Drain the first add's OWN deferred work before clearing: it runs after the response (`deferAfterTenantCommit`).
    await awaitDeferredWork(5000);
    // The invitee has since finished the code step at the identity service.
    verifiedStaff.add((await profile(staffEmail))!.id);

    clearCapturedMail();
    const secondAdd = await request(app)
      .post(`/api/v1/stores/${storeB.storeId}/staff`)
      .set('Authorization', `Bearer ${await identityTokenFor(storeB.ownerId)}`)
      .send({ email: staffEmail, firstName: 'Omar', lastName: 'Said' });
    expect(secondAdd.status).toBe(201);

    const mail = await waitForMailTo(staffEmail);
    expect(tokenFromCapturedMail(mail), 'no set-password link for an existing account').toBeNull();
    expect(invites, 'no second identity is created for the same address').toHaveLength(1);
    const user = await profile(staffEmail);
    expect(
      await prisma.storeStaff.count({ where: { userId: user!.id, storeId: storeB.storeId } })
    ).toBe(1);
  });
});
