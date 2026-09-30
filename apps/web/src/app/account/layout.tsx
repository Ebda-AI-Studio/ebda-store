'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '../../contexts/AuthContext';
import { useStoreUrl } from '../../contexts/StoreContext';
import { useFeatures } from '../../contexts/FeatureContext';
import { ShopChrome } from '../../components';
import { useLanguage } from '../../contexts/LanguageContext';
import { useWallet } from '../../hooks/useWallet';

const accountNav: Array<{ name: string; nameAr?: string; href: string; icon: string }> = [
  {
    name: 'Dashboard',
    href: '/account',
    icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  },
  {
    name: 'Orders',
    href: '/account/orders',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
  },
  {
    name: 'Addresses',
    href: '/account/addresses',
    icon: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z',
  },
  {
    name: 'Loyalty Rewards',
    href: '/account/loyalty',
    icon: 'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
  },
  {
    // Customer wallet (store credit, D1). Shown only when the API confirms the
    // wallet for this store (see useWallet) — never on enabledFeatures alone.
    name: 'Wallet',
    nameAr: 'المحفظة',
    href: '/account/wallet',
    icon: 'M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3',
  },
  {
    name: 'Settings',
    href: '/account/settings',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  },
];

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const { isEnabled } = useFeatures();
  const { t } = useLanguage();
  const { wallet } = useWallet();

  // Redirect to login if not authenticated once loading completes.
  //
  // - `router.replace` (not `push`): back from /auth/login should
  //   return the customer to whatever they were on BEFORE the
  //   protected route (thank-you / home / wherever), not bounce
  //   them straight back into /account/* and re-trigger this
  //   redirect into a loop.
  // - `?redirect=<original path>`: the login client already reads
  //   this param and sends successful sign-ins back to it. Without
  //   it, a guest who clicks "View Order Status" on the success
  //   page → logs in → lands on the home page instead of their
  //   orders.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const target = `${pathname || '/account'}`;
      const loginUrl = `${storeUrl('/auth/login')}?redirect=${encodeURIComponent(target)}`;
      router.replace(loginUrl);
    }
  }, [isLoading, isAuthenticated, router, storeUrl, pathname]);

  async function handleLogout() {
    await logout();
    router.push(storeUrl('/'));
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <ShopChrome>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="lg:grid lg:grid-cols-12 lg:gap-8">
          {/* Sidebar */}
          <aside className="lg:col-span-3">
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              {/* User Info */}
              <div className="flex items-center gap-4 border-b pb-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary font-bold">
                  {user?.firstName?.[0]}
                  {user?.lastName?.[0]}
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    {user?.firstName} {user?.lastName}
                  </p>
                  <p className="text-sm text-muted-foreground">{user?.email}</p>
                </div>
              </div>

              {/* Navigation */}
              <nav className="mt-6 space-y-1">
                {accountNav
                  .filter(item => {
                    if (item.href === '/account/loyalty') return isEnabled('loyalty');
                    if (item.href === '/account/returns') return isEnabled('returns');
                    if (item.href === '/account/wallet') return wallet !== null;
                    return true;
                  })
                  .map(item => {
                    const isActive = pathname === item.href;
                    return (
                      <Link
                        key={item.name}
                        href={storeUrl(item.href)}
                        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                          isActive
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        <svg
                          className="h-5 w-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d={item.icon}
                          />
                        </svg>
                        {item.nameAr ? t(item.name, item.nameAr) : item.name}
                      </Link>
                    );
                  })}
              </nav>

              <div className="mt-6 pt-6 border-t">
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-destructive-ink hover:bg-destructive/10 transition"
                  aria-label="Log out"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                    />
                  </svg>
                  Sign Out
                </button>
              </div>
            </div>
          </aside>

          {/* Main Content */}
          <div className="mt-8 lg:col-span-9 lg:mt-0">{children}</div>
        </div>
      </div>
    </ShopChrome>
  );
}
