/**
 * order-status-fanout-stuck-sweep (#619) — recovers an `order/status-changed`
 * event that was accepted but never delivered, which the inline fallback
 * (rejected enqueue only) cannot see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockOrderFindMany, mockFailedFindMany, mockUpdateMany, mockSend, mockSendAlert, locks } =
  vi.hoisted(() => ({
    // The UNCLAIMED query (statusFanoutClaimedAt: null).
    mockOrderFindMany: vi.fn(),
    // The claimed-but-never-completed query (issue 2071).
    mockFailedFindMany: vi.fn(),
    mockUpdateMany: vi.fn(),
    mockSend: vi.fn(),
    mockSendAlert: vi.fn(),
    locks: new Set<string>(),
  }));

vi.mock('@force/database', () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) =>
    fn({
      order: {
        findMany: (args: { where: { statusFanoutClaimedAt: unknown } }) =>
          args.where.statusFanoutClaimedAt === null
            ? mockOrderFindMany(args)
            : mockFailedFindMany(args),
        updateMany: mockUpdateMany,
      },
    }),
}));
vi.mock('@api/services/redis.service', () => ({
  redis: {
    acquireLock: async (k: string) => (locks.has(k) ? false : (locks.add(k), true)),
  },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: mockSend, createFunction: vi.fn(() => ({})) },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: mockSendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleOrderStatusFanoutStuckSweep } from '@api/lib/inngest/functions/order-status-fanout-stuck-sweep';

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
  locks.clear();
  mockFailedFindMany.mockResolvedValue([]);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderFindMany.mockResolvedValue([]);
  mockSend.mockResolvedValue(undefined);
  mockSendAlert.mockResolvedValue(undefined);
});

describe('order-status-fanout-stuck-sweep', () => {
  it('nothing stuck → no re-send, no alert', async () => {
    expect(await handleOrderStatusFanoutStuckSweep(stepStub)).toEqual({
      swept: 0,
      resent: 0,
      alerted: 0,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('queries unclaimed transitions inside a bounded window, only for statuses with side effects', async () => {
    await handleOrderStatusFanoutStuckSweep(stepStub);
    const where = mockOrderFindMany.mock.calls[0][0].where;
    expect(where.statusFanoutClaimedAt).toBeNull();
    expect(where.statusFanoutRequestedAt.gt.getTime()).toBeLessThan(
      where.statusFanoutRequestedAt.lt.getTime()
    );
    expect(where.status.in).toEqual(['confirmed', 'shipped', 'delivered', 'cancelled', 'refunded']);
    expect(where.status.in).not.toContain('pending');
  });

  it('re-sends order/status-changed for the CURRENT status', async () => {
    mockOrderFindMany.mockResolvedValue([
      {
        id: 'o1',
        storeId: 's1',
        status: 'delivered',
        paymentStatus: 'paid',
        statusFanoutRequestedAt: minsAgo(15),
      },
      {
        id: 'o2',
        storeId: 's1',
        status: 'refunded',
        paymentStatus: 'unpaid',
        statusFanoutRequestedAt: minsAgo(15),
      },
    ]);
    const r = await handleOrderStatusFanoutStuckSweep(stepStub);
    expect(r.resent).toBe(2);
    expect(mockSend).toHaveBeenCalledWith({
      name: 'order/status-changed',
      data: { orderId: 'o1', storeId: 's1', status: 'delivered', hadCapturedPayment: true },
    });
    expect(mockSend).toHaveBeenCalledWith({
      name: 'order/status-changed',
      data: { orderId: 'o2', storeId: 's1', status: 'refunded', hadCapturedPayment: false },
    });
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('P1-alerts when a transition stays unclaimed past 3x the window', async () => {
    mockOrderFindMany.mockResolvedValue([
      {
        id: 'o1',
        storeId: 's1',
        status: 'shipped',
        paymentStatus: 'paid',
        statusFanoutRequestedAt: minsAgo(60),
      },
    ]);
    const r = await handleOrderStatusFanoutStuckSweep(stepStub);
    expect(r.alerted).toBe(1);
    expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'p1' }));
  });
});

describe('order-status-fanout-stuck-sweep — requested transition (issue 2070, issue 2133)', () => {
  it('re-sends the REQUESTED status while the order is still at it', async () => {
    mockOrderFindMany.mockResolvedValue([
      {
        id: 'o1',
        storeId: 's1',
        status: 'confirmed',
        paymentStatus: 'paid',
        statusFanoutRequestedAt: minsAgo(15),
        statusFanoutRequestedStatus: 'confirmed',
      },
    ]);
    const r = await handleOrderStatusFanoutStuckSweep(stepStub);
    expect(r.resent).toBe(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'confirmed' }) })
    );
  });

  // Mutation-proof: re-sending `o.status` for a superseded row reddens this.
  it('never re-sends the CURRENT status of a superseded request — reports and disarms it', async () => {
    mockOrderFindMany.mockResolvedValue([
      {
        id: 'o1',
        storeId: 's1',
        status: 'refunded', // a gateway refund wrote this directly
        paymentStatus: 'refunded',
        statusFanoutRequestedAt: minsAgo(15),
        statusFanoutRequestedStatus: 'confirmed',
      },
    ]);
    const r = await handleOrderStatusFanoutStuckSweep(stepStub);
    expect(r.resent).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'order.status_fanout.superseded', level: 'p1' })
    );
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'o1', statusFanoutClaimedAt: null }),
        data: { statusFanoutRequestedAt: null },
      })
    );
  });
});

describe('order-status-fanout-stuck-sweep — failed after claim (issue 2071)', () => {
  const failedRow = {
    id: 'o9',
    storeId: 's1',
    status: 'delivered',
    statusFanoutRequestedStatus: 'delivered',
    statusFanoutRequestedAt: minsAgo(30),
  };

  it('reports a claimed, never-completed transition once, naming the order', async () => {
    mockFailedFindMany.mockResolvedValue([failedRow]);

    const first = await handleOrderStatusFanoutStuckSweep(stepStub);
    const second = await handleOrderStatusFanoutStuckSweep(stepStub);

    const alerts = mockSendAlert.mock.calls.filter(
      c => (c[0] as { source: string }).source === 'order.status_fanout.failed_after_claim'
    );
    expect(alerts).toHaveLength(1);
    expect(first.alerted).toBe(1);
    expect(second.alerted).toBe(0);
    expect(mockSend).not.toHaveBeenCalled(); // never auto re-sent
  });

  it('only looks at rows armed with a requested status (never the historical back-catalogue)', async () => {
    await handleOrderStatusFanoutStuckSweep(stepStub);
    const where = mockFailedFindMany.mock.calls[0][0].where;
    expect(where.statusFanoutCompletedAt).toBeNull();
    expect(where.statusFanoutRequestedStatus).toEqual({ not: null });
    expect(where.statusFanoutClaimedAt.gt).toBeInstanceOf(Date);
  });
});
