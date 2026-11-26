/**
 * Ported from tests/integration/search-log-distinct-searchers.test.ts (Postgres + real Redis + express). The k>=2 floor counts
 * DISTINCT searchers, not requests (Ruling SEARCH-T5-6): the dedupe is a salted, daily-rotated HMAC of (IP + user agent) kept only
 * as a short-lived Redis key; the counts live in the store's DO (`searchLogRecord`, real DO schema on node:sqlite via runMoneyOp),
 * read back by `searchInsights`. Redis is a faithful SET NX EX fake; Redis down -> fail-open, the request counts.
 * The route wiring (page-1 search calls claimSearcherSearch then recordSearch) is pinned by storefront-search-api-header.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
import { ensureMoneyOpsSchema, runMoneyOp } from '../../packages/repo/src/do/money-ops';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  store: new Map<string, { ttl: number }>(),
  down: false,
  available: true,
  warn: [] as unknown[][],
  money: undefined as unknown,
}));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => h.available,
    getClient: () => ({
      set: async (key: string, _v: string, _ex: string, ttl: number, _nx: string) => {
        if (h.down) throw Object.assign(new Error('redis down'), { code: 'ECONNREFUSED' });
        if (h.store.has(key)) return null;
        h.store.set(key, { ttl });
        return 'OK';
      },
    }),
  },
}));
vi.mock('../../apps/api/src/lib/analytics-backend', () => ({
  analyticsMoney: async () => h.money,
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: {
    warn: (...a: unknown[]) => void h.warn.push(a),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import {
  claimSearcherSearch,
  recordSearch,
  getSearchInsights,
  searcherDedupeKey,
  SEARCH_LOG_MIN_SEARCHES_SHOWN,
  SEARCH_LOG_SEARCHER_DEDUPE_TTL_S,
} from '../../apps/api/src/services/search-log.service';

type Searcher = { ip: string; userAgent: string };
const who = (n: number): Searcher => ({
  ip: `10.0.0.${n}`,
  userAgent: `Mozilla/5.0 dedupe-test/${n}`,
});

function newDo() {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  ensureMoneyOpsSchema(db);
  return new Proxy(
    {},
    {
      get: (_t, op: string) =>
        op === 'then' ? undefined : async (a: unknown) => runMoneyOp(db, STORE, op, a as never),
    }
  );
}
/** What the storefront search route does on a page-1 search: count it only for a new searcher. */
async function search(term: string, s: Searcher, results = 3) {
  if (await claimSearcherSearch(STORE, term, s)) await recordSearch(STORE, term, results);
}
const listed = async () =>
  (await getSearchInsights(STORE, { days: 7, filter: 'all' })).terms.map(t => [t.term, t.searches]);

beforeEach(() => {
  h.store.clear();
  h.down = false;
  h.available = true;
  h.warn.length = 0;
  h.money = newDo();
});

describe('distinct-searcher counting (DO counts, Redis dedupe)', () => {
  it('one searcher sorting, filtering and retrying counts once and stays under the floor', async () => {
    const a = who(1);
    const t = 'احمد محمد حسن';
    await search(t, a); // typed
    await search(t, a); // sort change
    await search(t, a); // category change
    await search(t, a); // retry
    await search('أحمد  محمد حسن', a); // spelling variant folds to the same stored term
    expect(SEARCH_LOG_MIN_SEARCHES_SHOWN).toBe(2);
    expect((await getSearchInsights(STORE, { days: 7, filter: 'all' })).totals.searches).toBe(1);
    expect(await listed()).toEqual([]);
  });

  it('two searchers count 2 and the term becomes visible in insights', async () => {
    const q = 'كوتشي ابيض';
    for (const s of [who(1), who(1), who(2), who(2)]) await search(q, s);
    expect(await listed()).toEqual([[q, 2]]);
  });

  it('same IP with a different user agent, or a different IP, is another searcher', async () => {
    const a = who(1);
    await search('فستان', a);
    await search('فستان', { ...a, userAgent: `${a.userAgent} other` });
    await search('فستان', { ...a, ip: '10.251.0.1' });
    expect(await listed()).toEqual([['فستان', 3]]);
  });

  it('the Redis key is a hex digest only (no IP, user agent or term) with a 30-minute TTL', async () => {
    const a = who(7);
    await search('شنطة', a);
    const key = searcherDedupeKey(STORE, 'شنطه', a);
    expect(key).toMatch(/^search-log:seen:[0-9a-f]{64}$/);
    for (const part of [a.ip, a.userAgent, 'شنطه', STORE]) expect(key).not.toContain(part);
    expect(h.store.get(key)?.ttl).toBe(SEARCH_LOG_SEARCHER_DEDUPE_TTL_S);
    expect(SEARCH_LOG_SEARCHER_DEDUPE_TTL_S).toBe(1800);
    // Daily rotation: the same searcher hashes differently on another Cairo day.
    expect(searcherDedupeKey(STORE, 'شنطه', a, new Date(Date.now() + 86_400_000))).not.toBe(key);
  });

  it('fail-open: Redis down counts every request once, never blocks the search, never logs the term', async () => {
    const a = who(9);
    const term = 'حقيبة جلد';
    h.down = true;
    await search(term, a);
    await search(term, a);
    expect(await listed()).toEqual([['حقيبه جلد', 2]]); // stored folded (ة -> ه)
    expect(JSON.stringify(h.warn)).not.toContain(term);
    // and with no client at all the request still counts
    h.down = false;
    h.available = false;
    expect(await claimSearcherSearch(STORE, term, a)).toBe(true);
  });
});
