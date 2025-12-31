'use client';

import CategoryCard from './CategoryCard';
import type { CategoryGridProps } from '../types';

export default function ModernCategoryGrid({ categories, isRtl = false }: CategoryGridProps) {
  if (categories.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
      {categories.map((category) => (
        <CategoryCard key={category.id} category={category} isRtl={isRtl} />
      ))}
    </div>
  );
}
