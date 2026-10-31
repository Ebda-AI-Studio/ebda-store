'use client';

/**
 * `featured-collection` with `layout: 'menu'` (Phase B4, Lamma; Ruling B4-1): dishes as ROWS,
 * grouped by the store's categories under sticky category tabs. The row is the platform card
 * (`StorefrontProductCard orientation="row"`): same data, helpers, badges and add control, so
 * there is no 14th card path. Tabs are an in-page navigation (anchor links with `aria-current`,
 * not an ARIA tablist: every group is on the page), each a 44px target, scroll-spied; a category
 * with no dish makes no tab, and a single group makes none. Nothing on the page scrolls
 * sideways: only the tab strip does, and its scroll direction follows the page direction.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SectionPaddingMaxWidthVisibility, TemplateId } from '@ebda/shared';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { StorefrontProductCard } from '../../templates/shared/StorefrontProductCard';
import { pickLocalizedName } from '../../templates/shared/display-helpers';
import { toTemplateProduct } from '../../templates/adapters';
import type { Product } from '@/lib/api';
import { SectionHeader } from './SectionHeader';
import { groupMenuProducts, type MenuCategory } from './menu-groups';

export interface MenuSettings extends SectionPaddingMaxWidthVisibility {
  heading?: string;
  headingAr?: string;
  subheading?: string;
  subheadingAr?: string;
  tabs?: 'categories' | 'none';
  bgColor?: string;
}

export function MenuSection({
  sectionId,
  settings,
  products,
  categories,
  pack,
  onAddToCart,
  editorMode = false,
}: {
  sectionId: string;
  settings: MenuSettings;
  products: Product[];
  categories: readonly MenuCategory[];
  pack: TemplateId;
  onAddToCart: (productId: string) => Promise<void>;
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const ar = language === 'ar';
  const pick = (en?: string, a?: string) => (ar ? a || en : en || a) || '';
  const edit = (key: string): Record<string, string> | undefined =>
    editorMode ? { 'data-builder-setting': ar ? `${key}Ar` : key } : undefined;
  const spacing = sectionSpacingClasses(settings, store.look);
  const groups = useMemo(() => groupMenuProducts(products, categories), [products, categories]);
  const showTabs = settings.tabs !== 'none' && groups.length > 1;
  const anchor = (key: string) => `menu-${sectionId}-${key}`;
  const [active, setActive] = useState<string | null>(groups[0]?.key ?? null);

  const navRef = useRef<HTMLElement | null>(null);

  // One offset source (a11y M3): the browser's own `scroll-padding-top` (header + --sticky-extra).
  // The tab strip publishes its height as --sticky-extra so a focus scroll (Shift+Tab, WCAG 2.4.11)
  // and an anchor jump both clear header AND strip. It also follows the auto-hiding header (M5):
  // when the header slides away the strip moves up to the viewport top instead of floating below a gap.
  useEffect(() => {
    const nav = navRef.current;
    if (!showTabs || !nav) return;
    const root = document.documentElement;
    const header = document.querySelector<HTMLElement>('[data-zone="header"] header, header');
    const publish = () =>
      root.style.setProperty('--sticky-extra', `${Math.ceil(nav.offsetHeight)}px`);
    publish();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    ro?.observe(nav);
    const follow = () => {
      const hidden = header?.classList.contains('-translate-y-full') ?? false;
      nav.style.top = hidden ? '0px' : '';
    };
    follow();
    const mo = header ? new MutationObserver(follow) : null;
    if (header) mo?.observe(header, { attributes: true, attributeFilter: ['class'] });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      root.style.removeProperty('--sticky-extra');
    };
  }, [showTabs]);

  // Scroll-spy: the LAST group whose top is above the line under header + strip (a11y M3).
  useEffect(() => {
    if (!showTabs) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const nav = navRef.current;
      const line = (nav ? nav.getBoundingClientRect().bottom : 0) + 16;
      let cur = groups[0]?.key ?? null;
      if (window.scrollY >= 1)
        for (const g of groups) {
          const el = document.getElementById(anchor(g.key));
          if (el && el.getBoundingClientRect().top <= line) cur = g.key;
        }
      setActive(cur);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, showTabs, sectionId]);

  // M4: keep the active tab visible inside the horizontal strip (instant under reduced motion).
  useEffect(() => {
    const cur = navRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!cur || !navRef.current) return;
    const strip = cur.closest('ul');
    if (!strip) return;
    const c = cur.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    if (c.left < s.left || c.right > s.right) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      // Scroll the STRIP only. `cur.scrollIntoView` is a second smooth scroll on the window: it
      // supersedes the anchor jump the tap just started, which then stops where it is (a tab half
      // outside the strip never reached its group). scrollBy is signed in both directions (RTL too).
      strip.scrollBy({
        left: c.left < s.left ? c.left - s.left : c.right - s.right,
        behavior: reduce ? 'auto' : 'smooth',
      });
    }
  }, [active]);

  if (groups.length === 0) return null;
  const nameOf = (g: (typeof groups)[number]) =>
    g.category ? (pickLocalizedName(g.category, ar) ?? g.category.name) : t('More', 'حاجات تانية');

  return (
    <section
      data-section="featured-collection"
      data-layout="menu"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        <SectionHeader
          title={pick(settings.heading, settings.headingAr)}
          subtitle={pick(settings.subheading, settings.subheadingAr) || undefined}
          linkLabel={t('View all', 'عرض الكل')}
          linkHref={storeUrl('/products')}
          editTitle={edit('heading')}
          editSubtitle={edit('subheading')}
        />
        {showTabs && (
          <nav
            ref={navRef}
            aria-label={t('Menu categories', 'أقسام المنيو')}
            data-part="menu-tabs"
            className="sticky top-[var(--header-h,0px)] z-30 transition-[top] duration-300 -mx-4 mb-4 border-b border-border bg-background px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
          >
            <ul className="flex gap-2 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {groups.map(g => (
                <li key={g.key} className="shrink-0">
                  <a
                    href={`#${anchor(g.key)}`}
                    aria-current={active === g.key ? 'true' : undefined}
                    onClick={() => setActive(g.key)}
                    className={`inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap rounded-[var(--radius)] px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      active === g.key
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-foreground'
                    }`}
                  >
                    {nameOf(g)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="space-y-8">
          {groups.map(g => (
            <div key={g.key} id={anchor(g.key)} data-menu-group={g.key}>
              {groups.length > 1 && (
                <h3 className="mb-3 font-display text-lg font-bold text-foreground sm:text-xl">
                  {nameOf(g)}
                </h3>
              )}
              <ul className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
                {g.products.map(p => (
                  <li key={p.id} className="flex md:[&:last-child:nth-child(odd)]:col-span-2">
                    <StorefrontProductCard
                      product={toTemplateProduct(p)}
                      pack={pack}
                      orientation="row"
                      isRtl={ar}
                      currency={store.currency}
                      urlPrefix={storeUrl('')}
                      onAddToCart={onAddToCart}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
