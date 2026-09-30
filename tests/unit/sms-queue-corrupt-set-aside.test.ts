/**
 * Issue 2353: the SMS twin of the email queue's set-aside path. An unreadable
 * dead-lettered SMS is parked in a BOUNDED list (newest 200, 30-day expiry)
 * and raises the same P1 as email — it used to be parked with no alert, no
 * reader and no bound.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  client: {
    lpush: vi.fn(async () => 1),
    rpop: vi.fn(),
    llen: vi.fn(),
    ltrim: vi.fn(async () => 'OK'),
    expire: vi.fn(async () => 1),
  },
  sendAlert: vi.fn(async () => undefined),
}));

vi.mock('@force/database', () => ({ prisma: {} }));
vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: () => true, getClient: () => h.client },
}));
vi.mock('@api/services/sms.service', () => ({ smsService: {} }));
vi.mock('@api/services/circuit-breaker.service', () => ({
  withCircuitBreaker: vi.fn(),
  circuitBreaker: {},
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { smsQueue } from '@api/services/sms-queue.service';

beforeEach(() => vi.clearAllMocks());

describe('sms queue set-aside (issue 2353)', () => {
  it('parks an unreadable entry in a bounded list and alerts', async () => {
    h.client.llen.mockResolvedValueOnce(2);
    h.client.rpop
      .mockResolvedValueOnce('{"broken":')
      .mockResolvedValueOnce(JSON.stringify({ id: 's1', to: '+965', attempts: 3 }));
    const res = await smsQueue.retryFailed();
    expect(res).toEqual({ retried: 1, skipped: 1 });
    expect(h.client.lpush).toHaveBeenCalledWith('sms:failed:corrupt', '{"broken":');
    expect(h.client.ltrim).toHaveBeenCalledWith('sms:failed:corrupt', 0, 199);
    expect(h.client.expire).toHaveBeenCalledWith('sms:failed:corrupt', 30 * 24 * 60 * 60);
    expect(h.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'p1',
        source: 'sms.queue.corrupt_entries',
        context: { skipped: 1, list: 'sms:failed:corrupt' },
      })
    );
  });

  it('no alert when every entry was readable', async () => {
    h.client.llen.mockResolvedValueOnce(0);
    await smsQueue.retryFailed();
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
});
