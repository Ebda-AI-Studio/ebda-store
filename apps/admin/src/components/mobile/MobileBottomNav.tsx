'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { bottomNavClasses } from '../ui/tokens';
import { useT } from '@/i18n/useT';

interface MobileBottomNavProps {
  storeId: string;
  /** When true, the "More" tab opens the existing hamburger drawer
   *  instead of routing — caller passes its own open handler. */
  onOpenMore: () => void;
}

interface Tab {
  key: string;
  href: string;
  /** SVG path d= attribute; reuse the icons already used in the
   *  sidebar so there's no visual mismatch when the merchant flips
   *  between the drawer and the bottom bar. */
  icon: string;
}

/**
 * Fixed bottom tab bar shown only at `< md` AND only on store-scoped
 * pages. The same nav item set is in the hamburger drawer
 * (`buildStoreAdminNav.ts`); this just surfaces the four most-used
 * destinations (Home / Orders / Products / More) with thumb-reach so
 * a merchant on their phone can run their day without the full
 * sidebar in the way.
 *
 * The "More" tab routes back to the existing drawer rather than
 * re-implementing every page link — keeps the IA in one place.
 */
export function MobileBottomNav({ storeId, onOpenMore }: MobileBottomNavProps) {
  const pathname = usePathname();
  const t = useT('nav');

  // Portal target — resolved after first client paint so SSR is safe.
  // Rendering via createPortal(…, document.body) detaches the nav from
  // any ancestor stacking context (the mobile sidebar <aside> uses
  // `transform: translateX(…)` which creates a new containing block in
  // iOS Safari / standalone-PWA, causing `position:fixed` children to
  // anchor to that transformed ancestor instead of the viewport — the
  // visual "jump on scroll" the merchant reported). A portal lifts the
  // nav out of that subtree so it is always viewport-anchored.
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  const tabs: Tab[] = [
    {
      key: 'dashboard',
      href: `/stores/${storeId}`,
      icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    },
    {
      key: 'orders',
      href: `/stores/${storeId}/orders`,
      icon: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
    },
    {
      key: 'products',
      href: `/stores/${storeId}/products`,
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    },
  ];

  function isActive(href: string): boolean {
    if (!pathname) return false;
    if (href === `/stores/${storeId}`) return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const nav = (
    <nav
      // pb env-safe-area-inset so the bar clears the iPhone home indicator.
      // Only ever rendered at < md — desktop shell remains the sidebar.
      // Rendered via createPortal to document.body so it is NEVER inside a
      // transformed ancestor (the mobile sidebar aside uses translateX which
      // creates a new CSS containing block on iOS Safari / standalone-PWA,
      // making position:fixed anchor to that element instead of the viewport
      // — the "jumps on scroll" the merchant reported). Portalling out
      // guarantees viewport anchoring regardless of what the admin layout
      // does with transforms. translateZ(0) is kept for GPU layer promotion.
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_10px_-4px_rgba(0,0,0,0.08)] [transform:translateZ(0)] [-webkit-transform:translateZ(0)] md:hidden"
      role="navigation"
      aria-label={t('mobileBottomNav')}
    >
      {tabs.map(tab => {
        const active = isActive(tab.href);
        return (
          <Link key={tab.key} href={tab.href} className={bottomNavClasses(active)}>
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
            </svg>
            <span>{t(tab.key as 'dashboard' | 'orders' | 'products')}</span>
          </Link>
        );
      })}
      <button
        data-ui="nav"
        type="button"
        onClick={onOpenMore}
        aria-label={t('more')}
        className={bottomNavClasses(false)}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
        <span>{t('more')}</span>
      </button>
    </nav>
  );

  // During SSR / before hydration portalRoot is null — render nothing
  // (the bar is md:hidden anyway so desktop sees no flash).
  if (!portalRoot) return null;
  return createPortal(nav, portalRoot);
}
