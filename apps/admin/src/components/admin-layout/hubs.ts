import type { HubTab } from './HubTabs';

export interface HubDefinition {
  key:
    | 'dashboard'
    | 'catalog'
    | 'sales'
    | 'stock'
    | 'finance'
    | 'analytics'
    | 'marketing'
    | 'settings';
  /** URL path segments (after `/stores/[id]`) that belong to this hub. */
  urlPrefixes: string[];
  /** Tabs to show inside the hub. Returns [] for single-page hubs. */
  buildTabs: (storeId: string, labels: HubLabels) => HubTab[];
}

export type HubLabels = {
  // Catalog tabs
  products: string;
  pageBuilder: string;
  content: string;
  blog: string;
  floatingWidget: string;
  // Sales tabs
  orders: string;
  customers: string;
  reviews: string;
  returns: string;
  coupons: string;
  loyalty: string;
  // Stock tabs
  stockDashboard: string;
  inventory: string;
  adjustments: string;
  suppliers: string;
  purchaseOrders: string;
  backorders: string;
  reorder: string;
  deadstock: string;
  // Finance tabs
  financeDashboard: string;
  accounts: string;
  journal: string;
  expenses: string;
  reports: string;
  // Analytics tabs — Overview is the legacy /analytics dashboard; the rest
  // are the former /insights subroutes folded into the analytics hub
  // (Ahmad 2026-05-20: "insights and analytics are not the same, remove one
  // if so" — kept both content surfaces but merged the nav).
  analyticsOverview: string;
  insightsDashboard: string;
  insightsCohorts: string;
  insightsFunnel: string;
  insightsSegments: string;
  insightsProducts: string;
  // Marketing tabs
  aiTools: string;
  aiUsage: string;
  whatsapp: string;
  whatsappTemplates: string;
  whatsappPaymentLink: string;
  marketingPixels: string;
  notifications: string;
  newsletter: string;
  affiliates: string;
  abandonedCarts: string;
};

export const HUBS: HubDefinition[] = [
  {
    key: 'dashboard',
    urlPrefixes: [''],
    buildTabs: () => [],
  },
  {
    key: 'catalog',
    urlPrefixes: [
      '/products',
      '/page-builder',
      '/content',
      '/blog',
      '/catalog',
      '/floating-widget',
    ],
    buildTabs: (storeId, labels) => [
      { label: labels.products, href: `/stores/${storeId}/products` },
      { label: labels.pageBuilder, href: `/stores/${storeId}/page-builder` },
      { label: labels.content, href: `/stores/${storeId}/content` },
      { label: labels.blog, href: `/stores/${storeId}/blog` },
      { label: labels.floatingWidget, href: `/stores/${storeId}/floating-widget` },
    ],
  },
  {
    key: 'sales',
    urlPrefixes: [
      '/orders',
      '/customers',
      '/sales',
      '/reviews',
      '/returns',
      '/coupons',
      '/loyalty',
    ],
    buildTabs: (storeId, labels) => [
      { label: labels.orders, href: `/stores/${storeId}/orders` },
      { label: labels.customers, href: `/stores/${storeId}/customers` },
      { label: labels.reviews, href: `/stores/${storeId}/reviews` },
      { label: labels.returns, href: `/stores/${storeId}/returns` },
      // Coupons and loyalty are feature-gated at the page level via
      // useRequireFeature('coupons') / loyalty gating. HubTab has no
      // per-tab featureKey mechanism so the tab always renders; the page
      // itself redirects/blocks when the feature is disabled.
      { label: labels.coupons, href: `/stores/${storeId}/coupons` },
      { label: labels.loyalty, href: `/stores/${storeId}/loyalty` },
    ],
  },
  {
    key: 'stock',
    urlPrefixes: ['/stock'],
    buildTabs: (storeId, labels) => [
      { label: labels.stockDashboard, href: `/stores/${storeId}/stock/dashboard` },
      { label: labels.inventory, href: `/stores/${storeId}/stock/inventory` },
      { label: labels.adjustments, href: `/stores/${storeId}/stock/adjustments` },
      { label: labels.suppliers, href: `/stores/${storeId}/stock/suppliers` },
      { label: labels.purchaseOrders, href: `/stores/${storeId}/stock/purchase-orders` },
      { label: labels.backorders, href: `/stores/${storeId}/stock/backorders` },
      { label: labels.reorder, href: `/stores/${storeId}/stock/reorder` },
      { label: labels.deadstock, href: `/stores/${storeId}/stock/deadstock` },
    ],
  },
  {
    key: 'finance',
    urlPrefixes: ['/finance'],
    buildTabs: (storeId, labels) => [
      { label: labels.financeDashboard, href: `/stores/${storeId}/finance/dashboard` },
      { label: labels.accounts, href: `/stores/${storeId}/finance/accounts` },
      { label: labels.journal, href: `/stores/${storeId}/finance/journal` },
      { label: labels.expenses, href: `/stores/${storeId}/finance/expenses` },
      { label: labels.reports, href: `/stores/${storeId}/finance/reports` },
    ],
  },
  {
    key: 'analytics',
    urlPrefixes: ['/analytics', '/insights'],
    buildTabs: (storeId, labels) => [
      { label: labels.analyticsOverview, href: `/stores/${storeId}/analytics` },
      { label: labels.insightsDashboard, href: `/stores/${storeId}/insights/dashboard` },
      { label: labels.insightsCohorts, href: `/stores/${storeId}/insights/cohorts` },
      { label: labels.insightsFunnel, href: `/stores/${storeId}/insights/funnel` },
      { label: labels.insightsSegments, href: `/stores/${storeId}/insights/segments` },
      { label: labels.insightsProducts, href: `/stores/${storeId}/insights/products` },
    ],
  },
  {
    key: 'marketing',
    urlPrefixes: [
      '/ai-tools',
      '/ai-usage',
      '/marketing',
      '/marketing-pixels',
      '/notifications',
      '/newsletter',
      '/affiliates',
      '/abandoned-carts',
    ],
    buildTabs: (storeId, labels) => [
      { label: labels.aiTools, href: `/stores/${storeId}/ai-tools` },
      { label: labels.aiUsage, href: `/stores/${storeId}/ai-usage` },
      { label: labels.notifications, href: `/stores/${storeId}/notifications` },
      { label: labels.newsletter, href: `/stores/${storeId}/newsletter` },
      { label: labels.abandonedCarts, href: `/stores/${storeId}/abandoned-carts` },
      { label: labels.marketingPixels, href: `/stores/${storeId}/marketing-pixels` },
      { label: labels.affiliates, href: `/stores/${storeId}/affiliates` },
    ],
  },
  {
    key: 'settings',
    urlPrefixes: [
      '/settings',
      '/integrations',
      '/whatsapp',
      '/wa-bot',
      '/wa-templates',
      '/wa-order-updates',
      '/payment-link',
      '/branding',
      '/navigation',
      '/seo',
      '/domain',
      '/payment-settings',
      '/shipping',
      '/shipping-carriers',
      '/tax',
      '/pwa',
      '/language',
      '/template',
      '/pages',
      // P4-A (audit 2026-06-01): add standalone pages to Settings hub so the
      // sidebar highlights correctly when a merchant lands on these URLs.
      '/announcement',
      '/hero',
    ],
    buildTabs: () => [],
  },
];

/**
 * Given the current pathname (e.g. `/stores/abc/stock/inventory`), return the
 * hub whose urlPrefixes match. Returns null for non-store routes.
 */
export function detectHub(pathname: string, storeId: string): HubDefinition | null {
  const base = `/stores/${storeId}`;
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length); // '' for dashboard, '/stock/inventory', etc.

  // Exact-match for dashboard (rest is '' or '/')
  if (rest === '' || rest === '/') {
    return HUBS.find(h => h.key === 'dashboard') ?? null;
  }

  // Find first hub with a matching urlPrefix
  return HUBS.find(h => h.urlPrefixes.some(p => p !== '' && rest.startsWith(p))) ?? null;
}
