export interface Store {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  logo?: string | null;
  status: 'active' | 'inactive' | 'suspended';
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  createdAt: string;
  owner: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  _count?: {
    products: number;
    orders: number;
  };
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export const statusConfig = {
  active: {
    variant: 'default' as const,
    bg: 'bg-success/10',
    text: 'text-success-ink',
    dot: 'bg-success',
  },
  inactive: {
    variant: 'secondary' as const,
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
  suspended: {
    variant: 'destructive' as const,
    bg: 'bg-destructive/5',
    text: 'text-destructive-ink',
    dot: 'bg-destructive',
  },
};

export const planConfig = {
  free: { bg: 'bg-muted', text: 'text-foreground', icon: '🆓' },
  starter: { bg: 'bg-info/5', text: 'text-info-ink', icon: '🚀' },
  professional: { bg: 'bg-primary/10', text: 'text-primary-ink', icon: '💼' },
  enterprise: { bg: 'bg-warning/10', text: 'text-warning-ink', icon: '👑' },
};

export { formatDate } from '@/lib/format';
