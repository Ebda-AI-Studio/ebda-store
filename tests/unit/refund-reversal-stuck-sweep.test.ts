/**
 * refund-reversal-stuck-sweep — the safety net for silent stock loss.
 *
 * `applyRefundEffects` only ENQUEUES `order/refunded`. A failed enqueue
 * propagates and is handled at every call site, but a SUCCESSFUL enqueue whose
 * event is never consumed (Inngest outage, bad signing key, worker down, event
 * dropped mid-deploy) is silent: the order reads `cancelled`, the customer is
 * refunded, and the stock never comes back.
 *
 * These tests pin the two things that make the sweep safe rather than harmful:
 *   - it re-sends for orders whose reversal genuinely never ran
 *   - it NEVER touches the historical back-catalog (the recency floor), which is
 *     the exact P0 order-created-stuck-sweep shipped on 2026-07-09
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOrderFindMany, mockReturnFindMany, mockSend, mockSendAlert } = vi.hoisted(() => ({
  mockOrderFindMany: vi.fn(),
  mockReturnFindMany: vi.fn(),
  mockSend: vi.fn(),
  mockSendAlert: vi.fn(),
}));

vi.mock('@force/database', () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) =>
    fn({ order: { findMany: mockOrderFindMany }, return: { findMany: mockReturnFindMany } }),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: mockSend, createFunction: vi.fn(() => ({})) },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: mockSendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  handleRefundReversalStuckSweep,
  handlePartialReturnReversalSweep,
} from '@api/lib/inngest/functions/refund-reversal-stuck-sweep';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockOrderFindMany.mockResolvedValue([]);
  mockReturnFindMany.mockResolvedValue([]);
  mockSend.mockResolvedValue(undefined);
  mockSendAlert.mockResolvedValue(undefined);
});

describe('refund-reversal-stuck-sweep', () => {
  it('re-sends order/refunded for a cancelled order whose reversal never ran', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'o1', storeId: 's1', status: 'cancelled', updatedAt: minsAgo(20) },
    ]);

    const res = await handleRefundReversalStuckSweep(stepStub);

    expect(res).toMatchObject({ swept: 1, resent: 1 });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      name: 'order/refunded',
      data: { orderId: 'o1', storeId: 's1', restoreInventory: true, notify: false },
    });
  });

  // A recovery re-send is a plumbing retry, not a new refund. Firing the
  // customer refund email / "Refund issued" merchant push again would be the
  // spurious-notification bug order.service.ts comments say was already fixed.
  it('never re-fires refund notifications on a recovery re-send', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'o1', storeId: 's1', status: 'refunded', updatedAt: minsAgo(20) },
    ]);

    await handleRefundReversalStuckSweep(stepStub);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ notify: false }) })
    );
  });

  it('does nothing when no order is stuck', async () => {
    const res = await handleRefundReversalStuckSweep(stepStub);
    expect(res).toEqual({ swept: 0, resent: 0, alerted: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // THE BACK-CATALOG GUARD. refundReversedAt is NULL for every cancelled or
  // refunded order predating the column, so without a floor the first tick
  // after deploy re-fires reversals across the entire order history. The query
  // must bound updatedAt on BOTH sides.
  it('bounds the query on both sides — staleness cutoff AND recency floor', async () => {
    await handleRefundReversalStuckSweep(stepStub);

    const where = mockOrderFindMany.mock.calls[0][0].where;
    expect(where.refundReversedAt).toBeNull();
    const [requested, legacy] = where.OR;
    // Legacy rows (no request stamp): the original status + updatedAt window.
    expect(legacy.refundReversalRequestedAt).toBeNull();
    expect(legacy.status).toEqual({ in: ['cancelled', 'refunded'] });
    expect(legacy.updatedAt.lt).toBeInstanceOf(Date);
    expect(legacy.updatedAt.gt).toBeInstanceOf(Date);
    // The floor must be genuinely older than the staleness cutoff, otherwise
    // the window is empty and the sweep silently never recovers anything.
    expect(legacy.updatedAt.gt.getTime()).toBeLessThan(legacy.updatedAt.lt.getTime());
    const w = requested.refundReversalRequestedAt;
    expect(w.gt.getTime()).toBeLessThan(w.lt.getTime());
  });

  // #839 + #855 — the primary branch keys on the request stamp alone: no
  // status filter (a manual full return leaves the order `delivered`) and no
  // updatedAt (a later tracking edit must not push a stuck order out).
  it('selects a requested-but-unclaimed reversal regardless of status or later edits', async () => {
    await handleRefundReversalStuckSweep(stepStub);
    const [requested] = mockOrderFindMany.mock.calls[0][0].where.OR;
    expect(Object.keys(requested)).toEqual(['refundReversalRequestedAt']);
  });

  it('ages a stuck order by its request stamp, not a later updatedAt bump', async () => {
    mockOrderFindMany.mockResolvedValue([
      {
        id: 'touched',
        storeId: 's1',
        status: 'delivered',
        updatedAt: minsAgo(1),
        refundReversalRequestedAt: minsAgo(120),
      },
    ]);
    const res = await handleRefundReversalStuckSweep(stepStub);
    expect(res.alerted).toBe(1);
  });

  it('caps each tick so one bad window cannot stampede Inngest', async () => {
    await handleRefundReversalStuckSweep(stepStub);
    expect(mockOrderFindMany.mock.calls[0][0].take).toBe(200);
    expect(mockOrderFindMany.mock.calls[0][0].orderBy).toEqual({ updatedAt: 'asc' });
  });

  it('P1-alerts when an order stays unreversed past 3x the window', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'old', storeId: 's1', status: 'cancelled', updatedAt: minsAgo(120) },
    ]);

    const res = await handleRefundReversalStuckSweep(stepStub);

    expect(res.alerted).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'order.refund.reversal.stuck' })
    );
  });

  it('does not alert for an order only just past the window', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'o1', storeId: 's1', status: 'cancelled', updatedAt: minsAgo(12) },
    ]);

    const res = await handleRefundReversalStuckSweep(stepStub);

    expect(res.alerted).toBe(0);
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  // One failing send must not abort the tick — the remaining stuck orders still
  // need recovering, and the next tick re-picks up whatever failed.
  it('keeps sweeping when an individual re-send throws', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'o1', storeId: 's1', status: 'cancelled', updatedAt: minsAgo(20) },
      { id: 'o2', storeId: 's1', status: 'cancelled', updatedAt: minsAgo(20) },
    ]);
    mockSend.mockRejectedValueOnce(new Error('inngest down'));

    const res = await handleRefundReversalStuckSweep(stepStub);

    expect(res.swept).toBe(2);
    expect(res.resent).toBe(1);
  });
});

// Issues 2246 / 2267: a PARTIAL return's item-level event had no stamp and no
// sweep, so a failed post-commit enqueue lost its stock restore + GL posting.
describe('refund-reversal-stuck-sweep — partial returns', () => {
  it('re-sends the ITEM-LEVEL event, rebuilt from the Return, with notify:false', async () => {
    mockReturnFindMany.mockResolvedValue([
      {
        id: 'ret-1',
        storeId: 's1',
        orderId: 'o1',
        refundAmount: 1250,
        reversalRequestedAt: minsAgo(20),
        items: [{ orderItemId: 'oi-1', quantity: 1 }],
      },
    ]);

    const res = await handlePartialReturnReversalSweep(stepStub);

    expect(res).toMatchObject({ swept: 1, resent: 1 });
    expect(mockSend).toHaveBeenCalledWith({
      name: 'order/refunded',
      data: {
        orderId: 'o1',
        storeId: 's1',
        restoreInventory: true,
        notify: false,
        partial: {
          items: [{ orderItemId: 'oi-1', quantity: 1 }],
          refundKey: 'ret-1',
          refundAmount: 1250,
        },
      },
    });
  });

  it('selects only requested-but-unapplied returns inside the window', async () => {
    await handlePartialReturnReversalSweep(stepStub);
    const where = mockReturnFindMany.mock.calls[0][0].where;
    expect(where.reversalAppliedAt).toBeNull();
    expect(where.reversalRequestedAt.lt).toBeInstanceOf(Date);
    // No recency floor: an armed return older than 12h is still recovered.
    expect(where.reversalRequestedAt).not.toHaveProperty('gt');
  });

  it('does nothing when no partial return is stuck', async () => {
    expect(await handlePartialReturnReversalSweep(stepStub)).toEqual({
      swept: 0,
      resent: 0,
      alerted: 0,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
