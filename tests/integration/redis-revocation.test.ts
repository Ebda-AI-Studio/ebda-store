import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { redis } from '@api/services/redis.service';

beforeAll(async () => {
  await redis.connect();
});

afterAll(async () => {
  await redis.disconnect();
});

describe('redis revocation helpers', () => {
  it('denies a jti and reports it denied', async () => {
    await redis.denyJti('jti-abc', 60);
    expect(await redis.isJtiDenied('jti-abc')).toBe(true);
    expect(await redis.isJtiDenied('jti-never')).toBe(false);
  });
});
