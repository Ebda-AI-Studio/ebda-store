'use client';

import { useEffect } from 'react';
import Link from '../../components/StoreLink';
import { type Category } from '@/lib/api';
import { useStore, useStoreUrl } from '@/contexts/StoreContext';
import { pageSurfaceStyle } from '@/lib/page-surface';
import { darkLookListingBand } from '../../templates/shared/section-bg';
import { useLanguage } from '../../contexts/LanguageContext';
import { ShopChrome } from '../../components';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { toTemplateCategory } from '../../templates/adapters';
import {
  resolveSectionZone,
  zoneStyle,
  scaleZone,
  pageTextScale,
  pageDensityStyle,
} from '../../templates/shared/section-typography';
import { INVERSE_SURFACE, type CategoriesPageSettings } from '@ebda/shared';
import { recordLastListing } from '@/lib/last-listing';

interface CategoriesClientProps {
  categories: Category[];
  /** Server-fetched categoriesPage layout settings. When provided, these are
   *  used instead of the client-side lazy-fetched context layout so the
   *  page surface styles (bgColor, colorScheme, density, textScale) render
   *  on the SSR pass without a layout-flash. */
  categoriesPage?: CategoriesPageSettings;
}

export default function CategoriesClient({
  categories,
  categoriesPage: categoriesPageProp,
}: CategoriesClientProps) {
  const storeUrl = useStoreUrl();
  const { store, layout } = useStore();
  const { language, t } = useLanguage();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  const isRtl = language === 'ar';
  const urlPrefix = storeUrl('');

  // Prefer the server-fetched prop (SSR-safe, no layout-flash) over the
  // client-side lazy-fetched context layout (available after hydration only).
  const catPage = categoriesPageProp ?? layout?.categoriesPage;

  // Categories page design (page-builder → Categories page).
  const catHeadingZone = resolveSectionZone(catPage?.typography?.heading, undefined, store.theme);
  // Category card labels — the theme CategoryGrid/CategoryCard already accept
  // a categoryLabelZone (built for the homepage block); feed it the per-page
  // categoryLabel override so the grid labels follow the Categories-page control.
  const catLabelZone = resolveSectionZone(
    catPage?.typography?.categoryLabel,
    undefined,
    store.theme
  );
  // A dark look lists its (white-ground) category photos on the inverse band (W2b, rule 1).
  const lookBand = darkLookListingBand(store.theme, store.look, !!catPage?.bgColor);
  const catBgStyle =
    lookBand ?? pageSurfaceStyle(catPage?.bgColor, store.theme, catPage?.colorScheme);
  const catScale = pageTextScale(catPage?.textScale);
  const catDensity = pageDensityStyle(catPage?.density);

  // Honor the merchant's "Show Best Sellers tile" toggle on the categories page
  // too (same StoreTheme flag as the homepage category strip). The virtual
  // best-sellers tile (synthesized by the API) has slug 'best-sellers'.
  const visibleCategories =
    store.theme?.showBestSellersTile === false
      ? categories.filter(c => c.slug !== 'best-sellers')
      : categories;

  const templateCategories = visibleCategories.map(toTemplateCategory);

  // Record this page as the last-browsed listing so "Continue Shopping" in
  // the cart returns the shopper here instead of /products.
  useEffect(() => {
    const path = window.location.pathname + window.location.search;
    const storePrefix = store?.slug && store.id !== 'demo' ? `/${store.slug}` : '';
    const relative =
      storePrefix && path.startsWith(storePrefix) ? path.slice(storePrefix.length) : path;
    recordLastListing(store?.id, relative || '/categories');
  }, [store?.id, store?.slug]);

  return (
    <ShopChrome>
      <div className="flex-1" style={catBgStyle}>
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8" style={catDensity}>
          {visibleCategories.length === 0 ? (
            <div className="text-center py-12">
              <h1 className="text-3xl font-bold mb-4" style={zoneStyle(catHeadingZone, catScale)}>
                {t('Shop by Category', 'تسوق حسب الفئة')}
              </h1>
              <p className="text-muted-foreground mb-4">
                {t('No categories available yet.', 'مفيش فئات متاحة دلوقتي')}
              </p>
              <Link href={storeUrl('/products')} className="text-primary hover:underline">
                {t('Browse all products', 'تصفح جميع المنتجات')}
              </Link>
            </div>
          ) : T && !templateLoading ? (
            <>
              {/* STORE-QA-42: the grid's heading is a styled element, not a heading. One real h1 per page. */}
              <h1 className="sr-only">{t('Shop by Category', 'تسوق حسب الفئة')}</h1>
              <T.CategoryGrid
                categories={templateCategories}
                title="Shop by Category"
                titleAr="تسوق حسب الفئة"
                isRtl={isRtl}
                urlPrefix={urlPrefix}
                // The band is the INVERSE surface: SectionHeading must measure against it, not the
                // dark page, or it paints a page-light heading onto the light band (1.1:1).
                sectionBgColor={lookBand ? INVERSE_SURFACE : undefined}
                headingZone={scaleZone(catHeadingZone, catScale)}
                categoryLabelZone={scaleZone(catLabelZone, catScale)}
                showCardFrame={layout?.categories?.showCardFrame}
                cardFrameStyle={layout?.categories?.cardFrameStyle}
                cardFrameWidth={layout?.categories?.cardFrameWidth}
                cardFrameSize={layout?.categories?.cardFrameSize}
                cardFrameColor={layout?.categories?.cardFrameColor}
              />
            </>
          ) : (
            // Skeleton while template loads.
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {visibleCategories.map(c => (
                <div key={c.id} className="animate-pulse rounded-xl border bg-card">
                  <div className="aspect-square bg-muted rounded-t-xl" />
                  <div className="p-4 space-y-2">
                    <div className="h-4 w-3/4 bg-muted rounded" />
                    <div className="h-3 w-1/2 bg-muted rounded" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ShopChrome>
  );
}
