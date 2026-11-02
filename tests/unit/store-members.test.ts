/**
 * Store membership for Ebda Chat (Ruling WA-PRICE-1a, identity contract v1.4): the Store owns membership (Store.ownerId and
 * StoreStaff), so the read lives on the Store worker (`WhatsAppBridge`), authorised by the CALLING USER at call time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const U1 = '11111111-1111-4111-8111-111111111111'; // owner of S1
const U2 = '22222222-2222-4222-8222-222222222222'; // staff of S1
const U3 = '33333333-3333-4333-8333-333333333333'; // suspended staff of S1
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const h = vi.hoisted(() => ({
  memberships: new Map<string, Array<{ id: string; role: 'owner' | 'staff' }>>(),
  staff: [] as Array<{
    userId: string;
    createdAt: Date;
    user: { firstName: string; lastName: string; status: string };
  }>,
  owner: { firstName: 'Omar', lastName: 'Owner', status: 'active' },
  down: false,
  scopes: [] as string[],
}));

vi.mock('@ebda/database', () => ({
  withStore: async (storeId: string, fn: (tx: unknown) => unknown) => {
    h.scopes.push(`store:${storeId}`);
    return fn({
      storeStaff: { findMany: async () => h.staff },
      store: { findUnique: async () => ({ createdAt: new Date('2026-01-01T00:00:00Z') }) },
    });
  },
  withUser: async (userId: string, fn: (tx: unknown) => unknown) => {
    h.scopes.push(`user:${userId}`);
    return fn({ user: { findUnique: async () => h.owner } });
  },
}));
vi.mock('../../apps/api/src/lib/identity-directory', () => ({
  storesForUser: async (userId: string) => {
    if (h.down) throw new Error('db down');
    return h.memberships.get(userId) ?? [];
  },
}));

const { listStoreMembers, memberRole } = await import('../../apps/api/src/lib/store-members');

beforeEach(() => {
  h.memberships = new Map([
    [U1, [{ id: S1, role: 'owner' }]],
    [U2, [{ id: S1, role: 'staff' }]],
  ]);
  h.staff = [
    {
      userId: U2,
      createdAt: new Date('2026-02-01T00:00:00Z'),
      user: { firstName: 'Sara', lastName: 'Staff', status: 'active' },
    },
    {
      userId: U3,
      createdAt: new Date('2026-03-01T00:00:00Z'),
      user: { firstName: 'Sam', lastName: 'Suspended', status: 'suspended' },
    },
  ];
  h.down = false;
  h.scopes = [];
});

describe('listStoreMembers', () => {
  it('lists the owner and the ACTIVE staff with a display name, role and addedAt, and nothing else', async () => {
    const r = await listStoreMembers(S1, U1);
    expect(r).toEqual({
      items: [
        {
          userId: U1,
          displayName: 'Omar Owner',
          role: 'owner',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          userId: U2,
          displayName: 'Sara Staff',
          role: 'staff',
          addedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(r)).not.toMatch(/email|phone|password|U3|Suspended/i);
  });

  it('only the OWNER of that store may list it: staff, another store owner and strangers are refused', async () => {
    await expect(listStoreMembers(S1, U2)).rejects.toThrow('FORBIDDEN');
    await expect(listStoreMembers(S2, U1)).rejects.toThrow('FORBIDDEN');
    await expect(listStoreMembers(S1, '44444444-4444-4444-8444-444444444444')).rejects.toThrow(
      'FORBIDDEN'
    );
    expect(h.scopes).toEqual([]); // nothing was read for a refused caller
  });

  it('reads the membership at call time (an owner who lost the store is refused at once)', async () => {
    expect((await listStoreMembers(S1, U1)).items).toHaveLength(2);
    h.memberships.set(U1, []);
    await expect(listStoreMembers(S1, U1)).rejects.toThrow('FORBIDDEN');
  });

  it('rejects malformed ids without touching the database and fails closed when the database is down', async () => {
    await expect(listStoreMembers('nope', U1)).rejects.toThrow('INVALID_ID');
    await expect(listStoreMembers(S1, 'nope')).rejects.toThrow('INVALID_ID');
    h.down = true;
    await expect(listStoreMembers(S1, U1)).rejects.toThrow();
  });
});

describe('memberRole (v1.4 revocation: re-checked on each staff request, never cached here)', () => {
  it('answers the live role and null once the person was removed', async () => {
    expect(await memberRole(S1, U1)).toBe('owner');
    expect(await memberRole(S1, U2)).toBe('staff');
    h.memberships.set(U2, []); // removed from the store
    expect(await memberRole(S1, U2)).toBeNull();
    expect(await memberRole(S2, U1)).toBeNull();
  });

  it('refuses malformed ids and fails closed (throws) when the database is down, never answering null', async () => {
    await expect(memberRole('nope', U1)).rejects.toThrow('INVALID_ID');
    h.down = true;
    await expect(memberRole(S1, U1)).rejects.toThrow();
  });
});
