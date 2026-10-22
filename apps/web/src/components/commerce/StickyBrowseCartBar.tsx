'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getLook } from '@ebda/shared';
import { useCart } from '../../contexts/CartContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { useNumerals } from '../../hooks/useNumerals';
import { countText, ITEMS } from '../../lib/plural';
import { MinOrderProgress } from './MinOrderProgress';
import { useStickyBarHeight } from './useStickyBarHeight';

/**
 * Where the browse cart bar may show: home, the product list, category pages and search. Never a
 * product page (it has its own buy bar), the cart or checkout (they have their own bars). The
 * pathname carries the store slug prefix on path-based tenants, so the prefix is stripped first.
 */
export function browseBarShownOn(pathname: string, prefix = ''): boolean {
  let path = pathname.toLowerCase();
  const p = prefix.toLowerCase().replace(/\/$/, '');
  if (p && path.startsWith(p)) path = path.slice(p.length);
  path = path.replace(/\/+$/, '') || '/';
  return (
    path === '/' ||
    path === '/products' ||
    path === '/categories' ||
    path.startsWith('/categories/') ||
    path === '/search'
  );
}

/**
 * Phone browse cart bar (Ruling B4-6): item count, total and the cart link while a basket exists,
 * on a look that sets `chrome.cartBar: 'total'`. C-04: while it shows it REPLACES the tab bar
 * (`useStickyBarHeight` marks `<html data-task-bar>`), never stacking on it, on the PDP buy bar or
 * on the cart total bar. When the store has a minimum order it carries the remaining-amount
 * progress (the same sentence the cart shows). The body reserves its space via
 * `body[data-sticky-cart]`, which also lifts the floating widget.
 */
export function StickyBrowseCartBar() {
  const { store } = useStore();
  // Cheap gate first: a store whose look has no cart bar mounts nothing else (no cart, price or
  // router hooks), so every other skin renders exactly as before.
  if (getLook(store?.look)?.chrome?.cartBar !== 'total') return null;
  return <BrowseCartBar />;
}

function BrowseCartBar() {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { itemCount, total } = useCart();
  const { t, language } = useLanguage();
  const { localize } = useNumerals();
  const formatPrice = useLocalePrice();
  const pathname = usePathname() ?? '/';
  const show = itemCount > 0 && browseBarShownOn(pathname, storeUrl(''));
  const minimumOrderFils = store?.settings?.minimumOrderFils as number | undefined;
  const hasProgress = !!minimumOrderFils && minimumOrderFils > total;

  const flag = hasProgress ? 'blocked' : '1';
  useEffect(() => {
    if (!show) return;
    document.body.dataset.stickyCart = flag;
    return () => {
      delete document.body.dataset.stickyCart;
    };
  }, [show, flag]);
  const barRef = useRef<HTMLDivElement>(null);
  useStickyBarHeight(barRef, show);
  if (!show) return null;

  const count = countText(language === 'ar' ? 'ar' : 'en', itemCount, ITEMS, localize(itemCount));

  return (
    <div
      ref={barRef}
      data-testid="sticky-browse-cart-bar"
      className="sticky-bar-in fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden"
    >
      <MinOrderProgress subtotalFils={total} minimumOrderFils={minimumOrderFils} className="mb-2" />
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{count}</p>
          <p
            data-testid="sticky-browse-cart-total"
            className="text-sm font-semibold tabular-nums text-foreground"
          >
            {formatPrice(total)}
          </p>
        </div>
        <Link
          href={storeUrl('/cart')}
          className="inline-flex h-11 min-w-[44px] items-center rounded-[var(--radius)] bg-primary px-5 text-sm font-semibold text-primary-foreground"
        >
          {t('View cart', 'عرض السلة')}
        </Link>
      </div>
    </div>
  );
}
