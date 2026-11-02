/**
 * The automatic gold rate (Ruling B5-15): the only thing the rest of the code imports from feed/.
 * Free, keyless, commercial-use sources behind a neutral interface: XAU/USD x USD/EGP is primary,
 * one currency file is the fallback; when both answer and differ by more than 2 % the run reports
 * `disagree` and the rate is never auto-applied. No provider name leaves this directory.
 *
 * Conversion (all BigInt, one rounding per figure):
 *   24k piastres per gram = XAUUSD x USDEGP x 100 / 31.1034768
 *   21k = 24k x 21/24, 18k = 24k x 18/24, taken from the UNROUNDED 24k value (never from a rounded one)
 *   plus the store's premium (basis points), applied once.
 */
import { GOLD_KARATS, goldRateJumpBps, type GoldKarat } from '@ebda/shared';
import { fetchXauUsdMicro, type FetchLike } from './gold-api';
import { fetchUsdEgpMicro } from './er-api';
import { fetchEgpPerXau } from './currency-api';
import { timedFetch } from '../../../lib/fetch-with-timeout';

/** Troy ounce in grams x 10^7 (31.1034768 g). */
const OZ_GRAMS_E7 = BigInt(311034768);
const B = (n: number) => BigInt(n);

/** Above this the two sources are in disagreement and nothing is auto-applied. */
export const CROSS_CHECK_BPS = 200;
export const FEED_TIMEOUT_MS = 8000;

/**
 * Patterns that identify a feed provider. The provider-name gate (tests/unit/gold-provider-name-gate.test.ts)
 * imports THIS list, so a source change updates the gate with it.
 */
export const PROVIDER_NAME_PATTERNS: readonly string[] = [
  'gold-api',
  'er-api',
  // the exchange-rate provider by name; the plain words "exchange rate" are the unrelated FX-rates admin page
  'exchange ?rate[- ]?api',
  'fawazahmed0',
  'currency-api',
  'jsdelivr',
];

export interface GoldFeedQuote {
  /** Rounded half-up, for display and the cross-check. */
  per24kGramPiastres: number;
  fetchedAt: string;
  source: 'primary' | 'fallback';
  /** Exact rational per24k = num / den (piastres), as strings: candidates are made from this, not from the rounded figure. */
  exact: { num: string; den: string };
  reference: {
    xauUsdMicro?: number;
    usdEgpMicro?: number;
    egpMicro?: number;
    xauFrac?: number;
    /** When the source data was current: the OLDEST leg's own time (Ruling B5-36). */
    quotedAt: string;
  };
}

export type GoldFeedResult =
  | { kind: 'ok'; quote: GoldFeedQuote }
  | { kind: 'disagree'; primary: GoldFeedQuote; fallback: GoldFeedQuote; diffBps: number }
  | { kind: 'down' };

export interface GoldFeedAdapter {
  fetch(signal: AbortSignal): Promise<GoldFeedResult>;
}

const roundDiv = (a: bigint, b: bigint): bigint => (B(2) * a + b) / (B(2) * b);

function quoteFrom(
  source: GoldFeedQuote['source'],
  num: bigint,
  den: bigint,
  reference: GoldFeedQuote['reference'],
  now: Date
): GoldFeedQuote | null {
  const per24 = Number(roundDiv(num, den));
  // plausibility: EGP 100 .. 100 000 per gram (the same bounds as a stored rate)
  if (!Number.isSafeInteger(per24) || per24 < 10_000 || per24 > 10_000_000) return null;
  return {
    per24kGramPiastres: per24,
    fetchedAt: now.toISOString(),
    source,
    exact: { num: num.toString(), den: den.toString() },
    reference,
  };
}

export interface FeedDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** The last stored 24k rate, for the 10x spike check; omitted = skip it. */
  previous24k?: number | null;
}

export function goldFeed(deps: FeedDeps = {}): GoldFeedAdapter {
  const fetchImpl: FetchLike =
    deps.fetchImpl ?? ((url, init) => timedFetch('gold-rate.feed')(url, init));
  const nowFn = deps.now ?? (() => new Date());
  return {
    async fetch(signal: AbortSignal): Promise<GoldFeedResult> {
      const now = nowFn();
      const [xau, usdEgp, fb] = await Promise.all([
        fetchXauUsdMicro(fetchImpl, signal, now.getTime()),
        fetchUsdEgpMicro(fetchImpl, signal, now.getTime()),
        fetchEgpPerXau(fetchImpl, signal, now.getTime()),
      ]);
      const spike = (q: GoldFeedQuote | null) =>
        q &&
        deps.previous24k &&
        (q.per24kGramPiastres > deps.previous24k * 10 ||
          q.per24kGramPiastres * 10 < deps.previous24k)
          ? null
          : q;

      // XAUUSD(micro) x USDEGP(micro) / 10^12 = EGP per oz ; x 100 piastres / 31.1034768
      //   = xau x egp x 100 x 10^7 / (10^12 x 311034768) = xau x egp / (311034768 x 10^3)
      const primary = spike(
        xau && usdEgp
          ? quoteFrom(
              'primary',
              B(xau.micro) * B(usdEgp.micro),
              OZ_GRAMS_E7 * B(1000),
              {
                xauUsdMicro: xau.micro,
                usdEgpMicro: usdEgp.micro,
                quotedAt: new Date(Math.min(xau.atMs, usdEgp.atMs)).toISOString(),
              },
              now
            )
          : null
      );
      // egpPerXau = egpMicro / 10^6 / (xauFrac / 10^12) = egpMicro x 10^6 / xauFrac ; piastres/g = that x 100 x 10^7 / 311034768
      const fallback = spike(
        fb
          ? quoteFrom(
              'fallback',
              B(fb.egpMicro) * B(1_000_000) * B(100) * B(10_000_000),
              B(fb.xauFrac) * OZ_GRAMS_E7,
              {
                egpMicro: fb.egpMicro,
                xauFrac: fb.xauFrac,
                quotedAt: new Date(fb.atMs).toISOString(),
              },
              now
            )
          : null
      );

      if (primary && fallback) {
        const diffBps = goldRateJumpBps(primary.per24kGramPiastres, fallback.per24kGramPiastres);
        if (diffBps > CROSS_CHECK_BPS) return { kind: 'disagree', primary, fallback, diffBps };
        return { kind: 'ok', quote: primary };
      }
      if (primary) return { kind: 'ok', quote: primary };
      if (fallback) return { kind: 'ok', quote: fallback };
      return { kind: 'down' };
    },
  };
}

/**
 * The store's candidate rates: 24k x (10000 + premium) / 10000, 21k and 18k from the same exact value,
 * ONE half-up rounding each, integer piastres per gram.
 */
export function storeCandidateRates(q: GoldFeedQuote, premiumBps: number): Map<GoldKarat, number> {
  const num = BigInt(q.exact.num);
  const den = BigInt(q.exact.den);
  const out = new Map<GoldKarat, number>();
  for (const karat of GOLD_KARATS)
    out.set(
      karat,
      Number(roundDiv(num * B(karat) * B(10_000 + premiumBps), den * B(24) * B(10_000)))
    );
  return out;
}
