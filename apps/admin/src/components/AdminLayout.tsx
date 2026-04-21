'use client';

import { useState, useEffect, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@force/ui';
import { useAuth } from '../lib/auth';
import { apiGet } from '../lib/api';
import { NotificationBell } from './NotificationBell';
import { useStore } from '../contexts/StoreContext';
import { useFeatures } from '../hooks/useFeatures';

interface NavItem {
  name: string;
  href: string;
  icon: string;
  /** When set, this nav item is hidden unless the named feature is enabled. */
  featureKey?: string;
}

// Super Admin navigation (Force Media platform admin)
const superAdminNav: NavItem[] = [
  {
    name: 'Dashboard',
    href: '/',
    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  },
  {
    name: 'Stores',
    href: '/stores',
    icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
  },
  {
    name: 'Users',
    href: '/users',
    icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
  },
  {
    name: 'Audit Logs',
    href: '/audit-logs',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  },
];

// Store Admin navigation factory — returns nav items scoped to the given storeId.
// Using a function instead of a static array ensures that Customers and Analytics
// link to the correct store-scoped URLs rather than the super-admin root pages.
// Items with a `featureKey` will be filtered out when that feature is disabled.
function buildStoreAdminNav(storeId: string): NavItem[] {
  return [
    {
      name: 'Dashboard',
      href: `/stores/${storeId}`,
      icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    },
    {
      name: 'Products',
      href: `/stores/${storeId}/products`,
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    },
    {
      name: 'Orders',
      href: `/stores/${storeId}/orders`,
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
    },
    {
      name: 'Customers',
      href: `/stores/${storeId}/customers`,
      icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    },
    {
      name: 'Analytics',
      href: `/stores/${storeId}/analytics`,
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      name: 'Settings',
      href: `/stores/${storeId}/settings`,
      icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    },
  ];
}

interface StoreBranding {
  id: string;
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
}

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
  mode = 'super_admin',
  storeBranding,
  storeId,
  storeDomain,
  storeSlug,
}: AdminLayoutProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const { user, logout, isLoading } = useAuth();
  const { selectedStoreId: globalStoreId } = useStore();
  const { isEnabled: isFeatureEnabled } = useFeatures();

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

  // Fetch store domain/slug for "View Store" button
  const [storeInfo, setStoreInfo] = useState<{ domain?: string; slug?: string } | null>(null);
  useEffect(() => {
    if (!currentStoreId || storeDomain || storeSlug) return;
    apiGet<{ store?: { domain?: string; slug?: string }; domain?: string; slug?: string }>(
      `/api/v1/stores/${currentStoreId}`
    ).then(({ data }) => {
      const s = (data as { store?: { domain?: string; slug?: string } })?.store || data;
      if (s) setStoreInfo({ domain: s.domain || undefined, slug: s.slug });
    });
  }, [currentStoreId, storeDomain, storeSlug]);

  const viewStoreUrl = useMemo(() => {
    const domain = storeDomain || storeInfo?.domain;
    const slug = storeSlug || storeInfo?.slug;
    if (domain) return `https://${domain}`;
    const webBase = process.env.NEXT_PUBLIC_WEB_URL;
    if (webBase && slug) return `${webBase}/${slug}`;
    if (webBase) return webBase;
    return null;
  }, [storeDomain, storeSlug, storeInfo]);

  // Show back button on all pages except root/dashboard
  const showBackButton = pathname !== '/' && pathname !== '/dashboard';

  // Store admin nav is computed dynamically so that Customers and Analytics
  // resolve to store-scoped URLs (/stores/:id/customers, /stores/:id/analytics)
  // rather than the super-admin root pages (/customers, /analytics).
  // Items with a `featureKey` are hidden when that feature is disabled.
  const allNavItems = mode === 'super_admin' ? superAdminNav : buildStoreAdminNav(storeId ?? '');
  const navItems = allNavItems.filter(
    item => !item.featureKey || isFeatureEnabled(item.featureKey)
  );
  const isStoreAdminWithBranding = mode === 'store_admin' && storeBranding;

  // Memoize sidebar content
  const sidebarContent = useMemo(
    () => (
      <>
        {/* Logo Section */}
        <div className="flex h-16 items-center gap-3 border-b border-border/50 px-6">
          {isStoreAdminWithBranding && storeBranding?.logo ? (
            // Store Branding Logo
            <>
              <div className="flex h-9 w-9 items-center justify-center rounded-xl overflow-hidden bg-muted shadow-lg">
                <Image
                  src={storeBranding.logo}
                  alt={storeBranding.name}
                  width={36}
                  height={36}
                  className="h-9 w-9 object-contain"
                />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-lg font-bold tracking-tight text-foreground truncate block">
                  {storeBranding.name}
                </span>
                {storeBranding.nameAr && (
                  <span className="text-xs text-muted-foreground truncate block" dir="rtl">
                    {storeBranding.nameAr}
                  </span>
                )}
              </div>
            </>
          ) : (
            // Force Media Branding (default)
            <>
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/90 shadow-lg shadow-primary/25">
                <Image
                  src="/logo.svg"
                  alt="Force Media"
                  width={20}
                  height={15}
                  className="brightness-0 invert"
                  unoptimized
                />
              </div>
              <div>
                <span className="text-lg font-bold tracking-tight">
                  <span className="text-primary">Force</span>
                  <span className="text-foreground">
                    {' '}
                    {mode === 'super_admin' ? 'Platform' : 'Admin'}
                  </span>
                </span>
              </div>
            </>
          )}
        </div>

        {/* Super Admin Badge */}
        {mode === 'super_admin' && (
          <div className="border-b border-border/50 px-4 py-3">
            <div className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-primary/10 to-primary/10 px-3 py-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/90 text-[10px] font-bold text-white shadow-sm">
                SA
              </div>
              <div>
                <span className="text-xs font-semibold text-foreground">Super Admin</span>
                <p className="text-[10px] text-muted-foreground">Full platform access</p>
              </div>
            </div>
          </div>
        )}

        {/* Store Admin Badge */}
        {isStoreAdminWithBranding && (
          <div className="border-b border-border/50 px-4 py-3">
            <div className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-blue-500/10 to-indigo-500/10 px-3 py-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-[10px] font-bold text-white shadow-sm">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                  />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold text-foreground">Store Admin</span>
                <p className="text-[10px] text-muted-foreground truncate">Managing your store</p>
              </div>
            </div>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="space-y-1">
            {navItems.map(item => {
              const isActive =
                pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
              return (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    onClick={() => setIsSidebarOpen(false)}
                    className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? 'bg-primary/8 text-primary'
                        : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                    }`}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    {/* Left border active indicator */}
                    {isActive && (
                      <span className="absolute start-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
                    )}
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 ${
                        isActive
                          ? 'bg-primary/15 text-primary'
                          : 'text-muted-foreground group-hover:bg-muted group-hover:text-foreground'
                      }`}
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d={item.icon}
                        />
                      </svg>
                    </span>
                    <span className={isActive ? 'font-semibold' : ''}>{item.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Theme Toggle */}
        <div className="px-4 pb-2">
          <button
            onClick={toggleTheme}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            )}
            {isDark ? 'Light Mode' : 'Dark Mode'}
          </button>
        </div>

        {/* User Profile Section */}
        <div className="border-t border-border/50 p-4">
          <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-3 transition-colors hover:bg-muted">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 text-sm font-bold text-primary">
              {user?.firstName?.[0]}
              {user?.lastName?.[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
            </div>
            <button
              onClick={logout}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label="Log out"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                />
              </svg>
            </button>
          </div>
        </div>
      </>
    ),
    [
      mode,
      navItems,
      pathname,
      user,
      logout,
      isStoreAdminWithBranding,
      storeBranding,
      globalStoreId,
      isDark,
      toggleTheme,
    ]
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
          <p className="text-sm font-medium text-muted-foreground">Loading dashboard...</p>
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
        className={`fixed inset-y-0 start-0 z-50 w-72 transform border-r border-border/50 bg-card shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col">
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
            aria-label="Close sidebar"
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
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-72 border-r border-border/50 bg-card lg:flex lg:flex-col">
        {sidebarContent}
      </aside>

      {/* Main Content */}
      <main id="admin-main-content" tabIndex={-1} className="flex-1 lg:ms-72">
        {/* Header */}
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border/50 bg-card/80 px-4 backdrop-blur-md lg:px-6">
          <div className="flex items-center gap-4">
            {/* Mobile menu button */}
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
              aria-label="Open sidebar"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
            {showBackButton && (
              <button
                onClick={() => router.back()}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Go back"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>
            )}
            <div>
              <h1 className="text-lg font-bold text-foreground">{title}</h1>
              {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Notifications */}
            <NotificationBell />

            {/* View Store — links to the storefront for the current store */}
            {viewStoreUrl && (
              <Link href={viewStoreUrl} target="_blank" className="hidden sm:block">
                <Button variant="outline" size="sm" className="gap-2 rounded-xl">
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                    />
                  </svg>
                  View Store
                </Button>
              </Link>
            )}
            {actions}
          </div>
        </header>

        {/* Page Content */}
        <div className="p-4 lg:p-6">{children}</div>
      </main>
    </div>
  );
}
