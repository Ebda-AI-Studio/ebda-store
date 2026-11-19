import type { HubTab } from './HubTabs';

export interface HubDefinition {
  key:
    | 'dashboard'
    | 'catalog'
    | 'editor'
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
  content: string;
  blog: string;
  floatingWidget: string;
  sizeCharts: string;
  goldRates: string;
  categories: string;
  // Sales tabs
  orders: string;
  invoices: string;
  customers: string;
  customerGroups: string;
  wholesaleApplications: string;
  reviews: string;
  returns: string;
  coupons: string;
  promotions: string;
  loyalty: string;
  bundles: string;
  wallet: string;
  customerIntelligence: string;
  // Stock tabs
  stockDashboard: string;
  inventory: string;
  warehouses: string;
  adjustments: string;
  suppliers: string;
  purchaseOrders: string;
  backorders: string;
  reorder: string;
  deadstock: string;
  scan: string;
  // Finance tabs
  financeDashboard: string;
  accounts: string;
  journal: string;
  expenses: string;
  reports: string;
  bankRec: string;
  /** Small caption before the ledger tabs (accounts .. bank rec): who they are for. */
  accountantGroup: string;
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
  insightsSearches: string;
  // Marketing tabs
  aiTools: string;
  aiUsage: string;
  marketingPixels: string;
  notifications: string;
  newsletter: string;
  campaigns: string;
  affiliates: string;
  abandonedCarts: string;
  paymentAbandonments: string;
  lifecycleEmails: string;
  answerEngine: string;
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
      '/content',
      '/blog',
      '/catalog',
      '/categories',
      '/tags',
      '/bulk',
      '/floating-widget',
      '/size-charts',
      '/gold-rates',
    ],
    buildTabs: (storeId, labels) => [
      { label: labels.products, href: `/stores/${storeId}/products` },
      // Categories, tags and bulk edit are catalog pages (UX:N-2): they used to highlight no hub at all.
      { label: labels.categories, href: `/stores/${storeId}/categories` },
      // Size charts sit with the products they describe (B0 Task 9).
      { label: labels.sizeCharts, href: `/stores/${storeId}/size-charts` },
      // Gold rate pricing sits with the products it prices (B5 Task 13).
      { label: labels.goldRates, href: `/stores/${storeId}/gold-rates` },
      { label: labels.content, href: `/stores/${storeId}/content` },
      { label: labels.blog, href: `/stores/${storeId}/blog` },
      { label: labels.floatingWidget, href: `/stores/${storeId}/floating-widget` },
    ],
  },
  {
    // The visual editor is its own sidebar entry (T9): it was a Catalog tab, reachable in practice only
    // from the branding Theme tab. The retired classic route still redirects here, so it keeps it highlighted.
    key: 'editor',
    urlPrefixes: ['/page-builder', '/builder'],
    buildTabs: () => [],
  },
  {
    // Sales = the fulfil job (orders, invoices, returns) plus the people who buy (customers divider group).
    // Coupons, promotions, loyalty, bundles and the wallet moved to the Marketing hub (UX:N-1).
    key: 'sales',
    urlPrefixes: [
      '/orders',
      '/invoices',
      '/customers',
      '/customer-groups',
      '/wholesale-applications',
      '/sales',
      '/reviews',
      '/returns',
      '/customer-intelligence',
    ],
    buildTabs: (storeId, labels) => [
      { label: labels.orders, href: `/stores/${storeId}/orders` },
      // Fiscal documents (tax invoices, receipts, credit notes): issued automatically per
      // sale / refund, so this is a read-only list, not a gated feature.
      { label: labels.invoices, href: `/stores/${storeId}/invoices` },
      { label: labels.returns, href: `/stores/${storeId}/returns` },
      // B2B review I5: both tabs carry the count of wholesale applications waiting for a decision. The Wholesale
      // applications tab is not feature-keyed (the page shows the upgrade prompt when the plan lacks b2b.wholesale).
      {
        label: labels.customers,
        href: `/stores/${storeId}/customers`,
        badgeKey: 'wholesalePending',
        groupStart: true,
      },
      { label: labels.customerGroups, href: `/stores/${storeId}/customer-groups` },
      {
        label: labels.wholesaleApplications,
        href: `/stores/${storeId}/wholesale-applications`,
        badgeKey: 'wholesalePending',
      },
      { label: labels.reviews, href: `/stores/${storeId}/reviews` },
      // Smart hints (Customer Intelligence). Always listed: the page is where the merchant switches them on.
      { label: labels.customerIntelligence, href: `/stores/${storeId}/customer-intelligence` },
    ],
  },
  {
    key: 'stock',
    urlPrefixes: ['/stock'],
    buildTabs: (storeId, labels) => [
      { label: labels.stockDashboard, href: `/stores/${storeId}/stock/dashboard` },
      { label: labels.inventory, href: `/stores/${storeId}/stock/inventory` },
      { label: labels.warehouses, href: `/stores/${storeId}/stock/warehouses` },
      { label: labels.scan, href: `/stores/${storeId}/stock/scan` },
      { label: labels.adjustments, href: `/stores/${storeId}/stock/adjustments` },
      // Purchasing group (suppliers, purchase orders, backorders), then the planning group: dividers keep the
      // 10-tab strip readable (audit 2.4).
      {
        label: labels.suppliers,
        href: `/stores/${storeId}/stock/suppliers`,
        groupStart: true,
      },
      { label: labels.purchaseOrders, href: `/stores/${storeId}/stock/purchase-orders` },
      { label: labels.backorders, href: `/stores/${storeId}/stock/backorders` },
      { label: labels.reorder, href: `/stores/${storeId}/stock/reorder`, groupStart: true },
      { label: labels.deadstock, href: `/stores/${storeId}/stock/deadstock` },
    ],
  },
  {
    key: 'finance',
    urlPrefixes: ['/finance'],
    buildTabs: (storeId, labels) => [
      { label: labels.financeDashboard, href: `/stores/${storeId}/finance/dashboard` },
      {
        label: labels.accounts,
        href: `/stores/${storeId}/finance/accounts`,
        groupStart: true,
        groupLabel: labels.accountantGroup,
      },
      { label: labels.journal, href: `/stores/${storeId}/finance/journal` },
      { label: labels.expenses, href: `/stores/${storeId}/finance/expenses` },
      { label: labels.reports, href: `/stores/${storeId}/finance/reports` },
      { label: labels.bankRec, href: `/stores/${storeId}/finance/bank-reconciliation` },
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
      { label: labels.insightsSearches, href: `/stores/${storeId}/insights/searches` },
    ],
  },
  {
    // Marketing and offers (UX:N-1): the offers the merchant runs (coupons, promotions, bundles, loyalty, wallet),
    // then the campaigns that tell customers about them. Notifications live in Settings (UX:N-4).
    key: 'marketing',
    urlPrefixes: [
      '/coupons',
      '/promotions',
      '/loyalty',
      '/bundles',
      '/wallet',
      '/ai-tools',
      '/ai-usage',
      '/marketing',
      '/marketing-pixels',
      '/newsletter',
      '/notifications',
      '/campaigns',
      '/affiliates',
      '/abandoned-carts',
      '/payment-abandonments',
      '/lifecycle-emails',
      '/answer-engine',
    ],
    buildTabs: (storeId, labels) => [
      // Coupons are in every plan, so the hub lands on a page everyone can open (audit M-1).
      { label: labels.coupons, href: `/stores/${storeId}/coupons` },
      // Promotions are automatic discounts (no code) and ungated: same reasoning as customer-groups.
      { label: labels.promotions, href: `/stores/${storeId}/promotions` },
      // Bundles are feature-gated (`bundles` is in NO plan baseline) via useRequireFeature('bundles'):
      // the tab always renders, the page itself gates. Same for loyalty.
      { label: labels.bundles, href: `/stores/${storeId}/bundles` },
      { label: labels.loyalty, href: `/stores/${storeId}/loyalty` },
      // Customer wallet (store credit, D1) is hidden outright for a store without the feature: it is OFF for
      // every store at launch, and a new upsell tab appearing on deploy is exactly the visible change to avoid.
      { label: labels.wallet, href: `/stores/${storeId}/wallet`, featureKey: 'customer_wallet' },
      { label: labels.newsletter, href: `/stores/${storeId}/newsletter`, groupStart: true },
      // Feature-gated (`email_campaigns` is Growth + Business, not Basic): the layout shows the locked card.
      { label: labels.campaigns, href: `/stores/${storeId}/campaigns` },
      { label: labels.abandonedCarts, href: `/stores/${storeId}/abandoned-carts` },
      { label: labels.paymentAbandonments, href: `/stores/${storeId}/payment-abandonments` },
      {
        label: labels.lifecycleEmails,
        href: `/stores/${storeId}/lifecycle-emails`,
        ownerOnly: true,
      },
      // Staff may manage order alerts, and the Settings hub is owner-only, so Notifications stays here (Ruling T3-1).
      { label: labels.notifications, href: `/stores/${storeId}/notifications` },
      { label: labels.affiliates, href: `/stores/${storeId}/affiliates`, groupStart: true },
      { label: labels.marketingPixels, href: `/stores/${storeId}/marketing-pixels` },
      { label: labels.aiTools, href: `/stores/${storeId}/ai-tools`, groupStart: true },
      { label: labels.aiUsage, href: `/stores/${storeId}/ai-usage` },
      { label: labels.answerEngine, href: `/stores/${storeId}/answer-engine` },
    ],
  },
  {
    key: 'settings',
    urlPrefixes: [
      '/settings',
      '/integrations',
      '/agent-key',
      '/merchant-keys',
      '/webhooks',
      '/branding',
      '/seo',
      '/domain',
      '/payment-settings',
      '/shipping',
      '/shipping-carriers',
      '/cod-reconciliation',
      '/tax',
      '/pwa',
      '/qr',
      '/codes',
      '/language',
      '/template',
      '/announcement',
      '/billing',
      '/delivery',
      '/staff',
    ],
    // Settings pages share one hub for nav highlighting; they have no sub-tabs.
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

/**
 * Whether a hub tab (and its ⌘K palette entry) is shown: `ownerOnly` tabs are hidden from staff, and a
 * feature-keyed tab only once the feature map has loaded and the feature is on (never on the loading default).
 */
export function isHubTabVisible(
  tab: HubTab,
  ctx: { role: string | undefined; featuresLoading: boolean; isEnabled: (key: string) => boolean }
): boolean {
  if (tab.ownerOnly && ctx.role === 'staff') return false;
  return !tab.featureKey || (!ctx.featuresLoading && ctx.isEnabled(tab.featureKey));
}
