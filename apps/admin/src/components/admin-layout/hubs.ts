import type { HubTab } from './HubTabs';

export interface HubDefinition {
  key:
    | 'dashboard'
    | 'catalog'
    | 'sales'
    | 'stock'
    | 'finance'
    | 'analytics'
    | 'insights'
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
  // Sales tabs
  orders: string;
  customers: string;
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
  // Insights tabs
  insightsDashboard: string;
  insightsCohorts: string;
  insightsFunnel: string;
  insightsSegments: string;
  insightsProducts: string;
  // Marketing tabs
  aiTools: string;
  whatsapp: string;
};

export const HUBS: HubDefinition[] = [
  {
    key: 'dashboard',
    urlPrefixes: [''],
    buildTabs: () => [],
  },
  {
    key: 'catalog',
    urlPrefixes: ['/products', '/page-builder', '/content', '/blog', '/catalog'],
    buildTabs: (storeId, labels) => [
      { label: labels.products, href: `/stores/${storeId}/products` },
      { label: labels.pageBuilder, href: `/stores/${storeId}/page-builder` },
      { label: labels.content, href: `/stores/${storeId}/content` },
      { label: labels.blog, href: `/stores/${storeId}/blog` },
    ],
  },
  {
    key: 'sales',
    urlPrefixes: ['/orders', '/customers', '/sales'],
    buildTabs: (storeId, labels) => [
      { label: labels.orders, href: `/stores/${storeId}/orders` },
      { label: labels.customers, href: `/stores/${storeId}/customers` },
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
    urlPrefixes: ['/analytics'],
    buildTabs: () => [],
  },
  {
    key: 'insights',
    urlPrefixes: ['/insights'],
    buildTabs: (storeId, labels) => [
      { label: labels.insightsDashboard, href: `/stores/${storeId}/insights/dashboard` },
      { label: labels.insightsCohorts, href: `/stores/${storeId}/insights/cohorts` },
      { label: labels.insightsFunnel, href: `/stores/${storeId}/insights/funnel` },
      { label: labels.insightsSegments, href: `/stores/${storeId}/insights/segments` },
      { label: labels.insightsProducts, href: `/stores/${storeId}/insights/products` },
    ],
  },
  {
    key: 'marketing',
    urlPrefixes: ['/ai-tools', '/integrations', '/marketing'],
    buildTabs: (storeId, labels) => [
      { label: labels.aiTools, href: `/stores/${storeId}/ai-tools` },
      { label: labels.whatsapp, href: `/stores/${storeId}/integrations/wbs` },
    ],
  },
  {
    key: 'settings',
    urlPrefixes: ['/settings'],
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
