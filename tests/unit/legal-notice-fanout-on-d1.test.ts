/**
 * The legal-notice email fan-out (Rulings LEGAL-4, LEGAL-6) on the platform D1 (ported from tests/integration/legal-notice-fanout.test.ts,
 * which ran on a live relational database under the strict-RLS `ebda_app` login): the real `runLegalNoticeSend` handler with a step shim
 * that memoizes like Inngest, the owners from the D1 `stores` directory, the accounts from the identity service (a Map), every DB call
 * acting as the super admin who pressed send (`asOperator`). Review Focus 1 (two stores -> one email) and 2 (a retry never double-sends).
 * The mail function is mocked only to COUNT sends per address; the template is covered by tests/unit/legal-notice-email.test.ts.
 * "Skips when the send row is gone" and the M1 pinned-run case are also covered at the unit level by tests/unit/legal-notice-send-job.test.ts.
 *
 * Mutation proofs: claim queued -> sending AFTER the mail (skip `claim`) -> "a row stuck in `sending`" and "a re-run"; mail a row whose
 * account is gone (drop the `gone` branch) -> "an owner deleted after the recipients were listed".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { formatLegalDate } from '@ebda/shared';

const h = vi.hoisted(() => ({ audit: [] as Array<Record<string, unknown>> }));
const { sendLegalNoticeEmail } = vi.hoisted(() => ({
  sendLegalNoticeEmail: vi.fn(async (_d: { email: string }) => undefined),
}));
vi.mock('@api/services/platform-mailer', async orig => ({
  ...(await orig<typeof import('@api/services/platform-mailer')>()),
  sendLegalNoticeEmail,
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

import { runLegalNoticeSend } from '@api/lib/inngest/functions/legal-notice-send';
import { inngest } from '@api/lib/inngest/client';
import {
  __setLegalPoliciesForTests,
  retryFailedDeliveries,
} from '@api/services/legal-notice.service';
import { installPlatformD1, uninstallPlatformD1 } from '../helpers/platform-d1-rig';
import {
  V,
  accounts,
  count,
  fixture,
  insDelivery,
  insSend,
  insStore,
  mkUser,
  rows,
} from '../helpers/legal-d1';

process.env.CAMPAIGN_PLATFORM_SEND_INTERVAL_MS = '0';

function makeStep(memo: Map<string, unknown>) {
  return {
    run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(id)) return memo.get(id) as T;
      const value = await fn();
      const serialized = value === undefined ? null : JSON.parse(JSON.stringify(value));
      memo.set(id, serialized);
      return serialized as T;
    },
  };
}

let d1: DatabaseSync;
const ids = { two: '', deletedOnly: '', noStore: '', en: '', demoOnly: '', op: '' };
let sendId = '';

const emailOf = (userId: string) => accounts.get(userId)!.email;
const sendsTo = (userId: string) =>
  sendLegalNoticeEmail.mock.calls.filter(c => c[0].email === emailOf(userId)).length;
const runJob = (id = sendId, sentBy = ids.op) =>
  runLegalNoticeSend({
    event: { data: { sendId: id, docKey: 'terms', version: V, sentBy } },
    step: makeStep(new Map()),
  });
const delivery = (userId: string) =>
  rows(
    d1,
    `SELECT status, error FROM legal_notice_deliveries WHERE user_id = ? AND doc_key = 'terms' AND version = ?`,
    userId,
    V
  )[0];
const sendRow = (id: string) =>
  rows(d1, 'SELECT recipient_count FROM legal_notice_sends WHERE id = ?', id)[0];
const wipe = () => d1.exec(`DELETE FROM legal_notice_deliveries; DELETE FROM legal_notice_sends`);

beforeAll(() => {
  d1 = installPlatformD1();
  __setLegalPoliciesForTests(fixture());
  ids.two = mkUser('two', 'store_admin');
  ids.deletedOnly = mkUser('deleted', 'store_admin');
  ids.noStore = mkUser('nostore', 'store_admin');
  ids.en = mkUser('en', 'store_admin', 'en');
  ids.demoOnly = mkUser('demo', 'store_admin');
  ids.op = mkUser('op', 'super_admin');
  insStore(d1, ids.two, 1);
  insStore(d1, ids.two, 2);
  insStore(d1, ids.deletedOnly, 3, { deleted: true });
  insStore(d1, ids.en, 4);
  insStore(d1, ids.demoOnly, 5, { demo: true });
});
beforeEach(() => {
  wipe();
  sendLegalNoticeEmail.mockReset();
  sendLegalNoticeEmail.mockImplementation(async () => undefined);
  sendId = insSend(d1, 'terms', V, ids.op);
});
afterAll(() => {
  __setLegalPoliciesForTests(null);
  uninstallPlatformD1();
});

describe('legal notice email fan-out on the platform D1', () => {
  it('two stores, one email; deleted/demo-store and store-less accounts get none; bilingual for everyone', async () => {
    const result = await runJob();
    expect(sendsTo(ids.two)).toBe(1);
    expect(sendsTo(ids.deletedOnly)).toBe(0);
    expect(sendsTo(ids.noStore)).toBe(0);
    expect(sendsTo(ids.demoOnly)).toBe(0);
    expect(sendsTo(ids.en)).toBe(1);
    const entry = fixture().terms.history.at(-1)!;
    const bilingual = {
      title: { ar: 'شروط الخدمة', en: 'Terms of service' },
      summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
      url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
    };
    const two = sendLegalNoticeEmail.mock.calls.find(c => c[0].email === emailOf(ids.two))!;
    expect(two[0]).toMatchObject(bilingual);
    expect(two[0]).toMatchObject({
      effectiveOn: {
        ar: formatLegalDate(entry.effectiveAt, 'ar'),
        en: formatLegalDate(entry.effectiveAt, 'en'),
      },
    });
    // users.language = 'en' changes nothing (Ruling LEGAL-6): same bilingual payload, one arg.
    const en = sendLegalNoticeEmail.mock.calls.find(c => c[0].email === emailOf(ids.en))!;
    expect(en[0]).toMatchObject(bilingual);
    expect(en).toHaveLength(1);
    expect(
      rows(d1, `SELECT user_id, status FROM legal_notice_deliveries ORDER BY user_id`).sort(
        (a, b) => String(a.user_id).localeCompare(String(b.user_id))
      )
    ).toEqual(
      [
        { user_id: ids.two, status: 'sent' },
        { user_id: ids.en, status: 'sent' },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id))
    );
    expect(sendRow(sendId).recipient_count).toBe(
      (result as { recipientCount: number }).recipientCount
    );
    expect(
      count(d1, `SELECT COUNT(*) n FROM legal_notice_deliveries WHERE status = 'queued'`)
    ).toBe(0);
  });

  it('a re-run (retry with a fresh memo) sends nothing new', async () => {
    await runJob();
    const first = sendLegalNoticeEmail.mock.calls.length;
    await runJob();
    expect(sendLegalNoticeEmail.mock.calls.length).toBe(first);
    expect(sendsTo(ids.two)).toBe(1);
  });

  it('a row stuck in `sending` (crash after the mail went out) is never re-sent', async () => {
    insDelivery(d1, ids.two, 'sending');
    await runJob();
    expect(sendsTo(ids.two)).toBe(0);
    expect(sendsTo(ids.en)).toBe(1);
  });

  it('a failed send marks the row failed with the error, and the run goes on', async () => {
    sendLegalNoticeEmail.mockImplementation(async d => {
      if (d.email === emailOf(ids.en)) throw new Error('Resend send failed: boom');
    });
    await runJob();
    expect(delivery(ids.en)).toMatchObject({ status: 'failed', error: 'Resend send failed: boom' });
    expect(sendsTo(ids.two)).toBe(1);
  });

  it('skips when the send row is gone (the request was compensated)', async () => {
    wipe();
    expect(await runJob()).toEqual({ skipped: 'SEND_ROW_MISSING' });
    expect(sendLegalNoticeEmail).not.toHaveBeenCalled();
  });

  it('refuses to run as a non-super-admin sentBy (operator check), mailing nobody', async () => {
    await expect(runJob(sendId, ids.two)).rejects.toThrow(/not an active super_admin/);
    expect(sendLegalNoticeEmail).not.toHaveBeenCalled();
  });

  it('Retry failed (I5): only the failed recipient is mailed again, once; sent rows are never re-mailed', async () => {
    sendLegalNoticeEmail.mockImplementation(async d => {
      if (d.email === emailOf(ids.en)) throw new Error('Resend send failed: boom');
    });
    await runJob();
    expect(sendsTo(ids.en)).toBe(1);
    expect(sendsTo(ids.two)).toBe(1);
    sendLegalNoticeEmail.mockReset();
    sendLegalNoticeEmail.mockImplementation(async () => undefined);
    const emitted = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: ['evt'] } as never);
    try {
      const r = await retryFailedDeliveries(ids.op, 'terms', V);
      expect(r.requeued).toBeGreaterThanOrEqual(1);
      expect(emitted).toHaveBeenCalledWith({
        name: 'legal/notice.send-requested',
        data: { sendId, docKey: 'terms', version: V, sentBy: ids.op },
      });
      // What the emitted event runs: the same handler, recipients NOT re-materialised.
      const before = sendRow(sendId);
      await runJob();
      await runJob(); // a second Resume on top: still nothing new
      expect(sendsTo(ids.en)).toBe(1);
      expect(sendsTo(ids.two)).toBe(0);
      expect(sendRow(sendId).recipient_count).toBe(before.recipient_count);
      expect(delivery(ids.en)).toMatchObject({ status: 'sent', error: null });
    } finally {
      emitted.mockRestore();
    }
  });

  it('Resume on a send whose recipients were never materialised mails everyone once (I5)', async () => {
    expect(sendRow(sendId).recipient_count).toBeNull();
    await runJob();
    expect(sendsTo(ids.two)).toBe(1);
    await runJob();
    expect(sendsTo(ids.two)).toBe(1);
  });

  it('an owner deleted after the recipients were listed is failed USER_GONE, not mailed (M3)', async () => {
    const late = mkUser('late', 'store_admin');
    insStore(d1, late, 6);
    insDelivery(d1, late, 'queued');
    d1.prepare('UPDATE legal_notice_sends SET recipient_count = 1 WHERE id = ?').run(sendId);
    // the identity service no longer knows the account (an erased account is absent)
    accounts.delete(late);
    await runJob();
    expect(sendLegalNoticeEmail).not.toHaveBeenCalled();
    expect(delivery(late)).toMatchObject({ status: 'failed', error: 'USER_GONE' });
  });

  it('a run pinned to a send row that no longer exists mails nobody (M1)', async () => {
    const stale = sendId;
    wipe();
    sendId = insSend(d1, 'terms', V, ids.op);
    expect(await runJob(stale)).toEqual({ skipped: 'SEND_ROW_MISSING' });
    expect(sendLegalNoticeEmail).not.toHaveBeenCalled();
    expect(count(d1, `SELECT COUNT(*) n FROM legal_notice_deliveries`)).toBe(0);
  });
});
