/**
 * S2-13 / Ruling BILL-NOTICE-1: nobody was told when an InstaPay grace period started, was about to end, or
 * ended. Each stage (grace_start, grace_d1, suspended) is claimed ONCE in `billing_reminders` before the notice
 * goes out, so a re-run / retry / second worker sends nothing twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 86_400_000;
const h = vi.hoisted(() => ({
  sub: null as Record<string, unknown> | null,
  claims: new Set<string>(),
  effects: [] as Array<Record<string, unknown>>,
}));

vi.mock('@api/lib/definer', () => ({ getEntityStoreId: async () => 's1' }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/billing/account.service', () => ({
  isBillableStoreId: async () => true,
  suspendForBilling: async () => true,
  assertPayableStore: vi.fn(),
}));
vi.mock('@api/services/billing/billing-notify', () => ({
  runBillingEffects: async (e: Array<Record<string, unknown>>) => {
    h.effects.push(...e);
  },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('@api/lib/repo-factory', () => ({ storeUpdate: vi.fn() }));

const tx = {
  storeSubscription: {
    findUnique: async () => h.sub,
    updateMany: async ({
      where,
      data,
    }: {
      where: { status?: string; nextRetryAt?: Date };
      data: Record<string, unknown>;
    }) => {
      const s = h.sub!;
      if (where.status && s.status !== where.status) return { count: 0 };
      if (where.nextRetryAt && s.nextRetryAt !== where.nextRetryAt) return { count: 0 };
      Object.assign(s, data);
      return { count: 1 };
    },
    // the lapse downgrade (MONEY-LAPSE-1 / #836)
    update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(h.sub!, data),
  },
  plan: { findUnique: async () => ({ code: 'free', featureTier: 'free' }) },
  billingReminder: {
    createMany: async ({
      data,
    }: {
      data: Array<{ subscriptionId: string; dueAt: Date; kind: string }>;
    }) => {
      const d = data[0]!;
      const key = `${d.subscriptionId}|${d.dueAt.toISOString()}|${d.kind}`;
      if (h.claims.has(key)) return { count: 0 };
      h.claims.add(key);
      return { count: 1 };
    },
  },
};
vi.mock('@ebda/database', () => ({
  prisma: { storeSubscription: { findMany: async () => [] } },
  withStore: async (_id: string, fn: (t: typeof tx) => unknown) => fn(tx),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
}));
vi.mock('@api/services/platform/billing-d1', () => ({ acrossBilling: async () => [] }));

import { renewSubscription } from '@api/services/billing/subscription-billing.service';
import { sendGraceEndingNotice } from '@api/services/billing/reminders.service';

const periodEnd = new Date('2026-11-01T00:00:00Z');
const baseSub = () => ({
  id: 'sub1',
  storeId: 's1',
  planCode: 'growth',
  status: 'active',
  billingMethod: 'instapay',
  currentPeriodEnd: periodEnd,
  nextRetryAt: null,
  cancelAtPeriodEnd: false,
  dunningAttempts: 0,
});

beforeEach(() => {
  h.sub = baseSub();
  h.claims.clear();
  h.effects.length = 0;
});

describe('grace-period notices (BILL-NOTICE-1)', () => {
  it('notifies once when the grace period starts, even if the job runs twice', async () => {
    const now = new Date(periodEnd.getTime() + 60_000);
    await renewSubscription('sub1', now);
    await renewSubscription('sub1', now);
    expect(h.effects.filter(e => e.kind === 'grace_started')).toHaveLength(1);
    expect(h.effects[0]).toMatchObject({
      kind: 'grace_started',
      storeId: 's1',
      suspendAt: new Date(periodEnd.getTime() + 3 * DAY),
    });
  });

  it('notifies once, one day before suspension', async () => {
    const suspendAt = new Date(periodEnd.getTime() + 3 * DAY);
    h.sub = { ...baseSub(), status: 'past_due', nextRetryAt: suspendAt };
    const now = new Date(suspendAt.getTime() - 12 * 3_600_000);
    await expect(sendGraceEndingNotice('sub1', now)).resolves.toMatchObject({ sent: true });
    await expect(sendGraceEndingNotice('sub1', now)).resolves.toEqual({
      sent: false,
      reason: 'already_sent',
    });
    expect(h.effects.filter(e => e.kind === 'grace_ending')).toHaveLength(1);
  });

  it('sends no one-day notice while more than a day of grace is left', async () => {
    const suspendAt = new Date(periodEnd.getTime() + 3 * DAY);
    h.sub = { ...baseSub(), status: 'past_due', nextRetryAt: suspendAt };
    const now = new Date(suspendAt.getTime() - 2 * DAY);
    await expect(sendGraceEndingNotice('sub1', now)).resolves.toEqual({
      sent: false,
      reason: 'no_window',
    });
    expect(h.effects).toHaveLength(0);
  });

  it('claims the suspension notice with the decision: one notice per suspension', async () => {
    const suspendAt = new Date(periodEnd.getTime() + 3 * DAY);
    h.sub = { ...baseSub(), status: 'past_due', nextRetryAt: suspendAt };
    const now = new Date(suspendAt.getTime() + 60_000);
    await renewSubscription('sub1', now);
    await renewSubscription('sub1', now);
    expect(h.effects.filter(e => e.kind === 'store_suspended' && e.applied === true)).toHaveLength(
      1
    );
    expect(h.claims.has(`sub1|${periodEnd.toISOString()}|suspended`)).toBe(true);
  });
});
