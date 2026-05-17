'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCart } from '../../contexts/CartContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStoreUrl } from '../../contexts/StoreContext';

/**
 * Sprint 3 (2026-05-17): Mobile sticky bottom tab bar with 4 destinations
 * — Home / Wishlist / Cart (elevated primary pill — matches Pecannbee
 * IMG_7985) / Search. Mirrors the pattern observed across all 3 OSOSS
 * reference storefronts during the 2026-05-17 UI catalog session.
 *
 * Visibility:
 *  - Mobile-only (`md:hidden`) — desktop has the top header.
 *  - Hidden on PDP routes (`/products/<slug>`) where a page-level sticky
 *    add-to-cart bar lives. Without this guard both bars would stack
 *    and crowd thumb territory on small phones.
 *  - Hidden on /checkout + /auth — those flows use MinimalChrome and
 *    shouldn't pull users back into shopping mid-purchase.
 *
 * Behavior:
 *  - Cart tab is visually primary (filled `--primary` pill bg + larger
 *    icon target) per the Stitch verification on 2026-05-17.
 *  - Active tab uses `--primary`-tinted background pill so the active
 *    state reads tactile, not just an icon color flip (Stitch
 *    surfaced this pattern from its first generation).
 *  - Cart shows the item count badge consistent with the header cart
 *    icon — same `useCart().itemCount` source.
 *  - Safe-area inset reserved for iOS notch via `pb-[env(safe-area-inset-bottom)]`.
 */
export function BottomTabBar() {
  const { isRtl } = useLanguage();
  const { itemCount } = useCart();
  const storeUrl = useStoreUrl();
  const pathname = usePathname() ?? '/';

  // PDP + checkout + auth routes hide the bar to avoid stacking
  // bottom-fixed UI. The pathname includes the store slug prefix on
  // path-based multi-tenant URLs, so match the trailing segment(s).
  const lowered = pathname.toLowerCase();
  const hideOn = ['/products/', '/checkout', '/auth/', '/account/order'];
  if (hideOn.some(p => lowered.includes(p))) return null;

  const tabs: Array<{
    key: string;
    href: string;
    labelEn: string;
    labelAr: string;
    icon: JSX.Element;
    primary?: boolean;
  }> = [
    {
      key: 'home',
      href: storeUrl('/'),
      labelEn: 'Home',
      labelAr: 'الرئيسية',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
          />
        </svg>
      ),
    },
    {
      key: 'wishlist',
      href: storeUrl('/wishlist'),
      labelEn: 'Wishlist',
      labelAr: 'المفضلة',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
          />
        </svg>
      ),
    },
    {
      key: 'cart',
      href: storeUrl('/cart'),
      labelEn: 'Cart',
      labelAr: 'السلة',
      primary: true,
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
      ),
    },
    {
      key: 'search',
      href: storeUrl('/search'),
      labelEn: 'Search',
      labelAr: 'بحث',
      icon: (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      ),
    },
  ];

  const isActive = (href: string) => {
    if (href === storeUrl('/')) {
      // Home is only active on exact root (avoid every page reading as home)
      return lowered === '/' || lowered === storeUrl('/').toLowerCase().replace(/\/$/, '');
    }
    return lowered.includes(href.toLowerCase().replace(/\/$/, ''));
  };

  return (
    <nav
      aria-label={isRtl ? 'شريط التنقل' : 'Bottom navigation'}
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed bottom-0 inset-x-0 z-40 md:hidden bg-[hsl(var(--bg-section-alt))] border-t border-foreground/10 pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="grid grid-cols-4 max-w-md mx-auto">
        {tabs.map(tab => {
          const active = isActive(tab.href);
          const label = isRtl ? tab.labelAr : tab.labelEn;
          // Cart gets the elevated treatment regardless of active state
          // (always-primary affordance). Other tabs get the soft pill
          // background only when active.
          const isPrimary = tab.primary;
          return (
            <li key={tab.key} className="flex">
              <Link
                href={tab.href}
                prefetch={false}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[56px] transition-colors ${
                  isPrimary
                    ? 'text-[hsl(var(--primary-foreground))]'
                    : active
                      ? 'text-foreground'
                      : 'text-foreground/60 hover:text-foreground'
                }`}
                aria-current={active ? 'page' : undefined}
              >
                {/* Elevated cart pill OR active soft pill */}
                <span
                  className={`relative inline-flex items-center justify-center rounded-full transition-colors ${
                    isPrimary
                      ? 'h-11 w-11 -mt-3 bg-[hsl(var(--primary))] shadow-[0_8px_20px_-6px_hsl(var(--primary)/0.5)]'
                      : active
                        ? 'h-9 w-12 bg-[hsl(var(--primary))]/10'
                        : 'h-9 w-12'
                  }`}
                >
                  {tab.icon}
                  {tab.key === 'cart' && itemCount > 0 && (
                    <span className="absolute -top-1 -end-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
                      {itemCount > 99 ? '99+' : itemCount}
                    </span>
                  )}
                </span>
                <span className="text-[10px] font-medium leading-none">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
