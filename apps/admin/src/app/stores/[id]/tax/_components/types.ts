export interface TaxSettings {
  taxEnabled: boolean;
  taxIncludedInPrice: boolean;
  defaultTaxRate: number | null;
}

export interface TaxRate {
  id: string;
  name: string;
  nameAr: string | null;
  rate: number;
  country: string | null;
  state: string | null;
  priority: number;
  isCompound: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface RateFormData {
  name: string;
  nameAr: string;
  rate: string;
  country: string;
  state: string;
  priority: string;
  isCompound: boolean;
  isActive: boolean;
}

export const DEFAULT_FORM: RateFormData = {
  name: '',
  nameAr: '',
  rate: '',
  country: '',
  state: '',
  priority: '0',
  isCompound: false,
  isActive: true,
};

export interface TaxTemplate {
  name: string;
  nameAr: string;
  rate: number;
}

export const COMMON_TAX_TYPES: TaxTemplate[] = [
  { name: 'VAT', nameAr: 'ضريبة القيمة المضافة', rate: 5 },
  { name: 'GST', nameAr: 'ضريبة السلع والخدمات', rate: 5 },
  { name: 'Sales Tax', nameAr: 'ضريبة المبيعات', rate: 10 },
  { name: 'Luxury Tax', nameAr: 'ضريبة السلع الفاخرة', rate: 15 },
];

export type RateFilter = 'all' | 'active' | 'inactive';
