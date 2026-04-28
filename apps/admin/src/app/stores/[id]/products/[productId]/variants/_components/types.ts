export interface OptionValue {
  id: string;
  value: string;
  valueAr: string | null;
  position: number;
}

export interface Option {
  id: string;
  name: string;
  nameAr: string | null;
  position: number;
  values: OptionValue[];
}

export interface Variant {
  id: string;
  title: string;
  titleAr: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  compareAtPrice: number | null;
  costPrice: number | null;
  inventory: number;
  weight: number | null;
  imageUrl: string | null;
  isActive: boolean;
  optionValues: Array<{
    optionId: string;
    optionName: string;
    optionNameAr: string | null;
    valueId: string;
    value: string;
    valueAr: string | null;
  }>;
}

export interface ProductInfo {
  id: string;
  name: string;
  nameAr: string | null;
  price: number;
  hasVariants: boolean;
  inventory: number;
}

export interface VariantFormState {
  sku: string;
  barcode: string;
  price: string;
  compareAtPrice: string;
  costPrice: string;
  inventory: string;
  weight: string;
  /**
   * Per-variant image URL. Empty string ⇒ no image set; the API treats
   * an explicit `null` as "clear". Saved into `ProductVariant.imageUrl`
   * so the storefront can swap the gallery's main image when this
   * variant is selected.
   */
  imageUrl: string;
}
