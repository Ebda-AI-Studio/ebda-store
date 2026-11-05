/**
 * SEC-CUSTOMER-SCOPE-1 - loyalty routes' customerId is a global users.id; it must be a customer of THIS store.
 *
 * Behavioural fake: an in-memory `users` + `loyaltyPoints` that evaluates the same `where` shapes the service sends, so a
 * missing membership check shows up as a created row / a leaked member, not as an assertion on a mock call.
 * `users` lives in Postgres for every store (DO-backed ones too), so one backend-independent check covers both paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const CUST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RANDOM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type U = { id: string; storeId: string | null; role: string };
type LP = {
  id: string;
  storeId: string;
  customerId: string;
  points: number;
  totalEarned: number;
  tier: string;
};

const db = vi.hoisted(() => ({
  users: [] as U[],
  lp: [] as LP[],
  tx: [] as unknown[],
  scoped: null as string | null, // store the RLS GUC is set to (null = no ambient scope)
}));

const h = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
}));

vi.mock('@ebda/database', () => {
  const matchUser = (u: U, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => (u as unknown as Record<string, unknown>)[k] === v);
  const prisma = {
    user: {
      // users is under RLS: no rows unless the store scope matches users.store_id.
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        db.users.find(u => db.scoped !== null && u.storeId === db.scoped && matchUser(u, where)) ??
        null,
    },
    loyaltyPoints: {
      findUnique: async ({
        where: {
          storeId_customerId: { storeId, customerId },
        },
      }: any) => db.lp.find(r => r.storeId === storeId && r.customerId === customerId) ?? null,
      create: async ({ data }: { data: Omit<LP, 'id'> }) => {
        const row = { id: `lp${db.lp.length + 1}`, totalEarned: 0, ...data } as LP;
        db.lp.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = db.lp.find(r => r.id === where.id)!;
        row.points += data.points.increment;
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = db.lp.find(r => r.id === where.id && r.points >= where.points.gte);
        if (row) row.points += data.points.increment;
        return { count: row ? 1 : 0 };
      },
      findUniqueOrThrow: async ({ where }: any) => db.lp.find(r => r.id === where.id)!,
      findMany: async ({ where }: { where: any }) =>
        db.lp
          .filter(r => r.storeId === where.storeId)
          .filter(r => {
            if (!where.customer) return true;
            const u = db.users.find(x => x.id === r.customerId);
            return !!u && matchUser(u, where.customer);
          })
          .map(r => ({ ...r, customer: { id: r.customerId, email: `${r.customerId}@x.test` } })),
      count: async () => 0,
    },
    loyaltyTransaction: { create: async (a: unknown) => ({ tx: a }) },
    $transaction: async (ops: any) => {
      // interactive form (BE: negative awards are conditional): run the callback with this same client
      if (typeof ops === 'function') {
        const r = await ops(prisma);
        db.tx.push([r]);
        return r;
      }
      db.tx.push(ops);
      return Promise.all(ops);
    },
  };
  return {
    prisma,
    Prisma: {},
    LoyaltyTransactionType: {},
    withMoneyTx: vi.fn(),
    withStore: async (s: string, fn: (tx: any) => unknown) => {
      const prev = db.scoped;
      db.scoped = s; // reuses/opens the store scope like the real withStore
      try {
        return await fn({
          ...prisma,
          store: { findUnique: async () => ({ loyaltySettings: {} }) },
        });
      } finally {
        db.scoped = prev;
      }
    },
  };
});
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: h.isFeatureEnabled },
}));
vi.mock('@api/lib/repo-factory', () => ({ storeMoney: vi.fn(), storeUpdate: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { LoyaltyService } from '@api/services/loyalty.service';
import { assertStoreCustomer } from '@api/lib/store-customer';

beforeEach(() => {
  db.users = [
    { id: CUST_A, storeId: STORE_A, role: 'customer' },
    { id: CUST_B, storeId: STORE_B, role: 'customer' },
    { id: STAFF, storeId: null, role: 'store_admin' },
  ];
  db.lp = [];
  db.tx = [];
  h.isFeatureEnabled.mockResolvedValue(true);
});

describe('assertStoreCustomer', () => {
  it('resolves with NO ambient store scope (job/webhook caller) by opening the scope itself', async () => {
    expect(db.scoped).toBeNull();
    await expect(assertStoreCustomer(STORE_A, CUST_A)).resolves.toBeUndefined();
    expect(db.scoped).toBeNull();
  });

  it('passes for a customer of the store', async () => {
    await expect(assertStoreCustomer(STORE_A, CUST_A)).resolves.toBeUndefined();
  });
  it.each([
    ['another store customer', CUST_B],
    ['an admin/staff account', STAFF],
    ['a random uuid', RANDOM],
  ])('404 CUSTOMER_NOT_FOUND for %s', async (_n, id) => {
    await expect(assertStoreCustomer(STORE_A, id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'CUSTOMER_NOT_FOUND',
    });
  });
});

describe('LoyaltyService.awardBonusPoints', () => {
  it('awards a real customer of the store', async () => {
    const r = await LoyaltyService.awardBonusPoints(STORE_A, CUST_A, 5, 'earn_manual' as any);
    expect(r.newBalance).toBe(5);
    expect(db.lp).toHaveLength(1);
  });

  it.each([
    ['a customer of store B', CUST_B],
    ['a staff account', STAFF],
    ['a random user uuid', RANDOM],
  ])('store A admin awarding %s gets 404 and NO row is created', async (_n, id) => {
    await expect(
      LoyaltyService.awardBonusPoints(STORE_A, id, 1, 'earn_manual' as any)
    ).rejects.toMatchObject({ statusCode: 404, code: 'CUSTOMER_NOT_FOUND' });
    expect(db.lp).toHaveLength(0);
    expect(db.tx).toHaveLength(0);
  });

  it('initializeCustomerPoints refuses a foreign user too', async () => {
    await expect(
      LoyaltyService.initializeCustomerPoints(STORE_A, CUST_B, true)
    ).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_FOUND',
    });
    expect(db.lp).toHaveLength(0);
  });
});

describe('LoyaltyService.listMembers', () => {
  it('never lists a user who is not this store customer, even with a pre-existing stray row', async () => {
    // Rows an exploit of the old award route would have left behind under store A.
    db.lp = [
      { id: 'r1', storeId: STORE_A, customerId: CUST_A, points: 1, totalEarned: 1, tier: 'bronze' },
      { id: 'r2', storeId: STORE_A, customerId: CUST_B, points: 1, totalEarned: 1, tier: 'bronze' },
      { id: 'r3', storeId: STORE_A, customerId: RANDOM, points: 1, totalEarned: 1, tier: 'bronze' },
    ];
    const { members } = await LoyaltyService.listMembers(STORE_A);
    expect(members.map((m: any) => m.customerId)).toEqual([CUST_A]);
  });
});

describe('LoyaltyService.awardBonusPoints deductions never go below zero (Postgres path)', () => {
  it('refuses a deduction larger than the balance with 409 INSUFFICIENT_POINTS and bilingual details', async () => {
    await LoyaltyService.awardBonusPoints(STORE_A, CUST_A, 5, 'earn_manual' as any);
    await expect(
      LoyaltyService.awardBonusPoints(STORE_A, CUST_A, -6, 'adjust' as any)
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_POINTS',
      details: { messageAr: expect.any(String), messageEn: expect.any(String) },
    });
    expect(db.lp[0].points).toBe(5);
    const r = await LoyaltyService.awardBonusPoints(STORE_A, CUST_A, -5, 'adjust' as any);
    expect(r.newBalance).toBe(0);
  });
});
