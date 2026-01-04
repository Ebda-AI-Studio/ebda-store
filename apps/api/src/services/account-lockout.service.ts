/**
 * Account Lockout Service
 * Prevents brute force attacks by locking accounts after failed attempts
 */

import { redis } from './redis.service';
import { prisma } from '@force/database';

export interface LockoutConfig {
  maxAttempts: number;
  lockoutDurationMs: number;
  attemptWindowMs: number;
}

const DEFAULT_CONFIG: LockoutConfig = {
  maxAttempts: 5,
  lockoutDurationMs: 15 * 60 * 1000, // 15 minutes
  attemptWindowMs: 15 * 60 * 1000, // 15 minutes
};

// In-memory fallback when Redis is unavailable
const memoryStore = new Map<string, { attempts: number; lockedUntil?: number }>();

class AccountLockoutService {
  private config: LockoutConfig;

  constructor(config: Partial<LockoutConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getKey(email: string): string {
    return `lockout:${email.toLowerCase()}`;
  }

  /**
   * Check if an account is locked
   */
  async isLocked(email: string): Promise<{ locked: boolean; remainingMs?: number }> {
    const key = this.getKey(email);

    if (redis.isAvailable()) {
      const lockedUntil = await redis.getClient()?.get(`${key}:locked`);
      if (lockedUntil) {
        const remaining = parseInt(lockedUntil) - Date.now();
        if (remaining > 0) {
          return { locked: true, remainingMs: remaining };
        }
        // Lock expired, clean up
        await redis.getClient()?.del(`${key}:locked`);
      }
    } else {
      const data = memoryStore.get(key);
      if (data?.lockedUntil) {
        const remaining = data.lockedUntil - Date.now();
        if (remaining > 0) {
          return { locked: true, remainingMs: remaining };
        }
        // Lock expired, clean up
        data.lockedUntil = undefined;
        data.attempts = 0;
      }
    }

    return { locked: false };
  }

  /**
   * Record a failed login attempt
   */
  async recordFailedAttempt(
    email: string,
    ip?: string
  ): Promise<{
    locked: boolean;
    attemptsRemaining: number;
    lockoutDurationMs?: number;
  }> {
    const key = this.getKey(email);

    let attempts: number;

    if (redis.isAvailable()) {
      const client = redis.getClient();

      // Increment attempts
      attempts = await client!.incr(`${key}:attempts`);

      // Set expiry on first attempt
      if (attempts === 1) {
        await client!.pexpire(`${key}:attempts`, this.config.attemptWindowMs);
      }
    } else {
      const data = memoryStore.get(key) || { attempts: 0 };
      data.attempts++;
      attempts = data.attempts;
      memoryStore.set(key, data);
    }

    // Log the attempt
    await this.logAttempt(email, ip, false);

    // Check if we should lock
    if (attempts >= this.config.maxAttempts) {
      await this.lockAccount(email);
      return {
        locked: true,
        attemptsRemaining: 0,
        lockoutDurationMs: this.config.lockoutDurationMs,
      };
    }

    return {
      locked: false,
      attemptsRemaining: this.config.maxAttempts - attempts,
    };
  }

  /**
   * Record a successful login (resets failed attempts)
   */
  async recordSuccessfulLogin(email: string, ip?: string): Promise<void> {
    const key = this.getKey(email);

    if (redis.isAvailable()) {
      const client = redis.getClient();
      await Promise.all([client!.del(`${key}:attempts`), client!.del(`${key}:locked`)]);
    } else {
      memoryStore.delete(key);
    }

    await this.logAttempt(email, ip, true);
  }

  /**
   * Lock an account
   */
  private async lockAccount(email: string): Promise<void> {
    const key = this.getKey(email);
    const lockedUntil = Date.now() + this.config.lockoutDurationMs;

    if (redis.isAvailable()) {
      await redis
        .getClient()
        ?.set(`${key}:locked`, lockedUntil.toString(), 'PX', this.config.lockoutDurationMs);
    } else {
      const data = memoryStore.get(key) || { attempts: 0 };
      data.lockedUntil = lockedUntil;
      memoryStore.set(key, data);
    }

    console.warn(`[LOCKOUT] Account locked: ${email}`);
  }

  /**
   * Manually unlock an account
   */
  async unlockAccount(email: string): Promise<void> {
    const key = this.getKey(email);

    if (redis.isAvailable()) {
      const client = redis.getClient();
      await Promise.all([client!.del(`${key}:attempts`), client!.del(`${key}:locked`)]);
    } else {
      memoryStore.delete(key);
    }

    console.log(`[LOCKOUT] Account unlocked: ${email}`);
  }

  /**
   * Get current attempt count
   */
  async getAttemptCount(email: string): Promise<number> {
    const key = this.getKey(email);

    if (redis.isAvailable()) {
      const attempts = await redis.getClient()?.get(`${key}:attempts`);
      return attempts ? parseInt(attempts) : 0;
    }

    return memoryStore.get(key)?.attempts || 0;
  }

  /**
   * Log login attempt to database
   */
  private async logAttempt(email: string, ip?: string, success?: boolean): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          action: success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED',
          resourceType: 'auth',
          details: { email },
          ipAddress: ip,
        },
      });
    } catch (error) {
      // Don't fail login for audit logging errors
      console.error('[LOCKOUT] Failed to log attempt:', error);
    }
  }
}

// Singleton instance
export const accountLockout = new AccountLockoutService();

// Export for testing/custom config
export { AccountLockoutService };
