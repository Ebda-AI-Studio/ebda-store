'use client';

import type { CategoryGridProps } from '../types';
import CategoryCard from './CategoryCard';

export default function ClassicCategoryGrid({
  categories,
  isRtl = false,
  title,
  titleAr,
}: CategoryGridProps) {
  const displayTitle = isRtl && titleAr ? titleAr : title;

  return (
    <section className="py-16 md:py-24 bg-background" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        {/* Section Header - Elegant centered */}
        {displayTitle && (
          <div className="text-center mb-12 md:mb-16">
            <div className="w-12 h-px bg-border mx-auto mb-6" />
            <h2 className="text-2xl md:text-3xl lg:text-4xl font-serif font-normal text-foreground">
              {displayTitle}
            </h2>
            <div className="w-12 h-px bg-border mx-auto mt-6" />
          </div>
        )}

        {/* Grid - 4 columns on desktop for elegant spacing */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-8 md:gap-12">
          {categories.map((category) => (
            <CategoryCard
              key={category.id}
              category={category}
              isRtl={isRtl}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
