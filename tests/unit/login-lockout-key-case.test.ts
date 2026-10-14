/**
 * Ebda SP5 review: the login lockout counter must not be resettable by
 * re-casing the address. `Victim@X.com`, `VICTIM@x.com` and ` victim@x.com `
 * share ONE lockout key, per tenant.
 *
 * Revert the case-fold in `AuthService.login` and this goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isLocked } = vi.hoisted(() => ({
  isLocked: vi.fn().mockResolvedValue({ locked: true, remainingMs: 60_000 }),
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/account-lockout.service', () => ({
  accountLockout: {
    isLocked,
    recordFailedAttempt: vi.fn(),
    recordSuccessfulLogin: vi.fn(),
    clearAttempts: vi.fn(),
  },
}));
vi.mock('@api/services/redis.service', () => ({ redis: {} }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@ebda/database', () => ({
  prisma: { user: { findFirst: vi.fn().mockResolvedValue(null) } },
  Prisma: {},
  hasTenantContext: () => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRlsBypass: (fn: any) => fn({}),
}));

import { AuthService } from '@api/services/auth.service';

const STORE_ID = '11111111-1111-1111-1111-111111111111';

async function lockoutKeyFor(email: string, storeId: string | null): Promise<string> {
  isLocked.mockClear();
  await AuthService.login(email, 'wrong-password', '203.0.113.9', storeId).catch(() => undefined);
  expect(isLocked).toHaveBeenCalledTimes(1);
  return isLocked.mock.calls[0][0] as string;
}

describe('AuthService.login — lockout key is case-insensitive', () => {
  beforeEach(() => isLocked.mockClear());

  it('admin (no store): every casing of one address maps to one key', async () => {
    const keys: string[] = [];
    for (const e of ['Victim@X.com', 'VICTIM@x.COM', ' victim@x.com ']) {
      keys.push(await lockoutKeyFor(e, null));
    }
    expect(new Set(keys)).toEqual(new Set(['victim@x.com']));
  });

  it('storefront: the key stays tenant-scoped and case-folded', async () => {
    expect(await lockoutKeyFor('Victim@X.com', STORE_ID)).toBe(`${STORE_ID}:victim@x.com`);
  });
});
