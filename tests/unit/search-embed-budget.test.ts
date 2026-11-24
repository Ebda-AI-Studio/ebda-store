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
  decr: vi.fn(async (k: string) => {
    store.set(k, (store.get(k) ?? 0) - 1);
    return store.get(k)!;
  }),
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
  SEARCH_EMBED_PER_SEARCHER_PER_MIN,
  searcherPerMinuteCap,
  searcherFromIp,
  queryBudgetSpent,
  queryBudgetSpentUntil,
  clearQueryBudgetSpentForTests,
} = await import('../../apps/api/src/lib/search/embed-budget');
const { regionDayStartOffset } = await import('@ebda/shared');

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
    clearQueryBudgetSpentForTests();
    client.incr.mockClear();
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
    for (let i = 0; i < 1000; i++) if (await takeQueryEmbed(A, `ip:${i}`)) granted++;
    expect(granted).toBe(25);
    // The daily counters equal the calls actually granted (refusals are refunded).
    const counts = [...store.entries()].filter(([k]) => k.startsWith('search:embed:query:'));
    expect(counts.every(([, n]) => n === 25)).toBe(true);
    expect(await takeQueryEmbed(B, 'ip:x')).toBe(true); // another store has its own budget
  });

  it('query-wide cap bounds the sum across stores (spreading over stores does not help)', async () => {
    process.env.SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP = '10';
    let granted = 0;
    for (let i = 0; i < 1000; i++)
      if (
        await takeQueryEmbed(`${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, `ip:${i}`)
      )
        granted++;
    expect(granted).toBe(10);
  });

  it('query embeds also count against the account-wide indexer budget', async () => {
    process.env.SEARCH_EMBED_GLOBAL_DAILY_CAP = '3';
    expect(await takeQueryEmbed(A, 'ip:a')).toBe(true);
    expect(await takeEmbedCalls(2)).toBe(true);
    expect(await takeQueryEmbed(A, 'ip:b')).toBe(false); // 4th call of the day
    expect(await takeEmbedCalls(1)).toBe(false);
  });

  it('a cap of 0 refuses; no Redis refuses (fails closed: keyword-only search)', async () => {
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = '0';
    expect(await takeQueryEmbed(A, 'ip:a')).toBe(false);
    delete process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP;
    available = false;
    expect(await takeQueryEmbed(A, 'ip:a')).toBe(false);
  });

  it('per searcher: 1000 attempts by one client in a minute are granted the per-minute cap', async () => {
    // The window is a FIXED minute: a wall-clock run straddling :59 -> :00 grants the cap twice (CI saw
    // 120 vs 60). Freeze Date mid-minute so the 1000 attempts all land in one window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:30Z'));
    let granted = 0;
    try {
      for (let i = 0; i < 1000; i++) if (await takeQueryEmbed(A, 'ip:203.0.113.7')) granted++;
    } finally {
      vi.useRealTimers();
    }
    expect(granted).toBe(SEARCH_EMBED_PER_SEARCHER_PER_MIN);
    // The 980 refused attempts never reached the store's or the platform's daily budget.
    const storeCount = [...store.entries()].find(([k]) => k.startsWith(`search:embed:query:${A}:`));
    expect(storeCount?.[1]).toBe(SEARCH_EMBED_PER_SEARCHER_PER_MIN);
    expect(await takeQueryEmbed(A, 'ip:203.0.113.8')).toBe(true); // another client is not punished
  });

  it('no searcher → refused (default deny), and nothing is charged', async () => {
    expect(await takeQueryEmbed(A, undefined)).toBe(false);
    expect(await takeQueryEmbed(A, '')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('the searcher identity collapses IPv6 to its /64 (rotating the low bits is the same client)', () => {
    expect(searcherFromIp('2001:db8:1:2:aaaa::1')).toBe(searcherFromIp('2001:db8:1:2:bbbb::9'));
    expect(searcherFromIp('198.51.100.1')).not.toBe(searcherFromIp('198.51.100.2'));
    // /64 explicitly (the library default is /56): two different /64s inside one /56 are two clients.
    expect(searcherFromIp('2001:db8:1:200::1')).not.toBe(searcherFromIp('2001:db8:1:201::1'));
    // No IP is no identity: never one shared bucket for every such request (review M4).
    expect(searcherFromIp(undefined)).toBeUndefined();
    expect(searcherFromIp('')).toBeUndefined();
  });

  it('defaults, and a bad value falls back to the default', () => {
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = 'x';
    process.env.SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP = '-1';
    expect(queryEmbedStoreDailyCap()).toBe(DEFAULT_QUERY_STORE_DAILY_CAP);
    expect(queryEmbedGlobalDailyCap()).toBe(DEFAULT_QUERY_GLOBAL_DAILY_CAP);
    // The query-wide cap stays below the account-wide one, so shoppers can never use up the indexer's.
    expect(DEFAULT_QUERY_GLOBAL_DAILY_CAP).toBeLessThan(DEFAULT_GLOBAL_DAILY_CAP);
  });

  // Review I1: a spent daily budget is a STABLE state until the next Cairo day, not a transient one.
  it('a spent store budget marks the store spent until the next Cairo day, and skips Redis', async () => {
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = '2';
    expect(queryBudgetSpent(A)).toBe(false);
    expect(await takeQueryEmbed(A, 'ip:1')).toBe(true);
    expect(await takeQueryEmbed(A, 'ip:2')).toBe(true);
    expect(await takeQueryEmbed(A, 'ip:3')).toBe(false); // the refusal that discovers it
    expect(queryBudgetSpent(A)).toBe(true);
    expect(queryBudgetSpent(B)).toBe(false); // another store is not affected
    expect(queryBudgetSpentUntil(A)).toBe(regionDayStartOffset(new Date(), 1).getTime());
    client.incr.mockClear();
    expect(await takeQueryEmbed(A, 'ip:4')).toBe(false);
    expect(client.incr).not.toHaveBeenCalled(); // no round trips while spent
  });

  it('a spent platform budget (query-wide or account-wide) marks every store spent', async () => {
    process.env.SEARCH_QUERY_EMBED_GLOBAL_DAILY_CAP = '1';
    expect(await takeQueryEmbed(A, 'ip:1')).toBe(true);
    expect(await takeQueryEmbed(B, 'ip:2')).toBe(false);
    expect(queryBudgetSpent(A)).toBe(true);
    expect(queryBudgetSpent(B)).toBe(true);
  });

  it('a configured cap of 0 reads as spent with no Redis call; a searcher refusal does not', async () => {
    process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP = '0';
    expect(queryBudgetSpent(A)).toBe(true);
    delete process.env.SEARCH_QUERY_EMBED_STORE_DAILY_CAP;
    expect(queryBudgetSpent(A)).toBe(false);
    for (let i = 0; i < SEARCH_EMBED_PER_SEARCHER_PER_MIN + 5; i++)
      await takeQueryEmbed(A, 'ip:same');
    expect(queryBudgetSpent(A)).toBe(false); // per-client and transient: never the store's state
  });

  // Review M5: behind Egyptian mobile CGNAT many shoppers share one IPv4, so the per-IP limit is a
  // knob with a CGNAT-sized default; the daily budgets are what bound spend.
  it('per-searcher limit: default 60/min, configurable, a bad value falls back, 0 means none', async () => {
    expect(SEARCH_EMBED_PER_SEARCHER_PER_MIN).toBe(60);
    expect(searcherPerMinuteCap()).toBe(60);
    process.env.SEARCH_EMBED_PER_SEARCHER_PER_MIN = '5';
    try {
      let granted = 0;
      for (let i = 0; i < 50; i++) if (await takeQueryEmbed(A, 'ip:198.51.100.9')) granted++;
      expect(granted).toBe(5);
      process.env.SEARCH_EMBED_PER_SEARCHER_PER_MIN = 'lots';
      expect(searcherPerMinuteCap()).toBe(60);
      process.env.SEARCH_EMBED_PER_SEARCHER_PER_MIN = '0';
      expect(await takeQueryEmbed(A, 'ip:198.51.100.10')).toBe(false);
    } finally {
      delete process.env.SEARCH_EMBED_PER_SEARCHER_PER_MIN;
    }
  });
});
