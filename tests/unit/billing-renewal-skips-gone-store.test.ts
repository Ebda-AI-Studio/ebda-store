/**
 * Production 2026-11-11: `billing-renewal-daily` failed with `AppError: This store is no longer available`
 * (410 STORE_STORAGE_REMOVED). One closed / removed store must be SKIPPED (logged), never fail the whole run; a real
 * failure (503) still throws so Inngest retries and alerts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@api/middleware/error-handler';

const h = vi.hoisted(() => ({ getEntityStoreId: vi.fn(), warn: vi.fn() }));

vi.mock('@api/lib/definer', () => ({ getEntityStoreId: h.getEntityStoreId }));
vi.mock('@ebda/database', () => ({
  prisma: {},
  withStore: vi.fn(),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() },
}));

import { renewSubscription } from '@api/services/billing/subscription-billing.service';
import { sendDueReminder } from '@api/services/billing/reminders.service';

beforeEach(() => vi.clearAllMocks());

describe('daily billing skips a store that is gone', () => {
  it('renewSubscription skips on 410 STORE_STORAGE_REMOVED', async () => {
    h.getEntityStoreId.mockRejectedValue(
      new AppError(410, 'STORE_STORAGE_REMOVED', 'This store is no longer available')
    );
    await expect(renewSubscription('sub1')).resolves.toEqual({
      action: 'skipped',
      reason: 'store_gone',
    });
    expect(h.warn).toHaveBeenCalled();
  });
  it('sendDueReminder skips on 404 STORE_NOT_FOUND', async () => {
    h.getEntityStoreId.mockRejectedValue(new AppError(404, 'STORE_NOT_FOUND', 'Store not found'));
    await expect(sendDueReminder('sub1')).resolves.toEqual({ sent: false, reason: 'store_gone' });
  });
  it('still throws a real failure (503) so it retries and alerts', async () => {
    h.getEntityStoreId.mockRejectedValue(new AppError(503, 'UNAVAILABLE', 'down'));
    await expect(renewSubscription('sub1')).rejects.toThrow('down');
    await expect(sendDueReminder('sub1')).rejects.toThrow('down');
  });
});
