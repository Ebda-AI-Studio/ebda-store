/**
 * #625: a status poll whose answer stated no amount tells the DO so (`amountUnverified`), and one that stated it does not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  paymentWebhook: vi.fn(async () => ({
    outcome: 'replayed',
    paymentId: 'p1',
    orderId: 'o1',
    paymentStatus: 'completed',
    orderStatus: 'confirmed',
    alerts: [],
    postCommit: [],
  })),
}));
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeMoney: async () => ({ paymentWebhook: h.paymentWebhook }),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => undefined) }));

const { PaymentService } = await import('@api/services/payment-providers/payment.factory');

const pay = { provider: 'kashier', transactionId: 'tx-1', amount: 85000, currency: 'EGP' };

describe('applyPolledStatusOnDo amountUnverified (#625)', () => {
  beforeEach(() => h.paymentWebhook.mockClear());

  it('no paidAmount in the answer: confirms at the payment amount, flagged unverified', async () => {
    await PaymentService.applyPolledStatusOnDo('s1', pay, 'completed', {});
    const input = (h.paymentWebhook.mock.calls[0] as any)[0].input;
    expect(input).toMatchObject({ amount: 85000, amountUnverified: true });
  });

  it('a stated paidAmount is passed as the gateway said it, not flagged', async () => {
    await PaymentService.applyPolledStatusOnDo('s1', pay, 'completed', { paidAmount: 40000 });
    const input = (h.paymentWebhook.mock.calls[0] as any)[0].input;
    expect(input).toMatchObject({ amount: 40000, amountUnverified: false });
  });
});
