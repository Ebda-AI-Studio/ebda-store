'use client';

import Link from 'next/link';
import { type Category } from '@/lib/api';
import { useStore, useStoreUrl } from '@/contexts/StoreContext';
import { pageSurfaceStyle } from '@/lib/page-surface';
import { useLanguage } from '../../contexts/LanguageContext';
import { ShopChrome } from '../../components';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { toTemplateCategory } from '../../templates/adapters';
import { resolveSectionZone, zoneStyle } from '../../templates/shared/section-typography';

interface CategoriesClientProps {
  categories: Category[];
}

export default function CategoriesClient({ categories }: CategoriesClientProps) {
  const storeUrl = useStoreUrl();
  const { store, layout } = useStore();
  const { language, t } = useLanguage();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  const isRtl = language === 'ar';
  const urlPrefix = storeUrl('');

  // Categories page design (page-builder → Categories page).
  const catHeadingZone = resolveSectionZone(
    layout?.categoriesPage?.typography?.heading,
    undefined,
    store.theme
  );
  // Category card labels — the theme CategoryGrid/CategoryCard already accept
  // a categoryLabelZone (built for the homepage block); feed it the per-page
  // categoryLabel override so the grid labels follow the Categories-page control.
  const catLabelZone = resolveSectionZone(
    layout?.categoriesPage?.typography?.categoryLabel,
    undefined,
    store.theme
  );
  const catBgStyle = pageSurfaceStyle(
    layout?.categoriesPage?.bgColor,
    store.theme,
    layout?.categoriesPage?.colorScheme
  );

  const templateCategories = categories.map(toTemplateCategory);

  return (
    <ShopChrome>
      <div className="flex-1" style={catBgStyle}>
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {categories.length === 0 ? (
            <div className="text-center py-12">
              <h1 className="text-3xl font-bold mb-4" style={zoneStyle(catHeadingZone)}>
                {t('Shop by Category', 'تسوق حسب الفئة')}
              </h1>
              <p className="text-muted-foreground mb-4">
                {t('No categories available yet.', 'لا توجد فئات متاحة حالياً')}
              </p>
              <Link href={storeUrl('/products')} className="text-primary hover:underline">
                {t('Browse all products', 'تصفح جميع المنتجات')}
              </Link>
            </div>
          ) : T && !templateLoading ? (
            <T.CategoryGrid
              categories={templateCategories}
              title="Shop by Category"
              titleAr="تسوق حسب الفئة"
              isRtl={isRtl}
              urlPrefix={urlPrefix}
              headingZone={catHeadingZone}
              categoryLabelZone={catLabelZone}
            />
          ) : (
            // Skeleton while template loads.
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {categories.map(c => (
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
