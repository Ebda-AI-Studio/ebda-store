/**
 * Primary source, leg 1: XAU/USD spot, keyless, commercial use permitted (Ruling B5-15; recorded
 * terms in business/ebda/gold-rate-free-sources.md). This is the ONLY file (with the other adapters
 * in feed/) that may name the provider: the provider-name gate fails anywhere else.
 */
import { z } from 'zod';

export const GOLD_SPOT_URL = 'https://api.gold-api.com/price/XAU';

const bodySchema = z.object({
  symbol: z.literal('XAU'),
  currency: z.literal('USD'),
  // USD per troy ounce
  price: z.number().finite().positive(),
  // required: a quote with no time cannot be shown to be live (Ruling B5-36)
  updatedAt: z.string().min(1),
});

/** A spot quote older than this is a frozen feed, not a price (Ruling B5-36). */
export const MAX_QUOTE_AGE_MS = 12 * 60 * 60 * 1000;
/** A timestamp this far in the future is a broken clock, not a fresh quote. */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

/** True when `atMs` is a usable instant no older than `maxAgeMs` and not absurdly in the future. */
export function isFreshQuoteTime(atMs: number, nowMs: number, maxAgeMs: number): boolean {
  return Number.isFinite(atMs) && nowMs - atMs <= maxAgeMs && atMs - nowMs <= MAX_FUTURE_SKEW_MS;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** USD per troy ounce as integer micro-dollars (6 decimals) with the quote's own time, or null on any failure or a stale quote. */
export async function fetchXauUsdMicro(
  fetchImpl: FetchLike,
  signal: AbortSignal,
  nowMs: number = Date.now()
): Promise<{ micro: number; atMs: number } | null> {
  try {
    const res = await fetchImpl(GOLD_SPOT_URL, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const parsed = bodySchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const atMs = Date.parse(parsed.data.updatedAt);
    if (!isFreshQuoteTime(atMs, nowMs, MAX_QUOTE_AGE_MS)) return null;
    const micro = Math.round(parsed.data.price * 1_000_000);
    return Number.isSafeInteger(micro) && micro > 0 ? { micro, atMs } : null;
  } catch {
    return null;
  }
}
