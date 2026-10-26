/**
 * Primary source, leg 2: USD/EGP, keyless, free plan, commercial use permitted with an attribution
 * link (shown in the merchant ADMIN rate editor only, `RateAttribution.tsx`). The response is reused
 * until its own `time_next_update_unix`, so a 6-hourly cron makes about one real call a day; a 429 is
 * never retried inside the run (Ruling B5-15).
 */
import { z } from 'zod/v3';
import { isFreshQuoteTime, type FetchLike } from './gold-api';

/** This source publishes once a day, so its own tolerance is wider than a spot quote's (Ruling B5-36). */
export const MAX_FX_AGE_MS = 36 * 60 * 60 * 1000;

export const USD_RATES_URL = 'https://open.er-api.com/v6/latest/USD';

const bodySchema = z.object({
  result: z.literal('success'),
  base_code: z.literal('USD'),
  time_last_update_unix: z.number().int().positive(),
  time_next_update_unix: z.number().int().positive().optional(),
  rates: z.object({ EGP: z.number().finite().positive() }),
});

let memo: { micro: number; atMs: number; reuseUntilMs: number } | null = null;
/** Reuse window when the body gives no next-update time. */
const DEFAULT_REUSE_MS = 60 * 60 * 1000;

/** Test hook: forget the reused response. */
export function resetUsdEgpMemo(): void {
  memo = null;
}

/** EGP per 1 USD as integer micro-EGP (6 decimals) with the file's own time, or null on any failure or a stale file. */
export async function fetchUsdEgpMicro(
  fetchImpl: FetchLike,
  signal: AbortSignal,
  nowMs: number = Date.now()
): Promise<{ micro: number; atMs: number } | null> {
  if (memo && nowMs < memo.reuseUntilMs && isFreshQuoteTime(memo.atMs, nowMs, MAX_FX_AGE_MS))
    return { micro: memo.micro, atMs: memo.atMs };
  try {
    const res = await fetchImpl(USD_RATES_URL, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null; // a 429 is NOT retried within the run; the next source / run handles it
    const parsed = bodySchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const micro = Math.round(parsed.data.rates.EGP * 1_000_000);
    if (!Number.isSafeInteger(micro) || micro <= 0) return null;
    const atMs = parsed.data.time_last_update_unix * 1000;
    if (!isFreshQuoteTime(atMs, nowMs, MAX_FX_AGE_MS)) return null;
    const next = parsed.data.time_next_update_unix;
    memo = {
      micro,
      atMs,
      reuseUntilMs: next ? Math.max(nowMs, next * 1000) : nowMs + DEFAULT_REUSE_MS,
    };
    return { micro, atMs };
  } catch {
    return null;
  }
}
