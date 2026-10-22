/**
 * Display helpers for a gold-priced piece on the storefront (Phase B5 Task 14). Display only: the SERVER
 * decides what can be ordered (GOLD_RATE_STALE at checkout), this tells the shopper early and disables the
 * button. Integers in, text out; no price is ever computed here.
 */
import { mgToGramsString, type PublicGoldPricing } from '@ebda/shared';

/** Same rule as the server's `isRateStale`: age in whole minutes >= the store's limit. */
export function goldRateIsStale(
  gold: Pick<PublicGoldPricing, 'rateAppliedAt' | 'maxAgeMinutes'>,
  now: number
): boolean {
  const applied = Date.parse(gold.rateAppliedAt);
  if (Number.isNaN(applied)) return true; // an unreadable timestamp is never trusted as fresh
  return Math.floor((now - applied) / 60_000) >= gold.maxAgeMinutes;
}

/** When the rate was recorded, in the Egyptian clock so SSR and the browser print the same text. */
export function goldRateTime(rateAppliedAt: string, lang: 'ar' | 'en'): string {
  const d = new Date(rateAppliedAt);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', {
    timeZone: 'Africa/Cairo',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export interface GoldLineParts {
  karat: number;
  grams: string;
}

export function goldLineParts(gold: Pick<PublicGoldPricing, 'karat' | 'weightMg'>): GoldLineParts {
  return { karat: gold.karat, grams: mgToGramsString(gold.weightMg) };
}

export interface PriceChangedLine {
  id: string;
  name: string;
  previous?: number;
  current: number;
}

/** The cart lines whose gold price moved, named in the shopper's language, for the "السعر اتحدّث" notice. */
export function priceChangedLines(
  items: ReadonlyArray<{
    id: string;
    name: string;
    nameAr?: string;
    price: number;
    previousPrice?: number;
    priceChanged?: boolean;
  }>,
  lang: string
): PriceChangedLine[] {
  return items
    .filter(i => i.priceChanged === true)
    .map(i => ({
      id: i.id,
      name: lang === 'ar' && i.nameAr ? i.nameAr : i.name,
      previous: i.previousPrice,
      current: i.price,
    }));
}
