'use client';

import Link from 'next/link';
import Image from 'next/image';
import { type Category } from '@/lib/api';
import { useStoreUrl } from '@/contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { ShopChrome } from '../../components';

interface CategoriesClientProps {
  categories: Category[];
}

export default function CategoriesClient({ categories }: CategoriesClientProps) {
  const storeUrl = useStoreUrl();
  const { language, t } = useLanguage();

  return (
    <ShopChrome>
      <div className="container mx-auto px-4 py-8 flex-1">
        <h1 className="text-3xl font-bold mb-8">
          {t(
            'Shop by Category',
            '\u062a\u0633\u0648\u0642 \u062d\u0633\u0628 \u0627\u0644\u0641\u0626\u0629'
          )}
        </h1>

        {categories.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-4">
              {t(
                'No categories available yet.',
                '\u0644\u0627 \u062a\u0648\u062c\u062f \u0641\u0626\u0627\u062a \u0645\u062a\u0627\u062d\u0629 \u062d\u0627\u0644\u064a\u0627\u064b'
              )}
            </p>
            <Link href={storeUrl('/products')} className="text-primary hover:underline">
              {t(
                'Browse all products',
                '\u062a\u0635\u0641\u062d \u062c\u0645\u064a\u0639 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a'
              )}
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {categories.map(category => (
              <Link
                key={category.id}
                href={storeUrl(`/products?category=${category.slug}`)}
                className="group bg-card rounded-xl shadow-md overflow-hidden hover:shadow-lg transition-shadow border"
              >
                <div className="aspect-square bg-gradient-to-br from-primary/5 to-primary/10 relative">
                  {category.image ? (
                    <Image
                      src={category.image}
                      alt={category.name}
                      width={500}
                      height={500}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-primary/50">
                      <svg
                        className="w-16 h-16"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                        />
                      </svg>
                    </div>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="font-semibold text-lg group-hover:text-primary transition-colors">
                    {language === 'ar' && category.nameAr ? category.nameAr : category.name}
                  </h3>
                  {category.description && (
                    <p className="text-muted-foreground text-sm mt-1 line-clamp-2">
                      {category.description}
                    </p>
                  )}
                  {category.productCount !== undefined && (
                    <p className="text-muted-foreground/70 text-sm mt-2">
                      {category.productCount} {t('products', '\u0645\u0646\u062a\u062c')}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </ShopChrome>
  );
}
