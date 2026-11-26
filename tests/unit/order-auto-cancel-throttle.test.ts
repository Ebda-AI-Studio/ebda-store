/**
 * #1014 — the between-provider-call throttle must run INSIDE a step.
 *
 * Inngest re-executes a function body from the top at every step boundary,
 * replaying memoized steps instantly but re-running plain code. A sleep in the
 * loop body therefore re-fires for every already-processed order on every
 * pass. This drives the real handler with a step stub that records whether
 * each timer was armed inside or outside a step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((ctx: { step: unknown }) => Promise<unknown>),
  findMany: vi.fn(),
  getPaymentStatus: vi.fn(),
  updateStatus: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: { order: { findMany: h.findMany }, $queryRaw: h.queryRaw },
  })
);
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((_cfg: unknown, fn: typeof h.handler) => {
      h.handler = fn;
      return {};
    }),
  },
}));
vi.mock('@api/services/order.service', () => ({
  OrderService: { updateStatus: h.updateStatus },
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { getPaymentStatus: h.getPaymentStatus },
}));
vi.mock('@api/services/payment-confirm.service', () => ({
  confirmPaymentFromProviderStatus: vi.fn(),
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

await import('@api/lib/inngest/functions/order-auto-cancel-unpaid');

const gatewayOrder = (id: string) => ({
  id,
  storeId: 's1',
  orderNumber: id,
  paymentStatus: 'unpaid',
  locale: 'en',
  payments: [
    {
      id: `p-${id}`,
      status: 'pending',
      provider: 'kashier',
      metadata: {},
      amount: 1000,
      currency: 'EGP',
      transactionId: `tx-${id}`,
    },
  ],
});

let depth = 0;
const timersOutsideStep: number[] = [];
const timersInsideStep: number[] = [];
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  vi.clearAllMocks();
  depth = 0;
  timersOutsideStep.length = 0;
  timersInsideStep.length = 0;
  h.findMany.mockResolvedValue([gatewayOrder('o1'), gatewayOrder('o2')]);
  h.getPaymentStatus.mockResolvedValue({ status: 'expired' });
  h.updateStatus.mockResolvedValue(undefined);
  h.queryRaw.mockResolvedValue([{ status: 'pending', payment_status: 'unpaid' }]);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    (depth > 0 ? timersInsideStep : timersOutsideStep).push(ms ?? 0);
    return realSetTimeout(fn, 0);
  }) as typeof setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => {
    depth += 1;
    try {
      return await fn();
    } finally {
      depth -= 1;
    }
  },
};

describe('order-auto-cancel-unpaid throttle', () => {
  it('paces provider calls with a sleep armed only inside a step (never replayed)', async () => {
    expect(h.handler).toBeTypeOf('function');
    const r = await h.handler!({ step });
    expect(r).toMatchObject({ scanned: 2, cancelled: 2 });
    expect(h.getPaymentStatus).toHaveBeenCalledTimes(2);
    // One pacing sleep per provider call …
    expect(timersInsideStep.filter(ms => ms > 0)).toHaveLength(2);
    // … and none in the replayed loop body.
    expect(timersOutsideStep.filter(ms => ms > 0)).toEqual([]);
  });

  it('the sweep also selects FAILED-payment orders so their held stock is released on the same timer (Ruling INV-AUDIT-2)', async () => {
    await h.handler!({ step });
    const where = h.findMany.mock.calls[0][0].where;
    expect(where.paymentStatus).toEqual({ in: ['unpaid', 'failed'] });
    expect(where.status).toBe('pending');
    expect(where.payments).toEqual({ none: { provider: 'cod' } });
  });

  it('an order a webhook PAID after the provider answered "expired" is not cancelled (row lock + re-check)', async () => {
    h.queryRaw.mockResolvedValue([{ status: 'confirmed', payment_status: 'paid' }]);
    const r = await h.handler!({ step });
    expect(r).toMatchObject({ scanned: 2, cancelled: 0 });
    expect(h.updateStatus).not.toHaveBeenCalled();
  });
});
