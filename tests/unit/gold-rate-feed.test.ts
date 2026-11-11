/**
 * Gold-rate pricing, Task 11 (Ruling B5-15): the automatic rate. All HTTP is stubbed with bodies
 * recorded from the live endpoints on 2026-10-22 (tests/fixtures/gold-feed/). The expected figures
 * were computed independently with arbitrary-precision decimals:
 *   24k = 4082.300049 USD/oz x 54.385184 EGP/USD / 31.1034768 g/oz = 7138.00070 EGP/g = 713 800 piastres
 *   21k = 24k x 21/24 = 624 575.06 -> 624 575 ; 18k = 24k x 18/24 = 535 350.05 -> 535 350
 *   with +250 bps: 731 645 / 640 189 / 548 734 (premium applied once, one rounding each)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  goldFeed,
  storeCandidateRates,
  CROSS_CHECK_BPS,
  type GoldFeedResult,
} from '../../apps/api/src/services/gold-rate/feed/adapter';
import { resetUsdEgpMemo } from '../../apps/api/src/services/gold-rate/feed/er-api';
import { GOLD_SPOT_URL } from '../../apps/api/src/services/gold-rate/feed/gold-api';
import { USD_RATES_URL } from '../../apps/api/src/services/gold-rate/feed/er-api';
import { FALLBACK_URLS } from '../../apps/api/src/services/gold-rate/feed/currency-api';

const fx = (f: string) =>
  JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/gold-feed', f), 'utf8'));
const XAU = fx('primary-xau.json');
const USD = fx('primary-usd-rates.json');
const FB_JS = fx('fallback-usd-jsdelivr.json');
const FB_PG = fx('fallback-usd-pages.json');

type Route = unknown | 'throw' | { status: number };
/** A fetch double: url -> body | 'throw' | {status}. Unlisted urls throw. */
const fakeFetch =
  (routes: Record<string, Route>, calls: string[] = []) =>
  async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined || r === 'throw') throw new Error('network down');
    if (
      r &&
      typeof r === 'object' &&
      'status' in (r as object) &&
      Object.keys(r as object).length === 1
    )
      return { ok: false, status: (r as { status: number }).status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
const ALL_OK = {
  [GOLD_SPOT_URL]: XAU,
  [USD_RATES_URL]: USD,
  [FALLBACK_URLS[0]]: FB_JS,
  [FALLBACK_URLS[1]]: FB_PG,
};
const NOW = new Date('2026-10-22T09:15:00Z');
const run = (routes: Record<string, Route>, previous24k?: number, calls: string[] = []) =>
  goldFeed({ fetchImpl: fakeFetch(routes, calls), now: () => NOW, previous24k }).fetch(
    new AbortController().signal
  );
const ok = (r: GoldFeedResult) => {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
  return r.quote;
};

beforeEach(() => resetUsdEgpMemo());

describe('conversion (hand-checked against a decimal computation)', () => {
  it('primary: 24k / 21k / 18k in integer piastres, one rounding each', async () => {
    const q = ok(await run(ALL_OK));
    expect(q.source).toBe('primary');
    expect(q.per24kGramPiastres).toBe(713_800);
    const c = storeCandidateRates(q, 0);
    expect([c.get(24), c.get(21), c.get(18)]).toEqual([713_800, 624_575, 535_350]);
  });
  it('21k and 18k come from the UNROUNDED 24k value (not from the rounded 713 800)', async () => {
    const q = ok(await run(ALL_OK));
    // 713 800 * 21/24 = 624 575.00 exactly; the unrounded 713 800.0704 * 21/24 = 624 575.0616: both round to 624 575,
    // so pin the exact rational instead: the candidate must equal round(num*21 / den*24), not round(rounded*21/24)
    const num = BigInt(q.exact.num);
    const den = BigInt(q.exact.den);
    expect(Number((2n * num * 21n + den * 24n) / (2n * den * 24n))).toBe(
      storeCandidateRates(q, 0).get(21)
    );
  });
  it('NEGATIVE CONTROL for the above: with 24k = 713 801.5 exactly, 21k from the exact value is 624 576 but from the rounded 24k (713 802) it would be 624 577', () => {
    const q = {
      per24kGramPiastres: 713_802,
      fetchedAt: NOW.toISOString(),
      source: 'primary' as const,
      exact: { num: '1427603', den: '2' },
      reference: {},
    };
    const c = storeCandidateRates(q, 0);
    expect(c.get(24)).toBe(713_802);
    expect(c.get(21)).toBe(624_576); // 713 801.5 x 21/24 = 624 576.3125
    expect(Math.round((713_802 * 21) / 24)).toBe(624_577); // what a rounded-then-scaled implementation would say
  });
  it('the premium applies ONCE: +250 bps', async () => {
    const c = storeCandidateRates(ok(await run(ALL_OK)), 250);
    expect([c.get(24), c.get(21), c.get(18)]).toEqual([731_645, 640_189, 548_734]);
    const down = storeCandidateRates(ok(await run(ALL_OK)), -1000);
    expect(down.get(24)).toBe(642_420); // 713 800.07 x 0.9
  });
  it('fallback alone: egp / xau from ONE file, same conversion', async () => {
    const q = ok(await run({ [FALLBACK_URLS[0]]: FB_JS }));
    expect(q.source).toBe('fallback');
    expect(q.per24kGramPiastres).toBe(721_959);
  });
});

describe('order of trust and fall-through (each failure mode)', () => {
  it('primary down (spot 500) -> the fallback quote, source recorded as fallback', async () => {
    const r = await run({ ...ALL_OK, [GOLD_SPOT_URL]: { status: 500 } });
    expect(ok(r).source).toBe('fallback');
  });
  it('malformed body, zero price, non-finite and a wrong symbol each fall through', async () => {
    for (const bad of [
      { ...XAU, price: 0 },
      { ...XAU, price: -5 },
      { ...XAU, symbol: 'XAG' },
      { nope: true },
      'text',
    ]) {
      const r = await run({ ...ALL_OK, [GOLD_SPOT_URL]: bad });
      expect(ok(r).source, JSON.stringify(bad)).toBe('fallback');
    }
  });
  it('an implausible quote (a unit slip, x1000 or /1000) is rejected by the EGP 100..100 000 per gram bounds and falls through', async () => {
    for (const price of [XAU.price * 1000, XAU.price / 1000]) {
      const r = await run({ ...ALL_OK, [GOLD_SPOT_URL]: { ...XAU, price } });
      expect(ok(r).source, String(price)).toBe('fallback');
    }
    // and with no fallback either, there is no quote at all (never a clamped or guessed one)
    expect(
      (await run({ [GOLD_SPOT_URL]: { ...XAU, price: XAU.price * 1000 }, [USD_RATES_URL]: USD }))
        .kind
    ).toBe('down');
  });
  it('a timeout (throw) falls through to the next source', async () => {
    expect(ok(await run({ ...ALL_OK, [USD_RATES_URL]: 'throw' })).source).toBe('fallback');
  });
  it('a 10x spike against the previous stored 24k is rejected', async () => {
    // previous 24k of 70 000 piastres: the quotes (713 800) are > 10x, both rejected -> down
    expect((await run(ALL_OK, 70_000)).kind).toBe('down');
    // a normal previous passes
    expect((await run(ALL_OK, 700_000)).kind).toBe('ok');
  });
  it('jsDelivr down -> the pages.dev mirror is used', async () => {
    const calls: string[] = [];
    const r = await run(
      { [FALLBACK_URLS[0]]: 'throw', [FALLBACK_URLS[1]]: FB_PG },
      undefined,
      calls
    );
    expect(ok(r).per24kGramPiastres).toBe(715_338);
    expect(calls).toContain(FALLBACK_URLS[1]);
  });
  it('a 429 on the USD/EGP leg is not retried inside the run; the response is then reused until its next-update time', async () => {
    const calls: string[] = [];
    await run({ ...ALL_OK, [USD_RATES_URL]: { status: 429 } }, undefined, calls);
    expect(calls.filter(c => c === USD_RATES_URL)).toHaveLength(1);
    resetUsdEgpMemo();
    const c2: string[] = [];
    await run(ALL_OK, undefined, c2);
    await run(ALL_OK, undefined, c2); // second run inside the memo window: no second call
    expect(c2.filter(c => c === USD_RATES_URL)).toHaveLength(1);
  });
  it('BOTH feeds down -> kind down (no quote, never a guess)', async () => {
    expect((await run({})).kind).toBe('down');
    expect(
      (
        await run({
          [GOLD_SPOT_URL]: 'throw',
          [FALLBACK_URLS[0]]: { status: 503 },
          [FALLBACK_URLS[1]]: 'throw',
        })
      ).kind
    ).toBe('down');
  });
});

describe('cross-check: the threshold is 200 bps and is pinned both sides', () => {
  const withFallbackScaledBy = (factor: number) => {
    // scale the fallback's egp so its 24k differs from the primary's 713 800 by `factor`
    const base = fx('fallback-usd-jsdelivr.json');
    const egp = (713_800 * factor * base.usd.xau * 31.1034768) / 100;
    // dated the same UTC day as NOW: a CURRENT file, so the 200 bps gate applies
    return { ...base, date: '2026-10-22', usd: { ...base.usd, egp } };
  };
  it('1.9 % apart: applies (ok, the primary)', async () => {
    const r = await run({ ...ALL_OK, [FALLBACK_URLS[0]]: withFallbackScaledBy(1.019) });
    expect(r.kind).toBe('ok');
  });
  it('2.1 % apart: DISAGREE, never auto-applied', async () => {
    const r = await run({ ...ALL_OK, [FALLBACK_URLS[0]]: withFallbackScaledBy(1.021) });
    expect(r.kind).toBe('disagree');
    if (r.kind === 'disagree') expect(r.diffBps).toBeGreaterThan(CROSS_CHECK_BPS);
  });
  it('a fallback file from the day BEFORE is lag, not disagreement: 281 bps apart still applies the primary (GOLD-FALLBACK-LAG-1)', async () => {
    const lagged = { ...withFallbackScaledBy(1.0281), date: '2026-10-21' };
    const r = await run({ ...ALL_OK, [FALLBACK_URLS[0]]: lagged });
    expect(r.kind).toBe('ok');
  });
  it('a lagging fallback does not hide a real fault: 7 % apart still disagrees', async () => {
    const lagged = { ...withFallbackScaledBy(1.07), date: '2026-10-21' };
    expect((await run({ ...ALL_OK, [FALLBACK_URLS[0]]: lagged })).kind).toBe('disagree');
  });
  it('a CURRENT fallback file keeps the 200 bps gate at 281 bps', async () => {
    expect((await run({ ...ALL_OK, [FALLBACK_URLS[0]]: withFallbackScaledBy(1.0281) })).kind).toBe(
      'disagree'
    );
  });
  it('one source up, one down: applies with no cross-check and records the single source', async () => {
    expect(ok(await run({ [GOLD_SPOT_URL]: XAU, [USD_RATES_URL]: USD })).source).toBe('primary');
  });
});

// Ruling B5-36: a frozen feed must not count as fresh.
describe('quote freshness', () => {
  const H = 3600_000;
  const xauAt = (ms: number) => ({ ...XAU, updatedAt: new Date(NOW.getTime() - ms).toISOString() });
  const usdAt = (ms: number) => ({
    ...USD,
    time_last_update_unix: Math.floor((NOW.getTime() - ms) / 1000),
  });
  const fbDay = (date: string) => ({ ...FB_PG, date });

  it('the spot quote: 11 h old is used, 13 h old is a frozen feed and falls through to the fallback', async () => {
    expect(ok(await run({ ...ALL_OK, [GOLD_SPOT_URL]: xauAt(11 * H) })).source).toBe('primary');
    expect(ok(await run({ ...ALL_OK, [GOLD_SPOT_URL]: xauAt(13 * H) })).source).toBe('fallback');
  });
  it('a spot quote with no timestamp, an unparseable one, or one from the future is not trusted', async () => {
    const { updatedAt: _u, ...none } = XAU;
    for (const bad of [none, { ...XAU, updatedAt: 'yesterday' }, xauAt(-5 * H)])
      expect(ok(await run({ ...ALL_OK, [GOLD_SPOT_URL]: bad })).source, JSON.stringify(bad)).toBe(
        'fallback'
      );
  });
  it('the USD/EGP file publishes daily: 30 h old is used, 40 h old is stale', async () => {
    expect(ok(await run({ ...ALL_OK, [USD_RATES_URL]: usdAt(30 * H) })).source).toBe('primary');
    resetUsdEgpMemo();
    expect(ok(await run({ ...ALL_OK, [USD_RATES_URL]: usdAt(40 * H) })).source).toBe('fallback');
  });
  it('the fallback file is dated: today and yesterday (inside 12 h of its end) pass, two days old does not', async () => {
    const only = (body: unknown) => ({ [FALLBACK_URLS[0]]: body, [FALLBACK_URLS[1]]: 'throw' });
    expect((await run(only(fbDay('2026-10-22')))).kind).toBe('ok');
    expect((await run(only(fbDay('2026-10-21')))).kind).toBe('ok'); // ended 9 h 15 min ago
    expect((await run(only(fbDay('2026-10-20')))).kind).toBe('down');
    expect((await run(only({ ...FB_PG, date: undefined }))).kind).toBe('down');
  });
  it('a stale first mirror falls through to a current second one', async () => {
    const r = await run({
      [FALLBACK_URLS[0]]: fbDay('2026-10-10'),
      [FALLBACK_URLS[1]]: fbDay('2026-10-22'),
    });
    expect(r.kind).toBe('ok');
  });
  it('the quote carries WHEN its data was current (the oldest leg), for the feedReference', async () => {
    const q = ok(await run(ALL_OK));
    expect(q.reference.quotedAt).toBe(new Date(1792627351 * 1000).toISOString()); // the USD/EGP file is the older leg
    const f = ok(await run({ [FALLBACK_URLS[1]]: FB_PG }));
    expect(f.reference.quotedAt).toBe(NOW.toISOString()); // today's file counts as now
  });
});
