/**
 * The checkout review's "Shipping to" lines (IA-01). Built from the STRUCTURED Egyptian address
 * the form collects (street, building, floor, apartment, area, governorate), in the page
 * language, with the localized area/governorate names when known (else the canonical value).
 * The same labels as the order's composed address1, so the review, the invoice and the courier
 * label read the same.
 */
export interface ShippingSummaryForm {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  governorate: string;
  area: string;
  street: string;
  building: string;
  floor: string;
  apartment: string;
  address?: string;
}

export interface LocalizedPlace {
  en: string;
  ar?: string | null;
}

export function shippingSummaryLines(
  f: ShippingSummaryForm,
  names: { area?: LocalizedPlace; governorate?: LocalizedPlace },
  lang: 'ar' | 'en'
): string[] {
  const ar = lang === 'ar';
  const sep = ar ? '، ' : ', ';
  const label = (en: string, a: string) => (ar ? a : en);
  const street = [
    (f.street ?? '').trim(),
    (f.building ?? '').trim() ? `${label('Building', 'مبنى')} ${(f.building ?? '').trim()}` : '',
    (f.floor ?? '').trim() ? `${label('Floor', 'الدور')} ${(f.floor ?? '').trim()}` : '',
    (f.apartment ?? '').trim() ? `${label('Apt', 'شقة')} ${(f.apartment ?? '').trim()}` : '',
  ]
    .filter(Boolean)
    .join(sep);
  const pick = (p: LocalizedPlace | undefined, canonical: string) =>
    (ar ? p?.ar || p?.en : p?.en) || canonical;
  const place = [pick(names.area, f.area ?? ''), pick(names.governorate, f.governorate ?? '')]
    .filter(Boolean)
    .join(sep);
  return [
    `${f.firstName ?? ''} ${f.lastName ?? ''}`.trim(),
    street || (f.address ?? '').trim(),
    place,
    f.phone,
    ...(f.email ? [f.email] : []),
  ].filter(Boolean);
}
