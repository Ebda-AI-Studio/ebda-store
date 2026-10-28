'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from '../../components/StoreLink';
import { usePathname } from 'next/navigation';
import { useCart } from '../../contexts/CartContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStoreUrl } from '../../contexts/StoreContext';
import type { BottomBarSettings, StoreTheme } from '@ebda/shared';
import { resolveColor, DEFAULT_THEME } from '@ebda/shared';
import { CartIcon } from '@ebda/ui';
import type { NavItem } from '../types';
import { Sheet } from '../../components/ui/Sheet';
import { useTabBarShown } from './tab-bar-visibility';

/**
 * Sprint 3 (2026-05-17): Mobile sticky bottom tab bar with 4 destinations
 * — Home / Wishlist / Cart (elevated primary pill — matches Storefront
 * IMG_7985) / Search. Mirrors the pattern observed across all 3 OSOSS
 * reference storefronts during the 2026-05-17 UI catalog session.
 *
 * Visibility:
 *  - Mobile-only (`md:hidden`) — desktop has the top header.
 *  - Shown on PDP too — the cart MUST stay reachable on mobile (the header
 *    cart icon is `hidden md:inline-flex`, so the tab bar is the ONLY mobile
 *    cart entry point). EXCEPT while a task bar is up (PDP buy bar, Dahab
 *    pinned bar, cart total bar): it REPLACES this bar instead of stacking on
 *    it (C-04). The task bar marks `<html data-task-bar>` and globals.css hides
 *    `[data-bottom-tab-bar]`; the bar is back the moment the task bar hides.
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
interface BottomTabBarProps {
  /** Merchant-controlled color overrides from `layout.bottomBar`. All optional —
   *  when unset the tab bar falls back to its class-based defaults (no regression
   *  for existing stores). Values are hex or `token:*`, resolved via resolveColor. */
  bottomBar?: BottomBarSettings;
  /** Store theme — needed to resolve `token:*` color values. */
  theme?: StoreTheme;
  /**
   * Resolved storefront navigation (same list the header + footer receive from
   * ShopChrome — already scheme-validated, slug-prefixed, and Locations-aware).
   * Rendered inside the bottom-bar "Menu" drawer so mobile shoppers can reach
   * every merchant-placed nav link (Products / Categories / About / Contact /
   * Locations / any custom link) without the desktop header. When empty the
   * Menu tab still opens but shows only the built-in destinations.
   */
  navigation?: NavItem[];
}

export function BottomTabBar({ bottomBar, theme, navigation = [] }: BottomTabBarProps = {}) {
  const { isRtl, t } = useLanguage();
  const { itemCount } = useCart();
  const storeUrl = useStoreUrl();
  const pathname = usePathname() ?? '/';
  // Menu-drawer open state. The drawer lists the store's full navigation so the
  // mobile bottom bar finally has a working, pressable "Menu" that OPENS (the
  // bar previously had no menu affordance at all — merchant complaint 2026-06-18).
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the drawer on route change so a tapped link doesn't leave it open.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  // Render into <body> via a portal. `position: fixed` is relative to the
  // nearest ancestor with a transform/filter/will-change/contain — and the
  // storefront page wrappers animate sections (transform), which was trapping
  // this bar mid-screen on mobile instead of pinning it to the viewport bottom
  // (reported 2026-06-05). Portaling to body escapes any such containing block.
  const shown = useTabBarShown();
  // The body and the content reserve the bar's height on phones (layout.tsx pb-32); with no bar on this route
  // that reserve is dead space under the footer, so mark the document and let globals.css drop it.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.tabBar = shown ? 'on' : 'off';
    return () => {
      delete root.dataset.tabBar;
    };
  }, [shown]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // checkout + auth + order-detail routes hide the bar (MinimalChrome flows;
  // don't pull users back into shopping mid-purchase). PDP is NOT hidden — on
  // mobile the tab bar is the cart's only entry point (header cart is
  // desktop-only). The pathname includes the store slug prefix on path-based
  // multi-tenant URLs, so match the trailing segment(s).
  const lowered = pathname.toLowerCase();
  if (!shown) return null;

  const tabs: Array<{
    key: string;
    href: string;
    labelEn: string;
    labelAr: string;
    icon: JSX.Element;
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
      icon: <CartIcon className="h-5 w-5" aria-hidden={true} />,
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

  // Resolve merchant color overrides. Undefined when not set → class-based
  // defaults apply, keeping exact existing behavior for stores that haven't
  // touched these settings (no regression).
  // `theme ?? DEFAULT_THEME` ensures resolveColor always receives a non-undefined
  // StoreTheme — `theme` is optional here because BottomTabBar can mount before
  // ShopChrome has resolved the store, but DEFAULT_THEME still paints tokens
  // sensibly and the prop is always populated at runtime.
  const effectiveTheme: StoreTheme = theme ?? DEFAULT_THEME;
  const resolvedBg = bottomBar?.bgColor
    ? (resolveColor(bottomBar.bgColor, effectiveTheme) ?? undefined)
    : undefined;
  const resolvedActive = bottomBar?.activeColor
    ? (resolveColor(bottomBar.activeColor, effectiveTheme) ?? undefined)
    : undefined;
  const resolvedInactive = bottomBar?.inactiveColor
    ? (resolveColor(bottomBar.inactiveColor, effectiveTheme) ?? undefined)
    : undefined;

  // Active pill: use resolved active color at ~10% opacity when set, else the
  // class-based `bg-[hsl(var(--primary))]/10` default takes over via className.
  // We express 10% opacity as a CSS color-mix when a custom color is provided.
  const activePillStyle: React.CSSProperties | undefined = resolvedActive
    ? { backgroundColor: `color-mix(in srgb, ${resolvedActive} 10%, transparent)` }
    : undefined;

  // Menu-tab icon (hamburger). Rendered as a button, not a Link, because it
  // toggles the nav drawer instead of navigating.
  const menuIcon = (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  );
  const menuLabel = t('Menu', 'القائمة');
  const menuColorStyle: React.CSSProperties | undefined =
    menuOpen && resolvedActive
      ? { color: resolvedActive }
      : !menuOpen && resolvedInactive
        ? { color: resolvedInactive }
        : undefined;

  const bar = (
    <nav
      aria-label={t('Bottom navigation', 'شريط التنقل')}
      dir={isRtl ? 'rtl' : 'ltr'}
      data-bottom-tab-bar
      className="fixed bottom-0 inset-x-0 z-40 md:hidden bg-[hsl(var(--bg-section-alt))] border-t border-foreground/10 pb-[env(safe-area-inset-bottom)]"
      style={resolvedBg ? { backgroundColor: resolvedBg } : undefined}
    >
      <ul className="grid grid-cols-5 max-w-md mx-auto">
        {tabs.map(tab => {
          const active = isActive(tab.href);
          const label = t(tab.labelEn, tab.labelAr);
          // Per-tab color: active uses resolvedActive, inactive uses resolvedInactive.
          // When neither applies, the className handles color as before (no regression).
          const tabColorStyle: React.CSSProperties | undefined =
            active && resolvedActive
              ? { color: resolvedActive }
              : !active && resolvedInactive
                ? { color: resolvedInactive }
                : undefined;
          return (
            <li key={tab.key} className="flex">
              <Link
                href={tab.href}
                prefetch={false}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[calc(var(--bottom-tab-h)-1px)] transition-colors ${
                  active
                    ? resolvedActive
                      ? ''
                      : 'text-foreground'
                    : resolvedInactive
                      ? ''
                      : 'text-foreground/70 hover:text-foreground'
                }`}
                style={tabColorStyle}
                aria-current={active ? 'page' : undefined}
              >
                <span
                  className={`relative inline-flex h-9 w-12 items-center justify-center rounded-full transition-colors ${
                    active && !activePillStyle ? 'bg-[hsl(var(--primary))]/10' : ''
                  }`}
                  style={active ? activePillStyle : undefined}
                >
                  {tab.icon}
                  {tab.key === 'cart' && itemCount > 0 && (
                    <span className="absolute -top-1 -end-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-foreground px-1 text-xs tabular-nums font-bold text-background">
                      {itemCount > 99 ? '99+' : itemCount}
                    </span>
                  )}
                </span>
                <span className="text-xs font-medium leading-snug">{label}</span>
              </Link>
            </li>
          );
        })}
        {/* Menu tab — opens the nav drawer. A real <button> with an onClick so
            it is pressable and actually OPENS (the prior 4-tab bar had no menu
            at all). aria-expanded + aria-controls wire it to the drawer. */}
        <li className="flex">
          <button
            type="button"
            onClick={() => setMenuOpen(v => !v)}
            aria-expanded={menuOpen}
            aria-controls="bottom-nav-menu-drawer"
            aria-label={menuLabel}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[calc(var(--bottom-tab-h)-1px)] transition-colors ${
              menuOpen
                ? resolvedActive
                  ? ''
                  : 'text-foreground'
                : resolvedInactive
                  ? ''
                  : 'text-foreground/70 hover:text-foreground'
            }`}
            style={menuColorStyle}
          >
            <span
              className={`relative inline-flex h-9 w-12 items-center justify-center rounded-full transition-colors ${
                menuOpen && !activePillStyle ? 'bg-[hsl(var(--primary))]/10' : ''
              }`}
              style={menuOpen ? activePillStyle : undefined}
            >
              {menuIcon}
            </span>
            <span className="text-xs font-medium leading-snug">{menuLabel}</span>
          </button>
        </li>
      </ul>
    </nav>
  );

  // Nav drawer on the shared Sheet primitive (R-04): Escape, focus in/trap/
  // return to the Menu tab, scroll lock, a 44px close. It lists the store's full
  // navigation (Products / Categories / About / Contact / Locations / custom).
  const drawer = (
    <Sheet
      open={menuOpen}
      onClose={() => setMenuOpen(false)}
      side="bottom"
      id="bottom-nav-menu-drawer"
      dir={isRtl ? 'rtl' : 'ltr'}
      title={menuLabel}
      closeLabel={t('Close menu', 'إغلاق القائمة')}
      className="bg-[hsl(var(--bg-section-alt))] text-foreground md:hidden"
      style={resolvedBg ? { backgroundColor: resolvedBg } : undefined}
      titleClassName="text-sm font-semibold text-muted-foreground"
      bodyClassName="mx-auto w-full max-w-md px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
    >
      <ul className="flex flex-col">
        {navigation.map(item => (
          <li key={item.href}>
            <Link
              href={item.href}
              prefetch={false}
              onClick={() => setMenuOpen(false)}
              className="block border-b border-foreground/5 py-3 text-sm font-medium text-foreground hover:text-[hsl(var(--primary))]"
            >
              {isRtl ? (item.labelAr ?? item.label) : item.label}
            </Link>
          </li>
        ))}
      </ul>
    </Sheet>
  );

  // Portal to body so no transformed ancestor can trap the fixed positioning.
  if (!mounted) return null;
  return createPortal(
    <>
      {bar}
      {drawer}
    </>,
    document.body
  );
}
