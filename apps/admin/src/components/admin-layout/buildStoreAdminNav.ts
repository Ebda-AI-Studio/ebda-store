export interface NavItem {
  name: string;
  href: string;
  icon: string;
  /** When set, this nav item is hidden unless the named feature is enabled. */
  featureKey?: string;
}

export type NavLabels = {
  dashboard: string;
  stores: string;
  users: string;
  auditLogs: string;
  products: string;
  orders: string;
  customers: string;
  analytics: string;
  pageBuilder: string;
  content: string;
  settings: string;
  aiTools: string;
  navAccounts: string;
  navJournal: string;
  // Stock group (Batch 2)
  navStockDashboard: string;
  navInventory: string;
  navAdjustments: string;
  navSuppliers: string;
  navPurchaseOrders: string;
  navReorder: string;
  navBackorders: string;
  navDeadstock: string;
  // Finance group extensions (Batch 2)
  navFinanceDashboard: string;
  navExpenses: string;
  navReports: string;
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

// Store Admin navigation factory — returns nav items scoped to the given storeId.
// Using a function instead of a static array ensures that Customers and Analytics
// link to the correct store-scoped URLs rather than the super-admin root pages.
// Items with a `featureKey` will be filtered out when that feature is disabled.
export function buildStoreAdminNav(storeId: string, labels: NavLabels): NavItem[] {
  return [
    {
      name: labels.dashboard,
      href: `/stores/${storeId}`,
      icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    },
    {
      name: labels.products,
      href: `/stores/${storeId}/products`,
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    },
    {
      name: labels.orders,
      href: `/stores/${storeId}/orders`,
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    },
    {
      name: labels.customers,
      href: `/stores/${storeId}/customers`,
      icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    },
    // ── Stock group (Batch 2) ────────────────────────────────────────────────
    {
      // Stock Dashboard — overview of on-hand levels, low-stock SKUs, etc.
      name: labels.navStockDashboard,
      href: `/stores/${storeId}/stock/dashboard`,
      // Chart bars icon
      icon: 'M3 12h2v9H3zm4-4h2v13H7zm4-4h2v17h-2zm4 8h2v9h-2zm4-12h2v21h-2z',
    },
    {
      // Inventory — per-product stock levels with quick-adjust
      name: labels.navInventory,
      href: `/stores/${storeId}/stock/inventory`,
      // List lines icon
      icon: 'M4 6h16M4 12h16M4 18h7',
    },
    {
      // Adjustments — manual stock adjustments that post balanced journal entries
      name: labels.navAdjustments,
      href: `/stores/${storeId}/stock/adjustments`,
      // Pencil/edit icon
      icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    },
    {
      // Suppliers — supplier directory for purchase orders
      name: labels.navSuppliers,
      href: `/stores/${storeId}/stock/suppliers`,
      // Building icon
      icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    },
    {
      // Purchase Orders — track POs; receipt updates inventory + AP accounts
      name: labels.navPurchaseOrders,
      href: `/stores/${storeId}/stock/purchase-orders`,
      // Cart icon (same as Batch 1 uses)
      icon: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
    },
    {
      // Reorder Suggestions — AI-powered (Batch 3 feature, visible now with coming-soon page)
      name: labels.navReorder,
      href: `/stores/${storeId}/stock/reorder`,
      // Refresh/cycle icon
      icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
    },
    {
      // Backorders — customers waiting on out-of-stock items
      name: labels.navBackorders,
      href: `/stores/${storeId}/stock/backorders`,
      // Clock icon
      icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    {
      // Dead Stock — AI-powered clearance detection (Batch 3 feature, coming-soon page)
      name: labels.navDeadstock,
      href: `/stores/${storeId}/stock/deadstock`,
      // Trash icon
      icon: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
    },
    // ── Finance group (Batch 1 + Batch 2 extensions) ─────────────────────────
    {
      // Finance Dashboard — P&L, balance sheet, cash summary (Batch 2)
      name: labels.navFinanceDashboard,
      href: `/stores/${storeId}/finance/dashboard`,
      // Dollar-sign circle icon
      icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1L15 8m-3-2v8m4-4a8 8 0 11-16 0 8 8 0 0116 0z',
    },
    {
      // Finance — Chart of Accounts (read-only COA tree)
      name: labels.navAccounts,
      href: `/stores/${storeId}/finance/accounts`,
      // BookOpen icon
      icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
    },
    {
      // Finance — General ledger / journal entries
      name: labels.navJournal,
      href: `/stores/${storeId}/finance/journal`,
      // List/lines icon
      icon: 'M4 6h16M4 10h16M4 14h16M4 18h16',
    },
    {
      // Finance — Expenses tracking (Batch 2)
      name: labels.navExpenses,
      href: `/stores/${storeId}/finance/expenses`,
      // Receipt/dollar icon
      icon: 'M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2zM10 9a.5.5 0 11-1 0 .5.5 0 011 0zm5 5a.5.5 0 11-1 0 .5.5 0 011 0z',
    },
    {
      // Finance — Financial reports: trial balance, P&L, balance sheet (Batch 2)
      name: labels.navReports,
      href: `/stores/${storeId}/finance/reports`,
      // Bar chart icon
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      name: labels.analytics,
      href: `/stores/${storeId}/analytics`,
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      // Unified page builder — Layout + Typography controls merged into
      // one page ordered by storefront section (2026-05-19 rename).
      // Old /layout and /typography URLs redirect here (301 in next.config.js).
      name: labels.pageBuilder,
      href: `/stores/${storeId}/page-builder`,
      icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
    },
    {
      name: labels.content,
      href: `/stores/${storeId}/content`,
      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    },
    {
      // Blog (Bucket E1, 2026-05-17). Always visible in the sidebar
      // even when blogEnabled=false so the merchant has a clear entry
      // point to turn it on. The list page surfaces an inline toggle.
      name: 'Blog',
      href: `/stores/${storeId}/blog`,
      // Pencil-write icon
      icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    },
    {
      name: labels.aiTools,
      href: `/stores/${storeId}/ai-tools`,
      // sparkle icon — matches the orange "✨" in the AI buttons throughout
      icon: 'M5 3v4 M3 5h4 M6 17v4 M4 19h4 M13 3l3.5 7L24 13.5 16.5 17 13 24l-3.5-7L2 13.5 9.5 10z',
    },
    {
      // Force WhatsApp Business Platform integration (2026-05-19).
      // Dedicated page for per-store WBS bridge config.
      name: 'WhatsApp Notifications',
      href: `/stores/${storeId}/integrations/wbs`,
      // WhatsApp-style chat-bubble icon
      icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    },
    {
      name: labels.settings,
      href: `/stores/${storeId}/settings`,
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
