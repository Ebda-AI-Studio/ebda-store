'use client';

import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getDisplayTitle } from '../shared';
import CategoryCard from './CategoryCard';

export default function BoldCategoryGrid({
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
    <section
      className="py-12 sm:py-16 md:py-28 bg-background relative overflow-hidden"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="categories"
    >
      {/* Background accent */}
      <div className="absolute top-0 left-0 w-1/2 h-1/2 bg-primary/5 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />

      <div className="container mx-auto px-4 relative z-10">
        {/* Section Header - Bold */}
        {displayTitle && (
          <div className="text-center mb-10 sm:mb-12 md:mb-16">
            <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black text-foreground tracking-tight">
              {displayTitle}
            </h2>
            <div className="mt-4 w-24 h-2 bg-primary mx-auto rounded-full" />
          </div>
        )}

        {/* Grid - Staggered layout for dynamism */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 md:gap-8">
          {categories.map((category, index) => (
            <div key={category.id} className={index % 2 === 1 ? 'lg:translate-y-8' : ''}>
              <CategoryCard category={category} isRtl={isRtl} urlPrefix={urlPrefix} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
