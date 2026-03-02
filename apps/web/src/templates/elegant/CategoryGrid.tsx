'use client';

import type { CategoryGridProps } from '../types';
import CategoryCard from './CategoryCard';

export default function ElegantCategoryGrid({
  categories,
  isRtl = false,
  title,
  titleAr,
  urlPrefix = '',
}: CategoryGridProps) {
  const displayTitle = isRtl && titleAr ? titleAr : title;

  return (
    <section className="py-20 md:py-28 bg-background" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        {/* Section Header - Editorial style */}
        {displayTitle && (
          <div className="text-center mb-16">
            <p className="text-xs tracking-[0.4em] uppercase text-muted-foreground mb-4">
              {isRtl ? 'تسوق حسب' : 'Shop by'}
            </p>
            <h2 className="text-3xl md:text-4xl font-light text-foreground tracking-wide">
              {displayTitle}
            </h2>
          </div>
        )}

        {/* Grid - 3 columns for elegant spacing */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-8 md:gap-12">
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
