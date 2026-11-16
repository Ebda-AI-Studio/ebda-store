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
  /** When true, this nav item is only shown to super_admin users. */
  superAdminOnly?: boolean;
  /**
   * When true, this nav item is hidden from staff users.
   * Staff can manage day-to-day operations but cannot touch store configuration
   * (billing, payment settings, branding, domain, shipping zones, etc.).
   */
  staffRestricted?: boolean;
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
  /** The visual storefront editor (its own entry since T9). */
  editor: string;
  sales: string;
  stock: string;
  finance: string;
  analytics: string;
  marketing: string;
  settings: string;
  // Super-admin only items
  stores: string;
  users: string;
  auditLogs: string;
  /** Platform-wide AI usage rollup (super_admin only) */
  platformAiUsage: string;
  platformUsageHistory: string;
  /** Plans catalogue editor (super_admin only) */
  platformPlans: string;
  platformBillingEvents: string;
  /** Merchant VAT-registration review queue (super_admin only) */
  platformTaxVerification: string;
  /** Provider activation requests queue (super_admin only) */
  platformProviderActivation: string;
  /** Six-year fiscal-document archive across all stores, deleted ones too (super_admin only) */
  platformTaxArchive: string;
  /** Legal documents + material-change notices (super_admin only, Ruling LEGAL-4) */
  platformPolicyUpdates: string;
  platformCiInsights: string;
  platformActivation: string;
  platformTrustRequests: string;
  /** Platform-wide settings, e.g. Ebda's own VAT (super_admin only) */
  platformSettings: string;
  // Super-admin store-scoped item
  manageFeatures: string;
};

// Super Admin navigation (Ebda platform admin)
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
    {
      // Sparkle icon — same as marketing hub to reinforce "AI" ownership
      name: labels.platformAiUsage,
      href: '/ai-usage',
      icon: 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z',
    },
    {
      // Bar-chart icon — monthly per-store usage snapshots (issue 1058).
      name: labels.platformUsageHistory,
      href: '/usage-history',
      icon: 'M3 3v18h18M7 16v-4m4 4V8m4 8v-6m4 6V5',
    },
    {
      // Layers icon — the plans catalogue (limits, visibility, prices).
      name: labels.platformPlans,
      href: '/plans',
      icon: 'M12 3l9 4.5-9 4.5-9-4.5L12 3zm0 9l9 4.5-9 4.5-9-4.5L12 12z',
    },
    {
      // Receipt icon — the append-only subscription billing ledger.
      name: labels.platformBillingEvents,
      href: '/billing-events',
      icon: 'M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z',
    },
    {
      // Shield-check icon — merchant VAT registration review queue.
      name: labels.platformTaxVerification,
      href: '/tax-verification',
      icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    },
    {
      // Plug icon — merchants' provider activation requests.
      name: labels.platformProviderActivation,
      href: '/provider-activation',
      icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    },
    {
      // Archive-box icon — fiscal documents kept seven years, deleted stores included.
      name: labels.platformTaxArchive,
      href: '/tax-archive',
      icon: 'M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5 M10 11.25h4 M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z',
    },
    {
      // Document-check icon — legal policy versions and merchant notices.
      name: labels.platformPolicyUpdates,
      href: '/policy-updates',
      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    },
    {
      // Light-bulb icon — Customer Intelligence findings to accept or dismiss.
      name: labels.platformCiInsights,
      href: '/ci-insights',
      icon: 'M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0012 3z M10 21h4',
    },
    {
      // Funnel icon — merchant activation: time from signup to first order, help needed, where orders stopped.
      name: labels.platformActivation,
      href: '/activation',
      icon: 'M3 4h18l-7 8v6l-4 2v-8L3 4z',
    },
    {
      // Life-buoy icon — what merchants ask of staff: support, appeals, protected address claims, store limit requests.
      name: labels.platformTrustRequests,
      href: '/trust-requests',
      icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 5a4 4 0 100 8 4 4 0 000-8zM5.6 5.6l3.2 3.2m6.4 6.4l3.2 3.2m0-12.8l-3.2 3.2m-6.4 6.4l-3.2 3.2',
    },
    {
      // Cog icon — platform-wide settings (Ebda's own VAT).
      name: labels.platformSettings,
      href: '/platform-settings',
      icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
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
  // No store id yet (first render): a link built now would be `/stores//...`, which the router prefetches as a 404.
  if (!storeId) return [];
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
      name: labels.editor,
      href: `/stores/${storeId}/builder`,
      hubKey: 'editor',
      // Pencil-square icon (Heroicons v2 `pencil-square`): edit the storefront.
      icon: 'M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10',
    },
    {
      name: labels.sales,
      href: `/stores/${storeId}/orders`,
      hubKey: 'sales',
      // Price tag (Heroicons v2 `tag`) — the classic commerce/sales glyph.
      // Replaces the old clipboard icon that read as "notes" not "sales".
      icon: 'M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z M6 6h.008v.008H6V6z',
    },
    {
      name: labels.stock,
      href: `/stores/${storeId}/stock/dashboard`,
      hubKey: 'stock',
      // Archive box with lid (Heroicons v2 `archive-box`) — a literal box
      // says "inventory" instantly. Replaces the bar-chart icon which read
      // as analytics and conflicted visually with the analytics hub.
      icon: 'M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5 M10 11.25h4 M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z',
    },
    {
      name: labels.finance,
      href: `/stores/${storeId}/finance/dashboard`,
      hubKey: 'finance',
      // Calculator (Heroicons v2 `calculator`) — reads as accounting, not
      // just "money/revenue" like the old dollar-circle.
      icon: 'M15.75 15.75V18 M8.25 6h7.5v2.25h-7.5V6z M12 2.25c-1.892 0-3.758.11-5.593.322C5.307 2.7 4.5 3.65 4.5 4.757V19.5a2.25 2.25 0 002.25 2.25h10.5a2.25 2.25 0 002.25-2.25V4.757c0-1.108-.806-2.057-1.907-2.185A48.507 48.507 0 0012 2.25z M8.25 11.25h.008v.008H8.25v-.008z M8.25 13.5h.008v.008H8.25V13.5z M8.25 15.75h.008v.008H8.25v-.008z M8.25 18h.008v.008H8.25V18z M10.748 11.25h.008v.008h-.008v-.008z M10.748 13.5h.008v.008h-.008V13.5z M10.748 15.75h.008v.008h-.008v-.008z M10.748 18h.008v.008h-.008V18z M13.252 11.25h.008v.008h-.008v-.008z M13.252 13.5h.008v.008h-.008V13.5z M13.252 15.75h.008v.008h-.008v-.008z M13.252 18h.008v.008h-.008V18z M15.75 11.25h.008v.008h-.008v-.008z M15.75 13.5h.008v.008h-.008V13.5z',
      // Accounting/financial records are owner-only — staff cannot post journal entries or view P&L
      staffRestricted: true,
    },
    {
      name: labels.analytics,
      href: `/stores/${storeId}/analytics`,
      hubKey: 'analytics',
      // Trending-up arrow (Heroicons v2 `arrow-trending-up`) — a rising
      // line reads as growth/analytics; visually distinct from the new
      // archive-box on Stock so the two hubs no longer look alike.
      icon: 'M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22 M16.106 8.818l5.94 2.281 M22.046 11.099l-2.28 5.941',
    },
    {
      name: labels.marketing,
      // Lands on the offers overview (coupons), a page every plan can open (audit M-1, UX:N-4).
      href: `/stores/${storeId}/coupons`,
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
      // Staff users should not see store settings (billing, payment config, branding)
      staffRestricted: true,
    },
    {
      name: labels.manageFeatures,
      href: `/stores/${storeId}/features`,
      // Adjustments / sliders icon (Heroicons v2 `adjustments-horizontal`)
      icon: 'M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75',
      superAdminOnly: true,
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
