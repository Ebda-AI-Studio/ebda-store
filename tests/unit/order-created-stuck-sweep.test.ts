/**
 * order-created-stuck-sweep (Builder Reality Audit Lens E, finding E2-1).
 *
 * Verifies the safety-net sweep that recovers PAID orders whose `order/created`
 * fanout never ran (the fire-and-forget enqueue had no fallback):
 *   - queries ONLY paid + unnotified + non-cancelled orders (never re-notifies
 *     an unpaid/pending online order → no ghost "new order" pings)
 *   - re-sends `order/created` once per stuck order
 *   - P1-alerts when an order stays unnotified past 3× the staleness window
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above module scope — create the mocks via
// vi.hoisted so they exist when the factories run.
const { mockOrderFindMany, mockSend, mockSendAlert } = vi.hoisted(() => ({
  mockOrderFindMany: vi.fn(),
  mockSend: vi.fn(),
  mockSendAlert: vi.fn(),
}));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: { order: { findMany: mockOrderFindMany } },
  })
);
vi.mock('@api/lib/inngest/client', () => ({
  // createFunction is invoked at module load for the wrapper export; stub it.
  inngest: { send: mockSend, createFunction: vi.fn(() => ({})) },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: mockSendAlert }));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleOrderCreatedStuckSweep } from '@api/lib/inngest/functions/order-created-stuck-sweep';

// stepStub runs step.run callbacks immediately (single-execution simulation).
// JSON round-trips the result the way Inngest memoizes step output: on every
// re-invocation a Date comes back as an ISO string (issue 2284). A stub that
// hands back the raw object hides every `.getTime()` on a memoized value.
const stepStub = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    const v = await fn();
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
  },
};

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockOrderFindMany.mockResolvedValue([]);
  mockSend.mockResolvedValue(undefined);
  mockSendAlert.mockResolvedValue(undefined);
});

describe('order-created-stuck-sweep', () => {
  it('no stuck orders → no re-send, no alert', async () => {
    const r = await handleOrderCreatedStuckSweep(stepStub);
    expect(r).toEqual({ swept: 0, resent: 0, alerted: 0, journalsRepaired: 0 });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('queries ONLY paid + unnotified + non-cancelled (no ghost-notify of unpaid)', async () => {
    await handleOrderCreatedStuckSweep(stepStub);
    const where = mockOrderFindMany.mock.calls[0][0].where;
    expect(where.paymentStatus).toBe('paid');
    expect(where.orderCreatedNotifiedAt).toBeNull();
    expect(where.status).toEqual({ not: 'cancelled' });
    // Bounded window: older than the notify grace (lt) AND within the recency
    // floor (gt) — the P0 fix so the historical back-catalog is never swept.
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(where.createdAt.gt).toBeInstanceOf(Date);
    expect(where.createdAt.gt.getTime()).toBeLessThan(where.createdAt.lt.getTime());
  });

  it('re-sends order/created for each stuck paid order (no alert when only mildly stale)', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'o1', storeId: 's1', locale: 'en', createdAt: minsAgo(15) },
      { id: 'o2', storeId: 's1', locale: null, createdAt: minsAgo(15) },
    ]);
    const r = await handleOrderCreatedStuckSweep(stepStub);
    expect(r.resent).toBe(2);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith({
      name: 'order/created',
      data: expect.objectContaining({ orderId: 'o1', storeId: 's1', locale: 'en' }),
    });
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('P1-alerts when an order stays unnotified past 3× the window', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'o1', storeId: 's1', locale: 'en', createdAt: minsAgo(60) }, // very stale (>30m)
    ]);
    const r = await handleOrderCreatedStuckSweep(stepStub);
    expect(r.resent).toBe(1); // still re-sends
    expect(r.alerted).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'order.created.stuck' })
    );
  });
});

describe('order-created-stuck-sweep: empty tick cost (Ruling INNGEST-BUDGET-1)', () => {
  it('a tick that finds nothing opens no step (one billed execution, not run + steps)', async () => {
    const run = vi.fn(stepStub.run);
    await handleOrderCreatedStuckSweep({ run });
    expect(run).not.toHaveBeenCalled();
  });
});
