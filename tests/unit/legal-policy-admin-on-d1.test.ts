/**
 * Super-admin "Send notice" (Ruling LEGAL-4) over HTTP on the platform D1 (ported from tests/integration/legal-policy-admin.test.ts, which
 * ran on a live relational database under the strict-RLS `ebda_app` login). The real admin router and service, the policy fixture
 * the built Worker cannot take, accounts from the identity service (a Map), the send / delivery / acceptance rows on the platform D1.
 * Review Focus 6: a second send is 409 with no second event; an enqueue failure leaves no row.
 *
 * Postgres-only mechanisms of the original, and where their intent lives now:
 *   - `ebda_withdraw_legal_notice_send` (SECURITY DEFINER, `super_admin required`, `FOR UPDATE`, naive-UTC `sent_at` M7): on D1 the
 *     withdrawal is ONE statement, `withdrawLegalSendD1`, with the operator id a required argument. The five refusal cases (deliveries,
 *     materialised recipients, another operator, an old row, the happy path) are re-run below through the real `withdrawLegalNoticeSend`;
 *     the statement itself is also covered by tests/unit/platform-n10b-d1.test.ts ("legal notice withdraw"). DELETED with reason:
 *     "refuses a non-super-admin and a contextless call" (no definer: the route's `authorize('super_admin')` is the gate, covered by
 *     "a store_admin cannot send") and M7 (no session time zone on D1, timestamps are integer epoch ms).
 *   - the `FOR UPDATE` race in materializeDeliveries: D1 has no row lock; the service re-checks the row after the fan-out and takes its
 *     deliveries back. The test below withdraws the row inside that window.
 *
 * Mutation proofs (each turns the named test red): `if (feeNoticeTooLate(...))` -> `if (false)` in requestNoticeSend -> "I1 ... NOTICE_TOO_LATE";
 * remove the `legalNoticeDelivery.deleteMany` take-back in materializeDeliveries -> "materializeDeliveries aborts cleanly".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import type { DatabaseSync } from 'node:sqlite';

const h = vi.hoisted(() => ({
  audit: [] as Array<Record<string, unknown>>,
  dropSendRowBeforeRecheck: null as null | (() => void),
}));

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
vi.mock('@api/services/platform/platform-d1', async importOriginal => {
  const real = await importOriginal<typeof import('@api/services/platform/platform-d1')>();
  return {
    ...real,
    // the window between materializeDeliveries' fan-out and its re-check: a withdrawal lands here
    sendRowStillExistsD1: async (id: string) => {
      h.dropSendRowBeforeRecheck?.();
      return real.sendRowStillExistsD1(id);
    },
  };
});

import { adminLegalPolicyRoutes } from '@api/routes/legal-policy.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { inngest } from '@api/lib/inngest/client';
import { withdrawLegalNoticeSend } from '@api/lib/definer';
import {
  __setLegalPoliciesForTests,
  materializeDeliveries,
} from '@api/services/legal-notice.service';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';
import { installPlatformD1, uninstallPlatformD1 } from '../helpers/platform-d1-rig';
import {
  V,
  count,
  fixture,
  insAcceptance,
  insDelivery,
  insSend,
  mkUser,
  rows,
} from '../helpers/legal-d1';

const FIXTURE = fixture();
/** A document whose CURRENT version is not material (the registry moves), so NOT_MATERIAL and canSend=false keep a real subject. */
const NON_MATERIAL_DOC = (Object.keys(FIXTURE) as Array<keyof LegalPolicies>).find(k => {
  const hist = FIXTURE[k].history;
  return !hist[hist.length - 1].material;
})!;
const nonMaterialCurrent = () => {
  const hist = FIXTURE[NON_MATERIAL_DOC].history;
  return hist[hist.length - 1].version;
};
void LEGAL_POLICIES;

let d1: DatabaseSync;
let app: Express;
let op = '';
let merchant = '';
let op2 = '';
let send = vi.spyOn(inngest, 'send');

const call = (method: 'get' | 'post', userId: string, url: string) => {
  const r = request(app)[method](url).set({ 'x-test-user': userId });
  return method === 'get' ? r : r.send({});
};
const sendUrl = (docKey: string, version: string) =>
  `/api/v1/admin/legal-policies/${docKey}/${version}/send-notice`;
const policies = '/api/v1/admin/legal-policies';
const termsRow = async () =>
  (await call('get', op, policies)).body.data.policies.find(
    (r: { docKey: string }) => r.docKey === 'terms'
  );
const sendsLeft = () =>
  count(d1, `SELECT COUNT(*) n FROM legal_notice_sends WHERE doc_key = 'terms' AND version = ?`, V);
const ago = (minutes: number) => Date.now() - minutes * 60_000;

beforeAll(() => {
  d1 = installPlatformD1();
  __setLegalPoliciesForTests(FIXTURE);
  app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/admin', adminLegalPolicyRoutes);
  app.use(errorHandler);
  op = mkUser('op', 'super_admin');
  merchant = mkUser('m', 'store_admin');
  op2 = mkUser('op2', 'super_admin');
});
beforeEach(() => {
  d1.exec(
    `DELETE FROM legal_notice_deliveries; DELETE FROM legal_notice_sends; DELETE FROM legal_acceptances`
  );
  h.audit.length = 0;
  h.dropSendRowBeforeRecheck = null;
  __setLegalPoliciesForTests(FIXTURE);
  send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: ['evt'] } as never);
});
afterAll(() => {
  __setLegalPoliciesForTests(null);
  uninstallPlatformD1();
});

describe('super-admin policy updates on the platform D1', () => {
  it('lists every document with its current version; only a super admin may read it', async () => {
    const res = await call('get', op, policies);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = res.body.data.policies as Array<{
      docKey: string;
      current: { version: string };
      canSend: boolean;
      send: unknown;
    }>;
    expect(list.map(r => r.docKey)).toEqual([
      'legal',
      'privacy',
      'terms',
      'acceptableUse',
      'merchant',
    ]);
    const terms = list.find(r => r.docKey === 'terms')!;
    expect(terms).toMatchObject({ current: { version: V }, canSend: true, send: null });
    expect(list.find(r => r.docKey === NON_MATERIAL_DOC)!.canSend).toBe(false);
    expect((await call('get', merchant, policies)).status).toBe(403);
  });

  it('refuses a non-material, a non-current and an unknown document', async () => {
    expect(NON_MATERIAL_DOC).toBeTruthy();
    expect(
      (await call('post', op, sendUrl(NON_MATERIAL_DOC, nonMaterialCurrent()))).body.error.code
    ).toBe('NOT_MATERIAL');
    expect((await call('post', op, sendUrl('terms', '1.0'))).body.error.code).toBe('NOT_CURRENT');
    expect((await call('post', op, sendUrl('cookies', '1.0'))).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends once; a second click is 409 with no second event', async () => {
    const first = await call('post', op, sendUrl('terms', V));
    expect(first.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    const row = rows(
      d1,
      `SELECT id FROM legal_notice_sends WHERE doc_key = 'terms' AND version = ? AND sent_by = ?`,
      V,
      op
    )[0];
    // M1: the event is pinned to THIS send row.
    expect(send).toHaveBeenCalledWith({
      name: 'legal/notice.send-requested',
      data: { sendId: row.id, docKey: 'terms', version: V, sentBy: op },
    });
    expect(h.audit.filter(a => a.action === 'legal.notice_sent')).toHaveLength(1);
    const second = await call('post', op, sendUrl('terms', V));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_SENT');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an enqueue failure answers 502 and leaves no send row (nothing half-announced)', async () => {
    send.mockRejectedValueOnce(new Error('inngest down'));
    const res = await call('post', op, sendUrl('terms', V));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ENQUEUE_FAILED');
    expect(sendsLeft()).toBe(0);
  });

  it('a store_admin cannot send', async () => {
    expect((await call('post', merchant, sendUrl('terms', V))).status).toBe(403);
  });

  it('lists failed deliveries with a masked address and counts a stuck sending row', async () => {
    expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
    const failedUser = mkUser('f', 'store_admin');
    const stuckUser = mkUser('s', 'store_admin');
    insDelivery(d1, failedUser, 'failed', 'SEND_WINDOW_EXHAUSTED');
    insDelivery(d1, stuckUser, 'sending');
    const res = await call('get', op, policies);
    const terms = res.body.data.policies.find((r: { docKey: string }) => r.docKey === 'terms');
    expect(terms.deliveries).toMatchObject({ failed: 1, sending: 1 });
    expect(terms.failedDeliveries).toHaveLength(1);
    expect(terms.failedDeliveries[0]).toMatchObject({ error: 'SEND_WINDOW_EXHAUSTED' });
    expect(terms.failedDeliveries[0].maskedEmail).toMatch(/^f\*\*\*@test\.local$/);
    expect(JSON.stringify(res.body)).not.toContain(failedUser.slice(0, 6));
  });

  describe('withdrawLegalNoticeSend (enqueue compensation, one D1 statement)', () => {
    const mkSend = (sentBy: string, recipientCount: number | null = null) =>
      insSend(d1, 'terms', V, sentBy, recipientCount);
    const withdraw = (actor: string, id: string) => withdrawLegalNoticeSend(id, actor);

    it("deletes the caller's own fresh, untouched row and returns 1", async () => {
      const id = mkSend(op);
      expect(await withdraw(op, id)).toBe(1);
      expect(sendsLeft()).toBe(0);
    });

    it('the operator is required: a contextless call is refused and the row stays', async () => {
      const id = mkSend(op);
      await expect(withdrawLegalNoticeSend(id)).rejects.toThrow(/operatorId/);
      expect(sendsLeft()).toBe(1);
    });

    it('never withdraws a send that has deliveries', async () => {
      const id = mkSend(op);
      insDelivery(d1, merchant);
      expect(await withdraw(op, id)).toBe(0);
      expect(sendsLeft()).toBe(1);
    });

    it('never withdraws a send that has materialised recipients', async () => {
      const id = mkSend(op, 3);
      expect(await withdraw(op, id)).toBe(0);
      expect(sendsLeft()).toBe(1);
    });

    it('another super admin cannot withdraw it', async () => {
      const id = mkSend(op);
      expect(await withdraw(op2, id)).toBe(0);
      expect(sendsLeft()).toBe(1);
    });

    it('an old row cannot be withdrawn', async () => {
      const id = mkSend(op);
      d1.prepare('UPDATE legal_notice_sends SET sent_at = ? WHERE id = ?').run(ago(11), id);
      expect(await withdraw(op, id)).toBe(0);
      expect(sendsLeft()).toBe(1);
    });
  });

  it('when the compensation is refused the answer is 502 WITHDRAW_FAILED and the row stays', async () => {
    send.mockImplementationOnce((async () => {
      // the fan-out had already started when the enqueue "failed"
      insDelivery(d1, merchant);
      throw new Error('timeout after accept');
    }) as never);
    const res = await call('post', op, sendUrl('terms', V));
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('WITHDRAW_FAILED');
    expect(sendsLeft()).toBe(1);
  });

  it('materializeDeliveries aborts cleanly when the send row was withdrawn while it waited', async () => {
    const id = insSend(d1, 'terms', V, op);
    // an owner with a live store, so the fan-out has someone to insert
    const owner = mkUser('own', 'store_admin');
    d1.prepare(
      `INSERT INTO stores (id, name, slug, owner_id, status) VALUES ('st1', 'n', 'n-1', ?, 'active')`
    ).run(owner);
    h.dropSendRowBeforeRecheck = () =>
      void d1.prepare('DELETE FROM legal_notice_sends WHERE id = ?').run(id);
    expect(await materializeDeliveries(op, id, 'terms', V)).toEqual({
      ok: false,
      reason: 'SEND_ROW_MISSING',
    });
    // the deliveries it had inserted are taken back: nobody is mailed
    expect(
      count(d1, `SELECT COUNT(*) n FROM legal_notice_deliveries WHERE doc_key = 'terms'`)
    ).toBe(0);
  });

  it('materializeDeliveries on a send row that never existed aborts with nothing written', async () => {
    expect(await materializeDeliveries(op, 'no-such-send', 'terms', V)).toEqual({
      ok: false,
      reason: 'SEND_ROW_MISSING',
    });
    expect(count(d1, `SELECT COUNT(*) n FROM legal_notice_deliveries`)).toBe(0);
  });

  it('the failed-deliveries list scrubs email addresses out of the provider text', async () => {
    expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
    insDelivery(d1, merchant, 'failed', 'Resend: mailbox full for jane.doe@gmail.com (550)');
    const res = await call('get', op, policies);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('jane.doe');
    expect(body).toContain('j***@gmail.com');
  });

  describe('I1: a fee change needs 30 days between the SEND and its effective date', () => {
    it('refuses a late fee-change Send with 422 NOTICE_TOO_LATE, no row, no event; the page row says so', async () => {
      __setLegalPoliciesForTests(fixture(29));
      const res = await call('post', op, sendUrl('terms', V));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('NOTICE_TOO_LATE');
      expect(send).not.toHaveBeenCalled();
      expect(sendsLeft()).toBe(0);
      expect(await termsRow()).toMatchObject({ canSend: false, sendBlocked: 'NOTICE_TOO_LATE' });
    });

    it('allows a fee change exactly 31 days out', async () => {
      __setLegalPoliciesForTests(fixture(31));
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
    });

    it('a NON-fee material change has no minimum: effective today is fine', async () => {
      __setLegalPoliciesForTests(fixture(0, false));
      expect(await termsRow()).toMatchObject({ canSend: true, sendBlocked: null });
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
    });
  });

  describe('I4: only aged rows read as stuck / no run', () => {
    it('a fresh send with no recipients yet is neither noRun nor stalled; after 11 minutes it is both', async () => {
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
      expect(await termsRow()).toMatchObject({ noRun: false, stalled: false, stuckSending: 0 });
      d1.prepare(`UPDATE legal_notice_sends SET sent_at = sent_at - ? WHERE doc_key = 'terms'`).run(
        11 * 60_000
      );
      expect(await termsRow()).toMatchObject({ noRun: true, stalled: true });
    });

    it('a sending row is stuck only after 15 minutes untouched; queued rows with no activity stall', async () => {
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
      d1.prepare(`UPDATE legal_notice_sends SET recipient_count = 2 WHERE doc_key = 'terms'`).run();
      const other = mkUser('q', 'store_admin');
      insDelivery(d1, merchant, 'sending');
      insDelivery(d1, other, 'queued');
      expect(await termsRow()).toMatchObject({
        deliveries: { sending: 1, queued: 1 },
        stuckSending: 0,
        noRun: false,
        stalled: false,
      });
      d1.prepare(`UPDATE legal_notice_deliveries SET updated_at = updated_at - ?`).run(16 * 60_000);
      d1.prepare(`UPDATE legal_notice_sends SET sent_at = sent_at - ?`).run(16 * 60_000);
      expect(await termsRow()).toMatchObject({ stuckSending: 1, stalled: true });
    });
  });

  describe('I5: Resume and Retry failed', () => {
    const url = (path: 'resume' | 'retry-failed') => `${policies}/terms/${V}/${path}`;
    const delivery = (userId: string) =>
      rows(
        d1,
        `SELECT status, error FROM legal_notice_deliveries WHERE user_id = ? AND doc_key = 'terms' AND version = ?`,
        userId,
        V
      )[0];

    it('404 NOT_SENT before any send; a store_admin gets 403', async () => {
      const r = await call('post', op, url('resume'));
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('NOT_SENT');
      expect((await call('post', merchant, url('retry-failed'))).status).toBe(403);
      expect(send).not.toHaveBeenCalled();
    });

    it('Resume re-emits the event for the same send row as the acting operator, and is audited', async () => {
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
      const row = rows(d1, `SELECT id FROM legal_notice_sends WHERE doc_key = 'terms'`)[0];
      send.mockClear();
      const r = await call('post', op2, url('resume'));
      expect(r.status).toBe(202);
      expect(send).toHaveBeenCalledWith({
        name: 'legal/notice.send-requested',
        data: { sendId: row.id, docKey: 'terms', version: V, sentBy: op2 },
      });
      expect(
        h.audit.filter(
          a =>
            a.userId === op2 && a.action === 'legal.notice_resumed' && a.resourceId === `terms@${V}`
        )
      ).toHaveLength(1);
    });

    it('Retry failed moves ONLY failed rows to queued (never sending/sent), then emits once', async () => {
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
      const a = mkUser('ra', 'store_admin');
      const b = mkUser('rb', 'store_admin');
      insDelivery(d1, merchant, 'failed', 'boom');
      insDelivery(d1, a, 'sent');
      insDelivery(d1, b, 'sending');
      send.mockClear();
      const r = await call('post', op, url('retry-failed'));
      expect(r.status).toBe(202);
      expect(r.body.data.requeued).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(delivery(merchant)).toMatchObject({ status: 'queued', error: null });
      expect(delivery(a).status).toBe('sent');
      expect(delivery(b).status).toBe('sending');
      expect(
        h.audit.filter(
          x =>
            x.userId === op &&
            x.action === 'legal.notice_retry_failed' &&
            x.resourceId === `terms@${V}`
        )
      ).toHaveLength(1);
      // Nothing failed any more: a second press requeues nothing and emits nothing.
      send.mockClear();
      const again = await call('post', op, url('retry-failed'));
      expect(again.body.data.requeued).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });

    it('Retry failed EXCLUDES TIMEOUT_UNKNOWN rows (may have been delivered); the overview lists them separately', async () => {
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
      const a = mkUser('ta', 'store_admin');
      insDelivery(d1, merchant, 'failed', 'boom');
      insDelivery(d1, a, 'failed', 'TIMEOUT_UNKNOWN');
      const before = await termsRow();
      expect(before.deliveries.failed).toBe(1);
      expect(before.unknownOutcome).toBe(1);
      expect(before.failedDeliveries).toHaveLength(1);
      expect(before.unknownDeliveries).toHaveLength(1);
      expect(before.unknownDeliveries[0]).toMatchObject({ error: 'TIMEOUT_UNKNOWN' });

      send.mockClear();
      const r = await call('post', op, url('retry-failed'));
      expect(r.status).toBe(202);
      expect(r.body.data.requeued).toBe(1);
      expect(delivery(merchant)).toMatchObject({ status: 'queued', error: null });
      expect(delivery(a)).toMatchObject({ status: 'failed', error: 'TIMEOUT_UNKNOWN' });
      // Only unknown-outcome rows left: a second press requeues nothing and emits nothing.
      d1.prepare('DELETE FROM legal_notice_deliveries WHERE user_id = ?').run(merchant);
      send.mockClear();
      const again = await call('post', op, url('retry-failed'));
      expect(again.body.data.requeued).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });

    it('Resume and Retry failed refuse a superseded version with 409 NOT_CURRENT (no event, no row change)', async () => {
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
      insDelivery(d1, merchant, 'failed', 'boom');
      // A newer terms version makes V superseded.
      __setLegalPoliciesForTests({
        ...FIXTURE,
        terms: {
          history: [
            ...FIXTURE.terms.history,
            { ...FIXTURE.terms.history[FIXTURE.terms.history.length - 1], version: '99.1' },
          ],
        },
      });
      send.mockClear();
      for (const path of ['resume', 'retry-failed'] as const) {
        const r = await call('post', op, url(path));
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('NOT_CURRENT');
      }
      expect(send).not.toHaveBeenCalled();
      expect(delivery(merchant)).toMatchObject({ status: 'failed', error: 'boom' });
    });

    it('a Retry whose enqueue fails puts the rows back to failed: no orphan queued rows', async () => {
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
      insDelivery(d1, merchant, 'failed', 'boom');
      send.mockRejectedValueOnce(new Error('inngest down'));
      const r = await call('post', op, url('retry-failed'));
      expect(r.status).toBe(502);
      expect(r.body.error.code).toBe('ENQUEUE_FAILED');
      expect(delivery(merchant)).toMatchObject({ status: 'failed', error: 'RETRY_ENQUEUE_FAILED' });
    });
  });

  describe("I6: one account's acceptance record (super admin)", () => {
    it('lists acceptances with a masked IP and the delivery status; only a super admin may read it', async () => {
      insAcceptance(d1, merchant, 'privacy', '1.0', 'signup', '203.0.113.45', 'UA');
      expect((await call('post', op, sendUrl('terms', V))).status).toBe(202);
      insDelivery(d1, merchant, 'sent');
      const res = await call('get', op, `/api/v1/admin/users/${merchant}/legal-acceptances`);
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
        (await call('get', merchant, `/api/v1/admin/users/${merchant}/legal-acceptances`)).status
      ).toBe(403);
    });
  });
});
