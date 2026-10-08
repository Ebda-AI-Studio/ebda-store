/**
 * One delivery-address renderer for every document a merchant or shopper reads
 * (invoice page + email, order confirmation email, admin and orders-app
 * delivery cards). Egyptian checkout writes `governorate`/`governorateAr`,
 * `area`/`areaAr` and the landmark («علامة مميزة») in `address2`, and leaves
 * `city`/`state`/`postalCode` EMPTY — so a `city, state postalCode` line
 * printed a stray ", " and dropped the governorate, area and landmark
 * (sense audit 1, findings 3 and 4).
 *
 * Pure: returns display lines (unescaped — callers escape for HTML), never an
 * empty line and never a dangling separator.
 */

import { REGION } from './region';

export type AddressLocale = 'ar' | 'en';

export interface AddressLines {
  /** Street / building / floor / apartment (the composed `address1`). */
  street: string | null;
  /** The landmark («علامة مميزة»), prefixed with its label. */
  landmark: string | null;
  /** "Area, Governorate[ postalCode]" in the reader's language, falling back to city/state. */
  locality: string | null;
  country: string | null;
}

const LANDMARK_LABEL: Record<AddressLocale, string> = {
  ar: 'علامة مميزة',
  en: 'Landmark',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function pick(locale: AddressLocale, ar: string, en: string): string {
  return locale === 'ar' ? ar || en : en || ar;
}

export function orderAddressParts(
  addr: Record<string, unknown> | null | undefined,
  locale: AddressLocale
): AddressLines {
  if (!addr) return { street: null, landmark: null, locality: null, country: null };
  const street = str(addr.address1) || str(addr.street);
  const landmark = str(addr.address2) || str(addr.landmark);
  const area = pick(locale, str(addr.areaAr), str(addr.area));
  const city = pick(locale, str(addr.cityAr), str(addr.city));
  const governorate = pick(locale, str(addr.governorateAr), str(addr.governorate));
  const state = str(addr.state);
  const sep = locale === 'ar' ? '، ' : ', ';
  // Area (or city when there is no area) then governorate (or state). A value
  // that repeats the previous one (city == governorate, "Cairo, Cairo") prints once.
  const parts: string[] = [];
  for (const p of [area || city, governorate || state]) {
    if (p && !parts.includes(p)) parts.push(p);
  }
  let locality = parts.join(sep);
  const postal = str(addr.postalCode);
  if (postal) locality = locality ? `${locality} ${postal}` : postal;
  const rawCountry = str(addr.country);
  // The home country in the reader's language ("Egypt" -> «مصر»); any other
  // country prints as stored.
  const isHome =
    rawCountry === REGION.countryName.en ||
    rawCountry === REGION.countryName.ar ||
    rawCountry.toUpperCase() === 'EG';
  const country = isHome ? REGION.countryName[locale] : rawCountry;
  return {
    street: street || null,
    landmark: landmark ? `${LANDMARK_LABEL[locale]}: ${landmark}` : null,
    locality: locality || null,
    country: country || null,
  };
}

/** The non-empty address lines in reading order. */
export function orderAddressLines(
  addr: Record<string, unknown> | null | undefined,
  locale: AddressLocale
): string[] {
  const p = orderAddressParts(addr, locale);
  return [p.street, p.landmark, p.locality, p.country].filter((l): l is string => !!l);
}
