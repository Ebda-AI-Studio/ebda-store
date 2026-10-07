/**
 * What the charge reads (ruling TAX-1, lib/order-tax.ts): the on/off switch,
 * tax-inclusive pricing, and the SUM of every active rate. Region, priority,
 * compound and a "default rate" are not charge inputs, so the page no longer
 * offers them and the API rejects them (issue 2357, ruling TAX-1a).
 */
export interface TaxSettings {
  taxEnabled: boolean;
  taxIncludedInPrice: boolean;
}

export interface TaxRate {
  id: string;
  name: string;
  nameAr: string | null;
  rate: number;
  isActive: boolean;
  createdAt: string;
}

export interface RateFormData {
  name: string;
  nameAr: string;
  rate: string;
  isActive: boolean;
}

export const DEFAULT_FORM: RateFormData = {
  name: '',
  nameAr: '',
  rate: '',
  isActive: true,
};

export interface TaxTemplate {
  name: string;
  nameAr: string;
  rate: number;
}

export const COMMON_TAX_TYPES: TaxTemplate[] = [
  { name: 'VAT', nameAr: 'ضريبة القيمة المضافة', rate: 14 },
  { name: 'GST', nameAr: 'ضريبة السلع والخدمات', rate: 5 },
  { name: 'Sales Tax', nameAr: 'ضريبة المبيعات', rate: 10 },
  { name: 'Luxury Tax', nameAr: 'ضريبة السلع الفاخرة', rate: 15 },
];

export type RateFilter = 'all' | 'active' | 'inactive';

/**
 * The combined rate the charge applies: the SUM of the active rates, in
 * hundredths so 0.1 + 0.2 is exactly 0.3 — the same arithmetic as
 * `resolveActiveTaxRate` (apps/api/src/lib/order-tax.ts).
 */
export function combinedActiveRate(rates: Pick<TaxRate, 'rate' | 'isActive'>[]): number {
  return (
    rates.filter(r => r.isActive).reduce((n, r) => n + Math.round(Number(r.rate) * 100), 0) / 100
  );
}
