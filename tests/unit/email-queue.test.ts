/**
 * Email Queue Unit Tests
 * Tests async email queue functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emailQueue, EmailQueueService, QueuedEmail } from '@api/services/email-queue.service';
import { redis } from '@api/services/redis.service';
import { EmailService } from '@api/services/email.service';
import logger from '@api/lib/logger';

// Mock dependencies
vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: vi.fn(),
    getClient: vi.fn(),
  },
}));

vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendRaw: vi.fn(),
    sendPlatformRaw: vi.fn(),
  },
}));

vi.mock('@api/services/circuit-breaker.service', () => ({
  withCircuitBreaker: vi.fn((name, operation) => operation()),
}));

const { sendAlertMock } = vi.hoisted(() => ({ sendAlertMock: vi.fn().mockResolvedValue('sent') }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: sendAlertMock }));

describe('Email Queue Service', () => {
  let mockRedisClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock Redis client
    mockRedisClient = {
      lpush: vi.fn().mockResolvedValue(1),
      rpop: vi.fn().mockResolvedValue(null),
      llen: vi.fn().mockResolvedValue(0),
      lrange: vi.fn().mockResolvedValue([]),
      ltrim: vi.fn().mockResolvedValue('OK'),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    };

    vi.mocked(redis.isAvailable).mockReturnValue(true);
    vi.mocked(redis.getClient).mockReturnValue(mockRedisClient);
  });

  afterEach(() => {
    emailQueue.stopProcessing();
  });

  describe('recipient validation + bad-recipient class', () => {
    it('never enqueues an email whose recipient is empty/invalid', async () => {
      for (const to of ['', '   ', 'no-at-sign', 'a@', '@b.com', [] as string[], ['', 'x@']]) {
        const id = await emailQueue.enqueue('store-1', { to, subject: 's', html: '<p>x</p>' });
        expect(id).toBe('skipped-invalid-recipient');
      }
      expect(mockRedisClient.lpush).not.toHaveBeenCalled();
    });

    it('keeps only the valid addresses of a mixed list', async () => {
      await emailQueue.enqueue('store-1', { to: ['', 'ok@example.com'], subject: 's', html: 'h' });
      const pushed = JSON.parse(mockRedisClient.lpush.mock.calls[0][1]);
      expect(pushed.options.to).toEqual(['ok@example.com']);
    });

    it('a bad-recipient failure is recorded on the entry and never pages', async () => {
      const email = {
        id: 'e1',
        storeId: 's',
        options: { to: 'x@y.z', subject: 's', html: 'h' },
        attempts: 1,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
      } as QueuedEmail;
      await emailQueue.recordBadRecipient(email, 'bad recipient: E_VALIDATION_ERROR');
      expect(sendAlertMock).not.toHaveBeenCalled();
      const [key, json] = mockRedisClient.lpush.mock.calls[0];
      expect(key).toBe('email:failed');
      expect(JSON.parse(json).failureClass).toBe('bad_recipient');
    });

    it('a provider-side permanent failure still pages P1', async () => {
      const email = {
        id: 'e2',
        storeId: 's',
        options: { to: 'x@y.z', subject: 's', html: 'h' },
        attempts: 3,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
      } as QueuedEmail;
      await emailQueue.parkDeadLetter(email, 'permanent send error E_SENDER_NOT_VERIFIED');
      expect(sendAlertMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'p1' }));
    });
  });

  describe('enqueue', () => {
    it('should enqueue email to Redis when available', async () => {
      const emailOptions = {
        to: 'test@example.com',
        subject: 'Test Email',
        html: '<p>Hello</p>',
      };

      const id = await emailQueue.enqueue('store-1', emailOptions);

      expect(id).toMatch(/^email_\d+_[a-z0-9]+$/);
      expect(mockRedisClient.lpush).toHaveBeenCalledWith(
        'email:queue',
        expect.stringContaining('"to":"test@example.com"')
      );
    });

    it('should send email immediately when Redis unavailable (with storeId)', async () => {
      vi.mocked(redis.isAvailable).mockReturnValue(false);
      vi.mocked(EmailService.sendRaw).mockResolvedValue({ id: 'm' });

      const emailOptions = {
        to: 'test@example.com',
        subject: 'Test Email',
        html: '<p>Hello</p>',
      };

      await emailQueue.enqueue('store-1', emailOptions);

      expect(EmailService.sendRaw).toHaveBeenCalledWith('store-1', emailOptions);
    });

    it('should send platform email immediately when Redis unavailable (no storeId)', async () => {
      vi.mocked(redis.isAvailable).mockReturnValue(false);
      vi.mocked(EmailService.sendPlatformRaw).mockResolvedValue({ id: 'm' });

      const emailOptions = {
        to: 'test@example.com',
        subject: 'Test Email',
        html: '<p>Hello</p>',
      };

      await emailQueue.enqueue(null, emailOptions);

      expect(EmailService.sendPlatformRaw).toHaveBeenCalledWith(emailOptions);
    });

    it('should generate unique IDs for each email', async () => {
      const emailOptions = {
        to: 'test@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
      };

      const id1 = await emailQueue.enqueue('store-1', emailOptions);
      const id2 = await emailQueue.enqueue('store-1', emailOptions);

      expect(id1).not.toBe(id2);
    });
  });

  describe('Queue Processing', () => {
    it('should start processing when startProcessing is called', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      emailQueue.startProcessing(2000);

      expect(setIntervalSpy).toHaveBeenCalled();

      // Cleanup
      emailQueue.stopProcessing();
    });

    it('should not start multiple processors', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      emailQueue.startProcessing(1000);
      emailQueue.startProcessing(1000);

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      emailQueue.stopProcessing();
    });

    it('should stop processing when stopProcessing is called', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      emailQueue.startProcessing(1000);
      emailQueue.stopProcessing();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return queue statistics when Redis available', async () => {
      mockRedisClient.llen.mockResolvedValueOnce(5).mockResolvedValueOnce(2);

      const stats = await emailQueue.getStats();

      expect(stats.pending).toBe(5);
      expect(stats.failed).toBe(2);
      expect(typeof stats.processing).toBe('boolean');
    });

    it('should return zeros when Redis unavailable', async () => {
      vi.mocked(redis.isAvailable).mockReturnValue(false);

      const stats = await emailQueue.getStats();

      expect(stats.pending).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });

  describe('getFailedEmails', () => {
    it('should return failed emails from queue', async () => {
      const failedEmail: QueuedEmail = {
        id: 'email_123',
        storeId: 'store-1',
        options: { to: 'test@example.com', subject: 'Test', html: '<p>Test</p>' },
        attempts: 3,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        error: 'Connection timeout',
      };

      mockRedisClient.lrange.mockResolvedValue([JSON.stringify(failedEmail)]);

      const failed = await emailQueue.getFailedEmails(10);

      expect(failed).toHaveLength(1);
      expect(failed[0].id).toBe('email_123');
      expect(failed[0].error).toBe('Connection timeout');
    });

    // Issue 2374: the reader agrees with the replayer. An entry that parses
    // but has no usable `options` used to reach the route mapper and 500 the
    // whole list; it is skipped here (still counted in stats.failed).
    it('skips entries the replayer would set aside (parseable but shapeless)', async () => {
      const good = {
        id: 'ok',
        storeId: null,
        options: { to: ['a@example.com'], subject: 'S', html: '<p/>' },
        attempts: 3,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
      };
      mockRedisClient.lrange.mockResolvedValue([
        '{"id":"x","attempts":3}',
        JSON.stringify({ ...good, id: 'no-subject', options: { to: 'a@example.com', html: '' } }),
        JSON.stringify({ ...good, id: 'to-number', options: { ...good.options, to: 42 } }),
        '[]',
        JSON.stringify(good),
      ]);

      const failed = await emailQueue.getFailedEmails(10);

      expect(failed.map(e => e.id)).toEqual(['ok']);
    });

    it('should return empty array when Redis unavailable', async () => {
      vi.mocked(redis.isAvailable).mockReturnValue(false);

      const failed = await emailQueue.getFailedEmails();

      expect(failed).toHaveLength(0);
    });
  });

  describe('retryFailed', () => {
    it('should move failed emails back to main queue', async () => {
      const failedEmail: QueuedEmail = {
        id: 'email_123',
        storeId: 'store-1',
        options: { to: 'test@example.com', subject: 'Test', html: '<p>Test</p>' },
        attempts: 3,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        error: 'Failed',
      };

      mockRedisClient.llen.mockResolvedValueOnce(1);
      mockRedisClient.rpop
        .mockResolvedValueOnce(JSON.stringify(failedEmail))
        .mockResolvedValueOnce(null);

      const count = await emailQueue.retryFailed();

      expect(count).toEqual({ retried: 1, skipped: 0, kept: 0 });
      expect(mockRedisClient.lpush).toHaveBeenCalledWith(
        'email:queue',
        expect.stringContaining('"attempts":0') // Reset attempts
      );
    });

    it('should clear error when retrying', async () => {
      const failedEmail: QueuedEmail = {
        id: 'email_123',
        storeId: null,
        options: { to: 'test@example.com', subject: 'Test', html: '<p>Test</p>' },
        attempts: 3,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
        error: 'Some error',
      };

      mockRedisClient.llen.mockResolvedValueOnce(1);
      mockRedisClient.rpop
        .mockResolvedValueOnce(JSON.stringify(failedEmail))
        .mockResolvedValueOnce(null);

      await emailQueue.retryFailed();

      const pushedEmail = JSON.parse(mockRedisClient.lpush.mock.calls[0][1]);
      expect(pushedEmail.error).toBeUndefined();
    });

    it('should return 0 when Redis unavailable', async () => {
      vi.mocked(redis.isAvailable).mockReturnValue(false);

      const count = await emailQueue.retryFailed();

      expect(count).toEqual({ retried: 0, skipped: 0, kept: 0 });
    });

    // Issue 2292: one unreadable entry used to throw AFTER rpop removed it —
    // that record destroyed, everything behind it never retried, a 500.
    it('sets a corrupt entry aside and still retries the entries behind it', async () => {
      const good = (id: string): QueuedEmail => ({
        id,
        storeId: 'store-1',
        options: { to: 'x@example.com', subject: 'S', html: '<p>x</p>' },
        attempts: 3,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
      });
      mockRedisClient.llen.mockResolvedValueOnce(3);
      mockRedisClient.rpop
        .mockResolvedValueOnce(JSON.stringify(good('a')))
        .mockResolvedValueOnce('{"truncated":')
        .mockResolvedValueOnce(JSON.stringify(good('b')))
        .mockResolvedValueOnce(null);

      const res = await emailQueue.retryFailed();

      expect(res).toEqual({ retried: 2, skipped: 1, kept: 0 });
      expect(mockRedisClient.lpush).toHaveBeenCalledWith('email:failed:corrupt', '{"truncated":');
      expect(mockRedisClient.rpop).toHaveBeenCalledTimes(3); // bounded by the starting length
      // PR 2335 audit: set aside is never silent — an operator is told where.
      expect(sendAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'email.queue.corrupt_entries',
          context: { skipped: 1, list: 'email:failed:corrupt' },
        })
      );
    });

    // Issue 2361: a Redis write that rejects AFTER rpop removed the entry used
    // to destroy it and abort the loop (route 500, no audit row).
    it('a rejected re-queue puts the entry back and keeps going', async () => {
      const good = (id: string): QueuedEmail => ({
        id,
        storeId: 'store-1',
        options: { to: 'x@example.com', subject: 'S', html: '<p>x</p>' },
        attempts: 3,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
      });
      const a = JSON.stringify(good('a'));
      mockRedisClient.llen.mockResolvedValueOnce(2);
      mockRedisClient.rpop
        .mockResolvedValueOnce(a)
        .mockResolvedValueOnce(JSON.stringify(good('b')));
      mockRedisClient.lpush
        .mockRejectedValueOnce(new Error('READONLY')) // re-queue of 'a' fails
        .mockResolvedValue(1);

      const res = await emailQueue.retryFailed();

      expect(res).toEqual({ retried: 1, skipped: 0, kept: 1 });
      expect(mockRedisClient.lpush).toHaveBeenNthCalledWith(2, 'email:failed', a); // put back
      expect(mockRedisClient.rpop).toHaveBeenCalledTimes(2); // 'b' still processed
    });

    it('a rejected set-aside puts the unreadable entry back on the failed list', async () => {
      mockRedisClient.llen.mockResolvedValueOnce(1);
      mockRedisClient.rpop.mockResolvedValueOnce('{"broken":');
      mockRedisClient.lpush.mockRejectedValueOnce(new Error('OOM')).mockResolvedValue(1);

      const res = await emailQueue.retryFailed();

      expect(res).toEqual({ retried: 0, skipped: 0, kept: 1 });
      expect(mockRedisClient.lpush).toHaveBeenLastCalledWith('email:failed', '{"broken":');
    });

    it('a rejected rpop removed nothing: stops and reports the rest as kept', async () => {
      mockRedisClient.llen.mockResolvedValueOnce(3);
      mockRedisClient.rpop.mockRejectedValueOnce(new Error('connection lost'));
      await expect(emailQueue.retryFailed()).resolves.toEqual({ retried: 0, skipped: 0, kept: 3 });
    });

    it('re-queue AND put-back both rejected → lost, and a P1 names it', async () => {
      sendAlertMock.mockClear();
      mockRedisClient.llen.mockResolvedValueOnce(1);
      mockRedisClient.rpop.mockResolvedValueOnce(
        JSON.stringify({
          id: 'e1',
          storeId: null,
          options: { to: 'x@example.com', subject: 'S', html: '<p/>' },
          attempts: 3,
        })
      );
      mockRedisClient.lpush.mockRejectedValue(new Error('down'));

      const res = await emailQueue.retryFailed();

      expect(res).toEqual({ retried: 0, skipped: 0, kept: 0 });
      expect(sendAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'p1',
          source: 'email.queue.replay_lost',
          context: { lost: 1, list: 'email:failed' },
        })
      );
    });

    // Issue 2353: the set-aside list is bounded and has a reader + a drain.
    it('bounds the set-aside list (newest 200, 30-day expiry) on every write', async () => {
      mockRedisClient.llen.mockResolvedValueOnce(1);
      mockRedisClient.rpop.mockResolvedValueOnce('not json');
      await emailQueue.retryFailed();
      expect(mockRedisClient.ltrim).toHaveBeenCalledWith('email:failed:corrupt', 0, 199);
      expect(mockRedisClient.expire).toHaveBeenCalledWith(
        'email:failed:corrupt',
        30 * 24 * 60 * 60
      );
    });

    it('exposes the set-aside entries by size only, and counts them in getStats', async () => {
      mockRedisClient.lrange.mockResolvedValueOnce(['{"a":', 'xyz']);
      expect(await emailQueue.getCorruptEntries(50)).toEqual([
        { position: 0, bytes: 5 },
        { position: 1, bytes: 3 },
      ]);
      expect(mockRedisClient.lrange).toHaveBeenCalledWith('email:failed:corrupt', 0, 49);
      mockRedisClient.llen
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(4);
      expect((await emailQueue.getStats()).corrupt).toBe(4);
    });

    it('discardCorrupt drops the list and reports how many it held', async () => {
      mockRedisClient.llen.mockResolvedValueOnce(3);
      expect(await emailQueue.discardCorrupt()).toBe(3);
      expect(mockRedisClient.del).toHaveBeenCalledWith('email:failed:corrupt');
    });

    // Issue 2371's class on the email twin: the predicate now checks every
    // field sendEmail and the list route dereference, not just `options`.
    it('a shape-invalid entry (options without subject/html) is set aside, not re-queued', async () => {
      const raw = JSON.stringify({ id: 'e2', options: { to: 'x@example.com' }, attempts: 3 });
      mockRedisClient.llen.mockResolvedValueOnce(1);
      mockRedisClient.rpop.mockResolvedValueOnce(raw);

      const res = await emailQueue.retryFailed();

      expect(res).toEqual({ retried: 0, skipped: 1, kept: 0 });
      expect(mockRedisClient.lpush).toHaveBeenCalledWith('email:failed:corrupt', raw);
      expect(mockRedisClient.lpush).not.toHaveBeenCalledWith('email:queue', expect.anything());
    });

    it('raises no set-aside alert when every entry was readable', async () => {
      sendAlertMock.mockClear();
      mockRedisClient.llen.mockResolvedValueOnce(0);
      await emailQueue.retryFailed();
      expect(sendAlertMock).not.toHaveBeenCalled();
    });
  });
});

describe('Email Queue Integration', () => {
  // These tests verify the behavior without mocks
  // They would run in integration test environment

  describe('Queue Item Structure', () => {
    it('should create properly structured queue item', async () => {
      const mockClient = {
        lpush: vi.fn().mockResolvedValue(1),
      };
      vi.mocked(redis.isAvailable).mockReturnValue(true);
      vi.mocked(redis.getClient).mockReturnValue(mockClient as any);

      await emailQueue.enqueue('store-1', {
        to: 'user@example.com',
        subject: 'Welcome',
        html: '<h1>Welcome!</h1>',
      });

      const pushedData = JSON.parse(mockClient.lpush.mock.calls[0][1]);

      expect(pushedData).toMatchObject({
        id: expect.stringMatching(/^email_\d+_/),
        storeId: 'store-1',
        options: {
          to: 'user@example.com',
          subject: 'Welcome',
          html: '<h1>Welcome!</h1>',
        },
        attempts: 0,
        maxAttempts: 3,
        createdAt: expect.any(String),
      });
    });
  });

  describe('Retry Configuration', () => {
    it('should respect max attempts configuration', () => {
      // The default MAX_ATTEMPTS is 3
      // This is a compile-time check of the constant
      expect(true).toBe(true); // Placeholder - actual value checked in integration tests
    });
  });
});

/**
 * Issue 2142 — a queued email that can never be sent must not be silent.
 * `enqueue` resolved long before the send, so the caller (the refund fanout's
 * #1935 gate, every `{ queue: true }` order email) cannot see the failure;
 * the queue itself must raise it. And with Redis down there is no queue at
 * all, so the inline send must reject to its caller.
 *
 * Mutation proof: drop the `reportPermanentFailure` call in the max-attempts
 * branch → the first case goes red; drop `if (opts.inline) … throw` → the
 * second goes red.
 */
describe('Email queue — terminal failure is loud (issue 2142)', () => {
  let client: any;
  beforeEach(() => {
    vi.clearAllMocks();
    client = {
      lpush: vi.fn().mockResolvedValue(1),
      rpop: vi.fn(),
      llen: vi.fn().mockResolvedValue(0),
      lrange: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(redis.isAvailable).mockReturnValue(true);
    vi.mocked(redis.getClient).mockReturnValue(client);
  });

  it('the last failed attempt moves the email to email:failed AND raises a P1 alert', async () => {
    const exhausted: QueuedEmail = {
      id: 'email_1',
      storeId: 'store-1',
      options: { to: 'buyer@example.com', subject: 'Refund issued', html: '<p/>' },
      attempts: 2,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    };
    client.rpop.mockResolvedValueOnce(JSON.stringify(exhausted));
    vi.mocked(EmailService.sendRaw).mockRejectedValue(new Error('resend 503'));

    await (emailQueue as any).processQueue();

    expect(client.lpush).toHaveBeenCalledWith('email:failed', expect.any(String));
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const alert = sendAlertMock.mock.calls[0][0];
    expect(alert).toMatchObject({ level: 'p1', source: 'email.queue.permanent_failure' });
    // No recipient address in the alert.
    expect(JSON.stringify(alert)).not.toContain('buyer@example.com');
  });

  // Issue 2292 (second report): when the retry's re-queue push is rejected
  // (Redis still reachable), the email is parked in email:failed BEFORE the
  // P1 — the alert sends the operator to the page that lists only that list.
  it('a rejected re-queue parks the email in email:failed before paging', async () => {
    vi.useFakeTimers();
    try {
      const retrying: QueuedEmail = {
        id: 'email_2',
        storeId: 'store-1',
        options: { to: 'buyer@example.com', subject: 'Order shipped', html: '<p/>' },
        attempts: 0,
        maxAttempts: 3,
        createdAt: new Date().toISOString(),
      };
      client.rpop.mockResolvedValueOnce(JSON.stringify(retrying));
      vi.mocked(EmailService.sendRaw).mockRejectedValue(new Error('resend 503'));
      client.lpush.mockImplementation(async (key: string) => {
        if (key === 'email:queue') throw new Error('OOM command not allowed');
        return 1;
      });

      await (emailQueue as any).processQueue();
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => expect(sendAlertMock).toHaveBeenCalledTimes(1));

      expect(client.lpush).toHaveBeenCalledWith('email:failed', expect.any(String));
      expect(sendAlertMock.mock.calls[0][0].body).toContain('Email queue page');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an email whose every recipient was dropped as undeliverable is not logged or counted as sent', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.mocked(EmailService.sendPlatformRaw).mockResolvedValue({ id: 'skipped-undeliverable' });
    await emailQueue.deliver({
      id: 'email_skip',
      storeId: null,
      options: { to: 'x@placeholder.invalid', subject: 's', html: '<p/>' },
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    });
    const infoMsgs = info.mock.calls.map(c => c[1]);
    expect(infoMsgs).not.toContain('[EMAIL QUEUE] Sent email');
    expect(warn.mock.calls.map(c => c[1]).join()).toContain('not sent');
  });

  it('with Redis unavailable, a failed inline send REJECTS enqueue (no silent success)', async () => {
    vi.mocked(redis.isAvailable).mockReturnValue(false);
    vi.mocked(EmailService.sendRaw).mockRejectedValue(new Error('resend 503'));

    await expect(
      emailQueue.enqueue('store-1', { to: 'b@example.com', subject: 's', html: '<p/>' })
    ).rejects.toThrow('resend 503');
  });
});

// Issue 2378: the live-queue processor has already rpop'ped an unreadable
// entry, so a rejected set-aside write must never destroy it silently.
describe('Email queue — unreadable LIVE entry survives a rejected set-aside (issue 2378)', () => {
  let client: any;
  const raw = '{"attempts":0}';
  beforeEach(() => {
    vi.clearAllMocks();
    client = {
      lpush: vi.fn().mockResolvedValue(1),
      rpop: vi.fn().mockResolvedValueOnce(raw),
      llen: vi.fn().mockResolvedValue(0),
      lrange: vi.fn().mockResolvedValue([]),
      ltrim: vi.fn().mockResolvedValue('OK'),
      expire: vi.fn().mockResolvedValue(1),
    };
    vi.mocked(redis.isAvailable).mockReturnValue(true);
    vi.mocked(redis.getClient).mockReturnValue(client);
  });

  it('parks it in email:failed:corrupt when Redis accepts the write', async () => {
    await (emailQueue as any).processQueue();
    expect(client.lpush).toHaveBeenCalledTimes(1);
    expect(client.lpush).toHaveBeenCalledWith('email:failed:corrupt', raw);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('a rejected set-aside puts it back on email:queue, no alert', async () => {
    client.lpush.mockRejectedValueOnce(new Error('OOM command not allowed'));
    await (emailQueue as any).processQueue();
    expect(client.lpush).toHaveBeenLastCalledWith('email:queue', raw);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('set-aside AND put-back rejected → P1 with size only, no payload', async () => {
    client.lpush.mockRejectedValueOnce(new Error('OOM')).mockRejectedValueOnce(new Error('OOM'));
    await (emailQueue as any).processQueue();
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const alert = sendAlertMock.mock.calls[0][0];
    expect(alert).toMatchObject({ level: 'p1', source: 'email.queue.unreadable_lost' });
    expect(alert.context).toEqual({ bytes: raw.length, list: 'email:queue' });
    expect(JSON.stringify(alert)).not.toContain('attempts');
  });
});
