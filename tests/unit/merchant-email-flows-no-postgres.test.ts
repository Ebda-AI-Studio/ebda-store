/**
 * Ruling NZ-ACCT-1: with no store on a Postgres-less Worker, resend-verification and forgot-password never reach `withUser`
 * (no users table there): resend answers the enumeration-safe generic success, the reset delegates to the identity service and
 * answers like a missing user. With Postgres present nothing changes (the lookup below still runs).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  removed: true,
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
vi.mock('@api/lib/postgres-present', () => ({ postgresRemovedOnThisWorker: () => h.removed }));
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

const { AuthService, GENERIC_RESEND_VERIFICATION_RESULT } =
  await import('@api/services/auth.service');
const { withUser } = await import('@ebda/database');

beforeEach(() => {
  h.forgot.mockClear();
  h.removed = true;
  h.user = null;
  vi.mocked(withUser).mockClear();
});

describe('merchant e-mail flows with no store on a Postgres-less Worker', () => {
  it('resend-verification is the generic success and never reads a user', async () => {
    h.user = { id: 'u1', email: 'm@example.com', emailVerified: false };
    const r = await AuthService.resendVerificationEmail('m@example.com', null);
    expect(r).toEqual(GENERIC_RESEND_VERIFICATION_RESULT);
    expect(withUser).not.toHaveBeenCalled();
  });

  it('forgot-password delegates to identity, returns null (a missing user answer) and never reads a user', async () => {
    const r = await AuthService.requestPasswordReset('m@example.com', null);
    expect(r).toBeNull();
    await new Promise(res => setTimeout(res, 0)); // the hand-over runs in cfWaitUntil, after the demo-owner guard (B1-13)
    expect(h.forgot).toHaveBeenCalledWith('m@example.com');
    expect(withUser).not.toHaveBeenCalled();
  });

  it('an identity failure is swallowed (enumeration-safe), not thrown', async () => {
    h.forgot.mockRejectedValueOnce(new Error('identity down'));
    await expect(AuthService.requestPasswordReset('m@example.com', null)).resolves.toBeNull();
  });

  it('with Postgres present the lookup path is unchanged', async () => {
    h.removed = false;
    h.user = null;
    await expect(AuthService.requestPasswordReset('m@example.com', null)).resolves.toBeNull();
    expect(h.forgot).not.toHaveBeenCalled();
  });
});
