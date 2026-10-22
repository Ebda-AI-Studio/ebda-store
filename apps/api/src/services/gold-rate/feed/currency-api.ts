/**
 * Fallback source: one currency file whose `usd` map carries both `egp` and `xau`, so EGP per troy
 * ounce is `egp / xau` from a SINGLE response (the two legs of the primary cannot disagree here). CC0,
 * no limits. jsDelivr first, the Cloudflare-pages mirror if that fails (Ruling B5-15).
 */
import { z } from 'zod';
import type { FetchLike } from './gold-api';

export const FALLBACK_URLS = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
] as const;

const bodySchema = z.object({
  date: z.string().optional(),
  usd: z.object({
    egp: z.number().finite().positive(),
    // troy ounces of gold per 1 USD (about 0.00024)
    xau: z.number().finite().positive(),
  }),
});

/** EGP per troy ounce as an integer number of micro-EGP, from one file, or null. */
export async function fetchEgpPerXau(
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<{ egpMicro: number; xauFrac: number } | null> {
  for (const url of FALLBACK_URLS) {
    try {
      const res = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const parsed = bodySchema.safeParse(await res.json());
      if (!parsed.success) continue;
      const egpMicro = Math.round(parsed.data.usd.egp * 1_000_000);
      // 12 decimals: xau is about 2.4e-4, so 12 places keep 8 significant digits
      const xauFrac = Math.round(parsed.data.usd.xau * 1_000_000_000_000);
      if (
        Number.isSafeInteger(egpMicro) &&
        egpMicro > 0 &&
        Number.isSafeInteger(xauFrac) &&
        xauFrac > 0
      )
        return { egpMicro, xauFrac };
    } catch {
      // try the next mirror
    }
  }
  return null;
}
