/**
 * Issue 2353: the SMS twin of the email queue's set-aside path. An unreadable
 * dead-lettered SMS is parked in a BOUNDED list (newest 200, 30-day expiry)
 * and raises the same P1 as email — it used to be parked with no alert, no
 * reader and no bound.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  client: {
    lpush: vi.fn(async (..._a: unknown[]) => 1 as unknown),
    rpop: vi.fn(),
    llen: vi.fn(),
    lrange: vi.fn(async () => [] as string[]),
    del: vi.fn(async () => 1),
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

beforeEach(() => {
  vi.clearAllMocks();
  h.client.lpush.mockReset().mockResolvedValue(1);
});

describe('sms queue set-aside (issue 2353)', () => {
  it('parks an unreadable entry in a bounded list and alerts', async () => {
    h.client.llen.mockResolvedValueOnce(2);
    h.client.rpop
      .mockResolvedValueOnce('{"broken":')
      .mockResolvedValueOnce(JSON.stringify({ id: 's1', to: '+965', attempts: 3 }));
    const res = await smsQueue.retryFailed();
    expect(res).toEqual({ retried: 1, skipped: 1, kept: 0 });
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

  // Issue 2361 (the SMS twin): a rejected re-queue after rpop keeps the entry.
  it('a rejected re-queue puts the SMS back and keeps going', async () => {
    const a = JSON.stringify({ id: 'a', recipientPhone: '+96512345678', attempts: 3 });
    h.client.llen.mockResolvedValueOnce(2);
    h.client.rpop
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(
        JSON.stringify({ id: 'b', recipientPhone: '+96512345679', attempts: 3 })
      );
    h.client.lpush.mockRejectedValueOnce(new Error('READONLY')).mockResolvedValue(1);

    const res = await smsQueue.retryFailed();

    expect(res).toEqual({ retried: 1, skipped: 0, kept: 1 });
    expect(h.client.lpush).toHaveBeenNthCalledWith(2, 'sms:failed', a);
  });

  // Issue 2363: the set-aside list now has a reader and a drain.
  it('exposes set-aside entries by size, counts them, and discards them', async () => {
    h.client.lrange.mockResolvedValueOnce(['{"a":', 'xyz']);
    expect(await smsQueue.getCorruptEntries(50)).toEqual([
      { position: 0, bytes: 5 },
      { position: 1, bytes: 3 },
    ]);
    expect(h.client.lrange).toHaveBeenCalledWith('sms:failed:corrupt', 0, 49);
    h.client.llen.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(4);
    expect((await smsQueue.getStats()).corrupt).toBe(4);
    h.client.llen.mockResolvedValueOnce(3);
    expect(await smsQueue.discardCorrupt()).toBe(3);
    expect(h.client.del).toHaveBeenCalledWith('sms:failed:corrupt');
  });
});
