/**
 * Issues 2001 / 2025 / 2026 / 2032 — the unbooked-refund alert.
 *
 * sendAlert throttles on `level:title:storeId` for 5 minutes. Every call site
 * used ONE constant title, so a second unbooked partial refund on the same
 * store inside the window was dropped; the alert was also awaited inline on
 * the refund request path while the tenant transaction was open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendAlert: vi.fn(async () => 'sent' as const),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  deferred: [] as Array<() => Promise<unknown>>,
  options: [] as Array<{ runOnRollback?: boolean } | undefined>,
}));

vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { error: h.loggerError, warn: h.loggerWarn, info: vi.fn(), debug: vi.fn() },
}));
// Simulate an HTTP request scope: the task is QUEUED, not run.
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: (
    _name: string,
    run: () => Promise<unknown>,
    options?: { runOnRollback?: boolean }
  ) => {
    h.deferred.push(run);
    h.options.push(options);
    return Promise.resolve(null);
  },
}));

import {
  alertUnbookedRefund,
  unbookedRefundAlertOptions,
} from '@api/services/payment-providers/unbooked-refund-alert';

const base = {
  kind: 'partial_no_gl' as const,
  store: { id: 'store-1', name: 'Store' },
  body: 'b',
  context: { paymentId: 'pay-1', refundId: 'rf-1' },
};

beforeEach(() => {
  h.sendAlert.mockClear();
  h.loggerError.mockClear();
  h.deferred.length = 0;
  h.options.length = 0;
});

describe('unbooked-refund alert', () => {
  it('two different orders get two different throttle titles', () => {
    const a = unbookedRefundAlertOptions({ ...base, orderRef: 'ORD-1' });
    const b = unbookedRefundAlertOptions({ ...base, orderRef: 'ORD-2' });
    expect(a.title).not.toBe(b.title);
    expect(a.title).toContain('ORD-1');
    expect(a.source).toBe('payment.refund.partial_no_gl');
  });

  it('writes an error log line with the ids BEFORE and regardless of delivery', async () => {
    await alertUnbookedRefund({ ...base, orderRef: 'ORD-1' });
    expect(h.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ orderRef: 'ORD-1', paymentId: 'pay-1', refundId: 'rf-1' }),
      expect.any(String)
    );
  });

  it('inside a request it does NOT call Telegram inline — the send is deferred to after COMMIT', async () => {
    await alertUnbookedRefund({ ...base, orderRef: 'ORD-1' });
    expect(h.sendAlert).not.toHaveBeenCalled();
    expect(h.deferred).toHaveLength(1);
    await h.deferred[0]();
    expect(h.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('ORD-1') })
    );
  });

  it('survives a rollback: the refund already left the gateway (runOnRollback)', async () => {
    await alertUnbookedRefund({ ...base, orderRef: 'ORD-1' });
    expect(h.options[0]).toEqual({ runOnRollback: true });
  });
});
