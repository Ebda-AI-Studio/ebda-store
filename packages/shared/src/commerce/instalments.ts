import { z } from 'zod/v3';

/**
 * Merchant-configured instalment display (`Store.settings.instalments`, Ruling B2-9).
 *
 * This is ARITHMETIC over the merchant's own settings, shown on the PDP only, named an estimate.
 * It is not a payment method: no provider is integrated, no logo or brand is shipped, checkout
 * totals never change. A merchant who enables it without offering instalments misleads shoppers,
 * which is why the admin card carries one honesty line. Cleared with an explicit `null` (the
 * server's settings merge is shallow), so readers treat null like unset.
 */
export const INSTALMENT_MONTHS_MIN = 3;
export const INSTALMENT_MONTHS_MAX = 60;
export const INSTALMENT_MARKUP_MAX = 100;

export const instalmentsSchema = z
  .object({
    enabled: z.boolean(),
    months: z.number().int().min(INSTALMENT_MONTHS_MIN).max(INSTALMENT_MONTHS_MAX),
    markupPct: z.number().min(0).max(INSTALMENT_MARKUP_MAX),
    /** Optional provider NAME as plain text (never a logo). */
    providerAr: z.string().trim().max(40).optional(),
    providerEn: z.string().trim().max(40).optional(),
    /** Minimum price (minor units) below which no line is shown. Absent = 0. */
    minPrice: z.number().int().min(0).optional(),
  })
  .strict();
export type Instalments = z.infer<typeof instalmentsSchema>;

/**
 * `ceil(price x (1 + markupPct/100) / months)` in integer minor units. The markup is taken in
 * basis points so 2.5 % is exact (no float drift in the ceil); `price` is the displayed price of
 * the selected variant (the sale price, never the struck compare-at).
 */
export function instalmentMonthly(
  price: number,
  s: Pick<Instalments, 'months' | 'markupPct'>
): number {
  const bp = Math.round(s.markupPct * 100);
  return Math.ceil((price * (10000 + bp)) / (10000 * s.months));
}

/**
 * What the PDP shows, or null: the setting is absent / null / invalid / disabled, the price is
 * under `minPrice`, the product cannot be bought now, or the price is not positive. A stored value
 * that fails the schema (a hand-edited JSON row) shows nothing rather than guessing.
 */
export function resolveInstalment(
  raw: unknown,
  priceMinor: number,
  buyable: boolean
): { monthly: number; months: number; providerAr?: string; providerEn?: string } | null {
  if (!buyable || !(priceMinor > 0)) return null;
  const parsed = instalmentsSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.enabled) return null;
  const s = parsed.data;
  if (priceMinor < (s.minPrice ?? 0)) return null;
  return {
    monthly: instalmentMonthly(priceMinor, s),
    months: s.months,
    providerAr: s.providerAr || undefined,
    providerEn: s.providerEn || undefined,
  };
}
