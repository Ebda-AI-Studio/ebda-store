export interface Product {
  id: string;
  name: string;
  nameAr?: string;
  sku: string | null;
  price: number;
  inventory: number;
  status: string;
  images: { url: string }[];
  hasVariants: boolean;
}

export interface Store {
  id: string;
  name: string;
  slug: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type StatusFilter = 'all' | 'active' | 'draft' | 'archived';
