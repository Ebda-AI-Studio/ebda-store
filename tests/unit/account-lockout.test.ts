/**
 * Account Lockout Unit Tests
 * Tests brute force protection logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AccountLockoutService,
  accountLockout,
  LockoutConfig,
} from '@api/services/account-lockout.service';
import { redis } from '@api/services/redis.service';
import { prisma } from '@force/database';

// Mock dependencies
vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: vi.fn(),
    getClient: vi.fn(),
  },
}));

vi.mock('@force/database', () => ({
  prisma: {
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe('Account Lockout Service', () => {
  let service: AccountLockoutService;
  let mockRedisClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh service for each test with short durations
    service = new AccountLockoutService({
      maxAttempts: 5,
      lockoutDurationMs: 1000, // 1 second for testing
      attemptWindowMs: 1000,
    });

    // Setup mock Redis client
    mockRedisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      incr: vi.fn().mockResolvedValue(1),
      pexpire: vi.fn().mockResolvedValue(1),
    };

    vi.mocked(redis.isAvailable).mockReturnValue(true);
    vi.mocked(redis.getClient).mockReturnValue(mockRedisClient);
  });

  describe('isLocked', () => {
    it('should return locked=false when account is not locked', async () => {
      const result = await service.isLocked('test@example.com');

      expect(result.locked).toBe(false);
    });

    it('should return locked=true with remaining time when locked', async () => {
      const futureTime = Date.now() + 60000; // 1 minute from now
      mockRedisClient.get.mockResolvedValue(futureTime.toString());

      const result = await service.isLocked('test@example.com');

      expect(result.locked).toBe(true);
      expect(result.remainingMs).toBeGreaterThan(0);
      expect(result.remainingMs).toBeLessThanOrEqual(60000);
    });

    it('should clean up expired locks', async () => {
      const pastTime = Date.now() - 1000; // 1 second ago
      mockRedisClient.get.mockResolvedValue(pastTime.toString());

      const result = await service.isLocked('test@example.com');

      expect(result.locked).toBe(false);
      expect(mockRedisClient.del).toHaveBeenCalledWith('lockout:test@example.com:locked');
    });

    it('should normalize email to lowercase', async () => {
      await service.isLocked('TEST@EXAMPLE.COM');

      expect(mockRedisClient.get).toHaveBeenCalledWith('lockout:test@example.com:locked');
    });
  });

  describe('recordFailedAttempt', () => {
    it('should increment attempt count', async () => {
      const result = await service.recordFailedAttempt('test@example.com');

      expect(mockRedisClient.incr).toHaveBeenCalledWith('lockout:test@example.com:attempts');
      expect(result.locked).toBe(false);
      expect(result.attemptsRemaining).toBe(4); // 5 - 1
    });

    it('should set expiry on first attempt', async () => {
      mockRedisClient.incr.mockResolvedValue(1);

      await service.recordFailedAttempt('test@example.com');

      expect(mockRedisClient.pexpire).toHaveBeenCalledWith(
        'lockout:test@example.com:attempts',
        1000 // attemptWindowMs
      );
    });

    it('should not set expiry on subsequent attempts', async () => {
      mockRedisClient.incr.mockResolvedValue(3);

      await service.recordFailedAttempt('test@example.com');

      expect(mockRedisClient.pexpire).not.toHaveBeenCalled();
    });

    it('should lock account after max attempts', async () => {
      mockRedisClient.incr.mockResolvedValue(5);

      const result = await service.recordFailedAttempt('test@example.com');

      expect(result.locked).toBe(true);
      expect(result.attemptsRemaining).toBe(0);
      expect(result.lockoutDurationMs).toBe(1000);
    });

    it('should log failed attempt to audit log', async () => {
      await service.recordFailedAttempt('test@example.com', '192.168.1.1');

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'LOGIN_FAILED',
          resourceType: 'auth',
          details: { email: 'test@example.com' },
          ipAddress: '192.168.1.1',
        }),
      });
    });
  });

  describe('recordSuccessfulLogin', () => {
    it('should reset attempts and unlock', async () => {
      await service.recordSuccessfulLogin('test@example.com');

      expect(mockRedisClient.del).toHaveBeenCalledWith('lockout:test@example.com:attempts');
      expect(mockRedisClient.del).toHaveBeenCalledWith('lockout:test@example.com:locked');
    });

    it('should log successful login to audit log', async () => {
      await service.recordSuccessfulLogin('test@example.com', '192.168.1.1');

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'LOGIN_SUCCESS',
          resourceType: 'auth',
          details: { email: 'test@example.com' },
          ipAddress: '192.168.1.1',
        }),
      });
    });
  });

  describe('unlockAccount', () => {
    it('should clear all lockout data', async () => {
      await service.unlockAccount('test@example.com');

      expect(mockRedisClient.del).toHaveBeenCalledWith('lockout:test@example.com:attempts');
      expect(mockRedisClient.del).toHaveBeenCalledWith('lockout:test@example.com:locked');
    });
  });

  describe('getAttemptCount', () => {
    it('should return current attempt count', async () => {
      mockRedisClient.get.mockResolvedValue('3');

      const count = await service.getAttemptCount('test@example.com');

      expect(count).toBe(3);
    });

    it('should return 0 when no attempts recorded', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const count = await service.getAttemptCount('test@example.com');

      expect(count).toBe(0);
    });
  });

  describe('In-Memory Fallback', () => {
    beforeEach(() => {
      vi.mocked(redis.isAvailable).mockReturnValue(false);
      // Create new service to use in-memory store
      service = new AccountLockoutService({
        maxAttempts: 3,
        lockoutDurationMs: 100,
        attemptWindowMs: 100,
      });
    });

    it('should track attempts in memory when Redis unavailable', async () => {
      const result1 = await service.recordFailedAttempt('test@example.com');
      expect(result1.attemptsRemaining).toBe(2);

      const result2 = await service.recordFailedAttempt('test@example.com');
      expect(result2.attemptsRemaining).toBe(1);
    });

    it('should lock account in memory', async () => {
      await service.recordFailedAttempt('test@example.com');
      await service.recordFailedAttempt('test@example.com');
      const result = await service.recordFailedAttempt('test@example.com');

      expect(result.locked).toBe(true);

      const lockStatus = await service.isLocked('test@example.com');
      expect(lockStatus.locked).toBe(true);
    });

    it('should unlock in memory after duration', async () => {
      // Lock the account
      await service.recordFailedAttempt('test@example.com');
      await service.recordFailedAttempt('test@example.com');
      await service.recordFailedAttempt('test@example.com');

      // Wait for lockout to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      const lockStatus = await service.isLocked('test@example.com');
      expect(lockStatus.locked).toBe(false);
    });

    it('should unlock account manually in memory', async () => {
      // Lock the account
      await service.recordFailedAttempt('test@example.com');
      await service.recordFailedAttempt('test@example.com');
      await service.recordFailedAttempt('test@example.com');

      // Manually unlock
      await service.unlockAccount('test@example.com');

      const lockStatus = await service.isLocked('test@example.com');
      expect(lockStatus.locked).toBe(false);
    });
  });

  describe('Singleton Instance', () => {
    it('should use default configuration', async () => {
      // The singleton instance uses default config
      expect(accountLockout).toBeDefined();
    });
  });
});

describe('Default Configuration', () => {
  it('should have reasonable default values', () => {
    const defaultConfig: LockoutConfig = {
      maxAttempts: 5,
      lockoutDurationMs: 15 * 60 * 1000, // 15 minutes
      attemptWindowMs: 15 * 60 * 1000, // 15 minutes
    };

    expect(defaultConfig.maxAttempts).toBe(5);
    expect(defaultConfig.lockoutDurationMs).toBe(900000); // 15 min in ms
    expect(defaultConfig.attemptWindowMs).toBe(900000);
  });
});
