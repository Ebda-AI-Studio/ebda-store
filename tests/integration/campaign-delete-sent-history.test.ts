/**
 * Issue 2084 — `DELETE /stores/:storeId/campaigns/:campaignId` refuses to
 * delete a campaign that already sent mail with ONE statement:
 *
 *   prisma.campaign.deleteMany({ where: { …, recipients: { none: { sentAt: { not: null } } } } })
 *
 * The whole guard is the SQL the Prisma engine emits for that top-level
 * relation filter (a DELETE … WHERE NOT EXISTS). The only prior coverage ran
 * against a hand-written in-memory fake that cannot model the engine, so a
 * mistranslation (a no-op guard, or a 500 on every delete) would have stayed
 * green. This drives the real route against a real Postgres.
 *
 * Auth/feature middleware are stubbed (they are not what is under test); the
 * database is real. Every fixture id is per CALL, so a `--retry=1` re-run
 * never collides with the failed attempt's rows.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { withRlsBypass } from '@ebda/database';

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'campaign-it-admin', role: 'super_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));

import campaignRoutes from '@api/routes/campaign.routes';
import { errorHandler } from '@api/middleware/error-handler';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

async function seedStore(): Promise<string> {
  const id = uid();
  return withRlsBypass(async tx => {
    const owner = await tx.user.create({
      data: {
        email: `campaign-it-owner-${id}@example.com`,
        passwordHash: 'not-a-real-hash',
        role: 'store_admin',
        firstName: 'Campaign',
        lastName: 'Fixture',
      },
    });
    const store = await tx.store.create({
      data: {
        name: `campaign-it-${id}`,
        slug: `campaign-it-${id}`,
        template: 'qamar',
        currency: 'EGP',
        ownerId: owner.id,
        status: 'active',
      },
    });
    return store.id;
  });
}

async function seedCampaign(
  storeId: string,
  status: 'draft' | 'cancelled' | 'failed' | 'sent',
  recipients: Array<{ sentAt: Date | null }>
): Promise<string> {
  return withRlsBypass(async tx => {
    const c = await tx.campaign.create({
      data: {
        storeId,
        name: `c-${uid()}`,
        subject: 'Hello',
        bodyHtml: '<p>hi</p>',
        status,
      },
    });
    for (const r of recipients) {
      await tx.campaignRecipient.create({
        data: {
          campaignId: c.id,
          storeId,
          email: `r-${uid()}@example.com`,
          locale: 'en',
          status: r.sentAt ? 'sent' : 'queued',
          sentAt: r.sentAt,
        },
      });
    }
    return c.id;
  });
}

const counts = (campaignId: string) =>
  withRlsBypass(async tx => ({
    campaigns: await tx.campaign.count({ where: { id: campaignId } }),
    recipients: await tx.campaignRecipient.count({ where: { campaignId } }),
  }));

describe.skipIf(!hasDb)('DELETE campaign — the sent-history guard against a real database', () => {
  let app: Express;
  let storeId: string;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/stores/:storeId/campaigns', campaignRoutes);
    app.use(errorHandler);
    storeId = await seedStore();
  });

  it('refuses (409) a cancelled campaign that already sent mail, and deletes NOTHING', async () => {
    const id = await seedCampaign(storeId, 'cancelled', [{ sentAt: new Date() }, { sentAt: null }]);

    const res = await request(app).delete(`/stores/${storeId}/campaigns/${id}`);

    expect(res.status).toBe(409);
    // Issue 2082 split the refusal: a deletable status with sent mail is
    // CAMPAIGN_HAS_SEND_HISTORY (the admin translates it separately from the
    // wrong-status CAMPAIGN_NOT_DELETABLE asserted below).
    expect(res.body.error.code).toBe('CAMPAIGN_HAS_SEND_HISTORY');
    expect(await counts(id)).toEqual({ campaigns: 1, recipients: 2 });
  });

  it('deletes (200) a cancelled campaign whose recipients never sent, cascading its rows', async () => {
    const id = await seedCampaign(storeId, 'cancelled', [{ sentAt: null }, { sentAt: null }]);

    const res = await request(app).delete(`/stores/${storeId}/campaigns/${id}`);

    expect(res.status).toBe(200);
    expect(await counts(id)).toEqual({ campaigns: 0, recipients: 0 });
  });

  it('deletes a draft with no recipients at all (the `none` filter over an empty relation)', async () => {
    const id = await seedCampaign(storeId, 'draft', []);
    const res = await request(app).delete(`/stores/${storeId}/campaigns/${id}`);
    expect(res.status).toBe(200);
    expect(await counts(id)).toEqual({ campaigns: 0, recipients: 0 });
  });

  it('refuses a sent campaign by status, independent of the recipient guard', async () => {
    const id = await seedCampaign(storeId, 'sent', [{ sentAt: null }]);
    const res = await request(app).delete(`/stores/${storeId}/campaigns/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAMPAIGN_NOT_DELETABLE');
    expect(await counts(id)).toEqual({ campaigns: 1, recipients: 1 });
  });
});
