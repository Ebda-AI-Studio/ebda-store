/**
 * Issue 2379 — the orphaned-invoice page must not hold the caller.
 *
 * `PaymentService.createPayment` raises this from inside the request's
 * tenant transaction, already aborted by the failed Payment write. Awaiting
 * the Telegram POST (capped at 5s) there pinned that pooled connection for
 * the whole send, once per failed checkout, during the DB incident that
 * caused the failure. The helper now writes its error log line (the durable
 * record) synchronously and dispatches the page in the background.
 *
 * Mutation-proof: `await dispatchOrphanPage(...)` instead of `void` reddens
 * "resolves while the page is still in flight" (the helper never resolves
 * against a send that never settles).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendAlert: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({ default: h.log }));

import { alertOrphanedProviderInvoice } from '@api/services/payment-providers/orphaned-invoice-alert';

const invoice = {
  storeId: '11111111-1111-4111-8111-111111111111',
  orderId: 'order-1',
  orderNumber: 'ORD-1001',
  provider: 'myfatoorah',
  transactionId: 'mf-123',
  amount: 12500,
  currency: 'EGP',
  source: 'record' as const,
};

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('alertOrphanedProviderInvoice (issue 2379)', () => {
  it('resolves while the page is still in flight, with the error log already written', async () => {
    h.sendAlert.mockReturnValue(new Promise(() => undefined)); // never settles
    const settled = await Promise.race([
      alertOrphanedProviderInvoice(invoice).then(() => 'resolved'),
      new Promise(r => setTimeout(() => r('blocked'), 50)),
    ]);
    expect(settled).toBe('resolved');
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'mf-123', orderId: 'order-1' }),
      expect.stringContaining('ORD-1001')
    );
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    expect(h.sendAlert.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      source: 'payment.create.orphaned_invoice.record',
    });
  });

  it('a rejecting send is caught and logged — never an unhandled rejection', async () => {
    h.sendAlert.mockRejectedValue(new Error('telegram 502'));
    await expect(alertOrphanedProviderInvoice(invoice)).resolves.toBeUndefined();
    await flush();
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1' }),
      '[payment] orphaned-invoice alert threw'
    );
  });

  it('an undelivered (throttled) page still warns that the log line is the record', async () => {
    h.sendAlert.mockResolvedValue('throttled');
    await alertOrphanedProviderInvoice(invoice);
    await flush();
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'mf-123', outcome: 'throttled' }),
      expect.stringContaining('not delivered')
    );
  });
});
