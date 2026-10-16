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

const {
  takeEmbedCalls,
  embedGlobalDailyCap,
  DEFAULT_GLOBAL_DAILY_CAP,
  takeQueryEmbed,
  queryEmbedStoreDailyCap,
  queryEmbedGlobalDailyCap,
  DEFAULT_QUERY_STORE_DAILY_CAP,
  DEFAULT_QUERY_GLOBAL_DAILY_CAP,
} = await import('../../apps/api/src/lib/search/embed-budget');

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

/** Ruling SEARCH-T12-3: storefront query embeds are budgeted (per store, query-wide, account-wide). */
describe('takeQueryEmbed', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  beforeEach(() => {
    store.clear();
    available = true;
    client.expire.mockClear();
  });
  afterEach(() => {
    delete process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP;
    delete process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP;
    delete process.env.SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP;
  });

  it('per-store cap: 1000 attempts in one store are granted exactly the cap', async () => {
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = '25';
    let granted = 0;
    for (let i = 0; i < 1000; i++) if (await takeQueryEmbed(A)) granted++;
    expect(granted).toBe(25);
    expect(await takeQueryEmbed(B)).toBe(true); // another store has its own budget
  });

  it('query-wide cap bounds the sum across stores (spreading over stores does not help)', async () => {
    process.env.SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP = '10';
    let granted = 0;
    for (let i = 0; i < 1000; i++)
      if (await takeQueryEmbed(`${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`))
        granted++;
    expect(granted).toBe(10);
  });

  it('query embeds also count against the account-wide indexer budget', async () => {
    process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP = '3';
    expect(await takeQueryEmbed(A)).toBe(true);
    expect(await takeEmbedCalls(2)).toBe(true);
    expect(await takeQueryEmbed(A)).toBe(false); // 4th call of the day
    expect(await takeEmbedCalls(1)).toBe(false);
  });

  it('a cap of 0 refuses; no Redis refuses (fails closed: keyword-only search)', async () => {
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = '0';
    expect(await takeQueryEmbed(A)).toBe(false);
    delete process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP;
    available = false;
    expect(await takeQueryEmbed(A)).toBe(false);
  });

  it('defaults, and a bad value falls back to the default', () => {
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = 'x';
    process.env.SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP = '-1';
    expect(queryEmbedStoreDailyCap()).toBe(DEFAULT_QUERY_STORE_DAILY_CAP);
    expect(queryEmbedGlobalDailyCap()).toBe(DEFAULT_QUERY_GLOBAL_DAILY_CAP);
    // The query-wide cap stays below the account-wide one, so shoppers can never use up the indexer's.
    expect(DEFAULT_QUERY_GLOBAL_DAILY_CAP).toBeLessThan(DEFAULT_GLOBAL_DAILY_CAP);
  });
});
