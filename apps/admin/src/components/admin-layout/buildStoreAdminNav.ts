export interface NavItem {
  name: string;
  href: string;
  icon: string;
  /** When set, this nav item is hidden unless the named feature is enabled. */
  featureKey?: string;
  /**
   * When set, this item is considered "active" whenever the detected hub
   * key matches — not just when the pathname starts with `href`. This lets
   * the Catalog hub item stay highlighted on /blog even though its href
   * points to /products.
   */
  hubKey?: string;
}

/**
 * Labels for the 9 top-level sidebar hub items + super-admin items.
 *
 * The per-tab labels used inside each hub (Products, Orders, Chart of Accounts,
 * etc.) live in HubLabels (hubs.ts) and are passed to HubTabs separately.
 */
export type NavLabels = {
  // Hub names (sidebar — 9 items)
  dashboard: string;
  catalog: string;
  sales: string;
  stock: string;
  finance: string;
  analytics: string;
  insights: string;
  marketing: string;
  settings: string;
  // Super-admin only items
  stores: string;
  users: string;
  auditLogs: string;
};

// Super Admin navigation (Force Media platform admin)
export function buildSuperAdminNav(labels: NavLabels): NavItem[] {
  return [
    {
      name: labels.dashboard,
      href: '/',
      icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    },
    {
      name: labels.stores,
      href: '/stores',
      icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    },
    {
      name: labels.users,
      href: '/users',
      icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    },
    {
      name: labels.auditLogs,
      href: '/audit-logs',
      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    },
  ];
}

/**
 * Store Admin navigation — 8 top-level hub items.
 *
 * Each hub item links to the hub's LANDING page (the first meaningful
 * sub-route). HubTabs in AdminLayout renders the per-hub tab bar above
 * page content automatically based on the current URL. No routes are
 * moved — all existing URLs continue to work.
 */
export function buildStoreAdminNav(storeId: string, labels: NavLabels): NavItem[] {
  return [
    {
      name: labels.dashboard,
      href: `/stores/${storeId}`,
      hubKey: 'dashboard',
      // Home icon
      icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    },
    {
      name: labels.catalog,
      href: `/stores/${storeId}/products`,
      hubKey: 'catalog',
      // Package / layers icon
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    },
    {
      name: labels.sales,
      href: `/stores/${storeId}/orders`,
      hubKey: 'sales',
      // Clipboard / orders icon
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    },
    {
      name: labels.stock,
      href: `/stores/${storeId}/stock/dashboard`,
      hubKey: 'stock',
      // Chart bars icon
      icon: 'M3 12h2v9H3zm4-4h2v13H7zm4-4h2v17h-2zm4 8h2v9h-2zm4-12h2v21h-2z',
    },
    {
      name: labels.finance,
      href: `/stores/${storeId}/finance/dashboard`,
      hubKey: 'finance',
      // Dollar-sign circle icon
      icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1L15 8m-3-2v8m4-4a8 8 0 11-16 0 8 8 0 0116 0z',
    },
    {
      name: labels.analytics,
      href: `/stores/${storeId}/analytics`,
      hubKey: 'analytics',
      // Bar chart icon
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      name: labels.insights,
      href: `/stores/${storeId}/insights/dashboard`,
      hubKey: 'insights',
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      name: labels.marketing,
      href: `/stores/${storeId}/ai-tools`,
      hubKey: 'marketing',
      // Sparkle icon
      icon: 'M5 3v4 M3 5h4 M6 17v4 M4 19h4 M13 3l3.5 7L24 13.5 16.5 17 13 24l-3.5-7L2 13.5 9.5 10z',
    },
    {
      name: labels.settings,
      href: `/stores/${storeId}/settings`,
      hubKey: 'settings',
      // Gear icon
      icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    },
  ];
}

export interface StoreBranding {
  id: string;
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
}
