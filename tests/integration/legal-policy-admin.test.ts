/**
 * Super-admin "Send notice" (Ruling LEGAL-4) over HTTP on the strict-RLS `ebda_app` login.
 * Review Focus 6: a second send is 409 with no second event; an enqueue failure leaves no row.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  createPrismaClient,
  asPlatformOperator,
  prisma,
  runWithRequestDb,
  withUser,
  type AppPrismaClient,
} from '@ebda/database';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';
import { config } from '@api/config';
import { inngest } from '@api/lib/inngest/client';
import { adminLegalPolicyRoutes } from '@api/routes/legal-policy.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { withdrawLegalNoticeSend } from '@api/lib/definer';
import {
  __setLegalPoliciesForTests,
  materializeDeliveries,
} from '@api/services/legal-notice.service';

// The admin routes require MFA enrolment; the gate itself is covered elsewhere.
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: unknown, _s: unknown, next: () => void) => next(),
}));

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const V = '99.0';
const DAY = 86_400_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
/** terms@99.0: a fee change published today, effective in 40 days (Send allowed). */
const fixture = (effectiveInDays = 40, feeChange = true): LegalPolicies => ({
  ...LEGAL_POLICIES,
  terms: {
    history: [
      ...LEGAL_POLICIES.terms.history,
      {
        version: V,
        publishedAt: isoDay(0),
        effectiveAt: isoDay(effectiveInDays),
        material: true,
        feeChange,
        summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
      },
    ],
  },
});
const FIXTURE = fixture();
/** A document whose CURRENT version is not material (the registry moves: 'privacy' became material at 1.1), so the NOT_MATERIAL and canSend=false paths keep a real subject. */
const NON_MATERIAL_DOC = (Object.keys(FIXTURE) as Array<keyof LegalPolicies>).find(k => {
  const h = FIXTURE[k].history;
  return !h[h.length - 1].material;
})!;
const nonMaterialCurrent = () => {
  const h = FIXTURE[NON_MATERIAL_DOC].history;
  return h[h.length - 1].version;
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
const token = (userId: string, role: 'store_admin' | 'super_admin') =>
  jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '30m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

describe.skipIf(!hasDb)('super-admin policy updates', () => {
  let owner: AppPrismaClient;
  let app: Express;
  let op = '';
  let merchant = '';
  let op2 = '';
  let send = vi.spyOn(inngest, 'send');

  const mkUser = async (tag: string, role: 'store_admin' | 'super_admin') =>
    (
      await owner.user.create({
        data: {
          email: `lpa-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`,
          passwordHash: 'x',
          firstName: 'Lpa',
          lastName: tag,
          role,
          emailVerified: true,
        },
      })
    ).id;
  const call = (
    method: 'get' | 'post',
    userId: string,
    role: 'store_admin' | 'super_admin',
    url: string
  ) =>
    asApp(async () => {
      const r = request(app)
        [method](url)
        .set('Authorization', `Bearer ${token(userId, role)}`);
      return method === 'get' ? r : r.send({});
    });
  const sendUrl = (docKey: string, version: string) =>
    `/api/v1/admin/legal-policies/${docKey}/${version}/send-notice`;
  const wipe = () => owner.legalNoticeSend.deleteMany({ where: { docKey: 'terms', version: V } });

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    __setLegalPoliciesForTests(FIXTURE);
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/admin', adminLegalPolicyRoutes);
    app.use(errorHandler);
    op = await mkUser('op', 'super_admin');
    merchant = await mkUser('m', 'store_admin');
    op2 = await mkUser('op2', 'super_admin');
  });
  beforeEach(async () => {
    await wipe();
    send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: ['evt'] } as never);
  });
  afterAll(async () => {
    await wipe();
    __setLegalPoliciesForTests(null);
    await owner.user.deleteMany({ where: { id: { in: [op, op2, merchant] } } });
    await owner.$disconnect();
  });

  it('lists every document with its current version; only a super admin may read it', async () => {
    const res = await call('get', op, 'super_admin', '/api/v1/admin/legal-policies');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const rows = res.body.data.policies as Array<{
      docKey: string;
      current: { version: string };
      canSend: boolean;
      send: unknown;
    }>;
    expect(rows.map(r => r.docKey)).toEqual([
      'legal',
      'privacy',
      'terms',
      'acceptableUse',
      'merchant',
    ]);
    const terms = rows.find(r => r.docKey === 'terms')!;
    expect(terms).toMatchObject({ current: { version: V }, canSend: true, send: null });
    expect(rows.find(r => r.docKey === NON_MATERIAL_DOC)!.canSend).toBe(false);
    expect(
      (await call('get', merchant, 'store_admin', '/api/v1/admin/legal-policies')).status
    ).toBe(403);
  });

  it('refuses a non-material, a non-current and an unknown document', async () => {
    expect(NON_MATERIAL_DOC).toBeTruthy();
    expect(
      (await call('post', op, 'super_admin', sendUrl(NON_MATERIAL_DOC, nonMaterialCurrent()))).body
        .error.code
    ).toBe('NOT_MATERIAL');
    expect((await call('post', op, 'super_admin', sendUrl('terms', '1.0'))).body.error.code).toBe(
      'NOT_CURRENT'
    );
    expect((await call('post', op, 'super_admin', sendUrl('cookies', '1.0'))).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends once; a second click is 409 with no second event', async () => {
    const first = await call('post', op, 'super_admin', sendUrl('terms', V));
    expect(first.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    const row = await owner.legalNoticeSend.findFirstOrThrow({
      where: { docKey: 'terms', version: V, sentBy: op },
    });
    // M1: the event is pinned to THIS send row.
    expect(send).toHaveBeenCalledWith({
      name: 'legal/notice.send-requested',
      data: { sendId: row.id, docKey: 'terms', version: V, sentBy: op },
    });
    const second = await call('post', op, 'super_admin', sendUrl('terms', V));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_SENT');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an enqueue failure answers 502 and leaves no send row (nothing half-announced)', async () => {
    send.mockRejectedValueOnce(new Error('inngest down'));
    const res = await call('post', op, 'super_admin', sendUrl('terms', V));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ENQUEUE_FAILED');
    expect(await owner.legalNoticeSend.count({ where: { docKey: 'terms', version: V } })).toBe(0);
  });

  it('a store_admin cannot send', async () => {
    expect((await call('post', merchant, 'store_admin', sendUrl('terms', V))).status).toBe(403);
  });

  it('lists failed deliveries with a masked address and counts a stuck sending row', async () => {
    expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
    const failedUser = await mkUser('f', 'store_admin');
    const stuckUser = await mkUser('s', 'store_admin');
    try {
      await owner.legalNoticeDelivery.createMany({
        data: [
          {
            userId: failedUser,
            docKey: 'terms',
            version: V,
            status: 'failed',
            error: 'SEND_WINDOW_EXHAUSTED',
          },
          { userId: stuckUser, docKey: 'terms', version: V, status: 'sending' },
        ],
      });
      const res = await call('get', op, 'super_admin', '/api/v1/admin/legal-policies');
      const terms = res.body.data.policies.find((r: { docKey: string }) => r.docKey === 'terms');
      expect(terms.deliveries).toMatchObject({ failed: 1, sending: 1 });
      expect(terms.failedDeliveries).toHaveLength(1);
      expect(terms.failedDeliveries[0]).toMatchObject({ error: 'SEND_WINDOW_EXHAUSTED' });
      expect(terms.failedDeliveries[0].maskedEmail).toMatch(/^l\*\*\*@test\.local$/);
      expect(JSON.stringify(res.body)).not.toContain(`-${run}-`);
    } finally {
      await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
      await owner.user.deleteMany({ where: { id: { in: [failedUser, stuckUser] } } });
    }
  });

  describe('ebda_withdraw_legal_notice_send (enqueue compensation)', () => {
    const mkSend = async (sentBy: string) =>
      (await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy } })).id;
    const withdraw = (actor: string, id: string) =>
      asApp(() => asPlatformOperator(actor, () => withdrawLegalNoticeSend(id)));
    const left = () => owner.legalNoticeSend.count({ where: { docKey: 'terms', version: V } });

    it("deletes the caller's own fresh, untouched row and returns 1", async () => {
      const id = await mkSend(op);
      expect(await withdraw(op, id)).toBe(1);
      expect(await left()).toBe(0);
    });

    it('refuses a non-super-admin and a contextless call', async () => {
      const id = await mkSend(op);
      await expect(
        asApp(() => withUser(merchant, () => withdrawLegalNoticeSend(id)))
      ).rejects.toThrow(/super_admin required/);
      await expect(asApp(() => withdrawLegalNoticeSend(id))).rejects.toThrow(
        /super_admin required/
      );
      expect(await left()).toBe(1);
    });

    it('never withdraws a send that has deliveries', async () => {
      const id = await mkSend(op);
      await owner.legalNoticeDelivery.create({
        data: { userId: merchant, docKey: 'terms', version: V },
      });
      try {
        expect(await withdraw(op, id)).toBe(0);
        expect(await left()).toBe(1);
      } finally {
        await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
      }
    });

    it('never withdraws a send that has materialised recipients', async () => {
      const id = await mkSend(op);
      await owner.legalNoticeSend.update({ where: { id }, data: { recipientCount: 3 } });
      expect(await withdraw(op, id)).toBe(0);
      expect(await left()).toBe(1);
    });

    it('another super admin cannot withdraw it', async () => {
      const id = await mkSend(op);
      expect(await withdraw(op2, id)).toBe(0);
      expect(await left()).toBe(1);
    });

    it('M7: a fresh row is withdrawable on a session far east of UTC (sent_at is naive UTC)', async () => {
      const id = await mkSend(op);
      const [r] = await owner.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${op}, true)`;
        return tx.$queryRaw<
          Array<{ n: number }>
        >`SELECT public.ebda_withdraw_legal_notice_send(${id}) AS n`;
      });
      expect(Number(r.n)).toBe(1);
      expect(await left()).toBe(0);
    });

    it('an old row cannot be withdrawn', async () => {
      const id = await mkSend(op);
      await owner.$executeRaw`UPDATE legal_notice_sends SET sent_at = (now() AT TIME ZONE 'UTC') - interval '11 minutes' WHERE id = ${id}`;
      expect(await withdraw(op, id)).toBe(0);
      expect(await left()).toBe(1);
    });
  });

  it('when the compensation is refused the answer is 502 WITHDRAW_FAILED and the row stays', async () => {
    send.mockImplementationOnce((async () => {
      // the fan-out had already started when the enqueue "failed"
      await owner.legalNoticeDelivery.create({
        data: { userId: merchant, docKey: 'terms', version: V },
      });
      throw new Error('timeout after accept');
    }) as never);
    try {
      const res = await call('post', op, 'super_admin', sendUrl('terms', V));
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('WITHDRAW_FAILED');
      expect(await owner.legalNoticeSend.count({ where: { docKey: 'terms', version: V } })).toBe(1);
    } finally {
      await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
    }
  });

  it('materializeDeliveries aborts cleanly when the send row was withdrawn while it waited', async () => {
    const id = (
      await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: op } })
    ).id;
    let release: () => void = () => undefined;
    const held = new Promise<void>(r => (release = r));
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>(r => (locked = r));
    const holder = owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM legal_notice_sends WHERE id = ${id} FOR UPDATE`;
      locked();
      await held;
      await tx.$executeRaw`DELETE FROM legal_notice_sends WHERE id = ${id}`;
    });
    await lockTaken;
    const mat = asApp(() => materializeDeliveries(op, 'terms', V));
    await new Promise(r => setTimeout(r, 400));
    release();
    await holder;
    expect(await mat).toEqual({ ok: false, reason: 'SEND_ROW_MISSING' });
    expect(await owner.legalNoticeDelivery.count({ where: { docKey: 'terms', version: V } })).toBe(
      0
    );
  });

  it('the failed-deliveries list scrubs email addresses out of the provider text', async () => {
    expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
    await owner.legalNoticeDelivery.create({
      data: {
        userId: merchant,
        docKey: 'terms',
        version: V,
        status: 'failed',
        error: 'Resend: mailbox full for jane.doe@gmail.com (550)',
      },
    });
    try {
      const res = await call('get', op, 'super_admin', '/api/v1/admin/legal-policies');
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('jane.doe');
      expect(body).toContain('j***@gmail.com');
    } finally {
      await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
    }
  });

  describe('I1: a fee change needs 30 days between the SEND and its effective date', () => {
    afterAll(() => __setLegalPoliciesForTests(FIXTURE));

    it('refuses a late fee-change Send with 422 NOTICE_TOO_LATE, no row, no event; the page row says so', async () => {
      __setLegalPoliciesForTests(fixture(29));
      const res = await call('post', op, 'super_admin', sendUrl('terms', V));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('NOTICE_TOO_LATE');
      expect(send).not.toHaveBeenCalled();
      expect(await owner.legalNoticeSend.count({ where: { docKey: 'terms', version: V } })).toBe(0);
      const list = await call('get', op, 'super_admin', '/api/v1/admin/legal-policies');
      const terms = list.body.data.policies.find((r: { docKey: string }) => r.docKey === 'terms');
      expect(terms).toMatchObject({ canSend: false, sendBlocked: 'NOTICE_TOO_LATE' });
    });

    it('allows a fee change exactly 31 days out', async () => {
      __setLegalPoliciesForTests(fixture(31));
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
    });

    it('a NON-fee material change has no minimum: effective today is fine', async () => {
      __setLegalPoliciesForTests(fixture(0, false));
      const list = await call('get', op, 'super_admin', '/api/v1/admin/legal-policies');
      const terms = list.body.data.policies.find((r: { docKey: string }) => r.docKey === 'terms');
      expect(terms).toMatchObject({ canSend: true, sendBlocked: null });
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
    });
  });

  describe('I4: only aged rows read as stuck / no run', () => {
    const terms = async () =>
      (
        await call('get', op, 'super_admin', '/api/v1/admin/legal-policies')
      ).body.data.policies.find((r: { docKey: string }) => r.docKey === 'terms');

    it('a fresh send with no recipients yet is neither noRun nor stalled; after 11 minutes it is both', async () => {
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
      expect(await terms()).toMatchObject({ noRun: false, stalled: false, stuckSending: 0 });
      await owner.$executeRaw`UPDATE legal_notice_sends SET sent_at = sent_at - interval '11 minutes' WHERE doc_key = 'terms' AND version = ${V}`;
      expect(await terms()).toMatchObject({ noRun: true, stalled: true });
    });

    it('a sending row is stuck only after 15 minutes untouched; queued rows with no activity stall', async () => {
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
      await owner.legalNoticeSend.update({
        where: { docKey_version: { docKey: 'terms', version: V } },
        data: { recipientCount: 2 },
      });
      const other = await mkUser('q', 'store_admin');
      try {
        await owner.legalNoticeDelivery.createMany({
          data: [
            { userId: merchant, docKey: 'terms', version: V, status: 'sending' },
            { userId: other, docKey: 'terms', version: V, status: 'queued' },
          ],
        });
        expect(await terms()).toMatchObject({
          deliveries: { sending: 1, queued: 1 },
          stuckSending: 0,
          noRun: false,
          stalled: false,
        });
        await owner.$executeRaw`UPDATE legal_notice_deliveries SET updated_at = updated_at - interval '16 minutes' WHERE doc_key = 'terms' AND version = ${V}`;
        await owner.$executeRaw`UPDATE legal_notice_sends SET sent_at = sent_at - interval '16 minutes' WHERE doc_key = 'terms' AND version = ${V}`;
        expect(await terms()).toMatchObject({ stuckSending: 1, stalled: true });
      } finally {
        await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
        await owner.user.delete({ where: { id: other } });
      }
    });
  });

  describe('I5: Resume and Retry failed', () => {
    const url = (path: 'resume' | 'retry-failed') =>
      `/api/v1/admin/legal-policies/terms/${V}/${path}`;

    it('404 NOT_SENT before any send; a store_admin gets 403', async () => {
      const r = await call('post', op, 'super_admin', url('resume'));
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('NOT_SENT');
      expect((await call('post', merchant, 'store_admin', url('retry-failed'))).status).toBe(403);
      expect(send).not.toHaveBeenCalled();
    });

    it('Resume re-emits the event for the same send row as the acting operator, and is audited', async () => {
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
      const row = await owner.legalNoticeSend.findFirstOrThrow({
        where: { docKey: 'terms', version: V },
      });
      send.mockClear();
      const r = await call('post', op2, 'super_admin', url('resume'));
      expect(r.status).toBe(202);
      expect(send).toHaveBeenCalledWith({
        name: 'legal/notice.send-requested',
        data: { sendId: row.id, docKey: 'terms', version: V, sentBy: op2 },
      });
      expect(
        await owner.auditLog.count({
          where: { userId: op2, action: 'legal.notice_resumed', resourceId: `terms@${V}` },
        })
      ).toBe(1);
    });

    it('Retry failed moves ONLY failed rows to queued (never sending/sent), then emits once', async () => {
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
      const a = await mkUser('ra', 'store_admin');
      const b = await mkUser('rb', 'store_admin');
      try {
        await owner.legalNoticeDelivery.createMany({
          data: [
            { userId: merchant, docKey: 'terms', version: V, status: 'failed', error: 'boom' },
            { userId: a, docKey: 'terms', version: V, status: 'sent' },
            { userId: b, docKey: 'terms', version: V, status: 'sending' },
          ],
        });
        send.mockClear();
        const r = await call('post', op, 'super_admin', url('retry-failed'));
        expect(r.status).toBe(202);
        expect(r.body.data.requeued).toBe(1);
        expect(send).toHaveBeenCalledTimes(1);
        const rows = await owner.legalNoticeDelivery.findMany({
          where: { docKey: 'terms', version: V },
          select: { userId: true, status: true, error: true },
        });
        const by = Object.fromEntries(rows.map(x => [x.userId, x]));
        expect(by[merchant]).toMatchObject({ status: 'queued', error: null });
        expect(by[a].status).toBe('sent');
        expect(by[b].status).toBe('sending');
        expect(
          await owner.auditLog.count({
            where: { userId: op, action: 'legal.notice_retry_failed', resourceId: `terms@${V}` },
          })
        ).toBe(1);
        // Nothing failed any more: a second press requeues nothing and emits nothing.
        send.mockClear();
        const again = await call('post', op, 'super_admin', url('retry-failed'));
        expect(again.body.data.requeued).toBe(0);
        expect(send).not.toHaveBeenCalled();
      } finally {
        await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
        await owner.user.deleteMany({ where: { id: { in: [a, b] } } });
      }
    });

    it('Retry failed EXCLUDES TIMEOUT_UNKNOWN rows (may have been delivered); the overview lists them separately', async () => {
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
      const a = await mkUser('ta', 'store_admin');
      try {
        await owner.legalNoticeDelivery.createMany({
          data: [
            { userId: merchant, docKey: 'terms', version: V, status: 'failed', error: 'boom' },
            { userId: a, docKey: 'terms', version: V, status: 'failed', error: 'TIMEOUT_UNKNOWN' },
          ],
        });
        const before = (
          await call('get', op, 'super_admin', '/api/v1/admin/legal-policies')
        ).body.data.policies.find((r: { docKey: string }) => r.docKey === 'terms');
        expect(before.deliveries.failed).toBe(1);
        expect(before.unknownOutcome).toBe(1);
        expect(before.failedDeliveries).toHaveLength(1);
        expect(before.unknownDeliveries).toHaveLength(1);
        expect(before.unknownDeliveries[0]).toMatchObject({ error: 'TIMEOUT_UNKNOWN' });

        send.mockClear();
        const r = await call('post', op, 'super_admin', url('retry-failed'));
        expect(r.status).toBe(202);
        expect(r.body.data.requeued).toBe(1);
        const rows = await owner.legalNoticeDelivery.findMany({
          where: { docKey: 'terms', version: V },
          select: { userId: true, status: true, error: true },
        });
        const by = Object.fromEntries(rows.map(x => [x.userId, x]));
        expect(by[merchant]).toMatchObject({ status: 'queued', error: null });
        expect(by[a]).toMatchObject({ status: 'failed', error: 'TIMEOUT_UNKNOWN' });
        // Only unknown-outcome rows left: a second press requeues nothing and emits nothing.
        await owner.legalNoticeDelivery.deleteMany({
          where: { userId: merchant, docKey: 'terms', version: V },
        });
        send.mockClear();
        const again = await call('post', op, 'super_admin', url('retry-failed'));
        expect(again.body.data.requeued).toBe(0);
        expect(send).not.toHaveBeenCalled();
      } finally {
        await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
        await owner.user.delete({ where: { id: a } });
      }
    });

    it('Resume and Retry failed refuse a superseded version with 409 NOT_CURRENT (no event, no row change)', async () => {
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
      await owner.legalNoticeDelivery.create({
        data: { userId: merchant, docKey: 'terms', version: V, status: 'failed', error: 'boom' },
      });
      try {
        // A newer terms version makes V superseded.
        const NEWER = '99.1';
        __setLegalPoliciesForTests({
          ...FIXTURE,
          terms: {
            history: [
              ...FIXTURE.terms.history,
              { ...FIXTURE.terms.history[FIXTURE.terms.history.length - 1], version: NEWER },
            ],
          },
        });
        send.mockClear();
        for (const path of ['resume', 'retry-failed'] as const) {
          const r = await call('post', op, 'super_admin', url(path));
          expect(r.status).toBe(409);
          expect(r.body.error.code).toBe('NOT_CURRENT');
        }
        expect(send).not.toHaveBeenCalled();
        const row = await owner.legalNoticeDelivery.findFirstOrThrow({
          where: { docKey: 'terms', version: V, userId: merchant },
        });
        expect(row).toMatchObject({ status: 'failed', error: 'boom' });
      } finally {
        __setLegalPoliciesForTests(FIXTURE);
        await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
      }
    });

    it('a Retry whose enqueue fails puts the rows back to failed: no orphan queued rows', async () => {
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
      await owner.legalNoticeDelivery.create({
        data: { userId: merchant, docKey: 'terms', version: V, status: 'failed', error: 'boom' },
      });
      try {
        send.mockRejectedValueOnce(new Error('inngest down'));
        const r = await call('post', op, 'super_admin', url('retry-failed'));
        expect(r.status).toBe(502);
        expect(r.body.error.code).toBe('ENQUEUE_FAILED');
        const row = await owner.legalNoticeDelivery.findFirstOrThrow({
          where: { docKey: 'terms', version: V, userId: merchant },
        });
        expect(row).toMatchObject({ status: 'failed', error: 'RETRY_ENQUEUE_FAILED' });
      } finally {
        await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
      }
    });
  });

  describe("I6: one account's acceptance record (super admin)", () => {
    it('lists acceptances with a masked IP and the delivery status; only a super admin may read it', async () => {
      await owner.legalAcceptance.create({
        data: {
          userId: merchant,
          docKey: 'privacy',
          version: '1.0',
          source: 'signup',
          ip: '203.0.113.45',
          userAgent: 'UA',
        },
      });
      expect((await call('post', op, 'super_admin', sendUrl('terms', V))).status).toBe(202);
      await owner.legalNoticeDelivery.create({
        data: { userId: merchant, docKey: 'terms', version: V, status: 'sent' },
      });
      try {
        const res = await call(
          'get',
          op,
          'super_admin',
          `/api/v1/admin/users/${merchant}/legal-acceptances`
        );
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.data.acceptances).toEqual([
          expect.objectContaining({
            docKey: 'privacy',
            version: '1.0',
            source: 'signup',
            maskedIp: '203.0.113.*',
          }),
        ]);
        expect(JSON.stringify(res.body)).not.toContain('203.0.113.45');
        expect(res.body.data.deliveries).toEqual([
          expect.objectContaining({ docKey: 'terms', version: V, status: 'sent' }),
        ]);
        expect(
          (
            await call(
              'get',
              merchant,
              'store_admin',
              `/api/v1/admin/users/${merchant}/legal-acceptances`
            )
          ).status
        ).toBe(403);
      } finally {
        await owner.legalAcceptance.deleteMany({ where: { userId: merchant } });
        await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
      }
    });
  });
});
