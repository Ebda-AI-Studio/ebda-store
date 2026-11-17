/**
 * Pending policy notices over HTTP (Ruling LEGAL-4) on the strict-RLS `ebda_app` login.
 * Review Focus 1 (one ack clears every store) and 4 (forged / non-pending ack refused).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';
import { config } from '@api/config';
import { meLegalAcceptanceRoutes, meLegalNoticeRoutes } from '@api/routes/legal-policy.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { __setLegalPoliciesForTests } from '@api/services/legal-notice.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const V = '99.0';

const FIXTURE: LegalPolicies = {
  ...LEGAL_POLICIES,
  terms: {
    history: [
      ...LEGAL_POLICIES.terms.history,
      {
        version: V,
        publishedAt: '2026-10-20',
        effectiveAt: '2026-11-20',
        material: true,
        feeChange: true,
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
      },
    ],
  },
};

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
type Role = 'store_admin' | 'super_admin' | 'staff';
const token = (userId: string, role: Role, impersonatedBy?: string) =>
  jwt.sign(
    { userId, email: `${userId}@example.test`, role, tv: 0, impersonatedBy },
    config.jwtSecret,
    {
      expiresIn: '30m',
      issuer: 'ebda-api',
      audience: 'ebda-app',
    }
  );

describe.skipIf(!hasDb)('pending legal notices', () => {
  let owner: AppPrismaClient;
  let app: Express;
  let merchant = '';
  let operator = '';
  let signedUp = '';
  const storeIds: string[] = [];

  const mkUser = async (tag: string, role: Role) =>
    (
      await owner.user.create({
        data: {
          email: `ln-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`,
          passwordHash: 'x',
          firstName: 'Ln',
          lastName: tag,
          role,
          emailVerified: true,
        },
      })
    ).id;
  const get = (userId: string, role: 'store_admin' | 'super_admin' = 'store_admin') =>
    asApp(async () =>
      request(app)
        .get('/api/v1/me/legal-notices')
        .set('Authorization', `Bearer ${token(userId, role)}`)
    );
  const ack = (userId: string, items: unknown, role: Role = 'store_admin') =>
    asApp(async () =>
      request(app)
        .post('/api/v1/me/legal-notices/ack')
        .set('Authorization', `Bearer ${token(userId, role)}`)
        .send({ items })
    );
  const wipe = async () => {
    await owner.legalNoticeSend.deleteMany({ where: { docKey: 'terms', version: V } });
    // I3 fixture: an (impossible in production) announcement of the NON-material privacy@1.0.
    await owner.legalNoticeSend.deleteMany({ where: { docKey: 'privacy', version: '1.0' } });
    await owner.legalAcceptance.deleteMany({ where: { docKey: 'terms', version: V } });
  };
  const withToken = (path: string, method: 'get' | 'post', tok: string) =>
    asApp(async () =>
      request(app)
        [method](path)
        .set('Authorization', `Bearer ${tok}`)
        .send({ items: [{ docKey: 'terms', version: V }] })
    );

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    __setLegalPoliciesForTests(FIXTURE);
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/me/legal-notices', meLegalNoticeRoutes);
    app.use('/api/v1/me/legal-acceptances', meLegalAcceptanceRoutes);
    app.use(errorHandler);
    merchant = await mkUser('m', 'store_admin');
    operator = await mkUser('op', 'super_admin');
    // A merchant who signed up through the click-wrap: has a row per document at 1.0.
    signedUp = await mkUser('su', 'store_admin');
    await owner.legalAcceptance.createMany({
      data: ['legal', 'privacy', 'terms', 'acceptableUse', 'merchant'].map(docKey => ({
        userId: signedUp,
        docKey,
        version: '1.0',
        source: 'signup',
      })),
    });
    // `merchant` has a recorded baseline (v1.0 of every document), so the notice tests below are about
    // CHANGES. A merchant with no record at all is asked for the baseline: see the ZERO-rows test.
    await owner.legalAcceptance.createMany({
      data: ['legal', 'privacy', 'terms', 'acceptableUse', 'merchant'].map(docKey => ({
        userId: merchant,
        docKey,
        version: '1.0',
        source: 'signup',
      })),
    });
    for (const n of [1, 2]) {
      const s = await owner.store.create({
        data: {
          name: `ln-${run}-${n}`,
          slug: `ln-${run}-${n}`,
          ownerId: merchant,
          status: 'active',
        },
      });
      storeIds.push(s.id);
    }
  });
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    __setLegalPoliciesForTests(null);
    await owner.store.deleteMany({ where: { id: { in: storeIds } } });
    await owner.user.deleteMany({ where: { id: { in: [merchant, operator, signedUp] } } });
    await owner.$disconnect();
  });

  it('nothing is pending before the version is sent; the read is never cached', async () => {
    const res = await get(merchant);
    expect(res.status).toBe(200);
    expect(res.body.data.notices).toEqual([]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('after a send the merchant has one pending notice with summary, date and links', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    const res = await get(merchant);
    expect(res.body.data.notices).toEqual([
      {
        docKey: 'terms',
        version: V,
        effectiveAt: '2026-11-20',
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
        title: { ar: 'شروط الخدمة', en: 'Terms of service' },
        url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
      },
    ]);
    // A super_admin is not a party to the merchant agreement: nothing pending, no 403.
    expect((await get(operator, 'super_admin')).body.data.notices).toEqual([]);
  });

  it('refuses an ack for a non-pending or forged version and writes nothing', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    for (const items of [
      [{ docKey: 'terms', version: '1.0' }], // superseded
      [{ docKey: 'privacy', version: '1.0' }], // not material, never sent
      [{ docKey: 'terms', version: '98.0' }], // does not exist
      [{ docKey: 'cookies', version: V }], // unknown document
      [
        { docKey: 'terms', version: V },
        { docKey: 'privacy', version: '1.0' },
      ], // one bad item refuses the whole request
    ]) {
      const res = await ack(merchant, items);
      expect(res.status, JSON.stringify(items)).toBe(422);
      expect(res.body.error.code).toBe('NOT_PENDING');
    }
    expect(
      await owner.legalAcceptance.count({
        where: { userId: merchant, docKey: 'terms', version: V },
      })
    ).toBe(0);
    expect((await ack(merchant, [])).status).toBe(400);
    expect((await ack(operator, [{ docKey: 'terms', version: V }], 'super_admin')).status).toBe(
      403
    );
  });

  it('one ack clears the notice for every store the merchant owns; a repeat ack is a no-op', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    const res = await ack(merchant, [{ docKey: 'terms', version: V }]);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ acknowledged: 1 });
    const rows = await owner.legalAcceptance.findMany({
      where: { userId: merchant, docKey: 'terms', version: V },
      select: { source: true },
    });
    expect(rows).toEqual([{ source: 'notice_ack' }]);
    // The notice is per user, not per store: no store of theirs shows it any more.
    expect((await get(merchant)).body.data.notices).toEqual([]);
    const again = await ack(merchant, [{ docKey: 'terms', version: V }]);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ acknowledged: 0 });
  });

  it('a user who accepted everything at signup: sees the sent notice, acks it, and cannot ack a signup version', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    expect(
      (await get(signedUp)).body.data.notices.map((n: { docKey: string }) => n.docKey)
    ).toEqual(['terms']);
    // privacy@1.0 is current but not material (accepted at signup): not ackable.
    const bad = await ack(signedUp, [{ docKey: 'privacy', version: '1.0' }]);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('NOT_PENDING');
    expect((await ack(signedUp, [{ docKey: 'terms', version: V }])).body.data).toEqual({
      acknowledged: 1,
    });
    expect((await ack(signedUp, [{ docKey: 'terms', version: V }])).body.data).toEqual({
      acknowledged: 0,
    });
    expect(
      await owner.legalAcceptance.count({ where: { userId: signedUp, source: 'notice_ack' } })
    ).toBe(1);
    expect((await get(signedUp)).body.data.notices).toEqual([]);
  });

  it('a staff-provisioned owner with ZERO acceptance rows is asked for every document, and can ack them all', async () => {
    const provisioned = await mkUser('pv', 'store_admin');
    try {
      expect(await owner.legalAcceptance.count({ where: { userId: provisioned } })).toBe(0);
      // Nothing was SENT, yet the missing baseline is pending (Ruling LEGAL-BASELINE-1).
      const res = await get(provisioned);
      expect(res.status).toBe(200);
      const notices = res.body.data.notices as Array<{ docKey: string; version: string }>;
      expect(notices.map(n => n.docKey).sort()).toEqual(
        ['acceptableUse', 'legal', 'merchant', 'privacy', 'terms'].sort()
      );
      const acked = await ack(
        provisioned,
        notices.map(n => ({ docKey: n.docKey, version: n.version }))
      );
      expect(acked.body.data).toEqual({ acknowledged: 5 });
      expect((await get(provisioned)).body.data.notices).toEqual([]);
    } finally {
      await owner.legalAcceptance.deleteMany({ where: { userId: provisioned } });
      await owner.user.delete({ where: { id: provisioned } });
    }
  });

  it('an impersonating session is refused on both routes and writes nothing', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    const tok = token(merchant, 'store_admin', operator);
    const g = await withToken('/api/v1/me/legal-notices', 'get', tok);
    expect(g.status).toBe(403);
    expect(g.body.error.code).toBe('IMPERSONATION_FORBIDDEN');
    const p = await withToken('/api/v1/me/legal-notices/ack', 'post', tok);
    expect(p.status).toBe(403);
    expect(p.body.error.code).toBe('IMPERSONATION_FORBIDDEN');
    expect(
      await owner.legalAcceptance.count({
        where: { userId: merchant, docKey: 'terms', version: V },
      })
    ).toBe(0);
  });

  it('I3: a version that WAS sent but is not material is still refused (422) and writes nothing', async () => {
    // Guards the `material` half of the eligibility rule on its own: privacy@1.0 is current and
    // has a send row, so only "not material" can refuse it.
    await owner.legalNoticeSend.create({
      data: { docKey: 'privacy', version: '1.0', sentBy: operator },
    });
    const res = await ack(merchant, [{ docKey: 'privacy', version: '1.0' }]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_PENDING');
    expect(
      await owner.legalAcceptance.count({ where: { userId: merchant, source: 'notice_ack' } })
    ).toBe(0);
    // ...and it never shows as a banner either (the same shared rule).
    expect((await get(merchant)).body.data.notices).toEqual([]);
  });

  it('M14: empty strings and 6+ items are 400; a duplicated item is acknowledged once; staff gets 403', async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    expect((await ack(merchant, [{ docKey: '', version: V }])).status).toBe(400);
    expect((await ack(merchant, [{ docKey: 'terms', version: '' }])).status).toBe(400);
    expect(
      (
        await ack(
          merchant,
          Array.from({ length: 6 }, () => ({ docKey: 'terms', version: V }))
        )
      ).status
    ).toBe(400);
    const dup = await ack(merchant, [
      { docKey: 'terms', version: V },
      { docKey: 'terms', version: V },
    ]);
    expect(dup.status).toBe(200);
    expect(dup.body.data).toEqual({ acknowledged: 1 });
    const staff = await mkUser('st', 'staff');
    try {
      const r = await ack(staff, [{ docKey: 'terms', version: V }], 'staff');
      expect(r.status).toBe(403);
      expect(await owner.legalAcceptance.count({ where: { userId: staff } })).toBe(0);
    } finally {
      await owner.user.delete({ where: { id: staff } });
    }
  });

  it("I6: GET /me/legal-acceptances lists only the caller's own records, newest first, never cached", async () => {
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: operator } });
    expect((await ack(signedUp, [{ docKey: 'terms', version: V }])).status).toBe(200);
    const res = await asApp(async () =>
      request(app)
        .get('/api/v1/me/legal-acceptances')
        .set('Authorization', `Bearer ${token(signedUp, 'store_admin')}`)
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = res.body.data.acceptances as Array<{
      docKey: string;
      version: string;
      source: string;
    }>;
    expect(list).toHaveLength(6);
    expect(list[0]).toMatchObject({ docKey: 'terms', version: V, source: 'notice_ack' });
    expect(list.filter(a => a.source === 'signup')).toHaveLength(5);
    expect(JSON.stringify(res.body)).not.toMatch(/"ip"|userAgent|userId/);
    const other = await asApp(async () =>
      request(app)
        .get('/api/v1/me/legal-acceptances')
        .set('Authorization', `Bearer ${token(merchant, 'store_admin')}`)
    );
    expect(other.body.data.acceptances).toEqual([]);
  });
});
