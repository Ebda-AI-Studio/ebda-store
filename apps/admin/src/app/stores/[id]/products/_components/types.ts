export interface Product {
  id: string;
  name: string;
  nameAr?: string;
  sku: string | null;
  price: number;
  /** Cost-of-goods in piastres. Optional — older rows may not have this set. */
  costPrice?: number | null;
  inventory: number;
  /** Variant-aware stock total from the API (variant sum for variant products, else `inventory`). */
  totalInventory?: number;
  status: string;
  images: { url: string }[];
  hasVariants: boolean;
  /** Every variant row (admin list `_count`); wins over the column. */
  variantCount?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  /** The search matched more products than the API returns (its closest 1,000): narrow it. */
  truncated?: boolean;
}

export type StatusFilter = 'all' | 'active' | 'draft' | 'archived';
