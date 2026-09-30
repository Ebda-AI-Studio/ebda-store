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

  notificationLog: {
    findUnique: vi.fn(async () => null as unknown),
    upsert: vi.fn(async () => ({})),
  },
  sendSms: vi.fn(async () => ({ messageId: 'm1' })),
}));

vi.mock('@force/database', () => ({ prisma: { notificationLog: h.notificationLog } }));
vi.mock('@api/services/redis.service', () => ({
  redis: { isAvailable: () => true, getClient: () => h.client },
}));
vi.mock('@api/services/sms.service', () => ({ smsService: { sendSms: h.sendSms } }));
vi.mock('@api/services/circuit-breaker.service', () => ({
  withCircuitBreaker: (_k: string, fn: () => unknown) => fn(),
  circuitBreaker: { getState: () => true, register: () => undefined },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { smsQueue, isQueuedSms } from '@api/services/sms-queue.service';

/** A complete dead-lettered SMS — every field `sendSms` dereferences. */
const sms = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  storeId: 'store-1',
  event: 'order.confirmed',
  recipientPhone: '+96512345678',
  messageText: 'Your order is confirmed',
  config: { provider: 'twilio' },
  idempotencyKey: `idem-${id}`,
  attempts: 3,
  maxAttempts: 3,
  createdAt: '2026-09-30T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.client.lpush.mockReset().mockResolvedValue(1);
});

describe('sms queue set-aside (issue 2353)', () => {
  it('parks an unreadable entry in a bounded list and alerts', async () => {
    h.client.llen.mockResolvedValueOnce(2);
    h.client.rpop
      .mockResolvedValueOnce('{"broken":')
      .mockResolvedValueOnce(JSON.stringify(sms('s1')));
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
    const a = JSON.stringify(sms('a'));
    h.client.llen.mockResolvedValueOnce(2);
    h.client.rpop.mockResolvedValueOnce(a).mockResolvedValueOnce(JSON.stringify(sms('b')));
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

  // Issue 2371: the replay predicate used to accept ANY object, so a
  // parseable-but-shapeless entry was re-queued and then destroyed by
  // sendSms (Prisma rejects `idempotencyKey: undefined`, outside the try).
  it.each([
    ['empty object', '{}'],
    ['array', '[1,2]'],
    ['no idempotencyKey', JSON.stringify(sms('x', { idempotencyKey: undefined }))],
    ['no recipientPhone', JSON.stringify(sms('x', { recipientPhone: null }))],
    ['no config', JSON.stringify(sms('x', { config: undefined }))],
  ])('a shape-invalid (%s) entry is set aside, never re-queued', async (_n, raw) => {
    h.client.llen.mockResolvedValueOnce(1);
    h.client.rpop.mockResolvedValueOnce(raw);
    const res = await smsQueue.retryFailed();
    expect(res).toEqual({ retried: 0, skipped: 1, kept: 0 });
    expect(h.client.lpush).toHaveBeenCalledWith('sms:failed:corrupt', raw);
    expect(h.client.lpush).not.toHaveBeenCalledWith('sms:queue', expect.anything());
  });

  // Issue 2374: the reader agrees with the replayer — a shapeless entry is not
  // listed (it stays counted in stats.failed and shows as "unreadable").
  it('getFailedMessages lists only entries the replayer would re-queue', async () => {
    h.client.lrange.mockResolvedValueOnce(['{}', JSON.stringify(sms('ok')), '{"broken":']);
    const listed = await smsQueue.getFailedMessages(10);
    expect(listed.map(m => m.id)).toEqual(['ok']);
    expect(isQueuedSms(sms('ok'))).toBe(true);
  });

  // Issue 2371 (second half): the idempotency lookup sits inside the try now,
  // so a DB blip there retries/dead-letters instead of dropping the SMS.
  it('a throwing idempotency lookup on the last attempt dead-letters the SMS', async () => {
    h.notificationLog.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    h.client.rpop.mockResolvedValueOnce(JSON.stringify(sms('z', { attempts: 2 })));
    await smsQueue.processQueue();
    expect(h.client.lpush).toHaveBeenCalledWith('sms:failed', expect.stringContaining('"id":"z"'));
    expect(h.sendSms).not.toHaveBeenCalled();
  });

  it('a shapeless entry on the LIVE queue is set aside, not destroyed', async () => {
    h.client.rpop.mockResolvedValueOnce('{"attempts":0}');
    await smsQueue.processQueue();
    expect(h.client.lpush).toHaveBeenCalledWith('sms:failed:corrupt', '{"attempts":0}');
    expect(h.notificationLog.findUnique).not.toHaveBeenCalled();
  });
});
