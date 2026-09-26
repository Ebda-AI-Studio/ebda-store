/**
 * #1955 — campaign sends are serialized per STORE (Inngest concurrency key),
 * and bounded platform-wide by the send pacer so concurrent stores together
 * stay under the shared Resend key's 2 req/s (default ≤1/s for campaigns).
 *
 * Mutation-proven: making `awaitCampaignSendSlot` return immediately turns
 * "two stores progress concurrently and the combined rate never exceeds the
 * cap" red (the min gap collapses to 0).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { redisState } = vi.hoisted(() => ({
  redisState: { client: null as any, available: false },
}));

vi.mock('@api/services/redis.service', () => ({
  redis: {
    getClient: () => redisState.client,
    isAvailable: () => redisState.available,
  },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  awaitCampaignSendSlot,
  campaignPlatformSendIntervalMs,
  __resetCampaignSendPacerForTests,
} from '@api/lib/campaign-send-pacer';

const PER_STORE_THROTTLE_MS = 1000; // campaignThrottleMs() default

/** One store's campaign: wait for a platform slot, "send", sleep the per-store throttle. */
async function runStoreCampaign(
  store: string,
  emails: number,
  sends: Array<{ store: string; at: number }>
) {
  for (let i = 0; i < emails; i++) {
    await awaitCampaignSendSlot();
    sends.push({ store, at: Date.now() });
    await new Promise(r => setTimeout(r, PER_STORE_THROTTLE_MS));
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  __resetCampaignSendPacerForTests();
  redisState.client = null;
  redisState.available = false;
  delete process.env.CAMPAIGN_PLATFORM_SEND_INTERVAL_MS;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('campaign send pacer (#1955)', () => {
  it('defaults to ≤1 campaign send/s platform-wide (≤1.5/s is the decision ceiling)', () => {
    expect(campaignPlatformSendIntervalMs()).toBe(1000);
    expect(1000 / campaignPlatformSendIntervalMs()).toBeLessThanOrEqual(1.5);
  });

  it('two stores progress concurrently and the combined rate never exceeds the cap', async () => {
    const sends: Array<{ store: string; at: number }> = [];
    const done = Promise.all([
      runStoreCampaign('A', 10, sends),
      runStoreCampaign('B', 10, sends),
      runStoreCampaign('C', 10, sends),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;

    expect(sends).toHaveLength(30);
    const times = sends.map(s => s.at).sort((a, b) => a - b);
    const interval = campaignPlatformSendIntervalMs();
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(interval);
    }
    // Never more than Resend's 2 req/s in any 1s window, from campaigns alone.
    for (const t of times) {
      expect(times.filter(x => x >= t && x < t + 1000).length).toBeLessThanOrEqual(2);
    }
    // Concurrency, not serialization: every store sends its first email before
    // any store finishes (under the old global limit-1, B started after A's 10th).
    const firstOf = (s: string) => sends.find(x => x.store === s)!.at;
    const lastOf = (s: string) => [...sends].reverse().find(x => x.store === s)!.at;
    const earliestFinish = Math.min(lastOf('A'), lastOf('B'), lastOf('C'));
    for (const s of ['A', 'B', 'C']) expect(firstOf(s)).toBeLessThan(earliestFinish);
  });

  it('a single store alone is still paced only by its own throttle', async () => {
    const sends: Array<{ store: string; at: number }> = [];
    const done = runStoreCampaign('A', 5, sends);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    const gaps = sends.slice(1).map((s, i) => s.at - sends[i].at);
    expect(gaps.every(g => g === PER_STORE_THROTTLE_MS)).toBe(true);
  });

  it('uses the shared Redis slot when Redis is available', async () => {
    const evalFn = vi.fn(async () => 250);
    redisState.client = { eval: evalFn };
    redisState.available = true;

    const start = Date.now();
    const p = awaitCampaignSendSlot();
    await vi.advanceTimersByTimeAsync(250);
    await p;

    expect(evalFn).toHaveBeenCalledTimes(1);
    expect(evalFn.mock.calls[0][2]).toBe('campaign:send-pacer:next-slot');
    expect(evalFn.mock.calls[0][3]).toBe('1000');
    expect(Date.now() - start).toBe(250);
  });

  it('falls back to the in-process slot when the Redis reserve throws (never blocks sending)', async () => {
    redisState.client = { eval: vi.fn(async () => Promise.reject(new Error('down'))) };
    redisState.available = true;
    const sends: Array<{ store: string; at: number }> = [];
    const done = Promise.all([runStoreCampaign('A', 3, sends), runStoreCampaign('B', 3, sends)]);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(sends).toHaveLength(6);
    const times = sends.map(s => s.at).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1000);
    }
  });
});
