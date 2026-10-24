/**
 * Seats and invitations (Ruling ID-13): the seat check is atomic with the insert (store row locked FOR UPDATE, count inside
 * the same transaction), and pending invitations that no longer fit the plan expire on a downgrade.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  limit: 1 as number | null,
  staff: 0,
  pending: [] as Array<{ id: string; createdAt: number }>,
  expired: [] as string[],
}));

const tx = {
  $queryRaw: async (strings: TemplateStringsArray) => {
    h.calls.push(strings.join('?').includes('FOR UPDATE') ? 'lock-store' : 'query');
    return [];
  },
  storeStaff: {
    count: async () => {
      h.calls.push('count');
      return h.staff;
    },
  },
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

const { assertWithinLimit } = await import('@api/services/plan-limit.service');
const { expireInvitesBeyondSeats } = await import('@api/services/staff-invite.service');

beforeEach(() => {
  h.calls = [];
  h.limit = 1;
  h.staff = 0;
  h.pending = [];
  h.expired = [];
});

describe('seat check is atomic with the insert', () => {
  it('with a transaction it locks the store row FIRST, then counts inside that same transaction', async () => {
    await assertWithinLimit('s1', 'maxStaff', { tx: tx as never });
    expect(h.calls).toEqual(['lock-store', 'count']);
  });

  it('the last seat taken (count already at the limit) is refused under the lock, so N racers cannot all pass', async () => {
    h.staff = 1; // what the second racer sees once the first has inserted and committed
    await expect(assertWithinLimit('s1', 'maxStaff', { tx: tx as never })).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });
  });

  it('without a transaction nothing is locked (the cheap pre-check)', async () => {
    await assertWithinLimit('s1', 'maxStaff');
    expect(h.calls).not.toContain('lock-store');
  });
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
