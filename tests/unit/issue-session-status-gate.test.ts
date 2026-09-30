/**
 * #1864 — `issueSessionFor` is the session-mint chokepoint for BOTH login()
 * and /auth/mfa/verify. login() gates on status before it hands out an MFA
 * challenge, but the verify step re-reads the row up to 5 minutes later: an
 * account suspended in between used to get a full session stamped with the
 * already-bumped token version, which the authenticate middleware accepts.
 * The gate now lives in issueSessionFor itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn(async () => ({ id: 'rt-1' })) }));

vi.mock('@force/database', () => ({
  prisma: { refreshToken: { create: mockCreate } },
  Prisma: {},
}));
vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: vi.fn().mockReturnValue(false), getClient: vi.fn() },
}));

const { AuthService } = await import('@api/services/auth.service');

const base = {
  id: 'user-1',
  email: 'admin@example.com',
  storeId: null,
  firstName: 'A',
  lastName: 'B',
  role: 'super_admin',
  emailVerified: true,
  tokenVersion: 3,
  status: 'active',
  deletedAt: null as Date | null,
};

beforeEach(() => mockCreate.mockClear());

describe('issueSessionFor refuses a non-active account', () => {
  it.each(['suspended', 'inactive'])('rejects status=%s without minting anything', async status => {
    await expect(AuthService.issueSessionFor({ ...base, status })).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCOUNT_SUSPENDED',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a soft-deleted account', async () => {
    await expect(
      AuthService.issueSessionFor({ ...base, deletedAt: new Date() })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('control: an active account still gets a session', async () => {
    const s = await AuthService.issueSessionFor(base);
    expect(typeof s.accessToken).toBe('string');
    expect(typeof s.refreshToken).toBe('string');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
