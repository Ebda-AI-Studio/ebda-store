/**
 * The Store's profile row is reconciled from the identity service at sign-in and never re-created from a deleted or inactive
 * identity (a Store-side deletion removes the identity first, so a still-valid token cannot resurrect the row).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccountState } from '../../apps/api/src/cf/bindings';

const db = vi.hoisted(() => ({
  existing: null as null | { id: string },
  creates: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));
vi.mock('@ebda/database', () => ({
  withUser: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      user: {
        findUnique: async () => db.existing,
        create: async (a: { data: Record<string, unknown> }) => (db.creates.push(a.data), {}),
        update: async (a: { data: Record<string, unknown> }) => (db.updates.push(a.data), {}),
      },
    }),
}));
const st = vi.hoisted(() => ({ value: null as null | { storeId: string | null; role: string } }));
vi.mock('../../apps/api/src/lib/definer', () => ({ getUserState: async () => st.value }));

import { reconcileShadowUser } from '../../apps/api/src/services/identity-shadow';
import {
  configureIdentityClient,
  isIdentityManagedUser,
  revokeIdentityIfManaged,
} from '../../apps/api/src/lib/identity-client';

const U = '3f2b6c1e-9d4a-4c1e-8b7a-0a1b2c3d4e5f';
const state = (over: Partial<AccountState> = {}): AccountState => ({
  id: U,
  email: 'm@example.com',
  emailVerified: true,
  mfaEnabled: false,
  mfaEnrolledAt: null,
  status: 'active',
  role: 'store_admin',
  firstName: 'M',
  lastName: 'E',
  phone: null,
  language: 'ar',
  ...over,
});
let accountState: AccountState | null = state();

beforeEach(() => {
  st.value = null;
  db.existing = null;
  db.creates.length = 0;
  db.updates.length = 0;
  accountState = state();
  configureIdentityClient({ getAccountState: async () => accountState });
});

describe('reconcileShadowUser', () => {
  it('creates the profile row (unusable credential) from a live identity, and updates it afterwards', async () => {
    await reconcileShadowUser(U);
    expect(db.creates).toHaveLength(1);
    expect(db.creates[0]).toMatchObject({
      id: U,
      storeId: null,
      passwordHash: '!identity',
      emailVerified: true,
      role: 'store_admin',
    });
    db.existing = { id: U };
    accountState = state({ mfaEnabled: true, emailVerified: true });
    await reconcileShadowUser(U);
    expect(db.updates[0]).toMatchObject({ mfaEnabled: true, emailVerified: true });
    expect(db.updates[0]).not.toHaveProperty('passwordHash');
  });

  it('a deleted identity (null) never creates a row: 401', async () => {
    accountState = null;
    await expect(reconcileShadowUser(U)).rejects.toMatchObject({ statusCode: 401 });
    expect(db.creates).toHaveLength(0);
  });

  it.each(['inactive', 'suspended'] as const)(
    'a %s identity never creates or updates a row: 401',
    async status => {
      accountState = state({ status });
      await expect(reconcileShadowUser(U)).rejects.toMatchObject({ statusCode: 401 });
      expect(db.creates).toHaveLength(0);
      expect(db.updates).toHaveLength(0);
    }
  );

  it('an unreachable identity service is a 503, not a silent skip', async () => {
    configureIdentityClient({
      getAccountState: async () => {
        throw new Error('down');
      },
    });
    await expect(reconcileShadowUser(U)).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('identity-managed users', () => {
  it('a merchant/staff/super-admin revocation reaches the identity service, and a failure there is loud', async () => {
    st.value = { storeId: null, role: 'store_admin' };
    const revoke = vi.fn(async () => undefined);
    configureIdentityClient({ revokeUser: revoke });
    await revokeIdentityIfManaged(U, 'password_changed');
    expect(revoke).toHaveBeenCalledWith(U, 'password_changed');
    configureIdentityClient({
      revokeUser: async () => {
        throw new Error('down');
      },
    });
    await expect(revokeIdentityIfManaged(U, 'x')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('a store customer is never sent to the identity service', async () => {
    st.value = { storeId: 'store-1', role: 'customer' };
    const revoke = vi.fn(async () => undefined);
    configureIdentityClient({ revokeUser: revoke });
    await revokeIdentityIfManaged(U, 'x');
    expect(revoke).not.toHaveBeenCalled();
  });

  it('customers are not identity-managed; a missing user is not either', async () => {
    expect(await isIdentityManagedUser(U)).toBe(false);
    const revoke = vi.fn(async () => undefined);
    configureIdentityClient({ revokeUser: revoke });
    await revokeIdentityIfManaged(U, 'x');
    expect(revoke).not.toHaveBeenCalled();
  });
});
