/**
 * settleRefund: the ONE function the refund webhook, the manual refresh route and the in-band claim release all call.
 * An in-memory stand-in for the payment row and its events; the payment lock is modelled by running calls one at a time
 * (the real `SELECT … FOR UPDATE` serialises them), so each race is tested in BOTH orders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** every database call is an await point where another flow may run (random, deterministic LCG) */
const tick = async () => {
  if (!db.yieldRandom) return;
  db.rnd = (db.rnd * 1103515245 + 12345) & 0x7fffffff;
  const n = db.rnd % 4;
  for (let i = 0; i < n; i++) await Promise.resolve();
};

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
  ambient: true,
  scope: undefined as string | undefined,
  yieldRandom: false,
  mutex: Promise.resolve() as Promise<unknown>,
  rnd: 1,
}));
vi.mock('@ebda/database', () => ({
  Prisma: {},
  hasTenantContext: () => db.ambient,
  currentTenantGucs: () => (db.scope ? { storeId: db.scope } : undefined),
  // a separate transaction: one at a time, like the payment row lock serialises them
  runInTenantContext: (_s: unknown, fn: () => Promise<unknown>) => {
    const run = db.mutex.then(fn, fn);
    db.mutex = run.catch(() => undefined);
    return run;
  },
  prisma: {
    $queryRaw: async () => {
      await tick();
      return [];
    },
    payment: {
      findUnique: async () => {
        await tick();
        return { ...db.payment };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        await tick();
        Object.assign(db.payment, data);
      },
    },
    paymentEvent: {
      findMany: async ({ where }: { where: { eventType: string | { in: string[] } } }) => {
        await tick();
        const types = typeof where.eventType === 'string' ? [where.eventType] : where.eventType.in;
        return db.events.filter(e => types.includes(e.eventType));
      },
      create: async ({ data }: { data: Ev & { details: Record<string, unknown> } }) => {
        await tick();
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
  inSettlementTx,
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
      // completeRefund seeds the per-refund status map, exactly like production
      refundStatusById: {
        ...((db.payment.metadata.refundStatusById as object) ?? {}),
        [o.executedRef]: 'completed',
      },
    };
  }
  db.clock = NOW;
};
const event = (
  provider: string,
  refundId: string,
  amount: number | null,
  status = 'completed',
  reference?: string
) => ({
  ...A,
  provider,
  refund: { refundId, status, amount, ...(reference !== undefined ? { reference } : {}) },
  now: NOW,
});
const apply = async (
  provider: string,
  refundId: string,
  amount: number | null,
  status = 'completed',
  reference?: string
) => {
  const s = await settleRefundEvent(event(provider, refundId, amount, status, reference));
  if (!s.seen && s.decision) {
    const d = s.decision;
    if (d.heldOpenClaimIdUnverified || d.heldUnaccountedEvent)
      db.events.push({
        eventType: 'webhook',
        createdAt: new Date(NOW),
        details: {
          flavour: 'refund',
          refundId,
          heldUnaccountedRefund: true,
          reportedAmount: amount,
        },
      });
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
    // and a pending notice does not file its id as accounted (the real completed refund must still be counted)
    expect((db.payment.metadata.refundEventIds as string[]) ?? []).not.toContain('R1');
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
      // The two callers send different shapes: the refresh route (order.routes.ts) has no provider reference, the
      // webhook (payment.factory.ts) carries one. Both must land on the same refund.
      for (const who of order)
        await apply('paymob', 'R1', 1000, 'completed', who === 'webhook' ? 'PMB-REF-1' : undefined);
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
        '../../packages/database/prisma/migrations/20261103000250_refund_claim_single_outcome/migration.sql'
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
    expect(second.seen).toBe(false); // never silently seen: held + alerted
    expect(second.decision?.heldUnaccountedEvent).toBe(true);
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
  it('AGE never closes the hold: an unknown id 2 days later with an unconsumed executed claim is held, not booked', async () => {
    claim('c1', 1000, { executedRef: 'API-REFUND-ID-1' });
    const s = await settleRefundEvent({
      ...event('kashier', 'LATE-ID', 1000),
      now: NOW + 2 * 86_400_000,
    });
    expect(s.decision?.heldOpenClaimIdUnverified).toBe(true);
    expect(s.decision?.accountedThisEvent).toBe(false);
  });
  it("the refund's OWN webhook (the API id) consumes the claim; afterwards an unknown id is a genuine refund and is booked", async () => {
    claim('c1', 1000, { executedRef: 'SAME-ID' });
    await settleRefundEvent(event('kashier', 'R0', 500)); // the seed refund's own webhook closes c0
    const own = await settleRefundEvent(event('kashier', 'SAME-ID', 1000));
    expect(own.seen).toBe(true);
    expect(
      types('refund_webhook_absorbed')
        .map(e => e.details.claimId)
        .sort()
    ).toEqual(['c0', 'c1']);
    expect(types('refund_webhook_absorbed')[1].details).toMatchObject({
      claimId: 'c1',
      via: 'id_match',
    });
    const later = await settleRefundEvent({
      ...event('kashier', 'DASH-2', 700),
      now: NOW + 2 * 86_400_000,
    });
    expect(later.decision?.heldOpenClaimIdUnverified).toBe(false);
    expect(later.decision?.accountedThisEvent).toBe(true);
  });
  it('the same id as the API answered with is the normal path: seen/accounted, no hold', async () => {
    claim('c1', 1000, { executedRef: 'SAME-ID' });
    const s = await apply('kashier', 'SAME-ID', 1000);
    expect(s.seen).toBe(true); // on the ledger: nothing held, nothing added
    expect(db.payment.refundedAmount).toBe(1500);
  });
  it('with NO open own claim an unknown id is a genuine dashboard refund and is booked', async () => {
    // the seed refund's own webhook (R0) arrived and closed its claim
    await settleRefundEvent(event('kashier', 'R0', 500));
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

describe('the settlement owns its transaction: interleaved at every await point (refresh route + webhooks)', () => {
  const inTx = (fn: () => Promise<unknown>) => inSettlementTx('s1', fn);
  const flow = (provider: string, id: string, amount: number) =>
    inTx(async () => {
      const s = await settleRefundEvent(event(provider, id, amount));
      const meta = s.payment.metadata; // the LOCKED copy: every patch is built from it
      const patch = s.decision
        ? {
            metadata: {
              ...meta,
              refundStatus: 'completed',
              refundStatusById: { ...((meta.refundStatusById as object) ?? {}), [id]: 'completed' },
              ...(s.decision.accountedThisEvent
                ? { refundEventIds: [...((meta.refundEventIds as string[]) ?? []), id] }
                : {}),
            },
            refundedAmount: s.decision.settledTotal,
            status: s.decision.isFullRefund ? 'refunded' : 'partially_refunded',
          }
        : {};
      if (!s.seen) await s.commit({ data: patch });
    });

  it('route + webhook for the SAME refund, and a different genuine refund, over 60 random interleavings: one effect, no lost metadata', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      db.ambient = false;
      db.yieldRandom = true;
      db.rnd = seed * 7919;
      db.mutex = Promise.resolve();
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
      claim('c1', 1000);
      const order = [
        () => flow('paymob', 'R1', 1000), // the manual refresh route
        () => flow('paymob', 'R1', 1000), // the provider webhook for the same refund
        () => flow('paymob', 'R9', 700), // a genuine dashboard refund
      ];
      if (seed % 2) order.reverse();
      await Promise.all(order.map(f => f()));
      expect(db.payment.refundedAmount, `seed ${seed}`).toBe(500 + 1000 + 700);
      expect(types('refund_webhook_absorbed'), `seed ${seed}`).toHaveLength(1);
      const by = db.payment.metadata.refundStatusById as Record<string, string>;
      expect(by.R1, `seed ${seed}: R1 status kept`).toBe('completed');
      expect(by.R9, `seed ${seed}: R9 status kept (no lost update)`).toBe('completed');
      expect((db.payment.metadata.refundEventIds as string[]).sort(), `seed ${seed}`).toEqual([
        'R0',
        'R1', // the absorbed id is filed by commit(), not by the caller
        'R9',
      ]);
    }
    db.ambient = true;
    db.yieldRandom = false;
  });

  it('release racing a webhook over 60 interleavings: never both a decrement and an absorb', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      db.ambient = false;
      db.yieldRandom = true;
      db.rnd = seed * 104729;
      db.mutex = Promise.resolve();
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
      claim('c1', 1000);
      const flows = [() => flow('paymob', 'R1', 1000), () => inTx(() => release('c1', 1000))];
      if (seed % 2) flows.reverse();
      await Promise.all(flows.map(f => f()));
      const absorbed = types('refund_webhook_absorbed').length;
      const released = types('refund_failed').length;
      expect(absorbed + released, `seed ${seed}: exactly one outcome`).toBe(1);
      // absorbed -> the claim stands (1500); released first -> the webhook is a real refund (1500). Money never lost either way.
      expect(db.payment.refundedAmount, `seed ${seed}`).toBe(1500);
    }
    db.ambient = true;
    db.yieldRandom = false;
  });
});

describe('review fixes: operator match validation, absorbed id filed, lock mode, store scope', () => {
  it('the operator match refuses an id no held webhook delivered, and an id already accounted', async () => {
    claim('c1', 1000, { executedRef: 'API-ID' });
    await expect(
      matchRefundToClaim({ ...A, claimId: 'c1', providerRefundId: 'TYPO', actorUserId: 'op' })
    ).rejects.toThrow('no held webhook');
    expect(types('refund_webhook_absorbed')).toHaveLength(0);
    await expect(
      matchRefundToClaim({ ...A, claimId: 'c1', providerRefundId: 'R0', actorUserId: 'op' })
    ).rejects.toThrow('already accounted');
  });
  it('an absorbed id is FILED as accounted and its status recorded by commit(), whatever the caller patches', async () => {
    claim('c1', 1000);
    const s = await settleRefundEvent(event('paymob', 'R1', 1000));
    await s.commit({ data: { metadata: { refundStatus: 'completed' } } }); // a caller that forgot the ledger
    expect(db.payment.metadata.refundEventIds).toContain('R1');
    expect((db.payment.metadata.refundStatusById as Record<string, string>).R1).toBe('completed');
    // a replay after the claim closed is therefore still seen
    expect((await settleRefundEvent(event('paymob', 'R1', 1000))).seen).toBe(true);
  });
  it('the payment is locked FOR NO KEY UPDATE (serialises writers, does not conflict with FK key-share locks)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../apps/api/src/services/payment-providers/refund-settle.ts'),
      'utf8'
    );
    expect(src).toContain('FOR NO KEY UPDATE');
    expect(src).not.toMatch(/FROM payments WHERE id = \$\{paymentId\} FOR UPDATE/);
  });
  it('an ambient transaction scoped to ANOTHER store is refused (RLS would hide the events: fail open)', async () => {
    db.ambient = true;
    db.scope = 'other-store';
    await expect(inSettlementTx('s1', async () => 1)).rejects.toThrow('another store');
    db.scope = 's1';
    expect(await inSettlementTx('s1', async () => 1)).toBe(1);
    db.scope = undefined;
  });
});

describe('final review fixes', () => {
  it('operator match refuses a held webhook whose amount differs from the claim (500 vs 2000)', async () => {
    claim('c1', 2000, { executedRef: 'API-ID' });
    await apply('kashier', 'WEBHOOK-ID', 500);
    await expect(
      matchRefundToClaim({ ...A, claimId: 'c1', providerRefundId: 'WEBHOOK-ID', actorUserId: 'op' })
    ).rejects.toThrow('amount');
    expect(types('refund_webhook_absorbed')).toHaveLength(0);
  });
  it('Fawry: a REPEATED amount-less partial notice is never silently seen - the 2nd is held and alerted', async () => {
    claim('c1', 1000, { executedRef: 'fawry-refund-F1-1500', full: false });
    const first = await apply('fawry', 'fawry-refund-F1-PARTIAL_REFUNDED', 0);
    expect(first.decision?.absorbedClaimId).toBe('c1');
    const second = await apply('fawry', 'fawry-refund-F1-PARTIAL_REFUNDED', 0);
    expect(second.seen).toBe(false);
    expect(second.decision?.absorbedClaimId ?? null).toBeNull();
    expect(second.decision?.heldUnaccountedEvent).toBe(true);
  });
});
