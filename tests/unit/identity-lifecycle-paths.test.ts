/**
 * Every Store path that creates, resets or reaches an identity-managed account goes through the identity service
 * (Rulings ID-2, ID-12): admin-namespace password reset is delegated, invitations are created there, and a platform admin is
 * never granted over the Store or over RPC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  forgot: vi.fn(async (_email: string) => {}),
  issueToken: vi.fn(),
  merchantMail: vi.fn(),
  waitUntil: vi.fn((p: Promise<unknown>) => void p),
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  currentStoreId: vi.fn(),
  hasTenantContext: vi.fn(() => false),
  runInTenantContext: vi.fn(),
  withStore: vi.fn(),
  withUser: vi.fn(async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      user: { findUnique: async () => h.user },
      store: { findFirst: async () => null },
    })
  ),
}));
vi.mock('@api/lib/definer', () => ({
  findUserIdByEmail: async () => (h.user ? (h.user.id as string) : null),
  deleteUserAddresses: vi.fn(),
  deleteUserPasskeys: vi.fn(),
  deleteUserTokens: vi.fn(),
  getUserState: vi.fn(),
  purgeRefreshTokens: vi.fn(),
  refreshTokenUser: vi.fn(),
  revokeUserSessionsRow: vi.fn(),
  verificationTokenUser: vi.fn(),
}));
vi.mock('@api/lib/identity-client', () => ({
  forgotIdentityPassword: (e: string) => h.forgot(e),
  revokeIdentityIfManaged: vi.fn(),
}));
vi.mock('@api/cf/bindings', () => ({ cfWaitUntil: h.waitUntil }));
vi.mock('@api/services/platform-mailer', () => ({
  sendMerchantPasswordResetEmail: h.merchantMail,
  sendMerchantVerificationEmail: vi.fn(),
}));
vi.mock('@api/services/email.service', () => ({
  EmailService: { sendPasswordReset: vi.fn(async () => {}) },
}));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));

const { AuthService } = await import('@api/services/auth.service');

beforeEach(() => {
  h.forgot.mockClear();
  h.merchantMail.mockClear();
});

describe('POST /auth/forgot-password for the admin namespace', () => {
  it('delegates to the identity service and issues NO Store password token', async () => {
    h.user = {
      id: 'u1',
      email: 'm@example.com',
      firstName: 'M',
      lastName: 'A',
      storeId: null,
      language: 'ar',
    };
    const issue = vi.spyOn(AuthService, 'issuePasswordSetToken' as never);
    const r = await AuthService.requestPasswordReset('m@example.com', null);
    expect(r).toEqual({ userId: 'u1' });
    expect(h.forgot).toHaveBeenCalledWith('m@example.com');
    expect(issue).not.toHaveBeenCalled();
    expect(h.merchantMail).not.toHaveBeenCalled();
  });

  it('answers generically for an unknown address without calling anything', async () => {
    h.user = null;
    expect(await AuthService.requestPasswordReset('x@example.com', null)).toBeNull();
    expect(h.forgot).not.toHaveBeenCalled();
  });

  it('a platform customer (storeId null, role customer) keeps the Store reset flow', async () => {
    h.user = {
      id: 'c1',
      email: 'c@example.com',
      firstName: 'C',
      lastName: 'U',
      storeId: null,
      role: 'customer',
      language: 'en',
    };
    const issue = vi
      .spyOn(AuthService, 'issuePasswordSetToken' as never)
      .mockResolvedValue('tok' as never);
    await AuthService.requestPasswordReset('c@example.com', null);
    expect(h.forgot).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledWith('c1');
  });
});
