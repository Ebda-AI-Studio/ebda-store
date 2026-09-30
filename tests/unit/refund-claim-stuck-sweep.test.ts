/**
 * The stuck refund-claim check (#1317).
 *
 * PaymentService.refund commits a claim (`refund_initiated`) before calling the
 * provider and resolves it with `refund_completed` or `refund_failed`. A claim
 * with neither means the balance counts money that may never have left — a
 * process died mid-refund, or the provider never answered. Only an old,
 * unresolved claim may be raised; a resolved or still-running one must not.
 *
 * issue 2002: a merchant settling the claim (`refund_reconciled`) resolves it.
 * issue 2027: one claim is alerted once per escalation stage, not every tick.
 * issue 2028: the read is bounded — claims first (take + oldest-first), then
 * only those payments' resolutions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Ev = {
  id: string;
  eventType: string;
  paymentId: string;
  storeId: string;
  orderId: string;
  details: Record<string, unknown>;
  occurredAt: Date;
};

const h = vi.hoisted(() => ({
  events: [] as Ev[],
  locks: new Set<string>(),
  findMany: vi.fn(),
  sendAlert: vi.fn(),
}));

/** A fake that honours the `where` the sweep sends, so the query shape matters. */
h.findMany.mockImplementation(
  async (args: {
    where: {
      eventType: string | { in: string[] };
      occurredAt?: { gt?: Date; lt?: Date };
      paymentId?: { in: string[] };
    };
    take?: number;
    cursor?: { id: string };
    skip?: number;
  }) => {
    const w = args.where;
    let rows = h.events.filter(e =>
      typeof w.eventType === 'string'
        ? e.eventType === w.eventType
        : w.eventType.in.includes(e.eventType)
    );
    if (w.occurredAt?.gt) rows = rows.filter(e => e.occurredAt > w.occurredAt!.gt!);
    if (w.occurredAt?.lt) rows = rows.filter(e => e.occurredAt < w.occurredAt!.lt!);
    if (w.paymentId) rows = rows.filter(e => w.paymentId!.in.includes(e.paymentId));
    rows = [...rows].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id)
    );
    if (args.cursor) {
      const at = rows.findIndex(e => e.id === args.cursor!.id);
      rows = rows.slice(at + (args.skip ?? 0));
    }
    return args.take ? rows.slice(0, args.take) : rows;
  }
);

vi.mock('@force/database', () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) => fn({ paymentEvent: { findMany: h.findMany } }),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    acquireLock: async (name: string) => {
      if (h.locks.has(name)) return false;
      h.locks.add(name);
      return true;
    },
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleStuckRefundClaimSweep } from '@api/lib/inngest/functions/refund-claim-stuck-sweep';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

let seq = 0;
function event(eventType: string, claimId: string, at: Date, paymentId = 'pay-1'): Ev {
  seq += 1;
  return {
    id: `ev-${String(seq).padStart(6, '0')}`,
    eventType,
    paymentId,
    storeId: 'store-1',
    orderId: 'order-1',
    details: { claimId, amount: 2000, reason: 'x' },
    occurredAt: at,
  };
}

describe('handleStuckRefundClaimSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.events = [];
    h.locks.clear();
    h.sendAlert.mockResolvedValue('sent');
  });

  it('raises a claim that was never confirmed or released', async () => {
    h.events = [event('refund_initiated', 'c1', minutesAgo(60))];

    const res = await handleStuckRefundClaimSweep(stepStub);

    expect(res.stuck).toBe(1);
    expect(h.sendAlert).toHaveBeenCalledOnce();
    expect(h.sendAlert.mock.calls[0][0].source).toBe('payment.refund.claim_stuck');
  });

  it('an indeterminate outcome is still unresolved', async () => {
    h.events = [
      event('refund_initiated', 'c1', minutesAgo(60)),
      event('refund_indeterminate', 'c1', minutesAgo(59)),
    ];

    expect((await handleStuckRefundClaimSweep(stepStub)).stuck).toBe(1);
  });

  // issue 2002 — `refund_reconciled` is the merchant's terminal state.
  it.each(['refund_completed', 'refund_failed', 'refund_reconciled'])(
    'a claim resolved by %s is not raised',
    async t => {
      h.events = [event('refund_initiated', 'c1', minutesAgo(60)), event(t, 'c1', minutesAgo(59))];

      const res = await handleStuckRefundClaimSweep(stepStub);

      expect(res.stuck).toBe(0);
      expect(h.sendAlert).not.toHaveBeenCalled();
    }
  );

  it('a claim still inside its request window is not raised', async () => {
    h.events = [event('refund_initiated', 'c1', minutesAgo(1))];

    expect((await handleStuckRefundClaimSweep(stepStub)).stuck).toBe(0);
    expect(h.sendAlert).not.toHaveBeenCalled();
  });

  // issue 2027 — mutation-proof: bypassing the per-(claim, stage) sentinel
  // makes the second tick alert again and reddens this.
  it('alerts a claim ONCE per escalation stage, not on every tick', async () => {
    h.events = [event('refund_initiated', 'c1', minutesAgo(60))];

    await handleStuckRefundClaimSweep(stepStub);
    await handleStuckRefundClaimSweep(stepStub);
    await handleStuckRefundClaimSweep(stepStub);

    expect(h.sendAlert).toHaveBeenCalledOnce();
  });

  it('alerts again when the claim reaches the next stage (24h)', async () => {
    h.events = [event('refund_initiated', 'c1', minutesAgo(60))];
    await handleStuckRefundClaimSweep(stepStub);
    h.events = [event('refund_initiated', 'c1', minutesAgo(25 * 60))];
    await handleStuckRefundClaimSweep(stepStub);
    expect(h.sendAlert).toHaveBeenCalledTimes(2);
    expect(h.sendAlert.mock.calls[1][0].context.claims[0].stageMinutes).toBe(24 * 60);
  });

  // issue 2028 — the claim read is bounded and resolutions are fetched only
  // for the claimed payments.
  it('reads claims with a bound, oldest first, then resolutions for those payments only', async () => {
    h.events = [
      event('refund_initiated', 'c1', minutesAgo(60), 'pay-1'),
      event('refund_completed', 'other', minutesAgo(30), 'pay-unrelated'),
    ];

    await handleStuckRefundClaimSweep(stepStub);

    const [claimsCall, resolutionsCall] = h.findMany.mock.calls.map(c => c[0]);
    expect(claimsCall.where.eventType).toBe('refund_initiated');
    expect(claimsCall.take).toBeGreaterThan(0);
    expect(claimsCall.orderBy).toEqual([{ occurredAt: 'asc' }, { id: 'asc' }]);
    expect(claimsCall.where.occurredAt.gt).toBeInstanceOf(Date);
    expect(resolutionsCall.where.paymentId).toEqual({ in: ['pay-1'] });
    expect(resolutionsCall.where.eventType).toEqual({
      in: ['refund_completed', 'refund_failed', 'refund_reconciled'],
    });
  });

  // issue 2296 — every successful refund writes a claim, so the window is
  // dominated by RESOLVED claims. A 500-row read spent on them hid a genuinely
  // stuck claim newer than the 500th. The bound must be on unresolved claims.
  it('finds a stuck claim behind more than one page of resolved claims', async () => {
    const events: Ev[] = [];
    for (let i = 0; i < 1200; i++) {
      const at = minutesAgo(2 * 24 * 60 - i);
      events.push(event('refund_initiated', `ok-${i}`, at, `pay-${i}`));
      events.push(event('refund_completed', `ok-${i}`, at, `pay-${i}`));
    }
    events.push(event('refund_initiated', 'stuck-1', minutesAgo(60), 'pay-stuck'));
    h.events = events;

    const res = await handleStuckRefundClaimSweep(stepStub);

    expect(res.stuck).toBe(1);
    expect(h.sendAlert).toHaveBeenCalledOnce();
    expect(h.sendAlert.mock.calls[0][0].context.claims[0].paymentId).toBe('pay-stuck');
  });
});
