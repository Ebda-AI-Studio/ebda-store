'use client';

import { Button } from '@/components/ui/Button';
import { Suspense, useState, useEffect, useMemo } from 'react';
import { FOCUS_MODE_STORAGE_KEY } from '@/lib/focus-mode-key';
import { usePathname, useRouter } from 'next/navigation';
import { storefrontOrigin } from '@ebda/shared';
import { liveDomain } from '@/lib/store-url';
import { useAuth } from '../lib/auth';
import { useStore } from '../contexts/StoreContext';
import { useCurrentStore } from '../hooks/useCurrentStore';
import { useFeatures } from '../hooks/useFeatures';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { AssistantDock } from './assistant/AssistantDock';
import { mergeRegistryIntoPalette, registryPaletteItems } from '../lib/settings-search';
import { SettingHighlight } from './SettingHighlight';
import {
  buildStoreAdminNav,
  buildSuperAdminNav,
  type NavLabels,
  type StoreBranding,
} from './admin-layout/buildStoreAdminNav';
import { HubTabs, type HubTab } from './admin-layout/HubTabs';
import { detectHub, type HubLabels } from './admin-layout/hubs';
import {
  buildStorePaletteItems,
  type PaletteItem,
  type SettingsPaletteLabels,
} from './admin-layout/buildPaletteItems';
import { SidebarHeader } from './admin-layout/SidebarHeader';
import { CommandPalette } from './CommandPalette';
import { SidebarNav } from './admin-layout/SidebarNav';
import { useAttention } from '../hooks/useAttention';
import { SidebarFooter } from './admin-layout/SidebarFooter';
import { ContactEbdaDialog } from './support/ContactEbdaDialog';
import { SuspensionNotice } from './support/SuspensionNotice';
import { TopBar } from './admin-layout/TopBar';
import { SettingsRail } from './admin-layout/SettingsRail';
import { DocumentTitle } from './DocumentTitle';
import { FocusTopBar } from './admin-layout/FocusTopBar';
import { MobileBottomNav } from './mobile/MobileBottomNav';
import { ConfirmHost } from '../hooks/useConfirm';
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
  /** Breadcrumb parent shown above the title (UX:N-5). Settings pages get "الإعدادات" automatically. */
  parent?: { label: string; href: string };
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
  parent,
}: AdminLayoutProps) {
  const t = useT('components.adminLayout');
  const tcp = useT('components.commandPalette');
  const tc = useT('common');
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const { user, logout, isLoading } = useAuth();
  const { selectedStoreId: globalStoreId } = useStore();
  const { isEnabled: isFeatureEnabled, isLoading: featuresLoading } = useFeatures();
  // Feature-keyed hub tabs (see HubTab.featureKey) appear only once the
  // feature map has loaded AND the feature is on — never on the loading
  // default, so a store without the feature never sees the tab flash.
  const isHubTabVisible = (tab: HubTab) =>
    !tab.featureKey || (!featuresLoading && isFeatureEnabled(tab.featureKey));
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
    editor: t('navEditor'),
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
    platformUsageHistory: t('navPlatformUsageHistory'),
    platformPlans: t('navPlatformPlans'),
    platformBillingEvents: t('navPlatformBillingEvents'),
    platformTaxVerification: t('navPlatformTaxVerification'),
    platformProviderActivation: t('navPlatformProviderActivation'),
    platformTaxArchive: t('navPlatformTaxArchive'),
    platformPolicyUpdates: t('navPlatformPolicyUpdates'),
    platformCiInsights: t('navPlatformCiInsights'),
    platformActivation: t('navPlatformActivation'),
    platformTrustRequests: t('navPlatformTrustRequests'),
    platformSettings: t('navPlatformSettings'),
    // Super-admin store-scoped
    manageFeatures: t('navManageFeatures'),
  };

  const hubLabels: HubLabels = {
    // Catalog tabs
    products: t('hubTabs.products'),
    content: t('hubTabs.content'),
    blog: t('hubTabs.blog'),
    floatingWidget: t('hubTabs.floatingWidget'),
    sizeCharts: t('hubTabs.sizeCharts'),
    goldRates: t('hubTabs.goldRates'),
    categories: t('hubTabs.categories'),
    // Sales tabs
    orders: t('hubTabs.orders'),
    invoices: t('hubTabs.invoices'),
    customers: t('hubTabs.customers'),
    customerGroups: t('hubTabs.customerGroups'),
    wholesaleApplications: t('hubTabs.wholesaleApplications'),
    reviews: t('hubTabs.reviews'),
    returns: t('hubTabs.returns'),
    coupons: t('hubTabs.coupons'),
    promotions: t('hubTabs.promotions'),
    loyalty: t('hubTabs.loyalty'),
    bundles: t('hubTabs.bundles'),
    wallet: t('hubTabs.wallet'),
    customerIntelligence: t('hubTabs.customerIntelligence'),
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
    bankRec: t('hubTabs.bankRec'),
    accountantGroup: t('hubTabs.accountantGroup'),
    // Analytics tabs (Overview = legacy /analytics; rest = ex-/insights)
    analyticsOverview: t('hubTabs.analyticsOverview'),
    insightsDashboard: t('hubTabs.insightsDashboard'),
    insightsCohorts: t('hubTabs.insightsCohorts'),
    insightsFunnel: t('hubTabs.insightsFunnel'),
    insightsSegments: t('hubTabs.insightsSegments'),
    insightsProducts: t('hubTabs.insightsProducts'),
    insightsSearches: t('hubTabs.insightsSearches'),
    // Marketing tabs
    aiTools: t('hubTabs.aiTools'),
    aiUsage: t('hubTabs.aiUsage'),
    answerEngine: t('hubTabs.answerEngine'),
    marketingPixels: t('hubTabs.marketingPixels'),
    productFeeds: t('hubTabs.productFeeds'),
    notifications: t('hubTabs.notifications'),
    newsletter: t('hubTabs.newsletter'),
    campaigns: t('hubTabs.campaigns'),
    affiliates: t('hubTabs.affiliates'),
    abandonedCarts: t('hubTabs.abandonedCarts'),
    paymentAbandonments: t('hubTabs.paymentAbandonments'),
    lifecycleEmails: t('hubTabs.lifecycleEmails'),
    // Settings tabs
  };

  // Ebda is dark-first; retain an explicitly saved light preference.
  useEffect(() => {
    const stored = localStorage.getItem('admin-theme');
    const shouldBeDark = stored !== 'light';
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
          const raw = localStorage.getItem(FOCUS_MODE_STORAGE_KEY);
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
    const domain = liveDomain({
      domain: storeDomain || fetchedStore?.domain,
      domainStatus: fetchedStore?.domainStatus,
    });
    const slug = storeSlug || fetchedStore?.slug;
    // Custom domain, else the store's own `<slug>.ebda.app` host.
    if (slug) return storefrontOrigin({ slug, domain });
    if (domain) return `https://${domain}`;
    return null;
  }, [
    storeDomain,
    storeSlug,
    fetchedStore?.domain,
    fetchedStore?.domainStatus,
    fetchedStore?.slug,
  ]);

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
  // One shared "needs attention" feed: the sidebar dot here, the section badges and the Settings list elsewhere.
  const attention = useAttention(mode === 'store_admin' ? navStoreId : null);
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

  // Full ⌘K palette index: every hub PLUS every page inside it (hub tabs) +
  // Settings sub-pages. In platform (super_admin, no store) mode there are no
  // hub tabs, so the hubs themselves are the whole index.
  const settingsPaletteLabels: SettingsPaletteLabels = {
    branding: tcp('pages.branding'),
    seo: tcp('pages.seo'),
    domain: tcp('pages.domain'),
    payments: tcp('pages.payments'),
    shipping: tcp('pages.shipping'),
    tax: tcp('pages.tax'),
    pwa: tcp('pages.pwa'),
    qr: tcp('pages.qr'),
    template: tcp('pages.template'),
    language: tcp('pages.language'),
    staff: tcp('pages.staff'),
    announcement: tcp('pages.announcement'),
    agentKey: tcp('pages.agentKey'),
    merchantKeys: tcp('pages.merchantKeys'),
    webhooks: tcp('pages.webhooks'),
    billing: tcp('pages.billing'),
  };
  // Admin search registry (E23): every page + individual setting in Arabic and English, deep-linked
  // to the control. Role- and feature-gated like the sidebar; merged under the palette's own pages.
  const uiLocale = useLocale() === 'ar' ? 'ar' : 'en';
  const paletteItems: PaletteItem[] =
    mode === 'store_admin' && navStoreId
      ? mergeRegistryIntoPalette(
          buildStorePaletteItems(
            navItems,
            navStoreId,
            hubLabels,
            settingsPaletteLabels,
            isHubTabVisible
          ),
          registryPaletteItems(
            navStoreId,
            { role: user?.role, isFeatureEnabled, featuresLoading },
            uiLocale
          )
        )
      : navItems.map(n => ({ name: n.name, href: n.href, icon: n.icon, group: n.name }));

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
      hubTabs: hub.buildTabs(navStoreId, hubLabels).filter(isHubTabVisible),
    };
    // hubLabels object is rebuilt on every render (from translation strings) but
    // its values are stable strings — useMemo deps on pathname + navStoreId is sufficient.
    // `featuresLoading` + `isFeatureEnabled` re-run it once the feature map lands,
    // so a feature-keyed tab appears then (see isHubTabVisible).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, navStoreId, pathname, featuresLoading, isFeatureEnabled]);

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

  // Settings pages (not the hub itself) get the rail on large screens and a "الإعدادات" breadcrumb everywhere.
  const settingsRoot = navStoreId ? `/stores/${navStoreId}/settings` : '';
  const onSettingsSubpage = activeHubKey === 'settings' && !!pathname && pathname !== settingsRoot;
  const showSettingsRail = onSettingsSubpage && !!navStoreId && !isFocused;
  const resolvedParent =
    parent ?? (onSettingsSubpage ? { label: t('navSettings'), href: settingsRoot } : undefined);

  const sidebarContent = (
    <>
      <SidebarHeader
        mode={mode}
        storeBranding={resolvedStoreBranding}
        isStoreAdminWithBranding={isStoreAdminWithBranding}
        userRole={user?.role as 'super_admin' | 'store_admin' | 'staff' | 'customer' | undefined}
      />
      <Button
        variant="outline"
        type="button"
        onClick={() => window.dispatchEvent(new Event('force:open-search'))}
        className="mx-3 mt-2 gap-2 text-muted-foreground w-[calc(100%-1.5rem)] justify-start"
      >
        <svg
          className="h-4 w-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
          />
        </svg>
        <span className="flex-1 text-start">{tcp('trigger')}</span>
        <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-xs lg:inline-block">
          {/* i18n-gate-allow: keyboard shortcut keycap */}
          ⌘K
        </kbd>
      </Button>
      <SidebarNav
        navItems={navItems}
        pathname={pathname}
        onNavigate={() => setIsSidebarOpen(false)}
        activeHubKey={activeHubKey}
        badges={
          mode === 'store_admin'
            ? { settings: attention.nav.settings, sales: attention.nav.orders }
            : undefined
        }
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
        <DocumentTitle title={title} />
        <FocusTopBar storeBranding={resolvedStoreBranding} />
        <main id="admin-main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 pb-6 lg:p-6">
          {children}
        </main>
        <ConfirmHost />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Global ⌘K command palette — renders null until opened; searches every admin page. */}
      <CommandPalette items={paletteItems} />
      {/* The one confirmation dialog behind useConfirm(). */}
      <ConfirmHost />
      {/* ?setting=<id> deep link: scroll to the control and highlight it. */}
      <Suspense fallback={null}>
        <SettingHighlight />
      </Suspense>
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
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={() => setIsSidebarOpen(false)}
            className="absolute end-3 top-4 justify-center text-muted-foreground lg:hidden"
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
          </Button>
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
          parent={resolvedParent}
        />

        {navStoreId && <SuspensionNotice storeId={navStoreId} />}

        {/* Hub tab nav — shown above page content when inside a multi-route hub
            (Catalog, Sales, Stock, Finance, Marketing). Empty for single-page
            hubs (Dashboard, Analytics, Settings). */}
        {hubTabs.length > 0 && <HubTabs items={hubTabs} />}

        {/* Page Content. `pb-20` on mobile reserves room for the
            fixed bottom-nav so primary actions / save buttons aren't
            hidden behind it; the sidebar shell already absorbs that
            on desktop so the padding is mobile-scoped. */}
        {showSettingsRail ? (
          <div className="flex gap-6 p-4 pb-20 lg:p-6 lg:pb-6">
            <SettingsRail storeId={navStoreId} />
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        ) : (
          <div className="p-4 pb-20 lg:p-6 lg:pb-6">{children}</div>
        )}
      </main>

      <ContactEbdaDialog storeId={navStoreId || null} />

      {/* Mobile Bottom Nav — store-scoped only. Renders nothing at
          md+ widths (its own internal `md:hidden`). When the merchant
          taps "More", we open the existing hamburger drawer rather
          than maintaining a parallel IA. */}
      {/* The Ebda assistant: renders nothing until the server says it is on for this store (rollout switch, default off). */}
      {navStoreId && mode === 'store_admin' && <AssistantDock storeId={navStoreId} />}
      {navStoreId && (
        <MobileBottomNav
          storeId={navStoreId}
          onOpenMore={() => setIsSidebarOpen(true)}
          badges={{ orders: attention.nav.orders, more: attention.nav.settings }}
        />
      )}
    </div>
  );
}
