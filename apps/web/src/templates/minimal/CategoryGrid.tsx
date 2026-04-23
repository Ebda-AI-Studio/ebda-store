'use client';

import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getDisplayTitle } from '../shared';
import CategoryCard from './CategoryCard';

export default function MinimalCategoryGrid({
  categories,
  isRtl: isRtlProp,
  title,
  titleAr,
  urlPrefix = '',
}: CategoryGridProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayTitle = getDisplayTitle(isRtl, title, titleAr);

  return (
    <section className="py-24 md:py-32 bg-background" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        {displayTitle && (
          <h2 className="text-sm tracking-[0.2em] uppercase text-muted-foreground mb-16 text-center">
            {displayTitle}
          </h2>
        )}

        {/* Grid - Simple 4 columns */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
          {categories.map(category => (
            <CategoryCard
              key={category.id}
              category={category}
              isRtl={isRtl}
              urlPrefix={urlPrefix}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
