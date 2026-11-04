import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ bound: true, verified: true as boolean | null }));
vi.mock('@ebda/database', () => ({
  withUser: () => {
    throw new Error('Postgres touched: withUser');
  },
}));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => (h.bound ? { ACCOUNTS: {} } : undefined) }));
vi.mock('@api/lib/identity-client', () => ({
  getAccountState: async () => (h.verified === null ? null : { emailVerified: h.verified }),
}));

import { requireVerifiedEmail } from '@api/middleware/require-verified-email';

const run = async (role = 'store_admin') => {
  let err: unknown;
  let passed = false;
  await requireVerifiedEmail(
    { user: { userId: 'u1', role } } as never,
    {} as never,
    (e?: unknown) => {
      err = e;
      passed = e === undefined;
    }
  );
  return { err: err as { code?: string } | undefined, passed };
};

describe('requireVerifiedEmail with the identity service bound', () => {
  it('reads the verified flag from the identity service, never Postgres', async () => {
    h.verified = true;
    expect((await run()).passed).toBe(true);
    h.verified = false;
    expect((await run()).err?.code).toBe('EMAIL_NOT_VERIFIED');
    h.verified = null; // no account record = deleted
    expect((await run()).err?.code).toBe('EMAIL_NOT_VERIFIED');
  });
  it('super admins are exempt', async () => {
    h.verified = false;
    expect((await run('super_admin')).passed).toBe(true);
  });
});
