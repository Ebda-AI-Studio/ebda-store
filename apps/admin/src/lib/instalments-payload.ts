import { instalmentsSchema, type Instalments } from '@ebda/shared';
import { majorInputToMinor } from './checkout-delivery-payload';

/**
 * Build `settings.instalments` from the card's inputs. Optional fields that are empty are simply
 * not in the object: the whole `instalments` value REPLACES the stored one (the settings merge is
 * shallow, one level), so an omitted provider or minimum is cleared, never left behind. Returns
 * 'invalid' when the numbers fail the shared schema (months 3..60, markup 0..100).
 */
export function buildInstalmentsPayload(input: {
  enabled: boolean;
  months: string;
  markup: string;
  providerEn: string;
  providerAr: string;
  minPrice: string;
}): Instalments | 'invalid' {
  const body: Record<string, unknown> = {
    enabled: input.enabled,
    months: Number(input.months),
    markupPct: input.markup.trim() === '' ? 0 : Number(input.markup),
  };
  const en = input.providerEn.trim();
  const ar = input.providerAr.trim();
  if (en) body.providerEn = en;
  if (ar) body.providerAr = ar;
  const min = majorInputToMinor(input.minPrice);
  if (min > 0) body.minPrice = min;
  const parsed = instalmentsSchema.safeParse(body);
  return parsed.success ? parsed.data : 'invalid';
}
