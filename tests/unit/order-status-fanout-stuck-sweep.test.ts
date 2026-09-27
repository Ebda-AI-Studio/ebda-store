/**
 * order-status-fanout-stuck-sweep (#619) — recovers an `order/status-changed`
 * event that was accepted but never delivered, which the inline fallback
 * (rejected enqueue only) cannot see.
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

import { handleOrderStatusFanoutStuckSweep } from '@api/lib/inngest/functions/order-status-fanout-stuck-sweep';

const stepStub = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
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
