/**
 * The legal-notice email fan-out (Rulings LEGAL-4, LEGAL-6), run through the real handler on
 * the strict-RLS `ebda_app` login (tenant guard on) with a step shim that memoizes like
 * Inngest. Every DB call acts as the super admin who pressed send (asPlatformOperator).
 * Review Focus 1 (two stores -> one email) and 2 (a retry never double-sends).
 * The mail function is mocked only to COUNT sends per address; the template is covered by
 * tests/unit/legal-notice-email.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { LEGAL_POLICIES, type LegalPolicies } from '@ebda/shared';

const { sendLegalNoticeEmail } = vi.hoisted(() => ({
  sendLegalNoticeEmail: vi.fn(async (_d: { email: string }) => undefined),
}));
vi.mock('@api/services/platform-mailer', async orig => ({
  ...(await orig<typeof import('@api/services/platform-mailer')>()),
  sendLegalNoticeEmail,
}));

import { runLegalNoticeSend } from '@api/lib/inngest/functions/legal-notice-send';
import { __setLegalPoliciesForTests } from '@api/services/legal-notice.service';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';

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

describe.skipIf(!hasDb)('legal notice email fan-out', () => {
  let owner: AppPrismaClient;
  const ids = { two: '', deletedOnly: '', noStore: '', en: '', demoOnly: '', op: '' };
  const emails: Record<string, string> = {};
  const storeIds: string[] = [];
  process.env.CAMPAIGN_PLATFORM_SEND_INTERVAL_MS = '0';

  const mkUser = async (tag: string, role: 'store_admin' | 'super_admin', language = 'ar') => {
    const email = `lnf-${tag}-${run}-${crypto.randomUUID().slice(0, 6)}@test.local`;
    const u = await owner.user.create({
      data: {
        email,
        passwordHash: 'x',
        firstName: 'Lnf',
        lastName: tag,
        role,
        emailVerified: true,
        language,
      },
    });
    emails[u.id] = email;
    return u.id;
  };
  const mkStore = async (
    ownerId: string,
    n: number,
    opts: { deleted?: boolean; demo?: boolean } = {}
  ) => {
    const s = await owner.store.create({
      data: {
        name: `lnf-${run}-${n}`,
        slug: `lnf-${run}-${n}`,
        ownerId,
        status: 'active',
        ...(opts.deleted ? { deletedAt: new Date() } : {}),
        ...(opts.demo ? { isDemo: true } : {}),
      },
    });
    storeIds.push(s.id);
  };
  const sendsTo = (userId: string) =>
    sendLegalNoticeEmail.mock.calls.filter(c => c[0].email === emails[userId]).length;
  const runJob = () =>
    asApp(() =>
      runLegalNoticeSend({
        event: { data: { docKey: 'terms', version: V, sentBy: ids.op } },
        step: makeStep(new Map()),
      })
    );
  const wipe = async () => {
    await owner.legalNoticeDelivery.deleteMany({ where: { docKey: 'terms', version: V } });
    await owner.legalNoticeSend.deleteMany({ where: { docKey: 'terms', version: V } });
  };

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 2, role: 'owner' });
    __setLegalPoliciesForTests(FIXTURE);
    ids.two = await mkUser('two', 'store_admin');
    ids.deletedOnly = await mkUser('deleted', 'store_admin');
    ids.noStore = await mkUser('nostore', 'store_admin');
    ids.en = await mkUser('en', 'store_admin', 'en');
    ids.demoOnly = await mkUser('demo', 'store_admin');
    ids.op = await mkUser('op', 'super_admin');
    await mkStore(ids.two, 1);
    await mkStore(ids.two, 2);
    await mkStore(ids.deletedOnly, 3, { deleted: true });
    await mkStore(ids.en, 4);
    await mkStore(ids.demoOnly, 5, { demo: true });
  });
  beforeEach(async () => {
    await wipe();
    sendLegalNoticeEmail.mockReset();
    sendLegalNoticeEmail.mockImplementation(async () => undefined);
    await owner.legalNoticeSend.create({ data: { docKey: 'terms', version: V, sentBy: ids.op } });
  });
  afterAll(async () => {
    await wipe();
    __setLegalPoliciesForTests(null);
    await owner.store.deleteMany({ where: { id: { in: storeIds } } });
    await owner.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await owner.$disconnect();
  });

  it('two stores, one email; deleted/demo-store and store-less accounts get none; bilingual for everyone', async () => {
    const result = await runJob();
    expect(sendsTo(ids.two)).toBe(1);
    expect(sendsTo(ids.deletedOnly)).toBe(0);
    expect(sendsTo(ids.noStore)).toBe(0);
    expect(sendsTo(ids.demoOnly)).toBe(0);
    expect(sendsTo(ids.en)).toBe(1);
    const bilingual = {
      title: { ar: 'شروط الخدمة', en: 'Terms of service' },
      summary: { ar: 'تغيير تجريبي في الرسوم.', en: 'Test fee change.' },
      effectiveOn: { ar: '20 نوفمبر 2026', en: '20 November 2026' },
      url: { ar: 'https://ebda.app/terms/', en: 'https://ebda.app/en/terms/' },
    };
    const two = sendLegalNoticeEmail.mock.calls.find(c => c[0].email === emails[ids.two])!;
    expect(two[0]).toMatchObject(bilingual);
    // users.language = 'en' changes nothing (Ruling LEGAL-6): same bilingual payload, one arg.
    const en = sendLegalNoticeEmail.mock.calls.find(c => c[0].email === emails[ids.en])!;
    expect(en[0]).toMatchObject(bilingual);
    expect(en).toHaveLength(1);
    const rows = await owner.legalNoticeDelivery.findMany({
      where: {
        docKey: 'terms',
        version: V,
        userId: { in: [ids.two, ids.deletedOnly, ids.noStore, ids.demoOnly] },
      },
      select: { userId: true, status: true },
    });
    expect(rows).toEqual([{ userId: ids.two, status: 'sent' }]);
    const send = await owner.legalNoticeSend.findUnique({
      where: { docKey_version: { docKey: 'terms', version: V } },
    });
    expect(send?.recipientCount).toBe((result as { recipientCount: number }).recipientCount);
    expect(
      await owner.legalNoticeDelivery.count({
        where: { docKey: 'terms', version: V, status: 'queued' },
      })
    ).toBe(0);
  }, 120_000);

  it('a re-run (retry with a fresh memo) sends nothing new', async () => {
    await runJob();
    const first = sendLegalNoticeEmail.mock.calls.length;
    await runJob();
    expect(sendLegalNoticeEmail.mock.calls.length).toBe(first);
    expect(sendsTo(ids.two)).toBe(1);
  }, 120_000);

  it('a row stuck in `sending` (crash after the mail went out) is never re-sent', async () => {
    await owner.legalNoticeDelivery.create({
      data: { userId: ids.two, docKey: 'terms', version: V, status: 'sending' },
    });
    await runJob();
    expect(sendsTo(ids.two)).toBe(0);
    expect(sendsTo(ids.en)).toBe(1);
  }, 120_000);

  it('a failed send marks the row failed with the error, and the run goes on', async () => {
    sendLegalNoticeEmail.mockImplementation(async d => {
      if (d.email === emails[ids.en]) throw new Error('Resend send failed: boom');
    });
    await runJob();
    const row = await owner.legalNoticeDelivery.findUnique({
      where: { userId_docKey_version: { userId: ids.en, docKey: 'terms', version: V } },
    });
    expect(row).toMatchObject({ status: 'failed', error: 'Resend send failed: boom' });
    expect(sendsTo(ids.two)).toBe(1);
  }, 120_000);

  it('skips when the send row is gone (the request was compensated)', async () => {
    await wipe();
    expect(await runJob()).toEqual({ skipped: 'SEND_ROW_MISSING' });
    expect(sendLegalNoticeEmail).not.toHaveBeenCalled();
  });

  it('refuses to run as a non-super-admin sentBy (RLS + operator check), mailing nobody', async () => {
    await expect(
      asApp(() =>
        runLegalNoticeSend({
          event: { data: { docKey: 'terms', version: V, sentBy: ids.two } },
          step: makeStep(new Map()),
        })
      )
    ).rejects.toThrow(/not an active super_admin/);
    expect(sendLegalNoticeEmail).not.toHaveBeenCalled();
  });
});
