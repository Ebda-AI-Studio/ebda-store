/**
 * Ruling B1-13 on the Worker (NZ-DEMO-OWNER-1). On a Postgres-less Worker the demo showroom's seeded owner (no mailbox) must
 * never be handed to the identity service for a reset code or a verification code: it would mail a dead address on demand.
 * The guard is identity (address -> account id) + platform D1 (`stores.owner_id` with `is_demo = 1`). A merchant who owns
 * no demo store is still handed over (the skip is demo-specific), and a lookup failure never blocks a real reset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  ids: new Map<string, string>(),
  demoOwners: new Set<string>(),
  d1: true,
  idLookup: null as null | ((e: string) => Promise<string | null>),
  forgot: vi.fn(async (_e: string) => {}),
  resend: vi.fn(async (_e: string) => {}),
  pending: [] as Promise<unknown>[],
}));

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  currentStoreId: vi.fn(),
  hasTenantContext: vi.fn(() => false),
  runInTenantContext: vi.fn(),
  withStore: vi.fn(),
  withUser: vi.fn(),
}));
vi.mock('@api/lib/definer', () => ({
  findUserIdByEmail: async () => null,
  deleteUserAddresses: vi.fn(),
  deleteUserPasskeys: vi.fn(),
  deleteUserTokens: vi.fn(),
  getUserState: vi.fn(),
  purgeRefreshTokens: vi.fn(),
  refreshTokenUser: vi.fn(),
  revokeUserSessionsRow: vi.fn(),
  verificationTokenUser: vi.fn(),
}));
vi.mock('@api/lib/postgres-present', () => ({ postgresRemovedOnThisWorker: () => true }));
vi.mock('@api/lib/platform-directory', () => ({
  platformDb: () =>
    h.d1
      ? {
          prepare: (sql: string) => ({
            bind: (ownerId: string) => ({
              first: async () => {
                expect(sql).toMatch(/is_demo = 1/);
                return h.demoOwners.has(ownerId) ? { yes: 1 } : null;
              },
            }),
          }),
        }
      : undefined,
}));
vi.mock('@api/lib/identity-client', () => ({
  forgotIdentityPassword: (e: string) => h.forgot(e),
  resendIdentityVerification: (e: string) => h.resend(e),
  identityAccountIdByEmail: (e: string) =>
    h.idLookup ? h.idLookup(e) : Promise.resolve(h.ids.get(e) ?? null),
  revokeIdentityIfManaged: vi.fn(),
}));
vi.mock('@api/cf/bindings', () => ({
  cfWaitUntil: (p: Promise<unknown>) => void h.pending.push(p),
}));
vi.mock('bcryptjs', () => ({ default: { hash: async () => 'hash', compare: async () => false } }));
vi.mock('@api/services/platform-mailer', () => ({
  sendMerchantPasswordResetEmail: vi.fn(),
  sendMerchantVerificationEmail: vi.fn(),
  sendMerchantDuplicateSignupNotice: vi.fn(),
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
const { MerchantSignupService } = await import('@api/services/merchant-signup.service');

const DEMO = 'storedemo-owner@ebda.app';
const SHOP = 'merchant@example.com';
const settle = () => Promise.allSettled(h.pending.splice(0));

beforeEach(() => {
  h.ids = new Map([
    [DEMO, 'u-demo'],
    [SHOP, 'u-shop'],
  ]);
  h.demoOwners = new Set(['u-demo']);
  h.d1 = true;
  h.idLookup = null;
  h.forgot.mockClear();
  h.resend.mockClear();
  h.pending.length = 0;
});

describe('demo owner is never mailed on the Worker', () => {
  it('forgot-password: the demo owner is never handed to identity, and answers like a missing user', async () => {
    await expect(AuthService.requestPasswordReset(DEMO, null)).resolves.toBeNull();
    await settle();
    expect(h.forgot).not.toHaveBeenCalled();
  });

  it('forgot-password: a merchant who owns no demo store IS handed over (the skip is demo-specific)', async () => {
    await AuthService.requestPasswordReset(SHOP, null);
    await settle();
    expect(h.forgot).toHaveBeenCalledWith(SHOP);
  });

  it('forgot-password: an unknown address is still handed over (identity answers generically)', async () => {
    await AuthService.requestPasswordReset('nobody@example.com', null);
    await settle();
    expect(h.forgot).toHaveBeenCalledWith('nobody@example.com');
  });

  it('forgot-password: a failing guard lookup never blocks a real reset (warn, hand over)', async () => {
    h.idLookup = async () => {
      throw new Error('identity down');
    };
    await AuthService.requestPasswordReset(SHOP, null);
    await settle();
    expect(h.forgot).toHaveBeenCalledWith(SHOP);
  });

  it('forgot-password: the check is deferred, so the response does not wait on it', async () => {
    let release!: () => void;
    h.idLookup = () => new Promise(r => (release = () => r(null)));
    await expect(AuthService.requestPasswordReset(SHOP, null)).resolves.toBeNull();
    expect(h.forgot).not.toHaveBeenCalled();
    release();
    await settle();
    expect(h.forgot).toHaveBeenCalledWith(SHOP);
  });

  it('resend-verification (auth route): never reaches identity for a store-less address, demo owner included', async () => {
    await expect(AuthService.resendVerificationEmail(DEMO, null)).resolves.toEqual(
      GENERIC_RESEND_VERIFICATION_RESULT
    );
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('resend-verification (merchant signup): the demo owner is never handed to identity; a merchant is', async () => {
    const demo = await MerchantSignupService.resendVerification(DEMO);
    const unknown = await MerchantSignupService.resendVerification('nobody@example.com');
    expect(demo).toEqual(unknown);
    expect(h.resend).not.toHaveBeenCalledWith(DEMO);
    await MerchantSignupService.resendVerification(SHOP);
    expect(h.resend).toHaveBeenCalledWith(SHOP);
  });

  it('no platform D1 (Node / tests): the guard stands aside, the Postgres ownsDemoStore path owns it', async () => {
    h.d1 = false;
    await AuthService.requestPasswordReset(DEMO, null);
    await settle();
    expect(h.forgot).toHaveBeenCalledWith(DEMO);
  });
});
