'use client';

import { useState, useEffect, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth';
import { useStore } from '../contexts/StoreContext';
import { useCurrentStore } from '../hooks/useCurrentStore';
import { useFeatures } from '../hooks/useFeatures';
import { useT } from '@/i18n/useT';
import {
  buildStoreAdminNav,
  buildSuperAdminNav,
  type NavLabels,
  type StoreBranding,
} from './admin-layout/buildStoreAdminNav';
import { HubTabs } from './admin-layout/HubTabs';
import { detectHub, type HubLabels } from './admin-layout/hubs';
import { SidebarHeader } from './admin-layout/SidebarHeader';
import { SidebarNav } from './admin-layout/SidebarNav';
import { SidebarFooter } from './admin-layout/SidebarFooter';
import { TopBar } from './admin-layout/TopBar';
import { FocusTopBar } from './admin-layout/FocusTopBar';
import { MobileBottomNav } from './mobile/MobileBottomNav';
import { useFocusMode } from '../contexts/FocusModeContext';

interface AdminLayoutProps {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  mode?: 'super_admin' | 'store_admin';
  storeBranding?: StoreBranding;
  /** Required when mode is 'store_admin' — used to build store-scoped nav links. */
  storeId?: string;
  /** Store's custom domain (e.g. 'mystore.com') or slug for the View Store button */
  storeDomain?: string;
  storeSlug?: string;
}

export function AdminLayout({
  children,
  title,
  subtitle,
  actions,
  mode: explicitMode,
  storeBranding,
  storeId,
  storeDomain,
  storeSlug,
}: AdminLayoutProps) {
  const t = useT('components.adminLayout');
  const tc = useT('common');
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const { user, logout, isLoading } = useAuth();
  const { selectedStoreId: globalStoreId } = useStore();
  const { isEnabled: isFeatureEnabled } = useFeatures();
  const { isFocused, focusStoreId, enterFocusMode } = useFocusMode();

  // When a super_admin is browsing inside a specific store
  // (`/stores/<id>/...`), they need the store-admin nav (Layout, Content,
  // Settings, Products, Orders, etc.) so they can edit that store the
  // same way its owner would. Without this, the platform nav stays
  // visible across every store page and the super_admin loses access to
  // the per-store editors.
  //
  // The match deliberately excludes `/stores` (the list), `/stores/new`
  // (creation flow), and the literal `/stores/[id]` dynamic-route token
  // that Next.js normalises in some edge cases.
  const storeScopeMatch = pathname.match(/^\/stores\/([^/]+)/);
  const isStoreScopedPath =
    !!storeScopeMatch && storeScopeMatch[1] !== 'new' && storeScopeMatch[1] !== '[id]';

  // Derive the mode from the authenticated user's role unless the page
  // explicitly opts out. A store_admin can never see super_admin chrome
  // (security + UX), so even if a page passes mode="super_admin" we coerce
  // it to store_admin when the user only has store_admin or staff privileges.
  const mode: 'super_admin' | 'store_admin' =
    user?.role === 'store_admin' || user?.role === 'staff'
      ? 'store_admin'
      : (explicitMode ?? (isStoreScopedPath ? 'store_admin' : 'super_admin'));

  const navLabels: NavLabels = {
    // Hub names (sidebar — 9 items)
    dashboard: t('navDashboard'),
    catalog: t('navCatalog'),
    sales: t('navSales'),
    stock: t('navStock'),
    finance: t('navFinance'),
    analytics: t('navAnalytics'),
    marketing: t('navMarketing'),
    settings: t('navSettings'),
    // Super-admin only
    stores: t('navStores'),
    users: t('navUsers'),
    auditLogs: t('navAuditLogs'),
    platformAiUsage: t('navPlatformAiUsage'),
    // Super-admin store-scoped
    manageFeatures: t('navManageFeatures'),
  };

  const hubLabels: HubLabels = {
    // Catalog tabs
    products: t('hubTabs.products'),
    pageBuilder: t('hubTabs.pageBuilder'),
    content: t('hubTabs.content'),
    blog: t('hubTabs.blog'),
    floatingWidget: t('hubTabs.floatingWidget'),
    // Sales tabs
    orders: t('hubTabs.orders'),
    customers: t('hubTabs.customers'),
    reviews: t('hubTabs.reviews'),
    returns: t('hubTabs.returns'),
    coupons: t('hubTabs.coupons'),
    loyalty: t('hubTabs.loyalty'),
    // Stock tabs
    stockDashboard: t('hubTabs.stockDashboard'),
    inventory: t('hubTabs.inventory'),
    warehouses: t('hubTabs.warehouses'),
    scan: t('hubTabs.scan'),
    adjustments: t('hubTabs.adjustments'),
    suppliers: t('hubTabs.suppliers'),
    purchaseOrders: t('hubTabs.purchaseOrders'),
    backorders: t('hubTabs.backorders'),
    reorder: t('hubTabs.reorder'),
    deadstock: t('hubTabs.deadstock'),
    // Finance tabs
    financeDashboard: t('hubTabs.financeDashboard'),
    accounts: t('hubTabs.accounts'),
    journal: t('hubTabs.journal'),
    expenses: t('hubTabs.expenses'),
    reports: t('hubTabs.reports'),
    // Analytics tabs (Overview = legacy /analytics; rest = ex-/insights)
    analyticsOverview: t('hubTabs.analyticsOverview'),
    insightsDashboard: t('hubTabs.insightsDashboard'),
    insightsCohorts: t('hubTabs.insightsCohorts'),
    insightsFunnel: t('hubTabs.insightsFunnel'),
    insightsSegments: t('hubTabs.insightsSegments'),
    insightsProducts: t('hubTabs.insightsProducts'),
    // Marketing tabs
    aiTools: t('hubTabs.aiTools'),
    aiUsage: t('hubTabs.aiUsage'),
    whatsapp: t('hubTabs.whatsapp'),
    whatsappTemplates: 'WhatsApp Templates',
    whatsappPaymentLink: 'WhatsApp Payment Link',
    marketingPixels: t('hubTabs.marketingPixels'),
    notifications: t('hubTabs.notifications'),
    newsletter: t('hubTabs.newsletter'),
    affiliates: t('hubTabs.affiliates'),
    abandonedCarts: t('hubTabs.abandonedCarts'),
  };

  // Sync dark mode with localStorage and system preference
  useEffect(() => {
    const stored = localStorage.getItem('admin-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldBeDark = stored === 'dark' || (!stored && prefersDark);
    setIsDark(shouldBeDark);
    document.documentElement.classList.toggle('dark', shouldBeDark);
  }, []);

  const toggleTheme = () => {
    setIsDark(!isDark);
    document.documentElement.classList.toggle('dark', !isDark);
    localStorage.setItem('admin-theme', !isDark ? 'dark' : 'light');
  };

  // Extract store ID from prop, URL path, or global store selector
  const currentStoreId = useMemo(() => {
    if (storeId) return storeId;
    const match = pathname.match(/\/stores\/([^/]+)/);
    if (match?.[1]) return match[1];
    // Fall back to global store selector (if a specific store is selected)
    if (globalStoreId && globalStoreId !== 'all') return globalStoreId;
    return null;
  }, [storeId, pathname, globalStoreId]);

  // ── Focus-mode pending resolution ──────────────────────────────────────
  // When the admin PWA is launched via the "?focus=1" shortcut but there
  // was no storeId in localStorage yet, FocusModeProvider sets the internal
  // state to '__pending__' (isFocused=false, focusStoreId=null externally).
  // AdminLayout waits until currentStoreId resolves and then calls
  // enterFocusMode to complete the transition.
  useEffect(() => {
    if (!isFocused && currentStoreId && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('focus') === '1') {
        try {
          // Only enter if there's no valid stored storeId yet
          const raw = localStorage.getItem('fwb_focus_mode');
          if (!raw) {
            enterFocusMode(currentStoreId);
          }
        } catch {
          // ignore
        }
      }
    }
  }, [isFocused, currentStoreId, enterFocusMode]);

  // ── Focus-mode route guard (client-side only) ──────────────────────────
  // When focus mode is ON, every page under the current store that is NOT
  // under /orders redirects to the orders list. We deliberately do NOT
  // touch server middleware (cross-origin auth is client-side in this app).
  useEffect(() => {
    if (!isFocused || !focusStoreId || !pathname) return;
    const ordersBase = `/stores/${focusStoreId}/orders`;
    if (!pathname.startsWith(ordersBase)) {
      router.replace(ordersBase);
    }
  }, [isFocused, focusStoreId, pathname, router]);

  // Fetch store domain/slug + branding for "View Store" button and sidebar
  // header. The shared useCurrentStore hook dedupes + caches, so we only hit
  // the network once per storeId regardless of how many admin pages mount
  // this layout. We always fetch when we have a storeId so the sidebar can
  // show the store name; previously we skipped when storeDomain/storeSlug
  // were already known but that left the sidebar without branding.
  const { store: fetchedStore } = useCurrentStore(currentStoreId);

  const viewStoreUrl = useMemo(() => {
    const domain = storeDomain || fetchedStore?.domain;
    const slug = storeSlug || fetchedStore?.slug;
    if (domain) return `https://${domain}`;
    const webBase = process.env.NEXT_PUBLIC_WEB_URL;
    if (webBase && slug) return `${webBase}/${slug}`;
    if (webBase) return webBase;
    return null;
  }, [storeDomain, storeSlug, fetchedStore?.domain, fetchedStore?.slug]);

  // Hide the back button on top-level "home" pages — there's nowhere to
  // go back to. For super_admins that's `/` and `/dashboard`. For
  // store_admins their home is `/stores/<id>`, the store dashboard, so
  // we hide the button there too. We match the exact dashboard path
  // rather than any `/stores/<id>/*` so deeper pages still get the back
  // button (e.g. `/stores/<id>/orders` should show it).
  const isStoreDashboard =
    /^\/stores\/[^/]+\/?$/.test(pathname) || pathname === '/' || pathname === '/dashboard';
  const showBackButton = !isStoreDashboard;

  // Store admin nav is computed dynamically so that Customers and Analytics
  // resolve to store-scoped URLs (/stores/:id/customers, /stores/:id/analytics)
  // rather than the super-admin root pages (/customers, /analytics).
  // Items with a `featureKey` are hidden when that feature is disabled.
  // Fall back to the resolved currentStoreId so a store_admin lands on
  // sensible nav links even on pages that don't pass `storeId` explicitly.
  const navStoreId = storeId ?? currentStoreId ?? '';
  const allNavItems =
    mode === 'super_admin'
      ? buildSuperAdminNav(navLabels)
      : buildStoreAdminNav(navStoreId, navLabels);
  const navItems = allNavItems.filter(item => {
    if (item.featureKey && !isFeatureEnabled(item.featureKey)) return false;
    if (item.superAdminOnly && user?.role !== 'super_admin') return false;
    // Staff users cannot access store settings (billing, branding, payment config, etc.)
    if (item.staffRestricted && user?.role === 'staff') return false;
    return true;
  });

  // Hub detection — only applies to store-admin mode with a resolved storeId.
  // Detects which hub the current URL belongs to, builds the tab list, and
  // exposes the hub key so SidebarNav can highlight the correct hub item even
  // when browsing a non-landing sub-route (e.g. /blog highlights Catalog).
  const { activeHubKey, hubTabs } = useMemo(() => {
    if (mode !== 'store_admin' || !navStoreId || !pathname) {
      return { activeHubKey: null, hubTabs: [] };
    }
    const hub = detectHub(pathname, navStoreId);
    if (!hub) return { activeHubKey: null, hubTabs: [] };
    return {
      activeHubKey: hub.key,
      hubTabs: hub.buildTabs(navStoreId, hubLabels),
    };
    // hubLabels object is rebuilt on every render (from translation strings) but
    // its values are stable strings — useMemo deps on pathname + navStoreId is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, navStoreId, pathname]);

  // Auto-derive store branding for the sidebar header when the page didn't
  // pass it explicitly. The shared useCurrentStore hook already fetched the
  // store's logo + name, so we hand them straight to SidebarHeader.
  const resolvedStoreBranding =
    storeBranding ??
    (mode === 'store_admin' && fetchedStore
      ? {
          id: fetchedStore.id,
          name: fetchedStore.name,
          nameAr: fetchedStore.nameAr ?? undefined,
          logo: fetchedStore.logo ?? undefined,
          logoAr: fetchedStore.logoAr ?? undefined,
        }
      : undefined);
  const isStoreAdminWithBranding = mode === 'store_admin' && !!resolvedStoreBranding;

  const sidebarContent = (
    <>
      <SidebarHeader
        mode={mode}
        storeBranding={resolvedStoreBranding}
        isStoreAdminWithBranding={isStoreAdminWithBranding}
        userRole={user?.role as 'super_admin' | 'store_admin' | 'staff' | 'customer' | undefined}
      />
      <SidebarNav
        navItems={navItems}
        pathname={pathname}
        onNavigate={() => setIsSidebarOpen(false)}
        activeHubKey={activeHubKey}
      />
      <SidebarFooter
        isDark={isDark}
        onToggleTheme={toggleTheme}
        user={user}
        onLogout={logout}
        storeId={navStoreId || null}
      />
    </>
  );

  // Loading state
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="h-12 w-12 motion-safe:animate-spin rounded-full border-4 border-muted border-t-primary" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-6 w-6 rounded-full bg-gradient-to-br from-primary to-primary/90 animate-pulse" />
            </div>
          </div>
          <p className="text-sm font-medium text-muted-foreground">{tc('loadingDashboard')}</p>
        </div>
      </div>
    );
  }

  // ── Focus mode layout ─────────────────────────────────────────────────
  // All sidebars and bottom nav are suppressed; a minimal top bar replaces
  // the full TopBar. The `lg:ms-72` offset is dropped because there is no
  // desktop sidebar to avoid. Hub tabs are not needed — orders list is the
  // only destination.
  if (isFocused) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <FocusTopBar storeBranding={resolvedStoreBranding} />
        <main id="admin-main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 pb-6 lg:p-6">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Mobile Sidebar Overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden animate-fade-in"
          onClick={() => setIsSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile Sidebar */}
      <aside
        id="admin-mobile-sidebar"
        className={`fixed inset-y-0 start-0 z-50 w-72 transform border-e border-border/50 bg-card shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full'
        }`}
        aria-hidden={!isSidebarOpen}
      >
        <div className="flex h-full flex-col">
          <button
            type="button"
            onClick={() => setIsSidebarOpen(false)}
            className="absolute end-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
            aria-label={t('closeSidebar')}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
          {sidebarContent}
        </div>
      </aside>

      {/* Desktop Sidebar */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-72 border-e border-border/50 bg-card lg:flex lg:flex-col">
        {sidebarContent}
      </aside>

      {/* Main Content. min-w-0 lets this flex child shrink below its content
          width so wide descendants don't push the viewport. We deliberately do
          NOT clip overflow here: overflow-x-clip was hiding real data (order
          prices / store dates ran under the clip). Individual wide surfaces
          (tables) own their own overflow-x-auto instead. */}
      <main id="admin-main-content" tabIndex={-1} className="min-w-0 flex-1 lg:ms-72">
        <TopBar
          title={title}
          subtitle={subtitle}
          actions={actions}
          showBackButton={showBackButton}
          isSidebarOpen={isSidebarOpen}
          onOpenSidebar={() => setIsSidebarOpen(true)}
          onBack={() => router.back()}
          viewStoreUrl={viewStoreUrl}
        />

        {/* Hub tab nav — shown above page content when inside a multi-route hub
            (Catalog, Sales, Stock, Finance, Marketing). Empty for single-page
            hubs (Dashboard, Analytics, Settings). */}
        {hubTabs.length > 0 && <HubTabs items={hubTabs} />}

        {/* Page Content. `pb-20` on mobile reserves room for the
            fixed bottom-nav so primary actions / save buttons aren't
            hidden behind it; the sidebar shell already absorbs that
            on desktop so the padding is mobile-scoped. */}
        <div className="p-4 pb-20 lg:p-6 lg:pb-6">{children}</div>
      </main>

      {/* Mobile Bottom Nav — store-scoped only. Renders nothing at
          md+ widths (its own internal `md:hidden`). When the merchant
          taps "More", we open the existing hamburger drawer rather
          than maintaining a parallel IA. */}
      {navStoreId && (
        <MobileBottomNav storeId={navStoreId} onOpenMore={() => setIsSidebarOpen(true)} />
      )}
    </div>
  );
}
