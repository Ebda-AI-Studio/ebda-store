import { describe, it, expect, vi, beforeEach } from 'vitest';

// Owner-only "send test email to myself" (QA-66): recipient is the owner's own address, never a shopper;
// non-owners are refused; the real once-per-store log is untouched; the signed unsubscribe link is attached.
const { sendLifecycleEmail, createMany, storeFind, subFind } = vi.hoisted(() => ({
  sendLifecycleEmail: vi.fn(),
  createMany: vi.fn(),
  storeFind: vi.fn(),
  subFind: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: { findUnique: storeFind },
      storeSubscription: { findUnique: subFind },
      storeLifecycleEmail: { createMany, findUnique: vi.fn(), findMany: vi.fn() },
    })
  ),
}));
vi.mock('../../lib/repo-factory', () => ({ storeDb: vi.fn() }));
vi.mock('../../lib/jobs/store-db', () => ({ customersById: vi.fn(), runInStoreCtx: vi.fn() }));
vi.mock('../../lib/demo-store', () => ({ isDemoStore: vi.fn() }));
vi.mock('../setup-guide.service', () => ({ SetupGuideService: { get: vi.fn() } }));
vi.mock('../email.service', () => ({ EmailService: { sendLifecycleEmail } }));
vi.mock('../../lib/lifecycle-unsubscribe-token', () => ({
  lifecycleUnsubscribeUrl: (id: string) => `https://api.ebda.app/unsub?token=${id}.sig`,
}));
vi.mock('../../config', () => ({ config: { adminUrl: 'https://admin.ebda.app' } }));
vi.mock('../../lib/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { sendLifecycleTestEmail } from '../lifecycle-emails.service';

const STORE = '11111111-1111-4111-8111-111111111111';
const store = {
  name: 'Amelia',
  slug: 'amelia',
  domain: null,
  settings: { defaultLanguage: 'en' },
  ownerId: 'owner-1',
  owner: { email: 'owner@example.com' },
};

beforeEach(() => {
  vi.clearAllMocks();
  storeFind.mockResolvedValue(store);
  subFind.mockResolvedValue({ trialEndsAt: new Date('2026-12-01T00:00:00Z') });
  sendLifecycleEmail.mockResolvedValue(undefined);
});

describe('sendLifecycleTestEmail', () => {
  it('mails only the owner, flagged as a test, with the signed unsubscribe link, and writes no log row', async () => {
    const r = await sendLifecycleTestEmail(
      STORE,
      'trial_recap',
      'owner-1',
      new Date('2026-11-27T00:00:00Z')
    );
    expect(r).toEqual({ status: 'sent', to: 'owner@example.com' });
    expect(sendLifecycleEmail).toHaveBeenCalledTimes(1);
    const [data, lang] = sendLifecycleEmail.mock.calls[0];
    expect(data.to).toBe('owner@example.com');
    expect(data.isTest).toBe(true);
    expect(data.unsubscribeUrl).toBe(`https://api.ebda.app/unsub?token=${STORE}.sig`);
    expect(data.daysLeft).toBe(4);
    expect(lang).toBe('en');
    expect(createMany).not.toHaveBeenCalled();
  });

  it('refuses anyone who is not the owner (staff / super admin) and sends nothing', async () => {
    expect(await sendLifecycleTestEmail(STORE, 'add_products', 'someone-else')).toEqual({
      status: 'not_owner',
    });
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it('404 for an unknown store, 409-shaped result when the owner has no email', async () => {
    storeFind.mockResolvedValueOnce(null);
    expect(await sendLifecycleTestEmail(STORE, 'add_products', 'owner-1')).toEqual({
      status: 'not_found',
    });
    storeFind.mockResolvedValueOnce({ ...store, owner: { email: null } });
    expect(await sendLifecycleTestEmail(STORE, 'add_products', 'owner-1')).toEqual({
      status: 'no_recipient',
    });
    expect(sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it('reports a queue failure instead of claiming it sent', async () => {
    sendLifecycleEmail.mockRejectedValueOnce(new Error('queue down'));
    expect(await sendLifecycleTestEmail(STORE, 'add_products', 'owner-1')).toEqual({
      status: 'failed',
      reason: 'ENQUEUE_FAILED',
    });
  });
});
