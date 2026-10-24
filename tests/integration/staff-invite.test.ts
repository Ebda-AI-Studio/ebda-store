/**
 * Staff invite consent (lens-2, 2026-09-22 security audit): adding a staff
 * member used to create an account the invitee could not discover — no
 * invite-token flow, and when the owner left the password field blank the
 * generated password was known to nobody. Every add now mails the invitee: a
 * brand-new account gets a real set-password link (the same token + redeem
 * path as "forgot password"); an account that already exists elsewhere gets a
 * short notice only.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { withRlsBypass } from '@ebda/database';
import staffRoutes from '@api/routes/staff.routes';
import authRoutes from '@api/routes/auth.routes';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import {
  clearCapturedMail,
  latestCapturedMailTo,
  tokenFromCapturedMail,
} from '@api/services/platform-mailer';
import { hasDb, storeAdminAccessTokenFor, type FixtureStore } from '../helpers/bundle-fixtures';

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

  beforeAll(() => {
    app = buildApp();
  });

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

  it('a brand-new staff account gets a mailed set-password link that actually works', async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const store = await seedPlainStore(run);
    const token = storeAdminAccessTokenFor(store.ownerId);
    const staffEmail = `new-staff-${run}@example.com`;
    clearCapturedMail();

    const res = await request(app)
      .post(`/api/v1/stores/${store.storeId}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: staffEmail, firstName: 'Sara', lastName: 'Ali' });

    expect(res.status).toBe(201);

    const mail = await waitForMailTo(staffEmail);
    const resetToken = tokenFromCapturedMail(mail);
    expect(resetToken, 'mail carries a working set-password token').toBeTruthy();

    // Redeem it exactly like a self-service password reset — same endpoint,
    // proving this is a REAL, usable path into the account, not just a link.
    const redeem = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: resetToken, password: 'NewStr0ng!Passw0rd' });
    expect(redeem.status).toBe(200);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: 'NewStr0ng!Passw0rd' });
    expect(login.status).toBe(200);
  });

  it('an owner-supplied password still works even though a set-password link is also mailed', async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const store = await seedPlainStore(run);
    const token = storeAdminAccessTokenFor(store.ownerId);
    const staffEmail = `owner-set-${run}@example.com`;
    clearCapturedMail();

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

    await waitForMailTo(staffEmail);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: 'OwnerChosen!9' });
    expect(login.status).toBe(200);
  });

  it('adding an EXISTING account to a second store sends a notice, not a new password link', async () => {
    const runA = crypto.randomUUID().slice(0, 8);
    const runB = crypto.randomUUID().slice(0, 8);
    const storeA = await seedPlainStore(runA);
    const storeB = await seedPlainStore(runB);
    const staffEmail = `shared-staff-${runA}@example.com`;

    const firstAdd = await request(app)
      .post(`/api/v1/stores/${storeA.storeId}/staff`)
      .set('Authorization', `Bearer ${storeAdminAccessTokenFor(storeA.ownerId)}`)
      .send({ email: staffEmail, firstName: 'Omar', lastName: 'Said', password: 'FirstPass!1' });
    expect(firstAdd.status).toBe(201);
    // Drain the first add's OWN deferred invite mail before clearing — it
    // runs after the response (`deferAfterTenantCommit`), so it can still be
    // in flight here; clearing too early would let it land AFTER the clear
    // and be mistaken for the second add's notice.
    await waitForMailTo(staffEmail);

    clearCapturedMail();
    const secondAdd = await request(app)
      .post(`/api/v1/stores/${storeB.storeId}/staff`)
      .set('Authorization', `Bearer ${storeAdminAccessTokenFor(storeB.ownerId)}`)
      .send({ email: staffEmail, firstName: 'Omar', lastName: 'Said' });
    expect(secondAdd.status).toBe(201);

    const mail = await waitForMailTo(staffEmail);
    expect(tokenFromCapturedMail(mail), 'no set-password link for an existing account').toBeNull();

    // The original password still works — the notice didn't touch it.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: 'FirstPass!1' });
    expect(login.status).toBe(200);
  });
});
