export interface Store {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: 'active' | 'inactive' | 'suspended';
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  createdAt: string;
  updatedAt: string;
  owner: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  _count?: {
    products: number;
    orders: number;
    customers: number;
  };
  stats?: {
    revenue: number;
    ordersThisMonth: number;
  };
}

export interface StoreEditForm {
  name: string;
  slug: string;
  plan: string;
  status: string;
}

export interface StoreFormErrors {
  name?: string;
  slug?: string;
}

export const statusColors = {
  active: 'default',
  inactive: 'secondary',
  suspended: 'destructive',
} as const;
