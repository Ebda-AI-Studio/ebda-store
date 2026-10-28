/** Credential management and legacy sign-in are closed for identity-managed accounts (Rulings ID-1/ID-2). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const st = vi.hoisted(() => ({ value: null as null | { storeId: string | null; role: string } }));
vi.mock('../../apps/api/src/lib/definer', () => ({ getUserState: async () => st.value }));
vi.mock('../../apps/api/src/services/redis.service', () => ({ redis: {} }));
vi.mock('@ebda/database', () => ({ prisma: {} }));

const { rejectIdentityManaged } = await import('../../apps/api/src/middleware/auth');

async function run(user?: { userId: string; role: string }) {
  const next = vi.fn();
  await rejectIdentityManaged({ user } as unknown as Request, {} as Response, next);
  return next.mock.calls[0]?.[0] as { statusCode?: number; code?: string } | undefined;
}

beforeEach(() => {
  st.value = null;
});

describe('rejectIdentityManaged', () => {
  it.each(['store_admin', 'staff', 'super_admin'])(
    'refuses a %s whose account lives in the identity service (409)',
    async role => {
      st.value = { storeId: null, role };
      expect(await run({ userId: 'u', role })).toMatchObject({
        statusCode: 409,
        code: 'USE_IDENTITY_SERVICE',
      });
    }
  );

  it('lets a store customer through', async () => {
    st.value = { storeId: 'store-1', role: 'customer' };
    expect(await run({ userId: 'u', role: 'customer' })).toBeUndefined();
  });

  it('does not even look at the database for a customer token', async () => {
    st.value = { storeId: null, role: 'store_admin' }; // would refuse if consulted
    expect(await run({ userId: 'u', role: 'customer' })).toBeUndefined();
  });

  it('is a no-op without a user (mount it after authenticate)', async () => {
    expect(await run(undefined)).toBeUndefined();
  });
});
