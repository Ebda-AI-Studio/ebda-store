export interface Product {
  id: string;
  name: string;
  nameAr?: string;
  sku: string | null;
  price: number;
  /** Cost-of-goods in fils. Optional — older rows may not have this set. */
  costPrice?: number | null;
  inventory: number;
  /** Variant-aware stock total from the API (variant sum for variant products, else `inventory`). */
  totalInventory?: number;
  status: string;
  images: { url: string }[];
  hasVariants: boolean;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type StatusFilter = 'all' | 'active' | 'draft' | 'archived';
