export interface PlatformStats {
  stores: number;
  users: number;
  orders: number;
  revenue: number;
}

export interface RecentStore {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  owner: { email: string };
}

export interface RecentOrder {
  id: string;
  orderNumber: string;
  total: number;
  status: string;
  createdAt: string;
  customer: { email: string; firstName: string; lastName: string };
  store: { name: string };
}
