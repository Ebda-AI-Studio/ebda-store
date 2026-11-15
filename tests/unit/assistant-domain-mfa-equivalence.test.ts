/**
 * The custom-domain route is guarded by `requireMfaEnrolled`; the assistant's domain tools have no MFA step. That is equivalent, not a gap:
 * the middleware enforces MFA only for super_admin and lets every other role through, and `runAsMerchant` refuses super_admin outright.
 */
import { describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({ withUser: vi.fn(), getAccountState: vi.fn() }));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));
vi.mock('@api/lib/identity-client', () => ({ getAccountState: m.getAccountState }));
vi.mock('@api/middleware/auth', () => ({ liveIdentityMemo: () => ({ value: undefined }) }));
vi.mock('@ebda/database', () => ({ withUser: m.withUser }));

import type { Request, Response } from 'express';
import { requireMfaEnrolled } from '@api/middleware/require-mfa';
import { MerchantForbidden, assertMerchantMay } from '@api/mcp/run-as-merchant';

const run = async (role: string) => {
  const next = vi.fn();
  await requireMfaEnrolled(
    { user: { role, userId: 'u1' } } as unknown as Request,
    {} as Response,
    next
  );
  return next;
};

describe('requireMfaEnrolled vs the assistant', () => {
  it('lets a store_admin WITHOUT MFA through (so the route has no step-up the tool lacks), reading nothing', async () => {
    m.withUser.mockResolvedValue({ mfaEnabled: false });
    const next = await run('store_admin');
    expect(next).toHaveBeenCalledWith(); // no error argument
    expect(m.withUser).not.toHaveBeenCalled();
    expect(m.getAccountState).not.toHaveBeenCalled();
  });
  it('enforces only for super_admin, and the assistant gate refuses a super_admin before any tool runs', async () => {
    m.withUser.mockResolvedValue({ mfaEnabled: false });
    const next = await run('super_admin');
    expect(next.mock.calls[0]![0]).toMatchObject({ code: 'MFA_SETUP_REQUIRED' });
    await expect(
      assertMerchantMay({
        storeId: 's1',
        userId: 'u1',
        role: 'super_admin',
        tool: 'domain_connect',
        roles: ['store_admin'],
      })
    ).rejects.toBeInstanceOf(MerchantForbidden);
  });
});
