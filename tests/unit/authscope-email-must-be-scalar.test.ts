/**
 * P1-1, second layer — the SINK guard in `auth.service.ts`'s `authScope`.
 *
 * The primary fix is the Zod parse on the two unvalidated routes
 * (`tests/unit/auth-email-enumeration-oracle.test.ts`). This file guards the
 * other half: `authScope(email, storeId)` puts `email` at the top level of a
 * Prisma `where`, where Prisma accepts a StringFilter OBJECT. A FUTURE caller
 * that forgets to validate must not be able to reopen the oracle, so the
 * scalar-ness is asserted at the sink itself, not only at the two known edges.
 *
 * `authScope` is module-private, so it is exercised through the two callers
 * that used to be reachable with an unvalidated value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUserFindFirst = vi.fn();

vi.mock('@force/database', () => ({
  prisma: {
    user: { findFirst: (...a: unknown[]) => mockUserFindFirst(...a) },
    refreshToken: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    store: { findUnique: vi.fn() },
  },
  Prisma: {},
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: { sendPasswordReset: vi.fn(), sendVerificationEmail: vi.fn() },
}));

vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { AuthService } from '@api/services/auth.service';

describe('authScope — email must be a scalar, never a Prisma filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindFirst.mockResolvedValue(null);
  });

  it('rejects a filter object in requestPasswordReset before any DB read', async () => {
    await expect(
      AuthService.requestPasswordReset({ not: 'zzz' } as unknown as string, null)
    ).rejects.toThrow();
    expect(mockUserFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a filter object in resendVerificationEmail before any DB read', async () => {
    await expect(
      AuthService.resendVerificationEmail({ startsWith: 'a' } as unknown as string, null)
    ).rejects.toThrow();
    expect(mockUserFindFirst).not.toHaveBeenCalled();
  });

  it('still passes a plain string straight through to the where clause', async () => {
    await AuthService.requestPasswordReset('real@example.test', 'store-1');
    expect(mockUserFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'real@example.test', storeId: 'store-1' },
      })
    );
  });

  it('keeps the admin (storeId null) scope shape unchanged', async () => {
    await AuthService.requestPasswordReset('admin@example.test', null);
    expect(mockUserFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'admin@example.test', storeId: null } })
    );
  });
});
