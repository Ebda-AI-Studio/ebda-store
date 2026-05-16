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
  // Bumped 2026-05-16 per Ahmad's reference images — desktop cards were
  // too large (~320px wide at lg). Now caps at xl:grid-cols-6 so wide
  // desktops show compact ~200px tiles matching the pecannbee/alkahraman
  // target sizing.
  const getGridCols = (count: number): string => {
    if (count === 1) return 'grid-cols-1';
    if (count === 2) return 'grid-cols-2';
    if (count === 3) return 'grid-cols-2 md:grid-cols-3';
    if (count === 4) return 'grid-cols-2 md:grid-cols-4';
    if (count === 5) return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5';
    return 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6';
  };

  return (
    <div
      className={`grid gap-4 md:gap-6 ${getGridCols(categories.length)}`}
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="categories"
    >
      {categories.map(category => (
        <CategoryCard key={category.id} category={category} isRtl={isRtl} urlPrefix={urlPrefix} />
      ))}
    </div>
  );
}
