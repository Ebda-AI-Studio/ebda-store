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

const { mockOrderFindMany, mockSend, mockSendAlert } = vi.hoisted(() => ({
  mockOrderFindMany: vi.fn(),
  mockSend: vi.fn(),
  mockSendAlert: vi.fn(),
}));

vi.mock('@force/database', () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) => fn({ order: { findMany: mockOrderFindMany } }),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: mockSend, createFunction: vi.fn(() => ({})) },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: mockSendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleRefundReversalStuckSweep } from '@api/lib/inngest/functions/refund-reversal-stuck-sweep';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockOrderFindMany.mockResolvedValue([]);
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
    expect(where.status).toEqual({ in: ['cancelled', 'refunded'] });
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
    expect(where.updatedAt.gt).toBeInstanceOf(Date);
    // The floor must be genuinely older than the staleness cutoff, otherwise
    // the window is empty and the sweep silently never recovers anything.
    expect(where.updatedAt.gt.getTime()).toBeLessThan(where.updatedAt.lt.getTime());
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
