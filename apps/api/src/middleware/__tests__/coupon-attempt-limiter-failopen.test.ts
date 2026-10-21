import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

// Redis "connected" but every command rejects: the limiter must serve the request, not 500/429.
vi.mock('../../services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    getClient: () => ({ call: () => Promise.reject(new Error('redis down')) }),
  },
}));

import { couponAttemptLimiter } from '../security';

describe('couponAttemptLimiter fail-open', () => {
  it('calls next() and sends no response when the store errors', async () => {
    const next = vi.fn();
    const status = vi.fn();
    await couponAttemptLimiter(
      { body: { couponCode: 'ANY' }, ip: '10.9.9.9' } as unknown as Request,
      { status, setHeader: vi.fn(), json: vi.fn() } as unknown as Response,
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });
});
