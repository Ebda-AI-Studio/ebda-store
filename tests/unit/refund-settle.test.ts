/**
 * settleRefund: the ONE function the refund webhook, the manual refresh route and the in-band claim release all call.
 * An in-memory stand-in for the payment row and its events; the payment lock is modelled by running calls one at a time
 * (the real `SELECT … FOR UPDATE` serialises them), so each race is tested in BOTH orders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Ev {
  eventType: string;
  createdAt: Date;
  details: Record<string, unknown>;
  [k: string]: unknown;
}
const db = vi.hoisted(() => ({
  payment: {
    id: 'p1',
    amount: 10000,
    currency: 'EGP',
    status: 'completed',
    refundedAmount: 0,
    metadata: {} as Record<string, unknown>,
  },
  events: [] as Ev[],
  clock: 0,
  uniqueViolations: 0,
}));
vi.mock('@ebda/database', () => ({
  Prisma: {},
  prisma: {
    $queryRaw: async () => [],
    payment: {
      findUnique: async () => ({ ...db.payment }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(db.payment, data);
      },
    },
    paymentEvent: {
      findMany: async ({ where }: { where: { eventType: { in: string[] } } }) =>
        db.events.filter(e => where.eventType.in.includes(e.eventType)),
      create: async ({ data }: { data: Ev & { details: Record<string, unknown> } }) => {
        // the unique index payment_events_claim_single_outcome_key
        const claimed = (t: string) => ['refund_webhook_absorbed', 'refund_failed'].includes(t);
        if (
          claimed(data.eventType) &&
          db.events.some(e => claimed(e.eventType) && e.details.claimId === data.details.claimId)
        ) {
          db.uniqueViolations++;
          throw new Error('unique violation payment_events_claim_single_outcome_key');
        }
        db.events.push({ ...data, createdAt: new Date(db.clock) });
      },
    },
  },
}));
vi.mock('@api/lib/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  settleRefundEvent,
  settleClaimRelease,
  matchRefundToClaim,
} from '@api/services/payment-providers/refund-settle';

const NOW = 1_000_000_000;
const A = { storeId: 's1', orderId: 'o1', paymentId: 'p1' };
const claim = (
  claimId: string,
  amount: number,
  o: { executedRef?: string; full?: boolean; ageMs?: number } = {}
) => {
  db.clock = NOW - (o.ageMs ?? 1000);
  db.payment.refundedAmount += amount;
  db.payment.status = 'partially_refunded';
  db.events.push({
    eventType: 'refund_initiated',
    createdAt: new Date(NOW - (o.ageMs ?? 1000)),
    details: { claimId, amount, isFullRefund: o.full ?? false },
  });
  if (o.executedRef) {
    db.events.push({
      eventType: 'refund_completed',
      createdAt: new Date(NOW - (o.ageMs ?? 1000) + 500),
      details: { claimId, refundId: o.executedRef },
    });
    db.payment.metadata = {
      ...db.payment.metadata,
      refundEventIds: [...((db.payment.metadata.refundEventIds as string[]) ?? []), o.executedRef],
    };
  }
  db.clock = NOW;
};
const event = (
  provider: string,
  refundId: string,
  amount: number | null,
  status = 'completed'
) => ({ ...A, provider, refund: { refundId, status, amount }, now: NOW });
const apply = async (
  provider: string,
  refundId: string,
  amount: number | null,
  status = 'completed'
) => {
  const s = await settleRefundEvent(event(provider, refundId, amount, status));
  if (!s.seen && s.decision) {
    const d = s.decision;
    await s.commit({
      data: {
        metadata: {
          ...s.payment.metadata,
          refundStatus: status,
          refundStatusById: {
            ...((s.payment.metadata.refundStatusById as object) ?? {}),
            [refundId]: status,
          },
          ...(d.accountedThisEvent
            ? {
                refundEventIds: [
                  ...((s.payment.metadata.refundEventIds as string[]) ?? []),
                  refundId,
                ],
              }
            : {}),
        },
        ...(status === 'completed'
          ? {
              refundedAmount: d.settledTotal,
              status: d.isFullRefund ? 'refunded' : 'partially_refunded',
            }
          : {}),
      },
    });
  }
  return s;
};
const types = (t: string) => db.events.filter(e => e.eventType === t);
const release = (claimId: string, amount: number) =>
  settleClaimRelease({
    ...A,
    claimId,
    amount,
    claimedStatus: 'partially_refunded',
    priorStatus: 'completed',
    provider: 'paymob',
    reason: 'provider_rejected',
    error: 'x',
  });

beforeEach(() => {
  db.payment = {
    id: 'p1',
    amount: 10000,
    currency: 'EGP',
    status: 'completed',
    refundedAmount: 0,
    metadata: {},
  };
  db.events = [];
  db.uniqueViolations = 0;
  // a first accounted refund so the payment carries a ledger
  claim('c0', 500, { executedRef: 'R0', ageMs: 3_600_000 });
});

describe('absorb only a COMPLETED event; one claim, one notice', () => {
  it('a webhook outrunning the id write is absorbed (total unchanged) and CONSUMES the claim', async () => {
    claim('c1', 1000);
    const s = await apply('paymob', 'R1', 1000);
    expect(s.decision?.absorbedClaimId).toBe('c1');
    expect(db.payment.refundedAmount).toBe(1500);
    expect(types('refund_webhook_absorbed')).toHaveLength(1);
  });
  it('a PENDING (not completed) event never consumes a claim; the later completed one does', async () => {
    claim('c1', 1000);
    const pending = await apply('paymob', 'R1', 1000, 'pending');
    expect(pending.decision?.absorbedClaimId ?? null).toBeNull();
    expect(types('refund_webhook_absorbed')).toHaveLength(0);
    const done = await apply('paymob', 'R1', 1000, 'completed');
    expect(done.decision?.absorbedClaimId).toBe('c1');
  });
  it('a failed notice moves nothing and consumes nothing', async () => {
    claim('c1', 1000);
    await apply('paymob', 'R1', 1000, 'failed');
    expect(db.payment.refundedAmount).toBe(1500);
    expect(types('refund_webhook_absorbed')).toHaveLength(0);
  });
  it('two concurrent same-amount refunds: each webhook consumes its own claim, both booked once', async () => {
    claim('c1', 1000);
    claim('c2', 1000);
    await apply('paymob', 'R1', 1000);
    await apply('paymob', 'R2', 1000);
    expect(db.payment.refundedAmount).toBe(2500);
    expect(
      types('refund_webhook_absorbed')
        .map(e => e.details.claimId)
        .sort()
    ).toEqual(['c1', 'c2']);
  });
  it('a genuine second refund of the same amount (dashboard) is added once the claim is consumed', async () => {
    claim('c1', 1000);
    await apply('paymob', 'R1', 1000); // absorbed
    await apply('paymob', 'R9', 1000); // another refund, same amount
    expect(db.payment.refundedAmount).toBe(2500);
  });
  it('a replayed webhook is a no-op (seen), even with the claim long consumed', async () => {
    claim('c1', 1000);
    await apply('paymob', 'R1', 1000);
    const again = await settleRefundEvent(event('paymob', 'R1', 1000));
    expect(again.seen).toBe(true);
    expect(db.payment.refundedAmount).toBe(1500);
  });
  it('a stale claim (older than the window) never absorbs', async () => {
    claim('c1', 1000, { ageMs: 10 * 60_000 });
    const s = await apply('paymob', 'R1', 1000);
    expect(s.decision?.absorbedClaimId).toBeNull();
    expect(db.payment.refundedAmount).toBe(2500);
  });
  it('the refresh route and the webhook racing for the same refund: whichever runs second sees it seen/consumed (both orders)', async () => {
    for (const order of [
      ['refresh', 'webhook'],
      ['webhook', 'refresh'],
    ]) {
      beforeEachReset();
      claim('c1', 1000);
      for (const who of order) await apply(who === 'refresh' ? 'paymob' : 'paymob', 'R1', 1000);
      expect(db.payment.refundedAmount).toBe(1500);
      expect(types('refund_webhook_absorbed')).toHaveLength(1);
    }
  });
});

const beforeEachReset = () => {
  db.payment = {
    id: 'p1',
    amount: 10000,
    currency: 'EGP',
    status: 'completed',
    refundedAmount: 0,
    metadata: {},
  };
  db.events = [];
  claim('c0', 500, { executedRef: 'R0', ageMs: 3_600_000 });
};

describe('release vs absorb (both orders, one outcome per claim)', () => {
  it('absorb first, then the provider "refuses": NOT released, marked for review, the balance stays', async () => {
    claim('c1', 1000);
    await apply('paymob', 'R1', 1000);
    expect(await release('c1', 1000)).toBe('review');
    expect(db.payment.refundedAmount).toBe(1500);
    expect(types('refund_reconcile_review')).toHaveLength(1);
    expect(types('refund_failed')).toHaveLength(0);
  });
  it('release first, then the webhook arrives: the released claim cannot be absorbed; the webhook is a real refund and adds', async () => {
    claim('c1', 1000);
    expect(await release('c1', 1000)).toBe('released');
    expect(db.payment.refundedAmount).toBe(500);
    const s = await apply('paymob', 'R1', 1000);
    expect(s.decision?.absorbedClaimId).toBeNull();
    expect(db.payment.refundedAmount).toBe(1500);
  });
  it('a second release of the same claim is a no-op', async () => {
    claim('c1', 1000);
    await release('c1', 1000);
    expect(await release('c1', 1000)).toBe('already_released');
    expect(db.payment.refundedAmount).toBe(500);
  });
  it('the database refuses a second outcome for one claim (unique index modelled): defence in depth behind the lock', async () => {
    claim('c1', 1000);
    await apply('paymob', 'R1', 1000);
    const { prisma } = await import('@ebda/database');
    await expect(
      prisma.paymentEvent.create({
        data: { eventType: 'refund_failed', details: { claimId: 'c1' } } as never,
      })
    ).rejects.toThrow('unique violation');
  });
  it('the migration really creates that unique partial index', () => {
    const sql = fs.readFileSync(
      path.join(
        __dirname,
        '../../packages/database/prisma/migrations/20261103000200_refund_claim_single_outcome/migration.sql'
      ),
      'utf8'
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "payment_events_claim_single_outcome_key"/
    );
    expect(sql).toMatch(/'refund_webhook_absorbed', 'refund_failed'/);
    expect(sql).toMatch(/"details" ->> 'claimId'/);
  });
});

describe('Fawry amount-less settle notice: attributed on positive evidence, else held', () => {
  const fawry = (id: string) => apply('fawry', id, 0);
  it('matches ONE executed claim of the same Fawry reference and kind, consumes it, and does not alert', async () => {
    claim('c1', 1000, { executedRef: 'fawry-refund-F1-1500', full: false });
    const s = await fawry('fawry-refund-F1-PARTIAL_REFUNDED');
    expect(s.decision?.absorbedClaimId).toBe('c1');
    expect(s.decision?.heldUnaccountedEvent).toBe(false);
    // a SECOND notice cannot ride the same claim
    const second = await fawry('fawry-refund-F1-PARTIAL_REFUNDED');
    expect(second.seen).toBe(true);
    const other = await apply('fawry', 'fawry-refund-F1-PARTIAL_REFUNDED#2', 0);
    expect(other.decision?.absorbedClaimId).toBeNull();
  });
  it('a missing / unparseable reference FAILS CLOSED: held and alerted, nothing consumed', async () => {
    claim('c1', 1000, { executedRef: 'fawry-refund-F1-1500' });
    for (const bad of [
      '',
      'garbage',
      'fawry-refund--PARTIAL_REFUNDED',
      'fawry-refund-F1-SOMETHING',
    ]) {
      const s = await fawry(bad || 'fawry-refund-');
      expect(s.decision?.absorbedClaimId ?? null).toBeNull();
    }
    expect(types('refund_webhook_absorbed')).toHaveLength(0);
  });
  it('another Fawry reference, the wrong kind (full vs partial), a claim with no outcome, or a stale one: held', async () => {
    claim('c1', 1000, { executedRef: 'fawry-refund-F1-1500', full: false });
    expect(
      (await fawry('fawry-refund-OTHER-PARTIAL_REFUNDED')).decision?.absorbedClaimId ?? null
    ).toBeNull();
    expect((await fawry('fawry-refund-F1-REFUNDED')).decision?.absorbedClaimId ?? null).toBeNull();
    beforeEachReset();
    claim('c2', 1000); // no outcome yet
    expect(
      (await fawry('fawry-refund-F1-PARTIAL_REFUNDED')).decision?.absorbedClaimId ?? null
    ).toBeNull();
  });
});

describe('Kashier: an unknown id while our own refund is open is HELD, never auto-booked (id equality unverified)', () => {
  it('holds an unknown-id completed event while an executed claim is open; nothing added, then an operator match settles it', async () => {
    claim('c1', 1000, { executedRef: 'API-REFUND-ID-1' });
    const s = await apply('kashier', 'WEBHOOK-TXN-ID-9', 1000);
    expect(s.decision?.heldOpenClaimIdUnverified).toBe(true);
    expect(s.decision?.accountedThisEvent).toBe(false);
    expect(db.payment.refundedAmount).toBe(1500);
    expect(
      await matchRefundToClaim({
        ...A,
        claimId: 'c1',
        providerRefundId: 'WEBHOOK-TXN-ID-9',
        actorUserId: 'op1',
      })
    ).toBe('matched');
    expect(types('refund_webhook_absorbed')[0].details).toMatchObject({
      claimId: 'c1',
      matchedBy: 'op1',
      via: 'operator_match',
    });
    expect(db.payment.refundedAmount).toBe(1500);
    // matched once; a second match, or a match of a released / unexecuted claim, is refused
    expect(
      await matchRefundToClaim({
        ...A,
        claimId: 'c1',
        providerRefundId: 'WEBHOOK-TXN-ID-9',
        actorUserId: 'op1',
      })
    ).toBe('already_matched');
    claim('c2', 200);
    await expect(
      matchRefundToClaim({ ...A, claimId: 'c2', providerRefundId: 'X', actorUserId: 'op1' })
    ).rejects.toThrow('no executed refund');
  });
  it('the same id as the API answered with is the normal path: seen/accounted, no hold', async () => {
    claim('c1', 1000, { executedRef: 'SAME-ID' });
    const s = await apply('kashier', 'SAME-ID', 1000);
    expect(s.decision?.heldOpenClaimIdUnverified).toBe(false);
    expect(db.payment.refundedAmount).toBe(1500);
  });
  it('with NO open own claim an unknown id is a genuine dashboard refund and is booked', async () => {
    const s = await apply('kashier', 'DASH-1', 700);
    expect(s.decision?.heldOpenClaimIdUnverified).toBe(false);
    expect(db.payment.refundedAmount).toBe(1200);
  });
  it('other providers keep the id-based rule (no extra hold)', async () => {
    claim('c1', 1000, { executedRef: 'API-ID' });
    const s = await apply('paymob', 'DIFFERENT', 1000);
    expect(s.decision?.heldOpenClaimIdUnverified).toBe(false);
    expect(db.payment.refundedAmount).toBe(2500);
  });
});
