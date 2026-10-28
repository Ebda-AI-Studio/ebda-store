/** The Store's side of the identity Service Binding: stores[] membership and the one-time-code mail. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendVerification: vi.fn(async (..._a: unknown[]) => undefined),
  sendReset: vi.fn(async (..._a: unknown[]) => undefined),
  staffRows: [] as Array<{ storeId: string; store: { deletedAt: Date | null } }>,
  owned: [] as string[],
}));
const { sendVerification, sendReset } = h;

vi.mock('@ebda/database', () => ({
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ storeStaff: { findMany: async () => h.staffRows } }),
}));
vi.mock('../../apps/api/src/lib/definer', () => ({ ownedStoreIds: async () => h.owned }));
vi.mock('../../apps/api/src/services/platform-mailer', () => ({
  sendMerchantVerificationEmail: h.sendVerification,
  sendMerchantPasswordResetEmail: h.sendReset,
}));
vi.mock('../../apps/api/src/config', () => ({ config: { adminUrl: 'https://store.ebda.app' } }));

import { sendCodeMail, storesForUser } from '../../apps/api/src/lib/identity-directory';

const U = '3f2b6c1e-9d4a-4c1e-8b7a-0a1b2c3d4e5f';

beforeEach(() => {
  sendVerification.mockClear();
  sendReset.mockClear();
  h.staffRows = [];
  h.owned = [];
});

describe('storesForUser', () => {
  it('lists owned stores as owner and staff memberships as staff, without duplicates or deleted stores', async () => {
    h.owned = ['s1', 's2'];
    h.staffRows = [
      { storeId: 's2', store: { deletedAt: null } }, // also owner: listed once, as owner
      { storeId: 's3', store: { deletedAt: null } },
      { storeId: 's4', store: { deletedAt: new Date() } }, // deleted store: not listed
    ];
    expect(await storesForUser(U)).toEqual([
      { id: 's1', role: 'owner' },
      { id: 's2', role: 'owner' },
      { id: 's3', role: 'staff' },
    ]);
  });

  it('refuses a non-UUID user id before touching the database', async () => {
    await expect(storesForUser("x'; drop table users;--")).rejects.toThrow(/UUID/);
  });
});

describe('sendCodeMail', () => {
  const base = {
    to: 'a+b@example.com',
    code: '123456',
    language: 'ar' as const,
    firstName: 'Nora',
    ttlMinutes: 30,
  };

  it('carries the code and the url-encoded address in the admin verify link', async () => {
    await sendCodeMail({ ...base, kind: 'email_verify' });
    expect(sendVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'a+b@example.com',
        verificationUrl:
          'https://store.ebda.app/verify-email?email=a%2Bb%40example.com#code=123456',
      }),
      'ar',
      true
    );
  });

  it('uses the reset template and the 15 minute ttl for a password reset', async () => {
    await sendCodeMail({ ...base, kind: 'password_reset', ttlMinutes: 15 });
    expect(sendReset).toHaveBeenCalledWith(
      expect.objectContaining({
        resetUrl: 'https://store.ebda.app/reset-password?email=a%2Bb%40example.com#code=123456',
        expiresInMinutes: 15,
      }),
      'ar',
      true
    );
  });

  it('refuses anything but a 6 digit code (no free text into a mail link)', async () => {
    await expect(sendCodeMail({ ...base, kind: 'email_verify', code: '12345a' })).rejects.toThrow();
    expect(sendVerification).not.toHaveBeenCalled();
  });
});
