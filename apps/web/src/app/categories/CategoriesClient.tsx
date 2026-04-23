'use client';

import Link from 'next/link';
import { type Category } from '@/lib/api';
import { useStoreUrl } from '@/contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { ShopChrome } from '../../components';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { toTemplateCategory } from '../../templates/adapters';

interface CategoriesClientProps {
  categories: Category[];
}

export default function CategoriesClient({ categories }: CategoriesClientProps) {
  const storeUrl = useStoreUrl();
  const { language, t } = useLanguage();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  const isRtl = language === 'ar';
  const urlPrefix = storeUrl('');

  const templateCategories = categories.map(toTemplateCategory);

  return (
    <ShopChrome>
      <div className="container mx-auto px-4 py-8">
        {categories.length === 0 ? (
          <div className="text-center py-12">
            <h1 className="text-3xl font-bold mb-4">{t('Shop by Category', 'تسوق حسب الفئة')}</h1>
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
    </ShopChrome>
  );
}
