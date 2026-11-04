/**
 * Display helpers for a gold-priced piece on the storefront (Phase B5 Task 14). Display only: the SERVER
 * decides what can be ordered (GOLD_RATE_STALE at checkout), this tells the shopper early and disables the
 * button. Integers in, text out; no price is ever computed here.
 */
import {
  isBnplMethod,
  mgToGramsString,
  PAY_LATER_REFERENCE_CODES,
  type PublicGoldPricing,
} from '@ebda/shared';

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
export function goldRateTime(rateAppliedAt: string, lang: 'ar' | 'en', _numerals?: 'latn'): string {
  const d = new Date(rateAppliedAt);
  if (Number.isNaN(d.getTime())) return '';
  // Western digits always (DIGITS-1): `ar-EG` alone prints Arabic-Indic ones.
  return new Intl.DateTimeFormat(`${lang === 'ar' ? 'ar-EG' : 'en-GB'}-u-nu-latn`, {
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

/**
 * The line a receipt or an order page prints for a gold-priced piece: the karat, the weight and the per-gram
 * rate it was priced at, frozen on the order. Null for any other line. Display only.
 */
export function goldSnapshotLine(
  snap: { karat: number; weightMg: number; ratePerGram: number } | null | undefined,
  lang: 'ar' | 'en',
  money: (piastres: number) => string,
  localize: (v: string | number) => string
): string | null {
  if (!snap) return null;
  const { karat, grams } = goldLineParts({
    karat: snap.karat as 24 | 21 | 18,
    weightMg: snap.weightMg,
  });
  return lang === 'ar'
    ? `عيار ${localize(karat)} · ${localize(grams)} جم · ${money(snap.ratePerGram)} للجرام`
    : `${localize(karat)} karat · ${localize(grams)} g · ${money(snap.ratePerGram)} per gram`;
}

/**
 * Checkout option ids that defer payment (`cod`, `paymob:valu`, `paymob:kiosk`, `fawry:payatfawry`; Kashier's hosted page is
 * kept because the API drops its installment token for gold). Hidden for a gold cart unless the merchant
 * allowed them (Ruling SHARIA-GOLD-1). Display only: the server refuses these on a gold order regardless.
 */
export function isDeferredGoldOption(optionId: string): boolean {
  const [provider, method] = optionId.toLowerCase().split(':');
  return (
    provider === 'cod' ||
    isBnplMethod(method) ||
    (PAY_LATER_REFERENCE_CODES as readonly string[]).includes(method ?? '')
  );
}
