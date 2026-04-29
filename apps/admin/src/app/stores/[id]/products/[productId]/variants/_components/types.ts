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
  /** Parent product SKU. Used to auto-fill per-variant SKUs when the
   *  merchant opens a variant in the editor with no SKU set —
   *  `<parentSku>-<slug(variant.title)>`. */
  sku: string | null;
  price: number;
  hasVariants: boolean;
  inventory: number;
}
