/**
 * #763 — the daily auto-cancel sweep rescues an order the provider reports
 * paid by confirming it through `confirmPaymentFromProviderStatus`. If the
 * order left `pending` after the sweep's query (a merchant cancelled it, or
 * another path confirmed it and moved it on), that confirm is a backwards
 * transition and throws AppError(400, INVALID_STATUS_TRANSITION). The throw
 * escaped the reconcile step, so Inngest retried a request that can never
 * succeed, the whole sweep failed (every later order went unprocessed) and a
 * non-actionable P1 fired. A terminal 4xx is now a skip; anything else still
 * throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@api/middleware/error-handler';

const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((ctx: { step: unknown }) => Promise<unknown>),
  findMany: vi.fn(),
  getPaymentStatus: vi.fn(),
  updateStatus: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@force/database', () => ({
  prisma: {},
  withRlsBypass: (fn: (tx: unknown) => unknown) => fn({ order: { findMany: h.findMany } }),
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
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
  confirmPaymentFromProviderStatus: h.confirm,
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
      provider: 'tap',
      metadata: {},
      amount: 1000,
      currency: 'KWD',
      transactionId: `tx-${id}`,
    },
  ],
});

const step = { run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn() };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTO_CANCEL_RECONCILE_THROTTLE_MS = '0';
  h.findMany.mockResolvedValue([gatewayOrder('o1'), gatewayOrder('o2')]);
  h.getPaymentStatus.mockResolvedValue({ status: 'completed' });
  h.updateStatus.mockResolvedValue(undefined);
});

describe('order-auto-cancel-unpaid — stale confirm on a paid order (#763)', () => {
  it('skips an order that moved on and keeps sweeping the rest', async () => {
    h.confirm
      .mockRejectedValueOnce(
        new AppError(
          400,
          'INVALID_STATUS_TRANSITION',
          'Cannot transition from cancelled to confirmed'
        )
      )
      .mockResolvedValueOnce({ paymentStatus: 'paid', statusChanged: true });

    const r = await h.handler!({ step });

    expect(h.confirm).toHaveBeenCalledTimes(2); // o2 was still processed
    expect(r).toMatchObject({ scanned: 2, rescued: 1, skipped: 1, cancelled: 0 });
    expect(h.updateStatus).not.toHaveBeenCalled(); // a paid order is never auto-cancelled
  });

  it('still throws a non-terminal error so Inngest retries it (control)', async () => {
    h.confirm.mockRejectedValueOnce(new Error('connection reset'));
    await expect(h.handler!({ step })).rejects.toThrow('connection reset');
  });

  it('still throws a 5xx AppError (control)', async () => {
    h.confirm.mockRejectedValueOnce(new AppError(503, 'UPSTREAM', 'db unavailable'));
    await expect(h.handler!({ step })).rejects.toThrow('db unavailable');
  });
});
