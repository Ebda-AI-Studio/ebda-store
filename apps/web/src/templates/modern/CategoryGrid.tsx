'use client';

import CategoryCard from './CategoryCard';
import type { CategoryGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ModernCategoryGrid({
  categories,
  isRtl: isRtlProp,
  urlPrefix = '',
}: CategoryGridProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  if (categories.length === 0) {
    return null;
  }

  // Auto-size grid based on category count for balanced layouts.
  // Bumped a second time 2026-05-16 per Ahmad: 'on desktop are huge must
  // be smaller'. xl breakpoint (1280px+) was too late — most desktops are
  // 1024-1440px wide, falling on lg or md. Now caps tile width earlier
  // at md:grid-cols-4 / lg:grid-cols-6 so 1024+ desktops show compact
  // ~150-180px tiles.
  const getGridCols = (count: number): string => {
    if (count === 1) return 'grid-cols-1';
    if (count === 2) return 'grid-cols-2';
    if (count === 3) return 'grid-cols-2 md:grid-cols-3';
    if (count === 4) return 'grid-cols-2 md:grid-cols-4';
    if (count === 5) return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-5';
    // 6+ categories: 2/4/6/6 cols across breakpoints — desktop cards
    // are ~170px wide at lg+ which matches the pecannbee reference
    // images ahmad shared.
    return 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6';
  };

  return (
    <div
      className={`grid gap-3 md:gap-4 ${getGridCols(categories.length)}`}
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="categories"
    >
      {categories.map(category => (
        <CategoryCard key={category.id} category={category} isRtl={isRtl} urlPrefix={urlPrefix} />
      ))}
    </div>
  );
}
