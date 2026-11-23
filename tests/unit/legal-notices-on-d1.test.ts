/**
 * Pending policy notices over HTTP (Ruling LEGAL-4) on the platform D1 (ported from tests/integration/legal-notices.test.ts, which ran
 * on a live relational database with the strict-RLS `ebda_app` login). The real router, service and platform router; the accounts are
 * the identity service's (a Map), the policy registry is the fixture the built Worker cannot take (`__setLegalPoliciesForTests`),
 * the user-keyed legal rows are the platform D1's. Review Focus 1 (one ack clears every store) and 4 (forged / non-pending ack refused).
 *
 * Mutation proofs: drop `noticeableVersions` from ackNotices -> "refuses an ack for a non-pending or forged version" and "I3";
 * drop `rejectImpersonated` from the ack route -> "an impersonating session".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import type { DatabaseSync } from 'node:sqlite';

const h = vi.hoisted(() => ({ audit: [] as Array<Record<string, unknown>> }));

vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // No Postgres transaction: an operator / user scope is the lazy per-query scope, and the platform D1 answers every query.
  return {
    ...real,
    withUser: (_u: string, fn: (tx: unknown) => unknown) => fn(real.prisma),
    runInUserScope: (_u: string, fn: () => unknown) => fn(),
  };
});
vi.mock('@api/lib/identity-client', async importOriginal => {
  const { accounts } = await import('../helpers/legal-d1');
  return {
    ...(await importOriginal<object>()),
    getAccountState: async (id: string) => {
      const a = accounts.get(id);
      return a ? { id, role: a.role, status: 'active', email: a.email } : null;
    },
    getAccountsBrief: async (ids: string[]) =>
      ids.flatMap(id => {
        const a = accounts.get(id);
        return a
          ? [
              {
                id,
                email: a.email,
                firstName: a.firstName,
                lastName: 'U',
                role: a.role,
                status: 'active',
              },
            ]
          : [];
      }),
  };
});
vi.mock('@api/middleware/auth', async importOriginal => {
  const { accounts } = await import('../helpers/legal-d1');
  return {
    ...(await importOriginal<object>()),
    // identity comes from a header (and an optional impersonator); authorize / rejectImpersonated stay real
    authenticate: (req: any, res: any, n: () => void) => {
      const id = String(req.headers['x-test-user']);
      const a = accounts.get(id);
      if (!a) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      const imp = req.headers['x-test-impersonated-by'];
      req.user = {
        userId: id,
        email: a.email,
        role: a.role,
        ...(imp ? { impersonatedBy: String(imp) } : {}),
      };
      n();
    },
  };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('@api/middleware/security', async importOriginal => ({
  ...(await importOriginal<object>()),
  auditLog: async (e: Record<string, unknown>) => void h.audit.push(e),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { meLegalAcceptanceRoutes, meLegalNoticeRoutes } from '@api/routes/legal-policy.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { __setLegalPoliciesForTests } from '@api/services/legal-notice.service';
import { installPlatformD1, uninstallPlatformD1 } from '../helpers/platform-d1-rig';
import {
  V,
  count,
  fixture,
  insAcceptance,
  insSend,
  insStore,
  mkUser,
  rows,
  type Role,
} from '../helpers/legal-d1';

let d1: DatabaseSync;
let app: Express;
let merchant = '';
let operator = '';
let signedUp = '';

const as = (userId: string, impersonatedBy?: string) => ({
  'x-test-user': userId,
  ...(impersonatedBy ? { 'x-test-impersonated-by': impersonatedBy } : {}),
});
const get = (userId: string) => request(app).get('/api/v1/me/legal-notices').set(as(userId));
const ack = (userId: string, items: unknown) =>
  request(app).post('/api/v1/me/legal-notices/ack').set(as(userId)).send({ items });
const acceptances = (userId: string, where = '') =>
  count(d1, `SELECT COUNT(*) n FROM legal_acceptances WHERE user_id = ? ${where}`, userId);
const sendTerms = () => insSend(d1, 'terms', V, operator);

beforeAll(() => {
  d1 = installPlatformD1();
  __setLegalPoliciesForTests(fixture());
  app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/me/legal-notices', meLegalNoticeRoutes);
  app.use('/api/v1/me/legal-acceptances', meLegalAcceptanceRoutes);
  app.use(errorHandler);
  merchant = mkUser('m', 'store_admin');
  operator = mkUser('op', 'super_admin');
  // A merchant who signed up through the click-wrap: has a row per document at 1.0.
  signedUp = mkUser('su', 'store_admin');
  for (const docKey of ['legal', 'privacy', 'terms', 'acceptableUse', 'merchant'])
    insAcceptance(d1, signedUp, docKey, '1.0', 'signup');
  insStore(d1, merchant, 1);
  insStore(d1, merchant, 2);
});
beforeEach(() => {
  d1.exec(
    `DELETE FROM legal_notice_sends; DELETE FROM legal_acceptances WHERE source = 'notice_ack'`
  );
});
afterAll(() => {
  __setLegalPoliciesForTests(null);
  uninstallPlatformD1();
});

describe('pending legal notices on the platform D1', () => {
  it('nothing is pending before the version is sent; the read is never cached', async () => {
    const res = await get(merchant);
    expect(res.status).toBe(200);
    expect(res.body.data.notices).toEqual([]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('after a send the merchant has one pending notice with summary, date and links', async () => {
    sendTerms();
    const res = await get(merchant);
    expect(res.body.data.notices).toEqual([
      {
        docKey: 'terms',
        version: V,
        effectiveAt: fixture().terms.history.at(-1)!.effectiveAt,
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
        title: { ar: 'شروط الخدمة', en: 'Terms of service' },
        url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
      },
    ]);
    // A super_admin is not a party to the merchant agreement: nothing pending, no 403.
    expect((await get(operator)).body.data.notices).toEqual([]);
  });

  it('refuses an ack for a non-pending or forged version and writes nothing', async () => {
    sendTerms();
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
    expect(acceptances(merchant)).toBe(0);
    expect((await ack(merchant, [])).status).toBe(400);
    expect((await ack(operator, [{ docKey: 'terms', version: V }])).status).toBe(403);
  });

  it('one ack clears the notice for every store the merchant owns; a repeat ack is a no-op', async () => {
    sendTerms();
    const res = await ack(merchant, [{ docKey: 'terms', version: V }]);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ acknowledged: 1 });
    expect(
      rows(
        d1,
        `SELECT source FROM legal_acceptances WHERE user_id = ? AND doc_key = 'terms' AND version = ?`,
        merchant,
        V
      )
    ).toEqual([{ source: 'notice_ack' }]);
    // The notice is per user, not per store: no store of theirs shows it any more.
    expect((await get(merchant)).body.data.notices).toEqual([]);
    const again = await ack(merchant, [{ docKey: 'terms', version: V }]);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ acknowledged: 0 });
  });

  it('a user who accepted everything at signup: sees the sent notice, acks it, and cannot ack a signup version', async () => {
    sendTerms();
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
    expect(acceptances(signedUp, `AND source = 'notice_ack'`)).toBe(1);
    expect((await get(signedUp)).body.data.notices).toEqual([]);
  });

  it('a staff-provisioned owner with ZERO acceptance rows gets the pending list and can ack', async () => {
    const provisioned = mkUser('pv', 'store_admin');
    expect(acceptances(provisioned)).toBe(0);
    sendTerms();
    const res = await get(provisioned);
    expect(res.status).toBe(200);
    expect(res.body.data.notices).toHaveLength(1);
    expect((await ack(provisioned, [{ docKey: 'terms', version: V }])).body.data).toEqual({
      acknowledged: 1,
    });
    expect((await get(provisioned)).body.data.notices).toEqual([]);
  });

  it('an impersonating session is refused on both routes and writes nothing', async () => {
    sendTerms();
    const items = [{ docKey: 'terms', version: V }];
    const g = await request(app)
      .get('/api/v1/me/legal-notices')
      .set(as(merchant, operator))
      .send({ items });
    expect(g.status).toBe(403);
    expect(g.body.error.code).toBe('IMPERSONATION_FORBIDDEN');
    const p = await request(app)
      .post('/api/v1/me/legal-notices/ack')
      .set(as(merchant, operator))
      .send({ items });
    expect(p.status).toBe(403);
    expect(p.body.error.code).toBe('IMPERSONATION_FORBIDDEN');
    expect(acceptances(merchant)).toBe(0);
  });

  it('I3: a version that WAS sent but is not material is still refused (422) and writes nothing', async () => {
    // Guards the `material` half of the eligibility rule on its own: privacy@1.0 is current and
    // has a send row, so only "not material" can refuse it.
    insSend(d1, 'privacy', '1.0', operator);
    const res = await ack(merchant, [{ docKey: 'privacy', version: '1.0' }]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_PENDING');
    expect(acceptances(merchant)).toBe(0);
    // ...and it never shows as a banner either (the same shared rule).
    expect((await get(merchant)).body.data.notices).toEqual([]);
  });

  it('M14: empty strings and 6+ items are 400; a duplicated item is acknowledged once; staff gets 403', async () => {
    sendTerms();
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
    const staff = mkUser('st', 'staff' as Role);
    const r = await ack(staff, [{ docKey: 'terms', version: V }]);
    expect(r.status).toBe(403);
    expect(acceptances(staff)).toBe(0);
  });

  it("I6: GET /me/legal-acceptances lists only the caller's own records, newest first, never cached", async () => {
    sendTerms();
    expect((await ack(signedUp, [{ docKey: 'terms', version: V }])).status).toBe(200);
    const res = await request(app).get('/api/v1/me/legal-acceptances').set(as(signedUp));
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
    const other = await request(app).get('/api/v1/me/legal-acceptances').set(as(merchant));
    expect(other.body.data.acceptances).toEqual([]);
  });
});
