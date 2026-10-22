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
  updatedAt: z.string().optional(),
});

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** USD per troy ounce as an integer number of micro-dollars (6 decimals), or null on any failure. */
export async function fetchXauUsdMicro(
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<number | null> {
  try {
    const res = await fetchImpl(GOLD_SPOT_URL, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const parsed = bodySchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const micro = Math.round(parsed.data.price * 1_000_000);
    return Number.isSafeInteger(micro) && micro > 0 ? micro : null;
  } catch {
    return null;
  }
}
