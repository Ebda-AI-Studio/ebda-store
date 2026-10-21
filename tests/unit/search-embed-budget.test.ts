/** Ruling SEARCH-T11-19: the account-wide indexer call budget (Redis, per Cairo day). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map<string, number>();
const sets = new Set<string>();
let available = true;
const client = {
  incr: vi.fn(async (k: string) => {
    store.set(k, (store.get(k) ?? 0) + 1);
    return store.get(k)!;
  }),
  expire: vi.fn(async () => 1),
  set: vi.fn(async (k: string) => (sets.has(k) ? null : (sets.add(k), 'OK'))),
};
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { getClient: () => (available ? client : null), isAvailable: () => available },
}));
const sendAlert = vi.fn(async () => undefined);
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert }));

const { takeEmbedCalls, embedGlobalDailyCap, DEFAULT_GLOBAL_DAILY_CAP } =
  await import('../../apps/api/src/lib/search/embed-budget');

describe('takeEmbedCalls', () => {
  beforeEach(() => {
    store.clear();
    sets.clear();
    available = true;
    sendAlert.mockClear();
    client.expire.mockClear();
  });
  afterEach(() => delete process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP);

  it('grants up to the cap, then refuses, and alerts once per day', async () => {
    process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP = '3';
    expect(await takeEmbedCalls(2)).toBe(true);
    expect(await takeEmbedCalls(1)).toBe(true);
    expect(await takeEmbedCalls(1)).toBe(false);
    expect(await takeEmbedCalls(5)).toBe(false);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(client.expire).toHaveBeenCalledTimes(1); // TTL set on the day's first call only
  });

  it('cap 0 refuses every call', async () => {
    process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP = '0';
    expect(await takeEmbedCalls(1)).toBe(false);
  });

  it('fails CLOSED with no Redis (no proof of budget, no spend)', async () => {
    available = false;
    expect(await takeEmbedCalls(1)).toBe(false);
  });

  it('a bad value falls back to the default', () => {
    process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP = 'lots';
    expect(embedGlobalDailyCap()).toBe(DEFAULT_GLOBAL_DAILY_CAP);
  });
});
