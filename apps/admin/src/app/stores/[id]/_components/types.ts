export interface StoreAcquisition {
  attribution: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    utm_term?: string;
    fbclid?: string;
    landing?: string;
    referrer?: string;
    first_seen: number;
  } | null;
  consent: { analytics: boolean; marketing: boolean };
  capturedAt: string;
}

export interface Store {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  /** Store settings JSON — `defaultLanguage` drives the language of customer-facing share text. */
  settings?: Record<string, unknown> | null;
  /** Storefront logo URL — used by the onboarding checklist to detect upload step. */
  logo?: string | null;
  /** Legacy single hero image URL — fallback signal when layoutSettings.hero.slides is empty. */
  heroImage?: string | null;
  status: 'active' | 'inactive' | 'suspended';
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  createdAt: string;
  updatedAt: string;
  owner: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    /** Super-admin only: how the owner found Ebda (null = no consented tracking at signup). */
    acquisition?: StoreAcquisition | null;
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
