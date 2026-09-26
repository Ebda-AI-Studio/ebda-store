/**
 * #1955 — the platform-wide campaign send pacer's Redis path, against a real
 * Redis: concurrent callers (standing in for several API replicas / several
 * stores' campaigns) are handed slots at least one interval apart.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { redis } from '@api/services/redis.service';
import { awaitCampaignSendSlot } from '@api/lib/campaign-send-pacer';

const INTERVAL = 60;

beforeAll(async () => {
  await redis.connect();
  process.env.CAMPAIGN_PLATFORM_SEND_INTERVAL_MS = String(INTERVAL);
  await redis.getClient()?.del('campaign:send-pacer:next-slot');
});

afterAll(async () => {
  delete process.env.CAMPAIGN_PLATFORM_SEND_INTERVAL_MS;
  await redis.getClient()?.del('campaign:send-pacer:next-slot');
  await redis.disconnect();
});

describe('campaign send pacer (Redis)', () => {
  it('spaces concurrent sends at least one interval apart', async () => {
    expect(redis.isAvailable()).toBe(true);
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        await awaitCampaignSendSlot();
        times.push(Date.now());
      })
    );
    times.sort((a, b) => a - b);
    // Timer resolution slack of a few ms; without the pacer the span is ~0.
    expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(5 * INTERVAL - 10);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(INTERVAL - 10);
    }
  });
});
