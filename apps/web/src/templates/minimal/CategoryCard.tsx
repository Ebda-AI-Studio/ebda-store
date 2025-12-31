'use client';

import Link from 'next/link';
import type { CategoryCardProps } from '../types';

export default function MinimalCategoryCard({ category, isRtl = false }: CategoryCardProps) {
  const displayName = isRtl && category.nameAr ? category.nameAr : category.name;

  return (
    <Link
      href={`/products?category=${category.slug}`}
      className="group block"
    >
      {/* Image - Clean square */}
      <div className="aspect-square bg-muted overflow-hidden mb-4">
        {category.image ? (
          <img
            src={category.image}
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-500"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xs text-muted-foreground tracking-widest uppercase">
              {isRtl ? 'صورة' : 'Image'}
            </span>
          </div>
        )}
      </div>

      {/* Title - Simple */}
      <h3 className="text-sm font-normal text-foreground group-hover:text-primary transition-colors">
        {displayName}
      </h3>
    </Link>
  );
}
