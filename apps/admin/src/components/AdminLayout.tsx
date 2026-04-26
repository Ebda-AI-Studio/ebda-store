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
import { SidebarHeader } from './admin-layout/SidebarHeader';
import { SidebarNav } from './admin-layout/SidebarNav';
import { SidebarFooter } from './admin-layout/SidebarFooter';
import { TopBar } from './admin-layout/TopBar';

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

  // Derive the mode from the authenticated user's role unless the page
  // explicitly opts out. A store_admin can never see super_admin chrome
  // (security + UX), so even if a page passes mode="super_admin" we coerce
  // it to store_admin when the user only has store_admin privileges.
  const mode: 'super_admin' | 'store_admin' =
    user?.role === 'store_admin'
      ? 'store_admin'
      : (explicitMode ?? (user?.role === 'super_admin' ? 'super_admin' : 'super_admin'));

  const navLabels: NavLabels = {
    dashboard: t('navDashboard'),
    stores: t('navStores'),
    users: t('navUsers'),
    auditLogs: t('navAuditLogs'),
    products: t('navProducts'),
    orders: t('navOrders'),
    customers: t('navCustomers'),
    analytics: t('navAnalytics'),
    layout: t('navLayout'),
    settings: t('navSettings'),
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

  // Show back button on all pages except root/dashboard
  const showBackButton = pathname !== '/' && pathname !== '/dashboard';

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
  const navItems = allNavItems.filter(
    item => !item.featureKey || isFeatureEnabled(item.featureKey)
  );

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
      />
      <SidebarNav
        navItems={navItems}
        pathname={pathname}
        onNavigate={() => setIsSidebarOpen(false)}
      />
      <SidebarFooter isDark={isDark} onToggleTheme={toggleTheme} user={user} onLogout={logout} />
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
        className={`fixed inset-y-0 start-0 z-50 w-72 transform border-e border-border/50 bg-card shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col">
          <button
            type="button"
            onClick={() => setIsSidebarOpen(false)}
            className="absolute end-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
            aria-label={t('closeSidebar')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

      {/* Main Content */}
      <main id="admin-main-content" tabIndex={-1} className="flex-1 lg:ms-72">
        <TopBar
          title={title}
          subtitle={subtitle}
          actions={actions}
          showBackButton={showBackButton}
          onOpenSidebar={() => setIsSidebarOpen(true)}
          onBack={() => router.back()}
          viewStoreUrl={viewStoreUrl}
        />

        {/* Page Content */}
        <div className="p-4 lg:p-6">{children}</div>
      </main>
    </div>
  );
}
