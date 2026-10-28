/**
 * Fallback source: one currency file whose `usd` map carries both `egp` and `xau`, so EGP per troy
 * ounce is `egp / xau` from a SINGLE response (the two legs of the primary cannot disagree here). CC0,
 * no limits. jsDelivr first, the Cloudflare-pages mirror if that fails (Ruling B5-15).
 */
import { z } from 'zod/v3';
import { MAX_QUOTE_AGE_MS, isFreshQuoteTime, type FetchLike } from './gold-api';

export const FALLBACK_URLS = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
] as const;

const bodySchema = z.object({
  // YYYY-MM-DD; required, a file with no date cannot be shown to be current (Ruling B5-36)
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  usd: z.object({
    egp: z.number().finite().positive(),
    // troy ounces of gold per 1 USD (about 0.00024)
    xau: z.number().finite().positive(),
  }),
});

/**
 * EGP per troy ounce as an integer number of micro-EGP, from one file, or null. The file carries a DATE, so
 * its instant is the END of that UTC day: it is current until 12 hours after the day ended (Ruling B5-36).
 */
export async function fetchEgpPerXau(
  fetchImpl: FetchLike,
  signal: AbortSignal,
  nowMs: number = Date.now()
): Promise<{ egpMicro: number; xauFrac: number; atMs: number } | null> {
  for (const url of FALLBACK_URLS) {
    try {
      const res = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const parsed = bodySchema.safeParse(await res.json());
      if (!parsed.success) continue;
      // today's file counts as "now" (its day has not ended); a past day counts from its last second
      const startMs = Date.parse(`${parsed.data.date}T00:00:00Z`);
      const atMs = Math.min(Date.parse(`${parsed.data.date}T23:59:59Z`), nowMs);
      if (
        !Number.isFinite(startMs) ||
        !isFreshQuoteTime(startMs <= nowMs ? atMs : startMs, nowMs, MAX_QUOTE_AGE_MS)
      )
        continue; // try the other mirror: it may be newer
      const egpMicro = Math.round(parsed.data.usd.egp * 1_000_000);
      // 12 decimals: xau is about 2.4e-4, so 12 places keep 8 significant digits
      const xauFrac = Math.round(parsed.data.usd.xau * 1_000_000_000_000);
      if (
        Number.isSafeInteger(egpMicro) &&
        egpMicro > 0 &&
        Number.isSafeInteger(xauFrac) &&
        xauFrac > 0
      )
        return { egpMicro, xauFrac, atMs };
    } catch {
      // try the next mirror
    }
  }
  return null;
}
