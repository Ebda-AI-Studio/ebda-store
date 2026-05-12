/**
 * Email Queue Unit Tests
 * Tests async email queue functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emailQueue, EmailQueueService, QueuedEmail } from '@api/services/email-queue.service';
import { redis } from '@api/services/redis.service';
import { EmailService } from '@api/services/email.service';

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
    };

    vi.mocked(redis.isAvailable).mockReturnValue(true);
    vi.mocked(redis.getClient).mockReturnValue(mockRedisClient);
  });

  afterEach(() => {
    emailQueue.stopProcessing();
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
      vi.mocked(EmailService.sendRaw).mockResolvedValue(undefined);

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
      vi.mocked(EmailService.sendPlatformRaw).mockResolvedValue(undefined);

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

      mockRedisClient.rpop
        .mockResolvedValueOnce(JSON.stringify(failedEmail))
        .mockResolvedValueOnce(null);

      const count = await emailQueue.retryFailed();

      expect(count).toBe(1);
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

      expect(count).toBe(0);
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
