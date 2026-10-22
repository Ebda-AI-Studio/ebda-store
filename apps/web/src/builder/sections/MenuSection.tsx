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
import React, { useEffect, useMemo, useState } from 'react';
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

  // Scroll-spy: the group nearest the top of the viewport (below the sticky header + tabs).
  useEffect(() => {
    if (!showTabs || typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = groups.find(g => seen.get(anchor(g.key)));
        if (first) setActive(first.key);
      },
      { rootMargin: '-120px 0px -60% 0px' }
    );
    for (const g of groups) {
      const el = document.getElementById(anchor(g.key));
      if (el) io.observe(el);
    }
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, showTabs, sectionId]);

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
            aria-label={t('Menu categories', 'أقسام المنيو')}
            data-part="menu-tabs"
            className="sticky top-[var(--header-h,0px)] z-30 -mx-4 mb-4 border-b border-border bg-background px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
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
            <div
              key={g.key}
              id={anchor(g.key)}
              data-menu-group={g.key}
              className="scroll-mt-[calc(var(--header-h,0px)+4rem)]"
            >
              {groups.length > 1 && (
                <h3 className="mb-3 font-display text-lg font-bold text-foreground sm:text-xl">
                  {nameOf(g)}
                </h3>
              )}
              <ul className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
                {g.products.map(p => (
                  <li key={p.id} className="flex">
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
