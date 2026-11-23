/**
 * Seats and invitations (Ruling ID-13): pending invitations that no longer fit the plan expire on a downgrade.
 * The seat check's atomicity with the insert is a platform-D1 batch now (access-d1.ts `addStaffWithinCap` /
 * `acceptInviteWithinCap`), proven by tests/unit/access-d1.test.ts ("two simultaneous adds cannot both take the last seat",
 * "accept with the seats full leaves the invitation PENDING"); the row-lock variant of this file was the removed arm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  limit: 1 as number | null,
  staff: 0,
  pending: [] as Array<{ id: string; createdAt: number }>,
  expired: [] as string[],
}));

const tx = {
  storeStaff: { count: async () => h.staff },
  staffInvite: {
    findMany: async () =>
      [...h.pending].sort((a, b) => a.createdAt - b.createdAt).map(p => ({ id: p.id })),
    updateMany: async ({ where }: any) => {
      h.expired.push(...where.id.in);
      return { count: where.id.in.length };
    },
  },
};

vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: {},
  withStore: async (_s: string, fn: any) => fn(tx),
  withUser: async (_u: string, fn: any) => fn(tx),
}));
vi.mock('@api/services/plan-entitlements', () => ({
  getEntitlements: async () => ({ limits: { maxStaff: h.limit }, planCode: 'growth' }),
  parseLimits: vi.fn(),
}));
vi.mock('@api/services/socket.service', () => ({ socketService: {} }));
vi.mock('@api/services/email.service', () => ({ EmailService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { expireInvitesBeyondSeats } = await import('@api/services/staff-invite.service');

beforeEach(() => {
  h.limit = 1;
  h.staff = 0;
  h.pending = [];
  h.expired = [];
});

describe('downgrade expires pending invitations that no longer fit', () => {
  it('keeps the oldest invites that fit the free seats and expires the rest', async () => {
    h.limit = 2;
    h.staff = 1; // one seat free
    h.pending = [
      { id: 'newest', createdAt: 3 },
      { id: 'oldest', createdAt: 1 },
      { id: 'middle', createdAt: 2 },
    ];
    expect(await expireInvitesBeyondSeats('s1')).toBe(2);
    expect(h.expired.sort()).toEqual(['middle', 'newest']);
  });

  it('a plan with no free seats expires every pending invite', async () => {
    h.limit = 1;
    h.staff = 1;
    h.pending = [{ id: 'a', createdAt: 1 }];
    await expireInvitesBeyondSeats('s1');
    expect(h.expired).toEqual(['a']);
  });

  it('an unlimited plan expires nothing', async () => {
    h.limit = null;
    h.pending = [{ id: 'a', createdAt: 1 }];
    expect(await expireInvitesBeyondSeats('s1')).toBe(0);
    expect(h.expired).toEqual([]);
  });
});
